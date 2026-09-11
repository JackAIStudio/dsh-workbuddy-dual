/**
 * Dual LLM Adapter for WorkBuddy CN and WorkBuddy Global.
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyDualCatalog } from './catalog.ts'
import type { WorkBuddyDualShim } from './shim.ts'
import type { WorkBuddyModelInfo, WorkBuddyRegion } from './types.ts'

export const WORKBUDDY_CN_PROVIDER = 'workbuddy-cn'
export const WORKBUDDY_GLOBAL_PROVIDER = 'workbuddy-global'

export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

const NO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const

const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-workbuddy-dual: no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

function normalizeCredits(credits: string | undefined): string | undefined {
  if (!credits) return undefined
  const trimmed = credits.trim()
  if (!trimmed || /^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

function displaySuffix(info: WorkBuddyModelInfo): string | undefined {
  const parts = [
    normalizeCredits(info.billing?.credits),
    ...(info.billing?.badges ?? []),
  ].filter((p): p is string => p !== undefined && p !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

function withCatalogDisplay(name: string, info: WorkBuddyModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name} · ${suffix}`
}

function reasoningFields(info: WorkBuddyModelInfo): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (!reasoning || !reasoning.supports) return { reasoning: false }
  const efforts = reasoning.supportedEfforts
  if (!efforts || efforts.length === 0) return { reasoning: false }
  const map: Record<ModelThinkingLevel, string | null> = {
    off: reasoning.canDisableThinking === true ? 'off' : null,
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

function toPiModel(info: WorkBuddyModelInfo, baseUrl: string, providerId: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

export interface WorkBuddyDualAdapterOptions {
  shim: WorkBuddyDualShim
  catalog: WorkBuddyDualCatalog
  resolveAttachments?: () => AttachmentStore | undefined
}

export interface WorkBuddyDualAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

export function createWorkBuddyDualAdapter(options: WorkBuddyDualAdapterOptions): WorkBuddyDualAdapter {
  const { shim, catalog, resolveAttachments } = options

  const buildModels = (region: WorkBuddyRegion, providerId: string): Model<Api>[] => {
    const baseUrl = shim.baseUrl(region)
    return catalog.modelsFor(region).map(info => toPiModel(info, baseUrl, providerId))
  }

  const createProviderFor = (region: WorkBuddyRegion, providerId: string, displayName: string): Provider => {
    const base = createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: `${displayName} OAuth Bearer`,
          async resolve() {
            return { auth: { apiKey: 'dummy-local-bearer' }, source: displayName }
          },
        },
      },
      models: buildModels(region, providerId),
      api: openAICompletionsApi(),
    })
    return { ...base, getModels: () => buildModels(region, providerId) }
  }

  const buildProfiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    const cnProvider = createProviderFor('cn', WORKBUDDY_CN_PROVIDER, 'WorkBuddy CN')
    const globalProvider = createProviderFor('global', WORKBUDDY_GLOBAL_PROVIDER, 'WorkBuddy Global')

    const cnProfile: ResolvedPiAiProviderProfile = {
      provider: WORKBUDDY_CN_PROVIDER,
      displayName: 'WorkBuddy CN',
      streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-dual CN retryPolicy'),
      configuredMaxTokens: new Map(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: cnProvider,
    }

    const globalProfile: ResolvedPiAiProviderProfile = {
      provider: WORKBUDDY_GLOBAL_PROVIDER,
      displayName: 'WorkBuddy Global',
      streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-dual Global retryPolicy'),
      configuredMaxTokens: new Map(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: globalProvider,
    }

    return new Map([
      [WORKBUDDY_CN_PROVIDER, cnProfile],
      [WORKBUDDY_GLOBAL_PROVIDER, globalProfile],
    ])
  }

  let profiles = buildProfiles()

  class DualPiAiAdapter extends PiAiAdapter {
    override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      const models = await super.listModels(provider)
      const region: WorkBuddyRegion = provider === WORKBUDDY_GLOBAL_PROVIDER ? 'global' : 'cn'
      const catalogModels = catalog.modelsFor(region)
      return models.map(m => {
        const info = catalogModels.find(x => x.id === m.id)
        if (!info) return m
        return { ...m, name: withCatalogDisplay(m.name, info) }
      })
    }

    override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      const resolved = await super.resolveModel(provider, model, signal)
      const region: WorkBuddyRegion = provider === WORKBUDDY_GLOBAL_PROVIDER ? 'global' : 'cn'
      const info = catalog.modelsFor(region).find(x => x.id === model)
      if (!info) return resolved
      return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
    }
  }

  const adapter = new DualPiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => 'dummy-local-bearer',
    ...(resolveAttachments ? { resolveAttachments } : {}),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
  }
}
