/**
 * Per-account, per-model availability memory for the automatic router.
 *
 * A rate limit belongs to one model on one account, not to the account as a
 * whole: an account that cannot run Flash this half hour may still answer with
 * GPT. Every verdict is therefore keyed by `region/uid/model`.
 *
 * The document has to outlive a restart. Without it, relaunching the host
 * forgets every 6004 and hands the first request straight back to the account
 * that is still cooling down, which is exactly the pause the router exists to
 * remove. Writes are cheap but not free (a request may succeed thousands of
 * times an hour), so a successful call only touches the file when it actually
 * clears a stored verdict.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyProbeVerdict, WorkBuddyRegion } from './types.ts'

export const WORKBUDDY_HEALTH_FILENAME = '.workbuddy-dual-health.json'

/** Default cooldowns when the gateway does not state its own reset moment. */
const RATE_LIMIT_COOLDOWN_MS = 60_000
const CREDIT_COOLDOWN_MS = 10 * 60_000
const AUTH_COOLDOWN_MS = 30 * 60_000
/**
 * A banned account does not come back on a timer.
 *
 * `11140 request illegal` is a gate on the account itself; retrying it every
 * half hour spends a request to learn the same thing. Keep it out of rotation
 * for a day, long enough that only a deliberate re-check or a new sign-in
 * brings it back.
 */
const BANNED_COOLDOWN_MS = 24 * 60 * 60_000

export interface WorkBuddyHealthEntry {
  verdict: WorkBuddyProbeVerdict
  /** Epoch ms after which the account may be tried again. */
  cooldownUntilMs: number
  checkedAt: number
  detail?: string | undefined
}

interface HealthDocument {
  version: 1
  entries: Record<string, WorkBuddyHealthEntry>
  updatedAt: number
}

export function healthKey(region: WorkBuddyRegion, uid: string, model: string): string {
  return `${region}/${uid}/${model}`
}

/** How long a verdict keeps an account out of rotation. */
export function cooldownFor(
  verdict: WorkBuddyProbeVerdict,
  resetsAtMs: number | undefined,
  now = Date.now(),
): number {
  switch (verdict) {
    case 'rate-limited': {
      // The gateway's own reset moment beats any guess. A value already in the
      // past (or absurdly far out) falls back to the default so one bogus
      // timestamp cannot park an account for a week.
      if (resetsAtMs !== undefined && resetsAtMs > now && resetsAtMs - now <= 24 * 60 * 60_000) {
        return resetsAtMs
      }
      return now + RATE_LIMIT_COOLDOWN_MS
    }
    case 'no-credit': return now + CREDIT_COOLDOWN_MS
    case 'auth': return now + AUTH_COOLDOWN_MS
    case 'banned': return now + BANNED_COOLDOWN_MS
    case 'error': return now + RATE_LIMIT_COOLDOWN_MS
    case 'ok': return now
  }
}

export interface WorkBuddyHealthStoreOptions {
  path?: string | undefined
  now?: (() => number) | undefined
}

/** Reads and writes the availability document with atomic replacement. */
export class WorkBuddyHealthStore {
  private readonly path: string
  private readonly now: () => number
  private entries: Record<string, WorkBuddyHealthEntry> = {}
  private loaded = false
  private loading: Promise<void> | undefined
  /** Serializes writes so two fast verdicts cannot interleave a whole file. */
  private writing: Promise<void> = Promise.resolve()

  constructor(options: WorkBuddyHealthStoreOptions = {}) {
    this.path = options.path ?? join(resolveDshHome(), WORKBUDDY_HEALTH_FILENAME)
    this.now = options.now ?? (() => Date.now())
  }

  /** Absolute document path; diagnostics only. */
  get documentPath(): string {
    return this.path
  }

  /** Whether this account is still cooling down for this model. */
  async isBlocked(region: WorkBuddyRegion, uid: string, model: string): Promise<boolean> {
    const entry = await this.get(region, uid, model)
    if (entry === undefined) return false
    return entry.cooldownUntilMs > this.now()
  }

  async get(region: WorkBuddyRegion, uid: string, model: string): Promise<WorkBuddyHealthEntry | undefined> {
    await this.load()
    return this.entries[healthKey(region, uid, model)]
  }

  /** Every verdict that still applies, for the settings panel. */
  async snapshot(): Promise<Record<string, WorkBuddyHealthEntry>> {
    await this.load()
    const now = this.now()
    const live: Record<string, WorkBuddyHealthEntry> = {}
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry.cooldownUntilMs > now) live[key] = entry
    }
    return live
  }

  /**
   * Remember what the gateway just said about this account and model.
   *
   * `ok` clears a stored cooldown, which is how an account rejoins rotation
   * after a successful retry instead of waiting for its timer to run out.
   */
  async record(
    region: WorkBuddyRegion,
    uid: string,
    model: string,
    verdict: WorkBuddyProbeVerdict,
    extra: { resetsAtMs?: number | undefined; detail?: string | undefined } = {},
  ): Promise<void> {
    await this.load()
    const key = healthKey(region, uid, model)
    const now = this.now()
    if (verdict === 'ok') {
      if (this.entries[key] === undefined) return
      delete this.entries[key]
      await this.flush()
      return
    }
    const previous = this.entries[key]
    const cooldownUntilMs = cooldownFor(verdict, extra.resetsAtMs, now)
    // Never shorten an existing block: a second 429 that reports no reset time
    // must not turn a two-hour limit into a one-minute one.
    const merged = previous === undefined ? cooldownUntilMs : Math.max(previous.cooldownUntilMs, cooldownUntilMs)
    this.entries[key] = {
      verdict,
      cooldownUntilMs: merged,
      checkedAt: now,
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    }
    await this.flush()
  }

  /** Forget one account's verdicts, e.g. after a manual re-check or sign-in. */
  async clear(region: WorkBuddyRegion, uid?: string): Promise<void> {
    await this.load()
    const prefix = uid === undefined ? `${region}/` : `${region}/${uid}/`
    let changed = false
    for (const key of Object.keys(this.entries)) {
      if (!key.startsWith(prefix)) continue
      delete this.entries[key]
      changed = true
    }
    if (changed) await this.flush()
  }

  private async flush(): Promise<void> {
    const doc: HealthDocument = { version: 1, entries: this.entries, updatedAt: this.now() }
    const payload = `${JSON.stringify(doc, null, 2)}\n`
    this.writing = this.writing.then(async () => {
      try {
        await withFileLock(this.path, async () => {
          await writeFileAtomic(this.path, payload, { mode: 0o600, dirMode: 0o700 })
        })
      } catch {
        // A read-only home must not break routing; the in-memory verdict still
        // applies for this process.
      }
    })
    await this.writing
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= (async () => {
      try {
        const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'))
        this.entries = normalizeEntries(raw, this.now())
      } catch {
        this.entries = {}
      }
      this.loaded = true
    })()
    await this.loading
  }
}

/** Keep only entries this document could have written, dropping expired ones. */
export function normalizeEntries(raw: unknown, now: number): Record<string, WorkBuddyHealthEntry> {
  if (typeof raw !== 'object' || raw === null) return {}
  const doc = raw as Record<string, unknown>
  const rawEntries = typeof doc['entries'] === 'object' && doc['entries'] !== null
    ? doc['entries'] as Record<string, unknown>
    : {}
  const out: Record<string, WorkBuddyHealthEntry> = {}
  for (const [key, value] of Object.entries(rawEntries)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const verdict = entry['verdict']
    if (verdict !== 'rate-limited' && verdict !== 'banned' && verdict !== 'no-credit' && verdict !== 'auth' && verdict !== 'error') continue
    const cooldownUntilMs = entry['cooldownUntilMs']
    if (typeof cooldownUntilMs !== 'number' || !Number.isFinite(cooldownUntilMs)) continue
    if (cooldownUntilMs <= now) continue
    const checkedAt = typeof entry['checkedAt'] === 'number' ? entry['checkedAt'] : now
    const detail = typeof entry['detail'] === 'string' ? entry['detail'] : undefined
    out[key] = {
      verdict,
      cooldownUntilMs,
      checkedAt,
      ...(detail === undefined ? {} : { detail }),
    }
  }
  return out
}
