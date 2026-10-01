/**
 * Reasoning-effort normalization for WorkBuddy models.
 *
 * The WorkBuddy catalog publishes two different shapes of reasoning metadata:
 *
 * - `supportedEfforts: ['low','high','max']` — an explicit list of selectable
 *   thinking levels (`kimi-k2.8-preview`, `glm-5.3`, `gpt-6-astra`, ...).
 * - `effort: 'medium' | 'high'` — a single advertised default with no list at
 *   all (`kimi-k3-1`, `deepseek-v4.1-flash`, `minimax-m3`, `gemini-3.5-flash`,
 *   ...). The WorkBuddy desktop client still offers 思考强度 for these models
 *   (its own model picker persists e.g. `kimi-k3-1` + `xhigh`), and the
 *   upstream chat API accepts `reasoning_effort` for them, so the level list
 *   has to come from the client side. Without it the Harness reports the model
 *   as supporting only `off`, and the thinking-strength selector disappears
 *   for most of the catalog.
 */

/** pi-ai / Harness thinking levels, in ascending effort order. */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export interface EffortDefault {
  /** Advertised default when the catalog publishes no `defaultEffort`. */
  readonly defaultEffort: EffortLevel
  /** Selectable levels, ascending. Omit to accept every known level. */
  readonly allowed?: readonly EffortLevel[]
}

/**
 * Client-side defaults per model family, used only when the catalog publishes
 * `effort` without `supportedEfforts`. Mirrors the level lists the WorkBuddy
 * client exposes for the same families (see its `kimi-k3` entry: low/high/max).
 */
const FAMILY_DEFAULTS: readonly (readonly [RegExp, EffortDefault])[] = [
  [/^kimi-k2\.8/, { defaultEffort: 'high', allowed: ['low', 'high', 'max'] }],
  [/^kimi-k3/, { defaultEffort: 'high', allowed: ['low', 'medium', 'high', 'xhigh'] }],
  [/^kimi-k2/, { defaultEffort: 'medium', allowed: ['low', 'medium', 'high'] }],
  [/^minimax/, { defaultEffort: 'medium', allowed: ['low', 'medium', 'high'] }],
  [/^(deepseek|hunyuan)/, { defaultEffort: 'high', allowed: ['low', 'medium', 'high', 'max'] }],
  [/^glm-/, { defaultEffort: 'high', allowed: ['low', 'high', 'max'] }],
  [/^gpt-/, { defaultEffort: 'high', allowed: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  [/^grok-/, { defaultEffort: 'high', allowed: ['low', 'medium', 'high', 'xhigh'] }],
  [/^gemini-/, { defaultEffort: 'medium', allowed: ['low', 'medium', 'high'] }],
  [/^hy/, { defaultEffort: 'high', allowed: ['low', 'high'] }],
]

/** Fallback for a reasoning model whose family we do not recognize. */
const GENERIC_DEFAULT: EffortDefault = {
  defaultEffort: 'high',
  allowed: ['low', 'medium', 'high'],
}

function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

/** Family defaults for a model id, or the generic fallback. */
export function effortDefaultFor(modelId: string): EffortDefault {
  const id = modelId.trim().toLowerCase()
  for (const [pattern, preset] of FAMILY_DEFAULTS) {
    if (pattern.test(id)) return preset
  }
  return GENERIC_DEFAULT
}

/**
 * Snap an arbitrary advertised default onto the selectable list.
 *
 * A family may omit the model's advertised default (for example the catalog
 * advertises `medium` for `kimi-k3-1` while the Kimi tier list starts at
 * `low`/`medium`/`high`/`xhigh`). Prefer the nearest level at or below the
 * advertised one so the default never silently means "think harder than the
 * provider said", then fall back to the nearest level above.
 */
export function clampEffort(defaultEffort: string | undefined, levels: readonly EffortLevel[]): EffortLevel {
  const first = levels[0] ?? 'high'
  if (defaultEffort === undefined) return first
  const normalized = defaultEffort.trim().toLowerCase()
  if (!isEffortLevel(normalized)) return first
  if (levels.includes(normalized)) return normalized
  const index = EFFORT_LEVELS.indexOf(normalized)
  for (let i = index; i >= 0; i -= 1) {
    const candidate = EFFORT_LEVELS[i]
    if (candidate !== undefined && levels.includes(candidate)) return candidate
  }
  for (let i = index; i < EFFORT_LEVELS.length; i += 1) {
    const candidate = EFFORT_LEVELS[i]
    if (candidate !== undefined && levels.includes(candidate)) return candidate
  }
  return first
}

export interface NormalizedReasoning {
  /** False when the model exposes no selectable level beyond the provider default. */
  readonly selectable: boolean
  /** Levels to publish, ascending. Empty when nothing can be offered. */
  readonly levels: readonly EffortLevel[]
  /** Level the Harness preselects. */
  readonly defaultEffort?: EffortLevel
  /** Whether the provider can be told to skip thinking entirely. */
  readonly canDisableThinking: boolean
}

export interface NormalizeReasoningInput {
  readonly id: string
  readonly supports?: boolean | undefined
  readonly supportedEfforts?: readonly string[] | undefined
  readonly defaultEffort?: string | undefined
  readonly canDisableThinking?: boolean | undefined
}

/**
 * Resolve the selectable thinking levels for one model.
 *
 * Explicit catalog lists win — they are server truth. A model that declares
 * reasoning but lists nothing gets its family's levels instead of losing the
 * control entirely.
 */
export function normalizeReasoning(input: NormalizeReasoningInput): NormalizedReasoning {
  const canDisableThinking = input.canDisableThinking === true
  if (input.supports !== true) {
    return { selectable: false, levels: [], canDisableThinking }
  }

  const declared = (input.supportedEfforts ?? [])
    .map(effort => effort.trim().toLowerCase())
    .filter(isEffortLevel)
  const levels: readonly EffortLevel[] = declared.length > 0
    ? EFFORT_LEVELS.filter(level => declared.includes(level))
    : (effortDefaultFor(input.id).allowed ?? ['low', 'medium', 'high'])

  if (levels.length === 0) {
    return { selectable: false, levels: [], canDisableThinking }
  }

  const advertised = input.defaultEffort ?? (declared.length > 0 ? undefined : effortDefaultFor(input.id).defaultEffort)
  return {
    selectable: true,
    levels,
    defaultEffort: clampEffort(advertised, levels),
    canDisableThinking,
  }
}
