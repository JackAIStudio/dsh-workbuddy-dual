/**
 * Which sign-in pays for the next request.
 *
 * The rule the user asked for is short: an account that can run the selected
 * model right now, with credits left, CN before Global. Everything else here is
 * what that rule needs in practice — a cooldown that outlives the process, a
 * session that stays on one account, and a way to skip the account that just
 * answered 6004.
 *
 * Ordering, first match wins:
 *
 *   1. CN accounts that are not cooling down, best (most credits, least
 *      recently used) first;
 *   2. Global accounts under the same rule;
 *   3. within that order, the account this session already holds goes first.
 *
 * Sticking to one account is deliberately a *within tier* tiebreak, not an
 * absolute one. CN credits come back with a daily check-in; Global credits are
 * spent once. A conversation that had to start on Global while CN was blocked
 * should return to CN as soon as CN frees up, even though that costs a prompt
 * cache miss — it spends the credit the user can replenish.
 *
 * Accounts already cooling down for this exact model are left out. The caller
 * gets the whole ordered list, not just the winner, because the shim retries on
 * the next candidate when the first one is rate limited mid-flight.
 */

import type { WorkBuddyDualCredentialStore } from './auth.ts'
import type { WorkBuddyPoolAccount } from './accounts.ts'
import { toCredential } from './accounts.ts'
import type { WorkBuddyHealthStore } from './health.ts'
import type { WorkBuddyCredential, WorkBuddyRegion } from './types.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

/** Regions in the order the router tries them. */
export const REGION_ORDER: readonly WorkBuddyRegion[] = ['cn', 'global']

const REFRESH_MARGIN_MS = 120_000

export interface WorkBuddyRouteCandidate {
  region: WorkBuddyRegion
  uid: string
  credential: WorkBuddyCredential
  /** `fallback` is the WorkBuddy app's own sign-in rather than a pool entry. */
  source: 'pool' | 'fallback'
  label: string
  credits?: number | undefined
}

export interface WorkBuddyRouteRequest {
  model: string
  /** Stable per conversation; the chosen account sticks to it. */
  sessionKey?: string | undefined
  /** Accounts that already failed this request and must not be retried. */
  exclude?: ReadonlySet<string> | undefined
  /** Restrict to one region (`model` only exists there, or the user pinned it). */
  region?: WorkBuddyRegion | undefined
  /**
   * Renew a token that is about to expire.
   *
   * The request path wants this, because a stale token is a failed turn. The
   * settings panel does not: it polls the account view every second or so, and
   * a refresh there would make the panel wait on the network for a verdict it
   * is only describing.
   */
  refreshTokens?: boolean | undefined
}

export interface WorkBuddyRouterOptions {
  store: WorkBuddyDualCredentialStore
  client: WorkBuddyUpstreamClient
  health: WorkBuddyHealthStore
  /** Last known credit balance per `region/uid`; the panel keeps these warm. */
  credits?: ((region: WorkBuddyRegion, uid: string) => number | undefined) | undefined
  /**
   * Whether this lane's catalog offers the model at all.
   *
   * Crossing lanes is only useful for models both gateways serve — Flash is on
   * both. A CN-only model (Kimi) has no Global equivalent, and sending it there
   * would trade a rate limit for an unknown model error.
   */
  hasModel?: ((region: WorkBuddyRegion, model: string) => boolean) | undefined
  now?: (() => number) | undefined
}

export type CandidateKey = string

export function candidateKey(region: WorkBuddyRegion, uid: string): CandidateKey {
  return `${region}/${uid}`
}

/**
 * A candidate's sort weight. Higher wins.
 *
 * Credits decide first, because the user's own rule is "has credits left".
 * Tie-break on least-recently-used rather than most-recently-used: spreading
 * load is the only thing that postpones the next 6004, and a session that keeps
 * hammering one account reaches it sooner.
 */
function preference(a: WorkBuddyRouteCandidate, lastUsed: Map<string, number>): number[] {
  // An unknown balance is not an empty one. A freshly imported account would
  // otherwise rank below an exhausted one until its first billing read lands.
  // Give it priority; the first 6004 corrects it within one request.
  const credits = a.credits ?? Number.MAX_SAFE_INTEGER
  const used = lastUsed.get(candidateKey(a.region, a.uid)) ?? 0
  return [credits, -used]
}

function compare(a: WorkBuddyRouteCandidate, b: WorkBuddyRouteCandidate, lastUsed: Map<string, number>): number {
  const pa = preference(a, lastUsed)
  const pb = preference(b, lastUsed)
  for (let i = 0; i < pa.length; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The account this session already used, held across turns of one conversation. */
export class WorkBuddySessionAffinity {
  private readonly chosen = new Map<string, CandidateKey>()
  private readonly lastUsed = new Map<CandidateKey, number>()

  get(sessionKey: string | undefined): CandidateKey | undefined {
    if (sessionKey === undefined) return undefined
    return this.chosen.get(sessionKey)
  }

  remember(sessionKey: string | undefined, region: WorkBuddyRegion, uid: string): void {
    if (sessionKey === undefined || sessionKey === '') return
    this.chosen.set(sessionKey, candidateKey(region, uid))
    this.lastUsed.set(candidateKey(region, uid), Date.now())
    // A long-lived harness runs many conversations; keep the map from growing
    // without bound by dropping the oldest half when it gets large.
    if (this.chosen.size > 512) {
      const keys = [...this.chosen.keys()].slice(0, 256)
      for (const key of keys) this.chosen.delete(key)
    }
  }

  forget(sessionKey: string | undefined): void {
    if (sessionKey !== undefined) this.chosen.delete(sessionKey)
  }

  markUsed(region: WorkBuddyRegion, uid: string): void {
    this.lastUsed.set(candidateKey(region, uid), Date.now())
  }

  lastUsedMap(): Map<CandidateKey, number> {
    return this.lastUsed
  }
}

async function usableCredential(
  options: WorkBuddyRouterOptions,
  account: WorkBuddyPoolAccount,
): Promise<WorkBuddyCredential> {
  const credential = toCredential(account)
  if (credential.expiresAtMs <= 0) return credential
  if (Date.now() + REFRESH_MARGIN_MS < credential.expiresAtMs) return credential
  if (credential.refreshToken === '') return credential
  try {
    const outcome = await options.client.refreshToken(credential)
    const refreshed: WorkBuddyCredential = {
      ...credential,
      accessToken: outcome.accessToken,
      ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
      expiresAtMs: outcome.expiresInSec !== undefined ? Date.now() + outcome.expiresInSec * 1000 : credential.expiresAtMs,
      ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
    }
    await options.store.poolFor(account.region).update(account.uid, refreshed)
    return refreshed
  } catch {
    // Keep the old token: the gateway decides, not our clock.
    return credential
  }
}

/** Every account in one lane, with the pool's own selection marked. */
async function laneCandidates(
  options: WorkBuddyRouterOptions,
  region: WorkBuddyRegion,
  refreshTokens: boolean,
): Promise<WorkBuddyRouteCandidate[]> {
  const pool = options.store.poolFor(region)
  const doc = await pool.get()
  const out: WorkBuddyRouteCandidate[] = []
  for (const account of doc.accounts) {
    const credential = refreshTokens
      ? await usableCredential(options, account)
      : toCredential(account)
    out.push({
      region,
      uid: account.uid,
      credential,
      source: 'pool',
      label: account.label ?? account.nickname ?? account.uid,
      credits: options.credits?.(region, account.uid),
    })
  }
  const fallback = await options.store.storeFor(region).fallback()
  if (fallback !== undefined && !out.some(candidate => candidate.uid === fallback.uid)) {
    out.push({
      region,
      uid: fallback.uid,
      credential: fallback,
      source: 'fallback',
      label: fallback.nickname ?? fallback.uid,
      credits: options.credits?.(region, fallback.uid),
    })
  }
  return out
}

/**
 * Ordered candidates for one request: [this session's account, then the rest].
 *
 * Blocked accounts are dropped only from the `available` list; the plan still
 * records them so the caller can say when the account that was blocked is free
 * again instead of reporting a bare "no account".
 */
export async function planRoute(
  options: WorkBuddyRouterOptions,
  affinity: WorkBuddySessionAffinity,
  request: WorkBuddyRouteRequest,
): Promise<WorkBuddyRouteCandidate[]> {
  const regions = request.region === undefined ? REGION_ORDER : [request.region]
  const pool: WorkBuddyRouteCandidate[] = []
  for (const region of regions) {
    if (options.hasModel !== undefined && !options.hasModel(region, request.model)) continue
    pool.push(...await laneCandidates(options, region, request.refreshTokens !== false))
  }

  const available: WorkBuddyRouteCandidate[] = []
  for (const candidate of pool) {
    if (request.exclude?.has(candidateKey(candidate.region, candidate.uid)) === true) continue
    if (await options.health.isBlocked(candidate.region, candidate.uid, request.model)) continue
    available.push(candidate)
  }

  const lastUsed = affinity.lastUsedMap()
  const ordered = [...available].sort((a, b) => {
    const regionDiff = regions.indexOf(a.region) - regions.indexOf(b.region)
    if (regionDiff !== 0) return regionDiff
    return compare(a, b, lastUsed)
  })

  const sticky = affinity.get(request.sessionKey)
  if (sticky === undefined) return ordered
  const pinned = ordered.find(candidate => candidateKey(candidate.region, candidate.uid) === sticky)
  if (pinned === undefined) return ordered
  // Only lift the session's account inside its own tier, so a conversation can
  // neither migrate to Global while CN is healthy nor drift between two CN
  // accounts on every turn.
  const topRegion = ordered[0]?.region
  if (pinned.region !== topRegion) return ordered
  return [pinned, ...ordered.filter(candidate => candidate !== pinned)]
}

/** Earliest moment any blocked lane account becomes usable, for the UI/message. */
export async function nextRecoveryMs(
  options: WorkBuddyRouterOptions,
  model: string,
  region?: WorkBuddyRegion | undefined,
): Promise<number | undefined> {
  const regions = region === undefined ? REGION_ORDER : [region]
  let earliest: number | undefined
  const snapshot = await options.health.snapshot()
  for (const key of Object.keys(snapshot)) {
    if (!key.endsWith(`/${model}`)) continue
    const matchesRegion = regions.some(candidate => key.startsWith(`${candidate}/`))
    if (!matchesRegion) continue
    const until = snapshot[key]?.cooldownUntilMs
    if (until === undefined) continue
    if (earliest === undefined || until < earliest) earliest = until
  }
  return earliest
}

export interface WorkBuddyRouteOverviewEntry {
  region: WorkBuddyRegion
  uid: string
  displayName: string
  cooldownUntilMs?: number | undefined
  blocked?: string | undefined
}

/**
 * The order a flash request would try accounts in, plus who is held back.
 *
 * The panel shows this so "automatic" is legible before it fires: the user can
 * see which account is next and why the best one is skipped, instead of
 * discovering a switch after the fact.
 */
export async function routeOverview(
  options: WorkBuddyRouterOptions,
  model: string,
  sessionKey?: string | undefined,
): Promise<{ order: WorkBuddyRouteOverviewEntry[]; blocked: WorkBuddyRouteOverviewEntry[]; nextRecoveryMs?: number }> {
  const all: WorkBuddyRouteCandidate[] = []
  for (const region of REGION_ORDER) {
    if (options.hasModel !== undefined && !options.hasModel(region, model)) continue
    // Read-only: the overview is served to a polling panel.
    all.push(...await laneCandidates(options, region, false))
  }

  const snapshot = await options.health.snapshot()
  const blocked: WorkBuddyRouteOverviewEntry[] = []
  for (const candidate of all) {
    const entry = snapshot[healthKeyOf(candidate.region, candidate.uid, model)]
    if (entry === undefined || entry.cooldownUntilMs <= Date.now()) continue
    blocked.push({
      region: candidate.region,
      uid: candidate.uid,
      displayName: candidate.label,
      cooldownUntilMs: entry.cooldownUntilMs,
      blocked: entry.verdict,
    })
  }
  blocked.sort((a, b) => (a.cooldownUntilMs ?? 0) - (b.cooldownUntilMs ?? 0))

  const affinity = new WorkBuddySessionAffinity()
  const ordered = await planRoute(options, affinity, { model, sessionKey, refreshTokens: false })
  const order: WorkBuddyRouteOverviewEntry[] = ordered.map(candidate => ({
    region: candidate.region,
    uid: candidate.uid,
    displayName: candidate.label,
  }))

  const earliest = blocked[0]?.cooldownUntilMs
  return {
    order,
    blocked,
    ...(earliest === undefined ? {} : { nextRecoveryMs: earliest }),
  }
}

/** Health keys carry the region and model; kept local to avoid a cycle. */
function healthKeyOf(region: WorkBuddyRegion, uid: string, model: string): string {
  return `${region}/${uid}/${model}`
}
