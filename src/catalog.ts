/**
 * Dual model catalog for WorkBuddy CN and WorkBuddy Global.
 */

import type { WorkBuddyModelInfo, WorkBuddyRegion } from './types.ts'

export const FALLBACK_CN_MODELS: readonly WorkBuddyModelInfo[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
    billing: { credits: 'x0.03 credits', badges: ['独家优惠'], free: false },
    region: 'cn',
  },
  {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
    billing: { credits: 'x0.00 credits', badges: ['限时免费'], free: true },
    region: 'cn',
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 48_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
    billing: { credits: 'x0.79', free: false },
    region: 'cn',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
    billing: { credits: 'x0.06', free: false },
    region: 'cn',
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax-M3',
    contextWindow: 512_000,
    maxTokens: 128_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
    billing: { credits: 'x0.25 credits', free: false },
    region: 'cn',
  },
  {
    id: 'kimi-k3-1',
    name: 'Kimi-K3',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
    billing: { credits: 'x1.62 credits', free: false },
    region: 'cn',
  },
]

export const FALLBACK_GLOBAL_MODELS: readonly WorkBuddyModelInfo[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
    billing: { credits: 'x0.00', badges: ['Free now'], free: true },
    region: 'global',
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true },
    billing: { credits: 'x6.67', free: false },
    region: 'global',
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true },
    billing: { credits: 'x3.47', free: false },
    region: 'global',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false },
    billing: { credits: 'x3.31', free: false },
    region: 'global',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini-3.5-Flash',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
    billing: { credits: 'x0.99', free: false },
    region: 'global',
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 48_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
    billing: { credits: 'x0.79', free: false },
    region: 'global',
  },
  {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false },
    billing: { credits: 'x0.00', badges: ['Free now'], free: true },
    region: 'global',
  },
]

export class WorkBuddyDualCatalog {
  private cnModels: readonly WorkBuddyModelInfo[] = FALLBACK_CN_MODELS
  private globalModels: readonly WorkBuddyModelInfo[] = FALLBACK_GLOBAL_MODELS

  modelsFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] {
    return region === 'cn' ? this.cnModels : this.globalModels
  }

  setModels(region: WorkBuddyRegion, models: readonly WorkBuddyModelInfo[]): void {
    if (region === 'cn') {
      this.cnModels = [...models]
    } else {
      this.globalModels = [...models]
    }
  }
}
