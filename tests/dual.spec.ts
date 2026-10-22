import { describe, expect, it } from 'vitest'
import { reasoningFields } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/types.ts'
import { normalizeReasoning } from '../src/reasoning.ts'
import { WorkBuddyDualCatalog } from '../src/catalog.ts'
import { defaultDesktopCandidatesFor, parseWorkBuddyAuth } from '../src/auth.ts'
import { createWorkBuddyDualShim, prepareChatBody, stripForeignHarnessSignature } from '../src/shim.ts'
import { WorkBuddyDualCredentialStore } from '../src/auth.ts'
import { WorkBuddyUpstreamClient, parseCatalogModels } from '../src/upstream.ts'
import {
  advertisedModelIds,
  defaultSelection,
  filterModels,
  normalizeLanePreference,
  normalizeModelIds,
  normalizeSelection,
} from '../src/selection.ts'
import { WorkBuddyDualSelectionStore } from '../src/selection-store.ts'
import { laneModelsView, parseUpdate } from '../src/model-route.ts'

describe('dsh-workbuddy-dual', () => {
  it('drops the foreign harness signature from the system prompt only', () => {
    const body = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'developer', content: 'You are an AI agent powered by DeepSeek Harness.' },
        { role: 'user', content: [{ type: 'text', text: 'DeepSeek Harness 是什么？' }] },
      ],
    })
    const prepared = JSON.parse(prepareChatBody(body)) as { messages: Array<Record<string, unknown>> }
    expect(prepared.messages[0]?.['content']).toBe('You are an AI agent powered by DeepSeek-Harness.')
    // User text is the user's own content and must survive untouched.
    expect(prepared.messages[1]?.['content']).toEqual([{ type: 'text', text: 'DeepSeek Harness 是什么？' }])
    expect(prepared.messages[0]?.['role']).toBe('system')
  })

  it('normalizes the signature across spacing and casing', () => {
    expect(stripForeignHarnessSignature('powered by deepseek   harness')).toBe('powered by DeepSeek-Harness')
    expect(stripForeignHarnessSignature('DeepSeek-Harness')).toBe('DeepSeek-Harness')
  })

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

      // The shim is the wire the model pickers ultimately read through, so a
      // narrowed lane must narrow here too — not only in the adapter.
      catalog.setSelection(normalizeSelection({ cn: { mode: 'selected', models: ['hy3'] } }))
      const narrowed = (await (await fetch(`${shim.origin}/cn/v1/models`)).json()) as { data: { id: string }[] }
      expect(narrowed.data.map(model => model.id)).toEqual(['hy3'])
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

describe('model selection', () => {
  it('leaves both lanes fully open when nothing is stored', () => {
    const catalog = new WorkBuddyDualCatalog()
    const selection = defaultSelection()
    const cn = catalog.modelsFor('cn')
    const global = catalog.modelsFor('global')

    expect(advertisedModelIds(cn, selection.cn)).toEqual(cn.map(model => model.id))
    expect(advertisedModelIds(global, selection.global)).toEqual(global.map(model => model.id))
  })

  it('narrows a lane to the chosen ids only', () => {
    const catalog = new WorkBuddyDualCatalog()
    const cn = catalog.modelsFor('cn')
    const lane = normalizeLanePreference({ mode: 'selected', models: ['deepseek-v4.1-flash'] })

    expect(filterModels(cn, lane).map(model => model.id)).toEqual(['deepseek-v4.1-flash'])
    expect(advertisedModelIds(cn, lane)).not.toContain('glm-5.3')
  })

  it('hides a lane entirely when it is disabled', () => {
    const catalog = new WorkBuddyDualCatalog()
    const lane = normalizeLanePreference({ enabled: false, mode: 'all' })
    expect(advertisedModelIds(catalog.modelsFor('global'), lane)).toEqual([])
  })

  it('treats an empty explicit list as “show everything”', () => {
    // An older plugin wrote `[]` for “no selection”. It must not blank the
    // picker after an upgrade.
    expect(normalizeLanePreference({}).mode).toBe('all')
    expect(normalizeLanePreference({ models: [] }).mode).toBe('all')
    expect(normalizeLanePreference({ mode: 'selected', models: [] }).mode).toBe('selected')
  })

  it('normalizes ids and tolerates a hand-edited document', () => {
    expect(normalizeModelIds([' glm-5.3 ', 'glm-5.3', '', 'hy3'])).toEqual(['glm-5.3', 'hy3'])
    const selection = normalizeSelection({ cn: { mode: 'selected', models: ['hy3'] }, global: 'nonsense' })
    expect(selection.cn.models).toEqual(['hy3'])
    expect(selection.global).toEqual({ enabled: true, mode: 'all', models: [] })
  })

  it('reports checked rows for a selected lane and all rows for an open lane', () => {
    const catalog = new WorkBuddyDualCatalog()
    const narrow = normalizeSelection({ cn: { mode: 'selected', models: ['hy3'] } })
    const view = laneModelsView(catalog, narrow, 'cn')

    expect(view.mode).toBe('selected')
    expect(view.selectedCount).toBe(1)
    expect(view.models.filter(model => model.selected).map(model => model.id)).toEqual(['hy3'])

    const open = laneModelsView(catalog, defaultSelection(), 'cn')
    expect(open.mode).toBe('all')
    expect(open.selectedCount).toBe(open.total)
  })

  it('rejects a malformed write instead of guessing', () => {
    expect(() => parseUpdate({ cn: { mode: 'nope' } })).toThrow(/mode/)
    expect(() => parseUpdate({ cn: { enabled: 'yes' } })).toThrow(/enabled/)
    expect(() => parseUpdate({ cn: { models: [1] } })).toThrow(/models/)
    expect(parseUpdate({ cn: { mode: 'selected', models: ['hy3'] } })).toEqual({
      cn: { mode: 'selected', models: ['hy3'] },
    })
  })


  it('disables the global lane without touching the CN lane', () => {
    const catalog = new WorkBuddyDualCatalog()
    const selection = normalizeSelection({
      cn: { mode: 'selected', models: ['hy3'] },
      global: { enabled: false, mode: 'all' },
    })
    catalog.setSelection(selection)

    expect(catalog.selectedModelsFor('cn').map(model => model.id)).toEqual(['hy3'])
    expect(catalog.selectedModelsFor('global')).toEqual([])
    // The unfiltered catalog stays available to finish an old Session.
    expect(catalog.modelsFor('global').length).toBeGreaterThan(0)
  })
})

describe('selection document', () => {
  it('round-trips through an atomic file and defaults when absent', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-dual-'))
    const doc = path.join(dir, 'models.json')
    try {
      const store = new WorkBuddyDualSelectionStore({ path: doc })
      expect(await store.get()).toEqual(defaultSelection())

      await store.updateLanes({ cn: { mode: 'selected', models: ['hy3', 'glm-5.3'] } })
      const reopened = new WorkBuddyDualSelectionStore({ path: doc })
      const stored = await reopened.get()
      expect(stored.cn).toEqual({ enabled: true, mode: 'selected', models: ['hy3', 'glm-5.3'] })
      // The untouched lane keeps its open default.
      expect(stored.global).toEqual(defaultSelection().global)

      const parsed = JSON.parse(await fs.readFile(doc, 'utf8')) as { version: number }
      expect(parsed.version).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
