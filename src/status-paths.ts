export const WORKBUDDY_DUAL_STATUS_PATH = '/plugins/dsh-workbuddy-dual/status'

export interface WorkBuddyWebCreditAccount {
  name: string
  balance: number
  total: number
}

export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
}

export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  free?: boolean | undefined
  badges?: readonly string[] | undefined
  credits?: string | undefined
}

export type WorkBuddyRegionWebStatus =
  | { status: 'signed-out'; region: 'cn' | 'global' }
  | {
      status: 'signed-in'
      region: 'cn' | 'global'
      nickname?: string | undefined
      domain?: string | undefined
      expiresAt?: number | undefined
      credits?: WorkBuddyWebCredits | undefined
      creditsError?: string | undefined
      models?: readonly WorkBuddyWebModelBadge[] | undefined
    }
  | { status: 'error'; region: 'cn' | 'global'; message: string }

export interface WorkBuddyDualWebStatus {
  cn: WorkBuddyRegionWebStatus
  global: WorkBuddyRegionWebStatus
}
