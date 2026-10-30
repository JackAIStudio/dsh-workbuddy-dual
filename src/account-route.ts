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
  type WorkBuddyWebRouteEntry,
  type WorkBuddyWebRouting,
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
  /** The automatic-switching preference and the route it produces. */
  router?: {
    settings: () => boolean
    setAutoRoute: (enabled: boolean) => Promise<boolean>
    /**
     * Persist a probe verdict for routing.
     *
     * The panel's probe is a real one-token request, so its answer is exactly
     * what the router needs. Without this the panel could show "limited until
     * 07:28" while the router still handed the next turn to that same account
     * and only learned about the limit by failing.
     */
    record: (region: WorkBuddyRegion, uid: string, model: string, probe: WorkBuddyWebProbe) => Promise<void>
    /** Accounts in the order the next flash request would try them. */
    order: () => Promise<{
      order: readonly WorkBuddyWebRouteEntry[]
      blocked: readonly WorkBuddyWebRouteEntry[]
      nextRecoveryMs?: number | undefined
    }>
  } | undefined
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
  /** Called with every fresh probe verdict, so the router sees it too. */
  onProbe?: ((region: WorkBuddyRegion, uid: string, model: string, probe: WorkBuddyWebProbe) => void | Promise<void>) | undefined
  /** One in-flight background refresh per lane, so polling cannot stack them. */
  refreshing: Map<WorkBuddyRegion, Promise<void>>
  /** Lanes asked to refresh again as soon as the current pass finishes. */
  queued: Set<WorkBuddyRegion>
  /** Epoch ms of the last failure per cache key, so a dead token backs off. */
  failures: Map<string, number>
}

export function createAccountRouteState(): WorkBuddyAccountRouteState {
  return {
    credits: new Map(),
    probes: new Map(),
    refreshing: new Map(),
    queued: new Set(),
    failures: new Map(),
  }
}

function cacheKey(region: WorkBuddyRegion, uid: string, model?: string | undefined): string {
  return `${region}/${uid}${model === undefined ? '' : `/${model}`}`
}

/**
 * How long a failed balance or probe is left alone.
 *
 * Without this, an expired token makes every poll retry forever: the failure
 * never lands in the cache, so each refresh starts a fresh request and the
 * panel's "still checking" state never ends.
 */
const FAILURE_BACKOFF_MS = 20_000

function failedRecently(state: WorkBuddyAccountRouteState, key: string): boolean {
  const at = state.failures.get(key)
  if (at === undefined) return false
  if (Date.now() - at < FAILURE_BACKOFF_MS) return true
  state.failures.delete(key)
  return false
}

/** What the panel can show right now, without touching the network. */
function cachedCredits(
  state: WorkBuddyAccountRouteState,
  credential: WorkBuddyCredential,
): number | undefined {
  return state.credits.get(cacheKey(credential.region, credential.uid))?.total
}

/** Whether this sign-in still needs a network round trip. */
function needsWork(state: WorkBuddyAccountRouteState, credential: WorkBuddyCredential): boolean {
  const creditKey = cacheKey(credential.region, credential.uid)
  const cached = state.credits.get(creditKey)
  const creditsStale = cached === undefined || Date.now() - cached.at >= CREDIT_CACHE_MS
  if (creditsStale && !failedRecently(state, creditKey)) return true
  const probeKey = cacheKey(credential.region, credential.uid, WORKBUDDY_FLASH_MODEL)
  const probeStale = probeFor(state, credential, WORKBUDDY_FLASH_MODEL) === undefined
  return probeStale && !failedRecently(state, probeKey)
}

/**
 * Probe and credit requests are cheap but not free, and the panel used to fire
 * one pair per account at once. Three at a time keeps a five-account pool from
 * turning into a burst the gateways rate limit.
 */
const REFRESH_CONCURRENCY = 3

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function creditsFor(
  state: WorkBuddyAccountRouteState,
  client: WorkBuddyUpstreamClient,
  credential: WorkBuddyCredential,
): Promise<number | undefined> {
  const key = cacheKey(credential.region, credential.uid)
  const cached = state.credits.get(key)
  if (cached !== undefined && Date.now() - cached.at < CREDIT_CACHE_MS) return cached.total
  if (failedRecently(state, key)) return cached?.total
  try {
    const credits = await client.fetchCredits(credential)
    state.credits.set(key, { total: credits.totalBalance, at: Date.now() })
    state.failures.delete(key)
    return credits.totalBalance
  } catch {
    state.failures.set(key, Date.now())
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

/**
 * The verdict a row should show right now.
 *
 * This is the last answer even if it has aged out of the cache window, so rows
 * keep their verdict while a refresh runs instead of blanking on every poll.
 * The one exception is an expired rate limit: once the upstream's own reset
 * time has passed, "limited until 18:47" is no longer true, and repeating it
 * would keep a usable account looking blocked.
 */
function displayProbe(
  state: WorkBuddyAccountRouteState,
  credential: WorkBuddyCredential,
  model: string,
): WorkBuddyWebProbe | undefined {
  const cached = state.probes.get(cacheKey(credential.region, credential.uid, model))
  if (cached === undefined) return undefined
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
  const key = cacheKey(credential.region, credential.uid, model)
  try {
    const result = await client.probeModel(credential, model)
    const probe: WorkBuddyWebProbe = {
      verdict: result.verdict,
      model,
      ...(result.resetsAtMs === undefined ? {} : { resetsAtMs: result.resetsAtMs }),
      checkedAt: result.checkedAt,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    }
    state.probes.set(key, { probe, at: Date.now() })
    state.failures.delete(key)
    // Feed the verdict to the router so a check the user just ran changes the
    // very next request instead of only repainting the row.
    await state.onProbe?.(credential.region, credential.uid, model, probe)
    return probe
  } catch (error: unknown) {
    state.failures.set(key, Date.now())
    throw error
  }
}

/**
 * One lane, answered from memory only.
 *
 * Reading the pool and the desktop sign-in is local file work (fast), but the
 * balances and verdicts are network round trips. Serving whatever the caches
 * hold and letting `refreshRegion` fill in the rest is what turns a settings
 * dialog that sat on "reading both accounts" for seconds into one that paints
 * immediately and fills in each row as its answer arrives.
 */
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
  const fallbackCredits = fallbackCredential === undefined
    ? undefined
    : cachedCredits(state, fallbackCredential)
  const fallbackProbe = fallbackCredential === undefined
    ? undefined
    : displayProbe(state, fallbackCredential, WORKBUDDY_FLASH_MODEL)

  const accounts = doc.accounts.map((account): WorkBuddyWebAccount => {
    const credits = state.credits.get(cacheKey(region, account.uid))?.total
    const probe = displayProbe(state, toCredential(account), WORKBUDDY_FLASH_MODEL)
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
  })

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
    // Busy means "a request is still outstanding", not "a pass is scheduled":
    // a pass that finds everything cached makes no requests, and reporting it
    // would keep the panel polling forever for nothing.
    refreshing: state.refreshing.has(region) && regionHasPendingWork(state, region, doc, fallbackCredential),
  }
}

/** Whether any sign-in in this lane still needs a network round trip. */
function regionHasPendingWork(
  state: WorkBuddyAccountRouteState,
  region: WorkBuddyRegion,
  doc: { accounts: readonly WorkBuddyPoolAccount[] },
  fallbackCredential: WorkBuddyCredential | undefined,
): boolean {
  if (fallbackCredential !== undefined && needsWork(state, fallbackCredential)) return true
  return doc.accounts.some(account => needsWork(state, toCredential(account)))
}

/**
 * Fetch the missing balances and verdicts for one lane.
 *
 * Only entries whose cache expired are requested, so re-opening the panel
 * spends nothing; a lane that is already refreshing is left alone instead of
 * stacking a second round of probes behind the first.
 */
async function refreshRegion(
  region: WorkBuddyRegion,
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
): Promise<void> {
  const pool = deps.store.poolFor(region)
  const store = deps.store.storeFor(region)
  const doc = await pool.get()
  const fallbackCredential = await store.fallback()

  const fill = async (credential: WorkBuddyCredential): Promise<void> => {
    try {
      await creditsFor(state, deps.client, credential)
      const probeKey = cacheKey(credential.region, credential.uid, WORKBUDDY_FLASH_MODEL)
      if (probeFor(state, credential, WORKBUDDY_FLASH_MODEL) === undefined && !failedRecently(state, probeKey)) {
        await probeAccount(state, deps.client, credential, WORKBUDDY_FLASH_MODEL)
      }
    } catch {
      // A single unreachable account must not blank the whole list; the row
      // keeps whatever verdict it had and the next poll tries again.
    }
  }

  const work: Array<() => Promise<void>> = []
  const seen = new Set<string>()
  if (fallbackCredential !== undefined) {
    seen.add(cacheKey(region, fallbackCredential.uid))
    if (needsWork(state, fallbackCredential)) {
      work.push(async () => {
        await fill(fallbackCredential)
      })
    }
  }
  for (const account of doc.accounts) {
    // The desktop sign-in is often imported into the pool as well. Probing it
    // twice would spend two requests for one answer, so key on the uid.
    const key = cacheKey(region, account.uid)
    if (seen.has(key)) continue
    seen.add(key)
    if (!needsWork(state, toCredential(account))) continue
    work.push(async () => {
      // A pooled token near expiry has to be renewed before it can be used.
      const credential = await usableCredential(pool, account, deps.client)
      await fill(credential)
    })
  }

  // Everything was still fresh: no requests, so the lane never looks busy.
  if (work.length === 0) return
  await mapLimit(work, REFRESH_CONCURRENCY, run => run())
}

/**
 * Start a lane's refresh unless one is already running.
 *
 * `requeue` is only for callers that changed the state (a switch, an import, a
 * removal): those need a second pass even if one is mid-flight. Polls must not
 * set it, or a panel that re-reads while waiting would queue a new pass for
 * every poll and never settle.
 */
function kickRefresh(
  region: WorkBuddyRegion,
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
  requeue = false,
): void {
  if (state.refreshing.has(region)) {
    if (requeue) state.queued.add(region)
    return
  }
  const task = refreshRegion(region, deps, state)
    .catch(() => {})
    .finally(() => {
      state.refreshing.delete(region)
      if (state.queued.delete(region)) kickRefresh(region, deps, state)
    })
  state.refreshing.set(region, task)
}

export async function workBuddyAccountsView(
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
): Promise<WorkBuddyWebAccounts> {
  const [cn, global] = await Promise.all([
    regionView('cn', deps, state),
    regionView('global', deps, state),
  ])
  const autoRoute = deps.router?.settings() ?? false
  const routing: WorkBuddyWebRouting = {
    model: WORKBUDDY_FLASH_MODEL,
    ...(await deps.router?.order().catch(() => ({ order: [], blocked: [] })) ?? { order: [], blocked: [] }),
  }
  return { cn, global, autoRoute, routing }
}

/**
 * Run both lanes' refresh and wait for it.
 *
 * The HTTP route never awaits this: it starts the refresh and answers from
 * cache. Tests and the CLI status command use it when they want the settled
 * view, and `kickRefresh` is idempotent so overlapping with a poll is safe.
 */
export async function workBuddyAccountsRefresh(
  deps: WorkBuddyDualAccountRouteOptions,
  state: WorkBuddyAccountRouteState,
): Promise<void> {
  kickRefresh('cn', deps, state)
  kickRefresh('global', deps, state)
  // A pass can queue a follow-up when the caller changed state, so drain until
  // both lanes are idle rather than awaiting one generation.
  for (let guard = 0; guard < 8; guard++) {
    const pending = [state.refreshing.get('cn'), state.refreshing.get('global')]
    if (pending.every(task => task === undefined)) return
    await Promise.all(pending.map(task => task?.catch(() => {})))
  }
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
    case 'autoroute': {
      const enabled = value['enabled']
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
      return { action: 'autoroute', enabled }
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
  if (action.action === 'autoroute') {
    await deps.router?.setAutoRoute(action.enabled)
    return await workBuddyAccountsView(deps, state)
  }

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
      // An explicit check is the one place that waits: the user asked for a
      // fresh verdict and is watching the row. Concurrent probes are capped so
      // "check all" does not fire a burst at the gateway.
      await mapLimit(targets, REFRESH_CONCURRENCY, async account => {
        try {
          const credential = await usableCredential(pool, account, deps.client)
          await probeAccount(state, deps.client, credential, model)
        } catch {
          // Leave the previous verdict in place; the row shows what we knew.
        }
      })
      break
    }
  }

  // Let the background pass fill in anything the mutation invalidated; the
  // response itself only carries what is already known. This one requeues: a
  // switch during a running pass would otherwise return a stale view.
  kickRefresh(action.region, deps, state, true)
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
        // Answer with what is already known and refresh behind the response.
        // The panel polls this route, so the verdicts land a moment later
        // instead of the dialog waiting on every gateway round trip first.
        kickRefresh('cn', deps, state)
        kickRefresh('global', deps, state)
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
  state.onProbe = async (region, uid, model, probe) => {
    await deps.router?.record(region, uid, model, probe)
  }
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
