import { describe, expect, it } from 'vitest'
import { reasoningFields, topEffort, withDefaultEffort } from '../src/adapter.ts'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { WorkBuddyModelInfo } from '../src/types.ts'
import { normalizeReasoning } from '../src/reasoning.ts'
import { WorkBuddyDualCatalog } from '../src/catalog.ts'
import { defaultDesktopCandidatesFor, parseWorkBuddyAuth } from '../src/auth.ts'
import {
  createWorkBuddyDualShim,
  deflectLeadingClientIdentity,
  prepareChatBody,
  rewrapSystemPrompt,
  stripForeignHarnessSignature,
} from '../src/shim.ts'
import { WorkBuddyDualCredentialStore } from '../src/auth.ts'
import { WorkBuddyUpstreamClient, parseBusinessCode, parseCatalogModels, parseResetTime } from '../src/upstream.ts'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyCredential } from '../src/types.ts'
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
import { workBuddyAccountHandler, createAccountRouteState, displayNameFor, maskUid, parseAccountAction } from '../src/account-route.ts'

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

  it('wraps running prose onto separate lines without changing a word', () => {
    const prompt = 'You are a helpful assistant. Read a file before overwriting it. Prefer edit for small changes.'
    const wrapped = rewrapSystemPrompt(prompt)
    expect(wrapped).toBe([
      'You are a helpful assistant.',
      'Read a file before overwriting it.',
      'Prefer edit for small changes.',
    ].join('\n'))
    // Nothing is added or removed beyond the line breaks themselves.
    expect(wrapped.replace(/\n/gu, ' ')).toBe(prompt)
  })

  it('leaves fenced code, lists and indented blocks alone', () => {
    const prompt = [
      'Intro sentence. Second sentence here.',
      '```ts',
      'const a = 1. const b = 2.',
      '```',
      '- item one. item two.',
      '    indented. second. third.',
    ].join('\n')
    const wrapped = rewrapSystemPrompt(prompt)
    expect(wrapped.split('\n')).toEqual([
      'Intro sentence.',
      'Second sentence here.',
      '```ts',
      'const a = 1. const b = 2.',
      '```',
      '- item one. item two.',
      '    indented. second. third.',
    ])
  })

  it('keeps the Global system prompt exactly as the harness wrote it', () => {
    const prompt = 'You are a helpful assistant. Read a file before overwriting it.'
    const build = (region: 'cn' | 'global'): string => {
      const body = JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'system', content: prompt }],
      })
      const prepared = JSON.parse(prepareChatBody(body, region)) as { messages: Array<Record<string, unknown>> }
      return String(prepared.messages[0]?.['content'])
    }
    expect(build('global')).toBe(prompt)
    expect(build('cn')).toBe([
      'You are a helpful assistant.',
      'Read a file before overwriting it.',
    ].join('\n'))
  })

  it('deflects another client identity only when it opens the prompt', () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    expect(deflectLeadingClientIdentity(identity)).toBe("You are Claude Code — Anthropic's official CLI for Claude.")
    // Only punctuation changes: the words and their order survive intact.
    expect(deflectLeadingClientIdentity(identity).replace(' — ', ', ')).toBe(identity)
    // A sentence later in the prompt is not the opening and keeps its comma.
    expect(deflectLeadingClientIdentity(`Intro. ${identity}`)).toBe(`Intro. ${identity}`)
    // A leading space or newline already moves the identity off the opening,
    // and the gateway accepts those unchanged.
    expect(deflectLeadingClientIdentity(` ${identity}`)).toBe(` ${identity}`)
    // A truncated identity is still the same opening, so it is deflected too;
    // the change stays a single punctuation mark in every case.
    expect(deflectLeadingClientIdentity('You are Claude Code, Anthropic')).toBe('You are Claude Code — Anthropic')
    // Unrelated openings are untouched.
    expect(deflectLeadingClientIdentity('You are Claude, an AI assistant.')).toBe('You are Claude, an AI assistant.')
    expect(deflectLeadingClientIdentity('You are Claude Code.')).toBe('You are Claude Code.')
  })

  it('rewrites a Claude Code system block on the CN lane and leaves the Global lane alone', () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const build = (region: 'cn' | 'global'): unknown => {
      const body = JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'system', content: [{ type: 'text', text: identity }] }],
      })
      const prepared = JSON.parse(prepareChatBody(body, region)) as { messages: Array<Record<string, unknown>> }
      return prepared.messages[0]?.['content']
    }
    expect(build('global')).toEqual([{ type: 'text', text: identity }])
    expect(build('cn')).toEqual([{ type: 'text', text: "You are Claude Code — Anthropic's official CLI for Claude." }])
  })

  it('types enums nested inside tool schemas so Kimi accepts the request', () => {
    const body = JSON.stringify({
      model: 'kimi-k3.1-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'parse_visual_regions',
          description: 'parse',
          parameters: {
            type: 'object',
            properties: {
              options: {
                type: 'object',
                properties: {
                  kinds: {
                    anyOf: [
                      { items: { enum: ['text', 'icon'] }, type: 'array', uniqueItems: true },
                      { type: 'null' },
                    ],
                  },
                },
              },
            },
          },
        },
      }],
    })
    const prepared = JSON.parse(prepareChatBody(body)) as {
      tools: Array<{ function: { parameters: { properties: { options: { properties: { kinds: { anyOf: Array<{ items?: Record<string, unknown> }> } } } } } } }>
    }
    const kinds = prepared.tools[0]?.function.parameters.properties.options.properties.kinds
    expect(kinds?.anyOf[0]?.items?.['type']).toBe('string')
    expect(kinds?.anyOf[0]?.items?.['enum']).toEqual(['text', 'icon'])
  })

  it('leaves a declared type and heterogeneous enums alone', () => {
    const body = JSON.stringify({
      model: 'kimi-k3.1-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'mixed',
          description: 'mixed',
          parameters: {
            type: 'object',
            properties: {
              declared: { type: 'integer', enum: ['1', '2'] },
              heterogeneous: { enum: ['a', 1] },
            },
          },
        },
      }],
    })
    const prepared = JSON.parse(prepareChatBody(body)) as {
      tools: Array<{ function: { parameters: { properties: Record<string, Record<string, unknown>> } } }>
    }
    const properties = prepared.tools[0]?.function.parameters.properties
    // An explicit type is the caller's decision and must survive verbatim.
    expect(properties?.['declared']?.['type']).toBe('integer')
    // No single type describes the values, so nothing is invented.
    expect(properties?.['heterogeneous']?.['type']).toBeUndefined()
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
    // The placeholder catalog must carry the id Global really serves, or the
    // cross-lane alias never fires before the live catalog arrives.
    expect(globalModels.some(m => m.id === 'deepseek-v4.1-flash-sg')).toBe(true)
    expect(globalModels.some(m => m.id === 'deepseek-v4.1-flash')).toBe(false)
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

  it('publishes the strongest level as the model default so a switch starts at the top', () => {
    // pi-ai carries no per-model default, so without this every WorkBuddy model
    // reached the picker with no default and the composer fell back to the
    // first advertised level (`off` or `low`) after a model switch.
    const resolved = {
      provider: 'workbuddy-cn',
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      inputModalities: ['text' as const],
      context: { contextWindow: 1_000_000 },
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
      },
    } as unknown as LlmResolvedModelInfo
    const info: WorkBuddyModelInfo = {
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      supportsImages: true,
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
      region: 'cn',
    }
    expect(withDefaultEffort(resolved, info)).toMatchObject({
      reasoning: { defaultEffort: 'max' },
    })
    // A weaker inherited default is overridden: switching models should not
    // land on Low while the model still offers Max.
    const configured = {
      ...resolved,
      reasoning: { ...resolved.reasoning, defaultEffort: ReasoningEffortId('low') },
    } as LlmResolvedModelInfo
    expect(withDefaultEffort(configured, info))
      .toMatchObject({ reasoning: { defaultEffort: 'max' } })
    expect(topEffort([{ id: 'off' }, { id: 'minimal' }, { id: 'xhigh' }])).toBe('xhigh')
    expect(topEffort([{ id: 'low' }, { id: 'high' }, { id: 'extra-high' }])).toBe('extra-high')
    expect(topEffort([])).toBeUndefined()
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

describe('account pool', () => {
  const credential = (uid: string, expiresAtMs = Date.now() + 3_600_000): WorkBuddyCredential => ({
    accessToken: `access-${uid}`,
    refreshToken: `refresh-${uid}`,
    expiresAtMs,
    domain: 'www.codebuddy.cn',
    uid,
    nickname: `name-${uid}`,
    source: 'pool',
    region: 'cn',
  })

  it('adds, selects, and persists accounts across processes', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-pool-'))
    const doc = path.join(dir, 'accounts-cn.json')
    try {
      const pool = new WorkBuddyAccountPool('cn', { path: doc })
      expect((await pool.get()).accounts).toEqual([])

      // A first add is also a selection: importing an account is pointless if
      // the harness keeps spending the previous one.
      await pool.upsert(credential('u1'))
      const afterFirst = await pool.get()
      expect(afterFirst.activeUid).toBe('u1')

      // A second add must not steal the selection.
      await pool.upsert(credential('u2'), { select: false })
      expect((await pool.get()).activeUid).toBe('u1')
      expect((await pool.get()).accounts.map(a => a.uid)).toEqual(['u1', 'u2'])

      // Another host (same file, separate process state) reads the selection.
      const reopened = new WorkBuddyAccountPool('cn', { path: doc })
      expect((await reopened.active())?.uid).toBe('u1')

      await reopened.select('u2')
      expect((await pool.get()).activeUid).toBe('u2')

      const removed = await pool.remove('u2')
      expect(removed.accounts.map(a => a.uid)).toEqual(['u1'])
      // Removing the selected account leaves no stale pointer behind.
      expect(removed.activeUid).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to select an account it does not hold', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-pool-'))
    try {
      const pool = new WorkBuddyAccountPool('cn', { path: path.join(dir, 'accounts-cn.json') })
      await pool.upsert(credential('u1'))
      await expect(pool.select('nope')).rejects.toThrow(/not in the cn pool/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a refreshed token in the pool entry that owns it', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-pool-'))
    try {
      const pool = new WorkBuddyAccountPool('cn', { path: path.join(dir, 'accounts-cn.json') })
      await pool.upsert(credential('u1'))
      await pool.update('u1', { ...credential('u1'), accessToken: 'rotated', refreshToken: 'rotated-refresh' })
      const stored = await pool.find('u1')
      expect(stored?.accessToken).toBe('rotated')
      expect(stored?.refreshToken).toBe('rotated-refresh')
      // Identity and provenance survive a token rotation.
      expect(stored?.addedAt).toBeLessThanOrEqual(Date.now())
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('credential resolution with a pool', () => {
  it('prefers the selected pool account over the desktop sign-in', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-pool-'))
    const desktopFile = path.join(dir, 'desktop.info')
    const poolFile = path.join(dir, 'accounts-cn.json')
    try {
      await fs.writeFile(desktopFile, JSON.stringify({
        auth: { accessToken: 'desktop-token', refreshToken: 'r', expiresIn: 3600 },
        account: { uid: 'desktop-uid' },
      }))
      const store = new WorkBuddyDualCredentialStore({
        refreshCN: async () => ({ accessToken: 'x' }),
        refreshGlobal: async () => ({ accessToken: 'x' }),
        cnPathOverride: desktopFile,
        poolPaths: { cn: poolFile },
      })

      // No selection yet: the desktop sign-in is what the harness spends.
      expect((await store.cn.current())?.accessToken).toBe('desktop-token')

      await store.poolFor('cn').upsert({
        accessToken: 'pool-token',
        refreshToken: 'r2',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
        uid: 'pool-uid',
        nickname: 'Pool account',
        source: 'pool',
        region: 'cn',
      })

      const current = await store.cn.current()
      expect(current?.accessToken).toBe('pool-token')
      expect(current?.source).toBe('pool')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the desktop sign-in when the selection is cleared', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-pool-'))
    const desktopFile = path.join(dir, 'desktop.info')
    try {
      await fs.writeFile(desktopFile, JSON.stringify({
        auth: { accessToken: 'desktop-token', refreshToken: 'r', expiresIn: 3600 },
        account: { uid: 'desktop-uid' },
      }))
      const store = new WorkBuddyDualCredentialStore({
        refreshCN: async () => ({ accessToken: 'x' }),
        refreshGlobal: async () => ({ accessToken: 'x' }),
        cnPathOverride: desktopFile,
        poolPaths: { cn: path.join(dir, 'accounts-cn.json') },
      })
      await store.poolFor('cn').upsert({
        accessToken: 'pool-token',
        refreshToken: 'r2',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
        uid: 'pool-uid',
        source: 'pool',
        region: 'cn',
      })
      await store.poolFor('cn').select(undefined)
      expect((await store.cn.current())?.accessToken).toBe('desktop-token')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('flash probe parsing', () => {
  it('reads the upstream reset time instead of guessing from credits', () => {
    const message = '{"code":6004,"msg":"当前模型请求过于频繁，将在 2026-10-26 21:44:41 恢复"}'
    expect(parseBusinessCode(message)).toBe('6004')
    const reset = parseResetTime(message)
    expect(reset).toBe(Date.parse('2026-10-26T21:44:41+08:00'))
  })

  it('reads the Global lane reset time, which is stated in English', () => {
    const message = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-10-31 07:28:11 UTC+8, alternatively, you can switch to the other models to continue using it."}'
    expect(parseBusinessCode(message)).toBe('6004')
    expect(parseResetTime(message)).toBe(Date.parse('2026-10-31T07:28:11+08:00'))
  })

  it('honours the zone the message states instead of assuming UTC+8', () => {
    expect(parseResetTime('will reset at 2026-10-31 07:28:11 UTC+0'))
      .toBe(Date.parse('2026-10-31T07:28:11Z'))
    expect(parseResetTime('will reset at 2026-10-31 07:28:11 UTC-5'))
      .toBe(Date.parse('2026-10-31T07:28:11-05:00'))
    // Minutes in the offset are rare but legal; reading them wrong shifts the
    // reset by up to 59 minutes.
    expect(parseResetTime('will reset at 2026-10-31 07:28:11 UTC+05:30'))
      .toBe(Date.parse('2026-10-31T07:28:11+05:30'))
  })

  it('accepts a reset time without seconds', () => {
    expect(parseResetTime('your usage will reset at 2026-10-31 07:28 UTC+8'))
      .toBe(Date.parse('2026-10-31T07:28:00+08:00'))
  })

  it('accepts ISO zone suffixes', () => {
    expect(parseResetTime('reset at 2026-10-31T07:28:11Z'))
      .toBe(Date.parse('2026-10-31T07:28:11Z'))
    expect(parseResetTime('reset at 2026-10-31T07:28:11+08:00'))
      .toBe(Date.parse('2026-10-31T07:28:11+08:00'))
  })

  it('returns no reset time when the gateway does not state one', () => {
    expect(parseResetTime('{"code":11140,"msg":"账号已被封禁"}')).toBeUndefined()
    expect(parseBusinessCode('no code here')).toBeUndefined()
  })
})

describe('account route', () => {
  it('never returns a full uid to the browser', () => {
    expect(maskUid('3ac06abe-657f-44f3-81a0-2bd25f3567d7')).toBe('3ac0…67d7')
    expect(displayNameFor({ uid: 'x', nickname: '173****0329' })).toBe('173****0329')
    // A user label wins over the nickname, because it is what the user chose.
    expect(displayNameFor({ uid: 'x', nickname: '173****0329', label: '主力号' })).toBe('主力号')
    // A short uid is shown as-is; masking it would hide the whole value.
    expect(displayNameFor({ uid: 'short' })).toBe('short')
  })

  it('validates every mutation payload', () => {
    expect(parseAccountAction({ action: 'select', region: 'cn', uid: 'u1' })).toEqual({ action: 'select', region: 'cn', uid: 'u1' })
    expect(parseAccountAction({ action: 'select', region: 'cn', uid: null })).toEqual({ action: 'select', region: 'cn', uid: null })
    expect(parseAccountAction({ action: 'probe', region: 'global' })).toEqual({ action: 'probe', region: 'global' })
    expect(() => parseAccountAction({ action: 'select', region: 'mars', uid: 'u1' })).toThrow(/region/)
    expect(() => parseAccountAction({ action: 'explode', region: 'cn' })).toThrow(/unknown action/)
    expect(() => parseAccountAction({ action: 'remove', region: 'cn' })).toThrow(/uid/)
  })

  it('forgets a rate-limit verdict once its own reset time passes', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-expiry-'))
    try {
      const store = new WorkBuddyDualCredentialStore({
        refreshCN: async () => ({ accessToken: 'x' }),
        refreshGlobal: async () => ({ accessToken: 'x' }),
        // Point both fallbacks at a file that does not exist: the suite must
        // never spend the developer's real sign-ins.
        cnPathOverride: path.join(dir, 'no-cn.info'),
        globalPathOverride: path.join(dir, 'no-global.info'),
        poolPaths: { cn: path.join(dir, 'cn.json'), global: path.join(dir, 'global.json') },
      })
      await store.poolFor('cn').upsert({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
        uid: 'u1',
        source: 'pool',
        region: 'cn',
      })

      let probes = 0
      let resetsAtMs = Date.now() - 60_000
      const fakeClient = {
        async fetchCredits() {
          return { accounts: [], totalBalance: 10 }
        },
        async probeModel() {
          probes++
          return { verdict: 'rate-limited' as const, code: '6004', resetsAtMs, elapsedMs: 1, checkedAt: Date.now() }
        },
      }
      const { workBuddyAccountsView, workBuddyAccountsRefresh, createAccountRouteState } = await import('../src/account-route.ts')
      const state = createAccountRouteState()
      // The view itself only reads cache; the refresh is what probes.
      await workBuddyAccountsRefresh({ store, client: fakeClient as never }, state)
      expect(probes).toBe(1)

      // The cached verdict expired with the upstream's reset time, so the
      // next view re-checks instead of repeating a dead answer.
      resetsAtMs = Date.now() + 3_600_000
      await workBuddyAccountsRefresh({ store, client: fakeClient as never }, state)
      const view = await workBuddyAccountsView({ store, client: fakeClient as never }, state)
      expect(probes).toBe(2)
      expect(view.cn.accounts[0]?.probe?.resetsAtMs).toBe(resetsAtMs)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('serves the pool, probes the flash model, and stops on untrusted hosts', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const http = await import('node:http')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-route-'))
    const server = http.createServer()
    try {
      const store = new WorkBuddyDualCredentialStore({
        refreshCN: async () => ({ accessToken: 'x' }),
        refreshGlobal: async () => ({ accessToken: 'x' }),
        cnPathOverride: path.join(dir, 'no-cn.info'),
        globalPathOverride: path.join(dir, 'no-global.info'),
        poolPaths: { cn: path.join(dir, 'cn.json'), global: path.join(dir, 'global.json') },
      })
      await store.poolFor('cn').upsert({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
        uid: '3ac06abe-657f-44f3-81a0-2bd25f3567d7',
        nickname: '173****0329',
        source: 'pool',
        region: 'cn',
      })

      let probes = 0
      // A future reset keeps the cached verdict fresh for the assertions below.
      const resetsAtMs = Date.now() + 3_600_000
      const fakeClient = {
        async fetchCredits() {
          return { accounts: [], totalBalance: 1706 }
        },
        async probeModel(_credential: unknown, model: string) {
          probes++
          // A real probe is a network round trip; the delay is what makes the
          // "answer from cache first" behaviour observable.
          await new Promise(resolve => setTimeout(resolve, 30))
          return {
            verdict: 'rate-limited' as const,
            code: '6004',
            resetsAtMs,
            elapsedMs: 5,
            checkedAt: Date.now(),
          }
        },
      }

      server.on('request', workBuddyAccountHandler({
        store,
        client: fakeClient as never,
      }, createAccountRouteState()))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address() as { port: number }
      const base = `http://127.0.0.1:${address.port}`

      const get = await fetch(base, { headers: { host: `127.0.0.1:${address.port}` } })
      expect(get.status).toBe(200)
      const view = (await get.json()) as { cn: { accounts: { uid: string; displayName: string; active: boolean; probe?: unknown }[]; usingFallback: boolean; refreshing: boolean } }
      expect(view.cn.usingFallback).toBe(false)
      expect(view.cn.accounts[0]?.displayName).toBe('173****0329')
      expect(view.cn.accounts[0]?.active).toBe(true)
      expect(view.cn.accounts[0]?.uid).toBe('3ac06abe-657f-44f3-81a0-2bd25f3567d7')
      // The first answer is served from cache: the row is there immediately and
      // the lane reports that its probe is still running.
      expect(view.cn.refreshing).toBe(true)

      // Polling, which is what the panel does, ends with a real verdict.
      let settled: typeof view | undefined
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(base, { headers: { host: `127.0.0.1:${address.port}` } })
        settled = (await response.json()) as typeof view
        if (!settled.cn.refreshing) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(settled?.cn.refreshing).toBe(false)
      expect((settled?.cn.accounts[0] as { probe?: { verdict?: string } } | undefined)?.probe?.verdict).toBe('rate-limited')

      const probe = await fetch(base, {
        method: 'POST',
        headers: { host: `127.0.0.1:${address.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'probe', region: 'cn' }),
      })
      expect(probe.status).toBe(200)
      const probed = (await probe.json()) as { cn: { accounts: { probe?: { verdict: string; resetsAtMs?: number } }[] } }
      expect(probed.cn.accounts[0]?.probe?.verdict).toBe('rate-limited')
      expect(probed.cn.accounts[0]?.probe?.resetsAtMs).toBe(resetsAtMs)
      // One background probe for the row, plus the explicit check.
      expect(probes).toBe(2)

      // Within the cache window a re-open must not spend another request.
      const second = await fetch(base, { headers: { host: `127.0.0.1:${address.port}` } })
      expect(second.status).toBe(200)
      await second.json()
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(probes).toBe(2)

      // A non-loopback Host header must not reach the account list.
      // `fetch` refuses to override Host, so this goes through http directly.
      const foreignStatus = await new Promise<number>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/',
          headers: { host: 'example.com' },
        }, response => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
        request.end()
      })
      expect(foreignStatus).toBe(403)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('backs off after a failed probe instead of retrying on every poll', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-backoff-'))
    try {
      const store = new WorkBuddyDualCredentialStore({
        refreshCN: async () => ({ accessToken: 'x' }),
        refreshGlobal: async () => ({ accessToken: 'x' }),
        cnPathOverride: path.join(dir, 'no-cn.info'),
        globalPathOverride: path.join(dir, 'no-global.info'),
        poolPaths: { cn: path.join(dir, 'cn.json'), global: path.join(dir, 'global.json') },
      })
      await store.poolFor('cn').upsert({
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
        uid: 'u1',
        source: 'pool',
        region: 'cn',
      })

      let probes = 0
      const fakeClient = {
        async fetchCredits() {
          return { accounts: [], totalBalance: 5 }
        },
        async probeModel() {
          probes++
          throw new Error('gateway unreachable')
        },
      }
      const { workBuddyAccountsView, workBuddyAccountsRefresh, createAccountRouteState } = await import('../src/account-route.ts')
      const state = createAccountRouteState()
      const deps = { store, client: fakeClient as never }

      await workBuddyAccountsRefresh(deps, state)
      expect(probes).toBe(1)
      // A dead gateway must not turn every poll into another request; the row
      // keeps the balance it could read and the next probe waits.
      await workBuddyAccountsRefresh(deps, state)
      await workBuddyAccountsRefresh(deps, state)
      expect(probes).toBe(1)

      const view = await workBuddyAccountsView(deps, state)
      expect(view.cn.refreshing).toBe(false)
      expect(view.cn.accounts[0]?.credits).toBe(5)
      expect(view.cn.accounts[0]?.probe).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('does not stack refreshes when the panel polls', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-poll-'))
    try {
      const store = new WorkBuddyDualCredentialStore({
        refreshCN: async () => ({ accessToken: 'x' }),
        refreshGlobal: async () => ({ accessToken: 'x' }),
        cnPathOverride: path.join(dir, 'no-cn.info'),
        globalPathOverride: path.join(dir, 'no-global.info'),
        poolPaths: { cn: path.join(dir, 'cn.json'), global: path.join(dir, 'global.json') },
      })
      for (const uid of ['a', 'b', 'c']) {
        await store.poolFor('cn').upsert({
          accessToken: 't',
          refreshToken: 'r',
          expiresAtMs: Date.now() + 3_600_000,
          domain: 'www.codebuddy.cn',
          uid,
          source: 'pool',
          region: 'cn',
        })
      }

      let inFlight = 0
      let peak = 0
      let probes = 0
      const fakeClient = {
        async fetchCredits() {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise(resolve => setTimeout(resolve, 20))
          inFlight--
          return { accounts: [], totalBalance: 5 }
        },
        async probeModel() {
          probes++
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise(resolve => setTimeout(resolve, 20))
          inFlight--
          return { verdict: 'ok' as const, elapsedMs: 1, checkedAt: Date.now() }
        },
      }
      const { workBuddyAccountsView, workBuddyAccountsRefresh, createAccountRouteState } = await import('../src/account-route.ts')
      const state = createAccountRouteState()

      // Five polls in a row, like a panel that re-reads while waiting.
      await Promise.all(Array.from({ length: 5 }, () => workBuddyAccountsRefresh({ store, client: fakeClient as never }, state)))
      const view = await workBuddyAccountsView({ store, client: fakeClient as never }, state)

      // Three accounts, one probe each: polling must not multiply requests.
      expect(probes).toBe(3)
      expect(peak).toBeLessThanOrEqual(3)
      expect(view.cn.accounts.every(account => account.probe?.verdict === 'ok')).toBe(true)
      expect(view.cn.accounts.every(account => account.credits === 5)).toBe(true)
      expect(view.cn.refreshing).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
