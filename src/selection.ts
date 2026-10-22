/**
 * User-owned model selection for the two WorkBuddy tracks.
 *
 * A lane starts in `all` mode, so upgrading the plugin never hides a model the
 * user already had. Once a lane switches to `selected`, only those ids are
 * advertised to the harness model pickers. The adapter still resolves hidden
 * ids, so a Session already using one keeps working.
 */

import type { WorkBuddyLaneMode, WorkBuddyLanePreference } from './model-paths.ts'
import type { WorkBuddyModelInfo, WorkBuddyRegion } from './types.ts'

export type WorkBuddyDualSelection = Record<WorkBuddyRegion, WorkBuddyLanePreference>

export const WORKBUDDY_LANES: readonly WorkBuddyRegion[] = ['cn', 'global']

/** The open default: every lane enabled, every catalog model advertised. */
export function defaultLanePreference(): WorkBuddyLanePreference {
  return { enabled: true, mode: 'all', models: [] }
}

/** Fresh selection for a deployment with no stored preference. */
export function defaultSelection(): WorkBuddyDualSelection {
  return { cn: defaultLanePreference(), global: defaultLanePreference() }
}

/** Normalize one lane: de-duplicated trimmed ids, `all` carries no list. */
export function normalizeLanePreference(input: unknown): WorkBuddyLanePreference {
  const raw = isRecord(input) ? input : {}
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true
  const rawModels = Array.isArray(raw['models']) ? raw['models'] : []
  const models = normalizeModelIds(rawModels.filter((id): id is string => typeof id === 'string'))
  const explicitMode = raw['mode'] === 'all' || raw['mode'] === 'selected' ? raw['mode'] : undefined
  const mode: WorkBuddyLaneMode = explicitMode ?? (models.length === 0 ? 'all' : 'selected')
  return { enabled, mode, models: mode === 'all' ? [] : models }
}

/** Normalize a whole selection document, keeping valid per-lane defaults. */
export function normalizeSelection(input: unknown): WorkBuddyDualSelection {
  const raw = isRecord(input) ? input : {}
  return {
    cn: normalizeLanePreference(raw['cn']),
    global: normalizeLanePreference(raw['global']),
  }
}

/** Trim, drop blanks, and preserve first-seen order. */
export function normalizeModelIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Whether one lane publishes every catalog model. */
export function laneShowsAll(lane: WorkBuddyLanePreference): boolean {
  return lane.enabled && lane.mode === 'all'
}

/** Filter one lane's full catalog into what the model pickers should show. */
export function filterModels(
  models: readonly WorkBuddyModelInfo[],
  lane: WorkBuddyLanePreference,
): readonly WorkBuddyModelInfo[] {
  if (!lane.enabled) return []
  if (lane.mode === 'all') return models
  const wanted = new Set(lane.models)
  return models.filter(model => wanted.has(model.id))
}

/** The exact ids a lane currently advertises, for tests and diagnostics. */
export function advertisedModelIds(
  models: readonly WorkBuddyModelInfo[],
  lane: WorkBuddyLanePreference,
): string[] {
  return filterModels(models, lane).map(model => model.id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
