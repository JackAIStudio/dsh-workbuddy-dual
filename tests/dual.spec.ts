import { describe, expect, it } from 'vitest'
import { WorkBuddyDualCatalog } from '../src/catalog.ts'
import { defaultDesktopCandidatesFor, parseWorkBuddyAuth } from '../src/auth.ts'
import { createWorkBuddyDualShim } from '../src/shim.ts'
import { WorkBuddyDualCredentialStore } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

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
