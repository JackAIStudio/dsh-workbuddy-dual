/**
 * Last known balance per account, for routing and for the panel.
 *
 * Routing needs a number synchronously — it cannot await seven billing calls
 * while a conversation is waiting — so balances are refreshed on a timer and
 * every decision reads whatever is cached. An unknown balance is not treated as
 * zero: a freshly imported account would otherwise rank below an exhausted one
 * until its first refresh.
 */

import type { WorkBuddyDualCredentialStore } from './auth.ts'
import { toCredential } from './accounts.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './types.ts'

/** Balances move slowly compared with a chat turn. */
const CREDIT_TTL_MS = 5 * 60_000

/** One billing call per account at a time; more just races the gateway. */
const REFRESH_CONCURRENCY = 3

function key(region: WorkBuddyRegion, uid: string): string {
  return `${region}/${uid}`
}

interface Entry {
  total: number
  at: number
}

export class WorkBuddyCreditsCache {
  private readonly entries = new Map<string, Entry>()
  private refreshing: Promise<void> | undefined

  /** Balance if it was read recently, else whatever was read last. */
  get(region: WorkBuddyRegion, uid: string): number | undefined {
    return this.entries.get(key(region, uid))?.total
  }

  set(region: WorkBuddyRegion, uid: string, total: number): void {
    this.entries.set(key(region, uid), { total, at: Date.now() })
  }

  isFresh(region: WorkBuddyRegion, uid: string): boolean {
    const entry = this.entries.get(key(region, uid))
    return entry !== undefined && Date.now() - entry.at < CREDIT_TTL_MS
  }

  forget(region: WorkBuddyRegion, uid: string): void {
    this.entries.delete(key(region, uid))
  }

  /**
   * Refresh balances that are missing or stale.
   *
   * Never awaited by a request: a slow billing endpoint must not add a round
   * trip to someone's chat turn. Failures leave the previous number in place.
   */
  refresh(store: WorkBuddyDualCredentialStore, client: WorkBuddyUpstreamClient): Promise<void> {
    this.refreshing ??= this.run(store, client).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async run(store: WorkBuddyDualCredentialStore, client: WorkBuddyUpstreamClient): Promise<void> {
    const targets: Array<{ region: WorkBuddyRegion; uid: string; credential: ReturnType<typeof toCredential> }> = []
    for (const region of ['cn', 'global'] as const) {
      const doc = await store.poolFor(region).get().catch(() => undefined)
      for (const account of doc?.accounts ?? []) {
        if (this.isFresh(region, account.uid)) continue
        targets.push({ region, uid: account.uid, credential: toCredential(account) })
      }
    }

    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= targets.length) return
        const target = targets[index]
        if (target === undefined) return
        try {
          const credits = await client.fetchCredits(target.credential)
          this.set(target.region, target.uid, credits.totalBalance)
        } catch {
          // Keep the old number; the panel shows what it last knew too.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, targets.length) }, worker))
  }
}
