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
  source: 'desktop' | 'dsh'
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
      source: 'desktop' | 'dsh'
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
