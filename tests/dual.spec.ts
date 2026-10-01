import { describe, expect, it } from 'vitest'
import { reasoningFields } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/types.ts'
import { normalizeReasoning } from '../src/reasoning.ts'
import { WorkBuddyDualCatalog } from '../src/catalog.ts'
import { defaultDesktopCandidatesFor, parseWorkBuddyAuth } from '../src/auth.ts'
import { createWorkBuddyDualShim } from '../src/shim.ts'
import { WorkBuddyDualCredentialStore } from '../src/auth.ts'
import { WorkBuddyUpstreamClient, parseCatalogModels } from '../src/upstream.ts'

describe('dsh-workbuddy-dual', () => {
  it('detects desktop candidates for both regions', () => {
    const cnCandidates = defaultDesktopCandidatesFor('cn')
    const globalCandidates = defaultDesktopCandidatesFor('global')

    expect(cnCandidates.length).toBeGreaterThan(0)
    expect(globalCandidates.length).toBeGreaterThan(0)
    expect(cnCandidates[0]).toContain('workbuddy-desktop.info')
    expect(globalCandidates[0]).toContain('workbuddy-desktop-ai.info')
  })

  it('parses credentials correctly', () => {
    const mockAuth = JSON.stringify({
      auth: {
        accessToken: 'mock-access',
        refreshToken: 'mock-refresh',
        expiresIn: 3600,
        domain: 'www.codebuddy.cn',
      },
      account: {
        nickname: 'TestUser',
        uid: 'user-123',
      },
    })

    const cred = parseWorkBuddyAuth(mockAuth, 'cn')
    expect(cred).toBeDefined()
    expect(cred?.accessToken).toBe('mock-access')
    expect(cred?.nickname).toBe('TestUser')
    expect(cred?.domain).toBe('www.codebuddy.cn')
    expect(cred?.region).toBe('cn')
  })

  it('parses real local desktop credentials if available', async () => {
    const fs = await import('node:fs')
    const candidates = defaultDesktopCandidatesFor('cn')
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8')
        const cred = parseWorkBuddyAuth(content, 'cn')
        expect(cred).toBeDefined()
        expect(cred?.accessToken).toMatch(/^[A-Za-z0-9._~+/-]+=*$/)
        expect(cred?.accessToken.length).toBeGreaterThan(50)
      }
    }
    const glCandidates = defaultDesktopCandidatesFor('global')
    for (const p of glCandidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8')
        const cred = parseWorkBuddyAuth(content, 'global')
        expect(cred).toBeDefined()
        expect(cred?.accessToken).toMatch(/^[A-Za-z0-9._~+/-]+=*$/)
        expect(cred?.accessToken.length).toBeGreaterThan(50)
      }
    }
  })

  it('manages dual model catalog correctly', () => {
    const catalog = new WorkBuddyDualCatalog()
    const cnModels = catalog.modelsFor('cn')
    const globalModels = catalog.modelsFor('global')

    expect(cnModels.some(m => m.id === 'deepseek-v4.1-flash')).toBe(true)
    expect(globalModels.some(m => m.id === 'gpt-6-astra')).toBe(true)
  })

  it('starts shim and serves dual OpenAI models endpoints', async () => {
    const client = new WorkBuddyUpstreamClient()
    const store = new WorkBuddyDualCredentialStore({
      refreshCN: async () => ({ accessToken: 'dummy' }),
      refreshGlobal: async () => ({ accessToken: 'dummy' }),
    })
    const catalog = new WorkBuddyDualCatalog()
    const shim = createWorkBuddyDualShim({ store, client, catalog })

    await shim.ready
    try {
      expect(shim.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      // Check healthz
      const healthRes = await fetch(`${shim.origin}/healthz`)
      expect(healthRes.status).toBe(200)

      // Check CN models
      const cnRes = await fetch(`${shim.origin}/cn/v1/models`)
      expect(cnRes.status).toBe(200)
      const cnJson = (await cnRes.json()) as { object: string; data: { id: string; owned_by: string }[] }
      expect(cnJson.object).toBe('list')
      expect(cnJson.data.some(m => m.id === 'deepseek-v4.1-flash')).toBe(true)
      expect(cnJson.data.every(m => m.owned_by === 'workbuddy-cn')).toBe(true)

      // Check Global models
      const glRes = await fetch(`${shim.origin}/global/v1/models`)
      expect(glRes.status).toBe(200)
      const glJson = (await glRes.json()) as { object: string; data: { id: string; owned_by: string }[] }
      expect(glJson.object).toBe('list')
      expect(glJson.data.some(m => m.id === 'gpt-6-astra')).toBe(true)
      expect(glJson.data.every(m => m.owned_by === 'workbuddy-global')).toBe(true)
    } finally {
      await shim.close()
    }
  })
})

describe('thinking levels', () => {
  const thinkingLevels = (info: WorkBuddyModelInfo): string[] => {
    const fields = reasoningFields(info)
    if (!fields.reasoning || !fields.thinkingLevelMap) return []
    const map = fields.thinkingLevelMap as unknown as Record<string, string | null>
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .filter(level => map[level] !== null && map[level] !== undefined)
  }

  it('keeps a model selectable when the catalog advertises only an effort default', () => {
    // Shape published for kimi-k3-1 / deepseek-v4.1-flash / minimax-m3 / gemini-3.5-flash:
    // a bare `effort` with no supportedEfforts list.
    const kimi: WorkBuddyModelInfo = {
      id: 'kimi-k3-1',
      name: 'Kimi-K3',
      contextWindow: 1_000_000,
      maxTokens: 32_000,
      supportsImages: true,
      reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
      region: 'cn',
    }
    expect(thinkingLevels(kimi)).toEqual(['low', 'medium', 'high', 'xhigh'])
    // Thinking cannot be disabled, so `off` must not be offered.
    expect(thinkingLevels(kimi)).not.toContain('off')
  })

  it('honors an explicit catalog effort list over the family default', () => {
    const preview: WorkBuddyModelInfo = {
      id: 'kimi-k2.8-preview',
      name: 'Kimi-K2.8-Preview',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      supportsImages: true,
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        canDisableThinking: true,
      },
      region: 'cn',
    }
    expect(thinkingLevels(preview)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('never offers a thinking control for a non-reasoning model', () => {
    const plain: WorkBuddyModelInfo = {
      id: 'default',
      name: 'Default',
      contextWindow: 200_000,
      maxTokens: 24_000,
      supportsImages: false,
      region: 'cn',
    }
    expect(reasoningFields(plain)).toEqual({ reasoning: false })
  })

  it('snaps an advertised default onto the selectable levels', () => {
    expect(normalizeReasoning({ id: 'kimi-k3-1', supports: true, defaultEffort: 'minimal' }))
      .toMatchObject({ selectable: true, defaultEffort: 'low' })
    expect(normalizeReasoning({ id: 'glm-5.3', supports: true, defaultEffort: 'xhigh' }))
      .toMatchObject({ selectable: true, defaultEffort: 'high' })
    expect(normalizeReasoning({ id: 'gpt-5.5', supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }))
      .toMatchObject({ levels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' })
  })

  it('maps the catalog reasoning shape, including effort aliases', () => {
    const parsed = parseCatalogModels([
      { id: 'kimi-k3-1', name: 'Kimi-K3', reasoning: { effort: 'medium', summary: 'auto' }, onlyReasoning: true, supportsImages: true },
      { id: 'glm-5.3', reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] } },
      { id: 'glm-5.2', reasoning: { defaultEffort: 'high', supportedEfforts: ['high', 'xhigh'] } },
    ], 'cn')

    expect(parsed[0]?.reasoning).toMatchObject({ supports: true, defaultEffort: 'medium', canDisableThinking: false })
    expect(parsed[1]?.reasoning).toMatchObject({ supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' })
    expect(thinkingLevels(parsed[2]!)).toEqual(['high', 'xhigh'])
  })
})
