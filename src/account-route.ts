/**
 * Loopback routes behind the account list: read the pool, pick an account,
 * import one from a WorkBuddy auth file, and probe the flash model per account.
 *
 * The route is served by the Host rather than through the model shim, so the
 * Web and desktop hosts share one implementation. Every call is guarded by the
 * same loopback-only check the other plugin routes use: responses carry account
 * identities, and the mutating calls decide which bearer token the whole
 * harness spends.
 */

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyAccountPool, WorkBuddyPoolAccount } from './accounts.ts'
import { toCredential } from './accounts.ts'
import { defaultDesktopCandidatesFor, parseWorkBuddyAuth } from './auth.ts'
import type { WorkBuddyDualCredentialStore, WorkBuddyRefreshOutcome } from './auth.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import {
  WORKBUDDY_DUAL_ACCOUNTS_PATH,
  WORKBUDDY_FLASH_MODEL,
  type WorkBuddyAccountAction,
  type WorkBuddyWebAccount,
  type WorkBuddyWebAccounts,
  type WorkBuddyWebProbe,
  type WorkBuddyWebRegionAccounts,
} from './account-paths.ts'
import type { WorkBuddyCredential, WorkBuddyRegion } from './types.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

const BODY_LIMIT = 16 * 1024

/** Credits go stale quickly; re-ask after a minute rather than on every render. */
const CREDIT_CACHE_MS = 60_000

/** Every probe spends a little credit, so repeated views reuse the last answer. */
const PROBE_CACHE_MS = 45_000

/** Refresh a little before expiry so a probe never fails on a dead token. */
const REFRESH_MARGIN_MS = 120_000

export interface WorkBuddyDualAccountRouteOptions {
  store: WorkBuddyDualCredentialStore
  client: WorkBuddyUpstreamClient
  /** Rebuild catalogs and notify pickers after the active account changes. */
  onAccountChange?: ((region: WorkBuddyRegion) => void | Promise<void>) | undefined
}

interface CachedCredits {
  total: number
  at: number
}

interface CachedProbe {
  probe: WorkBuddyWebProbe
  at: number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function trusted(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > BODY_LIMIT) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function regionOf(value: unknown): WorkBuddyRegion {
  if (value === 'cn' || value === 'global') return value
  throw new Error('region must be cn or global')
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`)
  return value.trim()
}

/**
 * The upstream nickname for a phone-based account is already masked
 * (`173****0329`). For anything else, mask the middle here so a full uid never
 * reaches the browser.
 */
export function displayNameFor(account: { uid: string; nickname?: string | undefined; label?: string | undefined }): string {
  const label = account.label?.trim()
  if (label !== undefined && label !== '') return label
  const nickname = account.nickname?.trim()
  if (nickname !== undefined && nickname !== '') return nickname
  return maskUid(account.uid)
}

export function maskUid(uid: string): string {
  if (uid.length <= 8) return uid
  return `${uid.slice(0, 4)}…${uid.slice(-4)}`
}

/** Strip anything token-shaped and collapse whitespace for display. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240)
}

/** Parse one auth document; `parseWorkBuddyAuth` owns the decryption rules. */
export async function readAuthFile(path: string, region: WorkBuddyRegion): Promise<WorkBuddyCredential> {
  const text = await readFile(path, 'utf8')
  const credential = parseWorkBuddyAuth(text, region)
  if (credential === undefined) {
    throw new Error(`could not read a WorkBuddy ${region} sign-in from ${path}`)
  }
  return credential
}

/** Newest auth file the official desktop app left behind for this region. */
async function importFromDesktop(region: WorkBuddyRegion): Promise<WorkBuddyCredential> {
  const candidates = defaultDesktopCandidatesFor(region)
  let lastError: unknown
  for (const path of candidates) {
    try {
      return await readAuthFile(path, region)
    } catch (error: unknown) {
      lastError = error
    }
  }
  throw new Error(`no signed-in WorkBuddy ${region} app found (${safeMessage(lastError)})`)
}

/** Whether a credential is close enough to expiry to need a refresh first. */
function needsRefresh(credential: WorkBuddyCredential): boolean {
  if (credential.expiresAtMs <= 0) return true
  return Date.now() + REFRESH_MARGIN_MS >= credential.expiresAtMs
}

/**
 * A usable credential for one pool entry, refreshing and persisting when the
 * token is about to expire. Renewing in the pool keeps every later request
 * (and every other host) on the refreshed token.
 */
async function usableCredential(
  pool: WorkBuddyAccountPool,
  account: WorkBuddyPoolAccount,
  client: WorkBuddyUpstreamClient,
): Promise<WorkBuddyCredential> {
  const credential = toCredential(account)
  if (!needsRefresh(credential)) return credential
  if (credential.refreshToken === '') return credential

  const outcome: WorkBuddyRefreshOutcome = await client.refreshToken(credential)
  const refreshed: WorkBuddyCredential = {
    ...credential,
    accessToken: outcome.accessToken,
    ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
    expiresAtMs: outcome.expiresInSec !== undefined ? Date.now() + outcome.expiresInSec * 1000 : credential.expiresAtMs,
    ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
  }
  await pool.update(account.uid, refreshed)
  return refreshed
}

export interface WorkBuddyAccountRouteState {
  credits: Map<string, CachedCredits>
  probes: Map<string, CachedProbe>
}

export function createAccountRouteState(): WorkBuddyAccountRouteState {
  return { credits: new Map(), probes: new Map() }
}

function cacheKey(region: WorkBuddyRegion, uid: string, model?: string | undefined): string {
  return `${region}/${uid}${model === undefined ? '' : `/${model}`}`
}

async function creditsFor(
  state: WorkBuddyAccountRouteState,
  client: WorkBuddyUpstreamClient,
  credential: WorkBuddyCredential,
): Promise<number | undefined> {
  const key = cacheKey(credential.region, credential.uid)
  const cached = state.credits.get(key)
  if (cached !== undefined && Date.now() - cached.at < CREDIT_CACHE_MS) return cached.total
  try {
    const credits = await client.fetchCredits(credential)
    state.credits.set(key, { total: credits.totalBalance, at: Date.now() })
    return credits.totalBalance
  } catch {
    return cached?.total
  }
}

function probeFor(
  state: WorkBuddyAccountRouteState,
  credential: WorkBuddyCredential,
  model: string,
): WorkBuddyWebProbe | undefined {
  const cached = state.probes.get(cacheKey(credential.region, credential.uid, model))
  if (cached === undefined) return undefined
  if (Date.now() - cached.at >= PROBE_CACHE_MS) return undefined
  // A stale "rate limited until 21:44" must not keep the row blocked after
  // 21:44: once the upstream's own reset time passes, the answer is unknown
  // again and the panel re-checks instead of repeating an expired verdict.
  if (
    cached.probe.verdict === 'rate-limited'
    && cached.probe.resetsAtMs !== undefined
    && Date.now() >= cached.probe.resetsAtMs
  ) {
    return undefined
  }
  return cached.probe
}

async function probeAccount(
  state: WorkBuddyAccountRouteState,
  client: WorkBuddyUpstreamClient,
  credential: WorkBuddyCredential,
  model: string,
): Promise<WorkBuddyWebProbe> {
  const result = await client.probeModel(credential, model)
  const probe: WorkBuddyWebProbe = {
    verdict: result.verdict,
    model,
    ...(result.resetsAtMs === undefined ? {} : { resetsAtMs: result.resetsAtMs }),
    checkedAt: result.checkedAt,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  }
  state.probes.set(cacheKey(credential.region, credential.uid, model), { probe, at: Date.now() })
  return probe
}

async function regionView(
  region: WorkBuddyRegion,
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
): Promise<WorkBuddyWebRegionAccounts> {
  const pool = deps.store.poolFor(region)
  const store = deps.store.storeFor(region)
  const doc = await pool.get()
  // Describe the fallback from the fallback itself, not from `current()`:
  // with a pooled account in use, `current()` is that pool entry and the
  // "app sign-in" row would repeat the selected account's name.
  const fallbackCredential = await store.fallback()
  let fallbackCredits: number | undefined
  let fallbackProbe: WorkBuddyWebProbe | undefined
  if (fallbackCredential !== undefined) {
    try {
      fallbackCredits = await creditsFor(state, deps.client, fallbackCredential)
      fallbackProbe = probeFor(state, fallbackCredential, WORKBUDDY_FLASH_MODEL)
        ?? await probeAccount(state, deps.client, fallbackCredential, WORKBUDDY_FLASH_MODEL)
    } catch {
      // Same rule as pool rows: one unreachable sign-in must not blank the panel.
    }
  }

  const accounts = await Promise.all(doc.accounts.map(async (account): Promise<WorkBuddyWebAccount> => {
    const key = cacheKey(region, account.uid)
    let credits = state.credits.get(key)?.total
    let probe = state.probes.get(cacheKey(region, account.uid, WORKBUDDY_FLASH_MODEL))?.probe
    try {
      const credential = await usableCredential(pool, account, deps.client)
      credits = await creditsFor(state, deps.client, credential)
      probe = probeFor(state, credential, WORKBUDDY_FLASH_MODEL)
        ?? await probeAccount(state, deps.client, credential, WORKBUDDY_FLASH_MODEL)
    } catch {
      // A single unreachable account must not blank the whole list; the row
      // still renders, just without a fresh verdict.
    }
    return {
      uid: account.uid,
      displayName: displayNameFor(account),
      ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
      ...(account.label === undefined ? {} : { label: account.label }),
      active: doc.activeUid === account.uid,
      fallback: false,
      ...(account.expiresAtMs === 0 ? {} : { expiresAtMs: account.expiresAtMs }),
      ...(credits === undefined ? {} : { credits }),
      ...(probe === undefined ? {} : { probe }),
    }
  }))

  return {
    region,
    fallbackSignedIn: fallbackCredential !== undefined,
    ...(fallbackCredential?.nickname === undefined ? {} : { fallbackName: fallbackCredential.nickname }),
    ...(fallbackCredential === undefined ? {} : { fallbackSource: fallbackCredential.source }),
    ...(fallbackCredits === undefined ? {} : { fallbackCredits }),
    ...(fallbackProbe === undefined ? {} : { fallbackProbe }),
    usingFallback: doc.activeUid === undefined,
    accounts,
    probeModel: WORKBUDDY_FLASH_MODEL,
  }
}

export async function workBuddyAccountsView(
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
): Promise<WorkBuddyWebAccounts> {
  const [cn, global] = await Promise.all([
    regionView('cn', deps, state),
    regionView('global', deps, state),
  ])
  return { cn, global }
}

export function parseAccountAction(value: unknown): WorkBuddyAccountAction {
  if (!isRecord(value)) throw new Error('payload must be an object')
  const action = value['action']
  const region = regionOf(value['region'])
  switch (action) {
    case 'select': {
      const uid = value['uid']
      if (uid !== null && typeof uid !== 'string') throw new Error('uid must be a string or null')
      return { action: 'select', region, uid: uid === null ? null : uid.trim() }
    }
    case 'add': {
      const path = value['path']
      if (path !== undefined && typeof path !== 'string') throw new Error('path must be a string')
      return { action: 'add', region, ...(path === undefined || path.trim() === '' ? {} : { path: path.trim() }) }
    }
    case 'remove':
      return { action: 'remove', region, uid: requiredString(value['uid'], 'uid') }
    case 'relabel':
      return {
        action: 'relabel',
        region,
        uid: requiredString(value['uid'], 'uid'),
        label: typeof value['label'] === 'string' ? value['label'].trim().slice(0, 40) : '',
      }
    case 'probe': {
      const uid = value['uid']
      if (uid !== undefined && typeof uid !== 'string') throw new Error('uid must be a string')
      const model = value['model']
      if (model !== undefined && typeof model !== 'string') throw new Error('model must be a string')
      return {
        action: 'probe',
        region,
        ...(uid === undefined || uid.trim() === '' ? {} : { uid: uid.trim() }),
        ...(model === undefined || model.trim() === '' ? {} : { model: model.trim() }),
      }
    }
    default:
      throw new Error('unknown action')
  }
}

/** Apply one mutation, then return the freshly rebuilt view. */
async function applyAction(
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
  action: WorkBuddyAccountAction,
): Promise<WorkBuddyWebAccounts> {
  const pool = deps.store.poolFor(action.region)

  switch (action.action) {
    case 'select': {
      await pool.select(action.uid === null ? undefined : action.uid)
      deps.store.storeFor(action.region).pool?.invalidate()
      await deps.onAccountChange?.(action.region)
      break
    }
    case 'add': {
      const credential = action.path === undefined
        ? await importFromDesktop(action.region)
        : await readAuthFile(action.path, action.region)
      // Imports are explicit, so the freshly added account becomes active;
      // that is the whole point of importing it.
      await pool.upsert(credential, { select: true })
      await deps.onAccountChange?.(action.region)
      break
    }
    case 'remove': {
      const doc = await pool.get()
      const wasActive = doc.activeUid === action.uid
      const next = await pool.remove(action.uid)
      state.credits.delete(cacheKey(action.region, action.uid))
      state.probes.delete(cacheKey(action.region, action.uid, WORKBUDDY_FLASH_MODEL))
      if (wasActive || next.activeUid === undefined) await deps.onAccountChange?.(action.region)
      break
    }
    case 'relabel': {
      await pool.relabel(action.uid, action.label)
      break
    }
    case 'probe': {
      const doc = await pool.get()
      const model = action.model ?? WORKBUDDY_FLASH_MODEL
      const targets = action.uid === undefined
        ? doc.accounts
        : doc.accounts.filter(account => account.uid === action.uid)
      if (action.uid !== undefined && targets.length === 0) {
        throw new Error(`account not in the ${action.region} pool`)
      }
      await Promise.all(targets.map(async account => {
        try {
          const credential = await usableCredential(pool, account, deps.client)
          await probeAccount(state, deps.client, credential, model)
        } catch {
          // Leave the previous verdict in place; the row shows what we knew.
        }
      }))
      break
    }
  }

  return await workBuddyAccountsView(deps, state)
}

export function workBuddyAccountHandler(
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState = createAccountRouteState(),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!trusted(req)) {
      json(res, 403, { ok: false, error: 'request-not-trusted' })
      return
    }
    try {
      if (req.method === 'GET') {
        json(res, 200, await workBuddyAccountsView(deps, state))
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const action = parseAccountAction(await readJson(req))
      json(res, 200, await applyAction(deps, state, action))
    } catch (error: unknown) {
      json(res, 400, { ok: false, error: safeMessage(error) })
    }
  }
}

/** Mount the same-origin account routes; safe on both Web and desktop hosts. */
export function registerWorkBuddyDualAccountRoutes(ctx: Context, deps: WorkBuddyDualAccountRouteOptions): void {
  const state = createAccountRouteState()
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_DUAL_ACCOUNTS_PATH,
      handler: workBuddyAccountHandler(deps, state),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-dual: account routes')
}
