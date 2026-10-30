/**
 * Upstream client for WorkBuddy CN and WorkBuddy Global.
 */

import type {
  WorkBuddyCredential,
  WorkBuddyCredits,
  WorkBuddyModelInfo,
  WorkBuddyProbeResult,
  WorkBuddyProbeVerdict,
  WorkBuddyRegion,
} from './types.ts'
import type { WorkBuddyRefreshOutcome } from './auth.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export type UpstreamErrorKind = 'auth' | 'credit' | 'rate' | 'client' | 'server' | 'not_found'

export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

const FALLBACK_APP_VERSION = { cn: '5.8.3', global: '5.6.2' } as const
const APP_INFO_PLIST = {
  cn: '/Applications/WorkBuddy.app/Contents/Info.plist',
  global: '/Applications/WorkBuddy AI.app/Contents/Info.plist',
} as const
const CLI_VERSION = { cn: '2.63.2', global: '2.115.0' } as const

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** A probe asks for one token, so a healthy answer costs a fraction of a credit. */
const PROBE_TIMEOUT_MS = 45_000
const PROBE_MAX_TOKENS = 1

/** Gateway codes that mean "this account cannot run this model right now". */
const PROBE_BLOCK_CODES = ['6004', '11140', '14018'] as const

const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit', '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate'
  const lowered = body.toLowerCase()
  if (HARD_CREDIT_MARKERS.some(marker => lowered.includes(marker))) return 'credit'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * The gateway answers a rate-limited stream with an SSE frame carrying the
 * business code and, for 6004, the exact moment the model frees up. Reading
 * that timestamp beats estimating from credits: it is the upstream's own
 * schedule.
 *
 * The two lanes word it differently. CN sends
 * `当前模型请求过于频繁，将在 2026-10-26 21:44:41 恢复`; Global sends
 * `usage exceeds frequency limit, ... your usage will reset at
 * 2026-10-31 07:28:11 UTC+8`. Matching only the CN phrasing left the Global
 * panel with an empty reset slot, so both shapes parse here. The written zone
 * is honoured when the message states one; otherwise +08:00 is assumed, which
 * is what both gateways have sent so far.
 */
export function parseResetTime(text: string): number | undefined {
  const match = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(text)
  if (match === null) return undefined
  const day = match[1] ?? ''
  const clock = match[2] ?? ''
  // Only the trailing zone matters: `UTC+8` sits after the timestamp. ISO
  // forms (`Z`, `+08:00`) and a bare `UTC` are accepted too, since a gateway
  // may word it that way instead.
  const tail = text.slice(match.index + match[0].length)
  const zoned = /^\s*(?:UTC|GMT)\s*([+-]?\d{1,2})(?::(\d{2}))?/i.exec(tail)
  const bareUtc = zoned === null && /^\s*(?:UTC|GMT)\s*(?:$|[),.;"}])/i.test(tail)
  const iso = /^\s*(Z|[+-]\d{2}:?\d{2})\b/i.exec(tail)
  let offset = '+08:00'
  if (zoned !== null && zoned[1] !== undefined) {
    const hoursPart = zoned[1]
    const sign = hoursPart.startsWith('-') ? '-' : '+'
    const hours = Math.abs(Number(hoursPart)).toString().padStart(2, '0')
    offset = `${sign}${hours}:${zoned[2] ?? '00'}`
  } else if (bareUtc) {
    offset = '+00:00'
  } else if (iso !== null && iso[1] !== undefined) {
    const zone = iso[1].toUpperCase()
    offset = zone === 'Z'
      ? '+00:00'
      : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`
  }
  const time = clock.length === 5 ? `${clock}:00` : clock
  const parsed = Date.parse(`${day}T${time}${offset}`)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** First gateway business code in a body or SSE frame. */
export function parseBusinessCode(text: string): string | undefined {
  const match = /"code"\s*:\s*(\d+)/.exec(text)
  return match?.[1]
}

function probeVerdictFor(status: number, code: string | undefined): WorkBuddyProbeVerdict {
  if (code === '6004') return 'rate-limited'
  if (code === '11140') return 'banned'
  if (code === '14018') return 'no-credit'
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return 'auth'
  return 'error'
}

/** Strip anything token-shaped before a message reaches the panel. */
function probeDetail(text: string): string | undefined {
  const cleaned = text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
  return cleaned === '' ? undefined : cleaned.slice(0, 200)
}

function chatBase(region: WorkBuddyRegion): string {
  return region === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(region: WorkBuddyRegion): string {
  return region === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(region: WorkBuddyRegion): string {
  return region === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/**
 * Read the installed WorkBuddy app version; the gateway checks this header.
 *
 * Reading it spawns PlistBuddy synchronously, and every request built headers
 * used to do that two or three times. A settings panel that checks seven
 * accounts therefore blocked the whole host for dozens of subprocess spawns.
 * The version only changes when the app is reinstalled, so one read per region
 * per process is enough.
 */
const appVersionCache = new Map<WorkBuddyRegion, string>()

function appVersion(region: WorkBuddyRegion): string {
  const cached = appVersionCache.get(region)
  if (cached !== undefined) return cached
  let version: string = FALLBACK_APP_VERSION[region]
  const plist = APP_INFO_PLIST[region]
  if (existsSync(plist)) {
    try {
      const value = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (value) version = value
    } catch {}
  }
  appVersionCache.set(region, version)
  return version
}

/** Drop the cached versions; tests use it to observe the first read. */
export function resetAppVersionCacheForTesting(): void {
  appVersionCache.clear()
}

const userAgentCache = new Map<WorkBuddyRegion, string>()

function clientUserAgent(region: WorkBuddyRegion): string {
  const cached = userAgentCache.get(region)
  if (cached !== undefined) return cached
  const version = appVersion(region)
  const agent = region === 'global'
    ? `WorkBuddy/${version} WorkBuddy/${version} CLI/${CLI_VERSION.global}`
    : `CLI/${CLI_VERSION.cn} CodeBuddy/${CLI_VERSION.cn}`
  userAgentCache.set(region, agent)
  return agent
}

/** The official gateway's trace triplet shares one trace id. */
function gatewayRequestHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString('hex')
  const spanId = randomBytes(8).toString('hex')
  const parentSpanId = randomBytes(8).toString('hex')
  return {
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'X-Request-ID': randomUUID(),
    'acp-connection-id': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    'X-Trace-ID': traceId,
  }
}

function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const version = appVersion(credential.region)
  return {
    'Accept': 'application/json, text/plain, */*',
    'Origin': originReferer(credential.region),
    'Referer': `${originReferer(credential.region)}/`,
    'User-Agent': clientUserAgent(credential.region),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Product-Version': version,
    'X-Private-Data': 'true',
  }
}

function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    ...gatewayRequestHeaders(),
    ...(credential.uid ? { 'X-User-Id': credential.uid } : { 'X-No-User-Id': '1' }),
    ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    'X-Domain': credential.domain || (credential.region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
  }
  return headers
}

function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId) {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid) headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId) {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  headers['X-Domain'] = credential.domain || (credential.region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn')
  return headers
}

async function readEnvelope(response: Response): Promise<{ code: number; msg?: string | undefined; data?: unknown }> {
  try {
    const raw = await response.text()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      code: typeof parsed['code'] === 'number' ? parsed['code'] : response.ok ? 0 : -1,
      msg: typeof parsed['msg'] === 'string' ? parsed['msg'] : undefined,
      data: parsed['data'],
    }
  } catch {
    return { code: response.ok ? 0 : -1 }
  }
}

export function parseCatalogModels(rawList: readonly unknown[], region: WorkBuddyRegion): WorkBuddyModelInfo[] {
  const result: WorkBuddyModelInfo[] = []
  for (const item of rawList) {
    if (typeof item !== 'object' || item === null) continue
    const m = item as Record<string, unknown>
    const id = typeof m['id'] === 'string' ? m['id'] : ''
    if (!id || m['disabled'] === true) continue

    const name = typeof m['name'] === 'string' && m['name'] ? m['name'] : id
    const contextWindow = typeof m['maxInputTokens'] === 'number' ? m['maxInputTokens'] : (typeof m['maxAllowedSize'] === 'number' ? m['maxAllowedSize'] : 200_000)
    const maxTokens = typeof m['maxOutputTokens'] === 'number' ? m['maxOutputTokens'] : 32_000
    const supportsImages = m['supportsImages'] === true && m['disabledMultimodal'] !== true

    // Reasoning
    let reasoning: WorkBuddyModelInfo['reasoning']
    if (typeof m['reasoning'] === 'object' && m['reasoning'] !== null) {
      const r = m['reasoning'] as Record<string, unknown>
      const supportedEfforts = Array.isArray(r['supportedEfforts']) ? r['supportedEfforts'].filter((x): x is string => typeof x === 'string') : undefined
      // `effort` is the catalog's advertised default and is also published at
      // the top level by some catalog revisions.
      const declaredEffort = [r['defaultEffort'], r['effort'], m['defaultEffort']]
        .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      reasoning = {
        supports: true,
        onlyReasoning: m['onlyReasoning'] === true,
        supportedEfforts,
        defaultEffort: declaredEffort,
        canDisableThinking: r['canDisableThinking'] === true,
      }
    } else if (m['supportsReasoning'] === true) {
      reasoning = { supports: true, onlyReasoning: m['onlyReasoning'] === true }
    }

    // Billing & badges
    const credits = typeof m['credits'] === 'string' ? m['credits'] : undefined
    const badges: string[] = []
    if (Array.isArray(m['tags'])) {
      for (const tag of m['tags']) {
        if (typeof tag === 'string') {
          if (tag.startsWith('badge:')) {
            const parts = tag.split(':')
            if (parts[1]) badges.push(parts[1])
          } else if (tag === '限时免费' || tag === 'Free now') {
            badges.push(tag)
          }
        }
      }
    }
    const free = credits === 'x0.00' || credits === 'x0.00 credits' || badges.includes('限时免费') || badges.includes('Free now')

    result.push({
      id,
      name,
      contextWindow,
      maxTokens,
      supportsImages,
      reasoning,
      billing: { credits, badges: badges.length > 0 ? badges : undefined, free },
      region,
    })
  }
  return result
}

export class WorkBuddyUpstreamClient {
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential.region)}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          ...chatHeaders(credential),
          'Authorization': `Bearer ${credential.accessToken}`,
        },
        body: bodyJson,
        ...(signal ? { signal } : {}),
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /**
   * Ask the gateway whether `model` runs on this account right now.
   *
   * This sends a real, one-token streaming request instead of reading credits:
   * a rate limit is per model, so the balance says nothing about whether
   * flash is available. Streaming is required — the CN gateway rejects
   * non-stream requests for these models with 11101.
   *
   * The first SSE frame already carries the verdict, so the body is cancelled
   * immediately: a blocked account streams one error frame and a healthy one
   * streams its first delta, and neither needs the rest.
   */
  async probeModel(
    credential: WorkBuddyCredential,
    model: string,
  ): Promise<WorkBuddyProbeResult> {
    const startedAt = Date.now()
    const body = JSON.stringify({
      model,
      // The Global gateway rejects a conversation that does not open with a
      // system message (code 11128), so the probe always sends one. CN accepts
      // it too, which keeps both lanes on one shape.
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'ok' },
      ],
      max_tokens: PROBE_MAX_TOKENS,
      stream: true,
    })
    const checkedAt = startedAt
    const finish = (
      verdict: WorkBuddyProbeVerdict,
      extra: { code?: string | undefined; head?: string | undefined } = {},
    ): WorkBuddyProbeResult => ({
      verdict,
      ...(extra.code === undefined ? {} : { code: extra.code }),
      ...(extra.head === undefined ? {} : { detail: probeDetail(extra.head) }),
      ...(extra.head === undefined ? {} : { resetsAtMs: parseResetTime(extra.head) }),
      elapsedMs: Date.now() - startedAt,
      checkedAt,
    })

    let response: Response
    try {
      response = await fetch(`${chatBase(credential.region)}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          ...chatHeaders(credential),
          'Authorization': `Bearer ${credential.accessToken}`,
        },
        body,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      return finish('error', { head: `transport error: ${String(error)}` })
    }

    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
      const code = parseBusinessCode(text)
      return finish(probeVerdictFor(response.status, code), { code, head: text })
    }

    let head = ''
    try {
      const reader = response.body?.getReader()
      if (reader === undefined) return finish('ok')
      const { value } = await reader.read()
      head = Buffer.from(value ?? []).toString('utf8')
      await reader.cancel().catch(() => {})
    } catch {
      // A body that never produced a frame still means the request was
      // accepted; treat it as usable rather than inventing a failure.
      return finish('ok')
    }

    const code = parseBusinessCode(head)
    if (code !== undefined && (PROBE_BLOCK_CODES as readonly string[]).includes(code)) {
      return finish(probeVerdictFor(response.status, code), { code, head })
    }
    return finish('ok')
  }

  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential.region)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`Token refresh failed HTTP ${response.status}: ${envelope.msg ?? 'unknown error'}`)
    }
    const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}) as Record<string, unknown>
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (!accessToken) throw new Error('Refresh endpoint returned empty accessToken')
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken']) outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain']) outcome.domain = data['domain']
    return outcome
  }

  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyModelInfo[]> {
    const region = credential.region
    const base = chatBase(region)
    // Try /v3/config first (which works on both CN and Global and contains promotional rates & badges)
    try {
      const configRes = await fetch(`${base}/v3/config`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...commonHeaders(credential),
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      if (configRes.ok) {
        const env = await readEnvelope(configRes)
        if (env.code === 0 && typeof env.data === 'object' && env.data !== null) {
          const cfg = env.data as Record<string, unknown>
          if (Array.isArray(cfg['models']) && cfg['models'].length > 0) {
            return parseCatalogModels(cfg['models'], region)
          }
        }
      }
    } catch {}

    // Fallback for CN: /console/enterprises/personal/models
    if (region === 'cn') {
      const res = await fetch(`${base}/console/enterprises/personal/models`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(region),
          'Referer': `${originReferer(region)}/`,
          'User-Agent': clientUserAgent(region),
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      if (res.ok) {
        const env = await readEnvelope(res)
        if (env.code === 0 && typeof env.data === 'object' && env.data !== null) {
          const data = env.data as Record<string, unknown>
          if (Array.isArray(data['models'])) {
            return parseCatalogModels(data['models'], region)
          }
        }
      }
    }

    throw new Error(`Failed to fetch models for ${region}`)
  }

  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const base = billingBase(credential.region)
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')

    const response = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw new Error(`Fetch credits failed HTTP ${response.status}`)
    const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}) as Record<string, unknown>
    const respWrapper = (typeof data['Response'] === 'object' && data['Response'] !== null ? data['Response'] : {}) as Record<string, unknown>
    const dataInner = (typeof respWrapper['Data'] === 'object' && respWrapper['Data'] !== null ? respWrapper['Data'] : {}) as Record<string, unknown>
    const rawAccounts = Array.isArray(dataInner['Accounts']) ? dataInner['Accounts'] : []

    let totalBalance = 0
    const accounts = []
    for (const a of rawAccounts) {
      if (typeof a !== 'object' || a === null) continue
      const item = a as Record<string, unknown>
      const name = typeof item['PackageName'] === 'string' ? item['PackageName'] : 'Credits Package'
      const remain = typeof item['CycleCapacityRemain'] === 'number'
        ? item['CycleCapacityRemain']
        : (typeof item['CapacityRemain'] === 'number' ? item['CapacityRemain'] : 0)
      const total = typeof item['CycleCapacitySize'] === 'number'
        ? item['CycleCapacitySize']
        : (typeof item['CapacitySize'] === 'number' ? item['CapacitySize'] : 0)
      totalBalance += remain
      accounts.push({ name, balance: remain, total })
    }

    return { accounts, totalBalance }
  }
}
