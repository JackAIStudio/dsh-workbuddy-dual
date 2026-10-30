/** Wire vocabulary shared by the Host account routes and the settings card. */

import type { WorkBuddyProbeVerdict, WorkBuddyRegion } from './types.ts'

export const WORKBUDDY_DUAL_ACCOUNTS_PATH = '/plugins/dsh-workbuddy-dual/accounts'

/**
 * The model whose availability decides which account is worth using.
 * It is the cheap flash tier, not the flagship: an account with thousands of
 * credits is useless when this one is rate limited.
 */
export const WORKBUDDY_FLASH_MODEL = 'deepseek-v4.1-flash'

/** Whether one account can run the flash model right now. */
export interface WorkBuddyWebProbe {
  verdict: WorkBuddyProbeVerdict
  /** Model the verdict belongs to. */
  model: string
  /** Epoch ms when a rate limit lifts. */
  resetsAtMs?: number | undefined
  checkedAt: number
  detail?: string | undefined
}

/** One row in the account list. */
export interface WorkBuddyWebAccount {
  uid: string
  /** Masked identifier, e.g. `173****0329`; never the full uid. */
  displayName: string
  nickname?: string | undefined
  label?: string | undefined
  /** True for the account the plugin currently uses. */
  active: boolean
  /** True for the entry that is not in the pool (desktop sign-in / cache). */
  fallback: boolean
  expiresAtMs?: number | undefined
  credits?: number | undefined
  creditsAt?: number | undefined
  probe?: WorkBuddyWebProbe | undefined
}

/** One region's account list plus the state of its fallback credential. */
export interface WorkBuddyWebRegionAccounts {
  region: WorkBuddyRegion
  /** The sign-in the plugin would use when no pool entry is selected. */
  fallbackSignedIn: boolean
  fallbackName?: string | undefined
  fallbackSource?: 'desktop' | 'dsh' | 'pool' | undefined
  /** Credits of the fallback sign-in, when it could be read. */
  fallbackCredits?: number | undefined
  /** Flash verdict for the fallback sign-in, when it has been checked. */
  fallbackProbe?: WorkBuddyWebProbe | undefined
  /** True when the plugin ignores the pool and uses the fallback credential. */
  usingFallback: boolean
  accounts: readonly WorkBuddyWebAccount[]
  /** Model whose availability the rows report. */
  probeModel: string
  /**
   * True while this lane is still checking balances or probing upstream.
   *
   * The route answers from cache first and refreshes in the background, so the
   * panel paints instantly and fills in verdicts as they arrive instead of
   * holding the whole settings dialog until every account answered.
   */
  refreshing: boolean
}

export interface WorkBuddyWebAccounts {
  cn: WorkBuddyWebRegionAccounts
  global: WorkBuddyWebRegionAccounts
  /** Whether the router may switch accounts without being asked. */
  autoRoute: boolean
  /** The order accounts would be tried in for the flash model, right now. */
  routing: WorkBuddyWebRouting
}

/** One account in the router's current order. */
export interface WorkBuddyWebRouteEntry {
  region: WorkBuddyRegion
  uid: string
  displayName: string
  /** When this account becomes usable again, if it is cooling down. */
  cooldownUntilMs?: number | undefined
  /** Short reason it is out of rotation. */
  blocked?: string | undefined
}

export interface WorkBuddyWebRouting {
  /** Model the order was computed for. */
  model: string
  /** Usable accounts, in the order the next request would try them. */
  order: readonly WorkBuddyWebRouteEntry[]
  /** Accounts held back by a cooldown, soonest recovery first. */
  blocked: readonly WorkBuddyWebRouteEntry[]
  /** Epoch ms when the earliest blocked account frees up. */
  nextRecoveryMs?: number | undefined
}

/** POST bodies accepted by the account route. */
export type WorkBuddyAccountAction =
  | { action: 'select'; region: WorkBuddyRegion; uid: string | null }
  | { action: 'add'; region: WorkBuddyRegion; path?: string | undefined }
  | { action: 'remove'; region: WorkBuddyRegion; uid: string }
  | { action: 'relabel'; region: WorkBuddyRegion; uid: string; label: string }
  | { action: 'probe'; region: WorkBuddyRegion; uid?: string | undefined; model?: string | undefined }
  | { action: 'autoroute'; enabled: boolean }
