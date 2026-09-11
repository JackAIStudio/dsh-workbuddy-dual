/**
 * Upstream client for WorkBuddy CN and WorkBuddy Global.
 */

import type {
  WorkBuddyCredential,
  WorkBuddyCredits,
  WorkBuddyModelInfo,
  WorkBuddyRegion,
} from './types.ts'
import type { WorkBuddyRefreshOutcome } from './auth.ts'

export type UpstreamErrorKind = 'auth' | 'credit' | 'rate' | 'client' | 'server' | 'not_found'

export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

const CLIENT_UA_CN = 'CLI/2.63.2 CodeBuddy/2.63.2'
const CLIENT_UA_GLOBAL = 'WorkBuddy/5.3.14 WorkBuddy/5.3.14 CLI/2.115.0'

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

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

function chatBase(region: WorkBuddyRegion): string {
  return region === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(region: WorkBuddyRegion): string {
  return region === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(region: WorkBuddyRegion): string {
  return region === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const isGlobal = credential.region === 'global'
  return {
    'Accept': 'application/json, text/plain, */*',
    'Origin': originReferer(credential.region),
    'Referer': `${originReferer(credential.region)}/`,
    'User-Agent': isGlobal ? CLIENT_UA_GLOBAL : CLIENT_UA_CN,
    ...(isGlobal ? {
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Version': '5.3.14',
      'X-Product-Version': '5.3.14',
    } : {}),
  }
}

function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
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
            return this.parseModelsList(cfg['models'], region)
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
          'User-Agent': CLIENT_UA_CN,
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      if (res.ok) {
        const env = await readEnvelope(res)
        if (env.code === 0 && typeof env.data === 'object' && env.data !== null) {
          const data = env.data as Record<string, unknown>
          if (Array.isArray(data['models'])) {
            return this.parseModelsList(data['models'], region)
          }
        }
      }
    }

    throw new Error(`Failed to fetch models for ${region}`)
  }

  private parseModelsList(rawList: unknown[], region: WorkBuddyRegion): WorkBuddyModelInfo[] {
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
        reasoning = {
          supports: true,
          onlyReasoning: m['onlyReasoning'] === true,
          supportedEfforts,
          defaultEffort: typeof r['defaultEffort'] === 'string' ? r['defaultEffort'] : (typeof r['effort'] === 'string' ? r['effort'] : undefined),
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
