/**
 * The same product published under a different id on the other lane.
 *
 * WorkBuddy names DeepSeek-V4.1-Flash `deepseek-v4.1-flash` on CN and
 * `deepseek-v4.1-flash-sg` on Global. Both catalogs call it the same thing and
 * charge the same rate, but the router's old rule was "the model id must exist
 * verbatim in the target catalog" — so when every CN account was rate limited,
 * the Global lane was dropped before it was ever asked, and the turn failed
 * with "No WorkBuddy account can run deepseek-v4.1-flash right now" while two
 * healthy Global accounts sat unused.
 *
 * Only pairs that are known to be one product belong here. Matching by display
 * name would be wrong: `Kimi-K3` is `kimi-k3-1` on CN and `kimi-k3` on Global
 * with different limits, and `Hy3` maps to two ids on each side.
 *
 * Direction matters. A request only crosses CN → Global (the CN provider is the
 * default entry point); picking WorkBuddy Global must stay on Global so a
 * Global-only model never silently lands on a CN account.
 */

import type { WorkBuddyRegion } from './types.ts'

export const WORKBUDDY_CROSS_LANE_MODELS: Readonly<Record<string, Partial<Record<WorkBuddyRegion, string>>>> = {
  'deepseek-v4.1-flash': { global: 'deepseek-v4.1-flash-sg' },
}

/**
 * The id `region` serves for `model`, or undefined when that lane cannot run it.
 *
 * A lane's own id always wins: if Global ever publishes `deepseek-v4.1-flash`
 * itself, that is what gets sent there instead of the alias.
 */
export function crossLaneWireModel(
  has: (region: WorkBuddyRegion, model: string) => boolean,
  region: WorkBuddyRegion,
  model: string,
): string | undefined {
  if (has(region, model)) return model
  const alias = WORKBUDDY_CROSS_LANE_MODELS[model]?.[region]
  if (alias !== undefined && has(region, alias)) return alias
  return undefined
}

/**
 * Whether `region` can serve the product at all.
 *
 * This is the "can this lane run it" question, not the "what id do I send"
 * question. Both lanes answer yes for Flash; only Global's answer involves the
 * `-sg` alias.
 */
export function laneServesModel(
  has: (region: WorkBuddyRegion, model: string) => boolean,
  region: WorkBuddyRegion,
  model: string,
): boolean {
  return crossLaneWireModel(has, region, model) !== undefined
}
