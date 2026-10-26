export type WorkBuddyRegion = 'cn' | 'global'

export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number | undefined
  domain: string
  uid: string
  enterpriseId?: string | undefined
  nickname?: string | undefined
  /**
   * Where this credential came from. `pool` means it is one entry of the
   * plugin's own account list, which the user picks from in the settings card.
   */
  source: 'desktop' | 'dsh' | 'pool'
  region: WorkBuddyRegion
}

export type WorkBuddyAuthStatus =
  | { state: 'signed-out'; region: WorkBuddyRegion }
  | {
      state: 'signed-in'
      region: WorkBuddyRegion
      expiresAtMs: number
      refreshExpiresAtMs?: number | undefined
      nickname?: string | undefined
      domain?: string | undefined
      source: 'desktop' | 'dsh' | 'pool'
    }

export interface WorkBuddyCreditAccount {
  name: string
  balance: number
  total: number
}

export interface WorkBuddyCredits {
  accounts: readonly WorkBuddyCreditAccount[]
  totalBalance: number
}

export interface WorkBuddyDualCredits {
  cn?: WorkBuddyCredits | undefined
  global?: WorkBuddyCredits | undefined
}

export interface WorkBuddyModelReasoning {
  supports: boolean
  onlyReasoning?: boolean | undefined
  supportedEfforts?: readonly string[] | undefined
  defaultEffort?: string | undefined
  canDisableThinking?: boolean | undefined
}

export interface WorkBuddyModelBilling {
  credits?: string | undefined
  badges?: readonly string[] | undefined
  free: boolean
}

export interface WorkBuddyModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  reasoning?: WorkBuddyModelReasoning | undefined
  billing?: WorkBuddyModelBilling | undefined
  region: WorkBuddyRegion
}

export interface WorkBuddyDualModelCatalog {
  cn: readonly WorkBuddyModelInfo[]
  global: readonly WorkBuddyModelInfo[]
}

/**
 * Result of asking the upstream whether one model can run *right now* on one
 * account. `ok` means a real (one-token) request was accepted; the other
 * verdicts are the exact reasons it was not.
 */
export type WorkBuddyProbeVerdict = 'ok' | 'rate-limited' | 'banned' | 'no-credit' | 'auth' | 'error'

export interface WorkBuddyProbeResult {
  verdict: WorkBuddyProbeVerdict
  /** Upstream business code when the gateway supplied one (6004, 11140, …). */
  code?: string | undefined
  /** When a rate limit lifts, in epoch milliseconds; parsed from the message. */
  resetsAtMs?: number | undefined
  /** Short, token-free explanation for the panel. */
  detail?: string | undefined
  /** How long the probe took. */
  elapsedMs: number
  checkedAt: number
}
