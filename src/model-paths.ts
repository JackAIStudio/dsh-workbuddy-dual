/** Wire vocabulary shared by the Host model routes and the browser card. */

export const WORKBUDDY_DUAL_MODELS_PATH = '/plugins/dsh-workbuddy-dual/models'

export type WorkBuddyLaneMode = 'all' | 'selected'

/** Stored per-lane preference. `all` ignores `models`; `selected` uses them. */
export interface WorkBuddyLanePreference {
  enabled: boolean
  mode: WorkBuddyLaneMode
  models: readonly string[]
}

/** Versioned on-disk shape. */
export interface WorkBuddyStoredSelection {
  version: 1
  cn: WorkBuddyLanePreference
  global: WorkBuddyLanePreference
  updatedAt: number
}

/** One selectable model row in the settings page. */
export interface WorkBuddyWebModelOption {
  id: string
  name: string
  contextWindow: number
  supportsImages: boolean
  free?: boolean | undefined
  credits?: string | undefined
  badges?: readonly string[] | undefined
  selected: boolean
}

/** One lane as the settings page sees it. */
export interface WorkBuddyWebLaneModels {
  /** Whether the account for this lane is signed in. */
  signedIn: boolean
  enabled: boolean
  mode: WorkBuddyLaneMode
  live: boolean
  total: number
  selectedCount: number
  models: readonly WorkBuddyWebModelOption[]
}

/** Both lanes' catalogs plus their current preference. */
export interface WorkBuddyDualWebModels {
  cn: WorkBuddyWebLaneModels
  global: WorkBuddyWebLaneModels
}

/** Partial write payload; omitted lanes keep their stored preference. */
export interface WorkBuddyDualWebModelsUpdate {
  cn?: Partial<WorkBuddyLanePreference> | undefined
  global?: Partial<WorkBuddyLanePreference> | undefined
}
