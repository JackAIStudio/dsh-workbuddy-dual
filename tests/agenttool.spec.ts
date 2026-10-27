import { describe, expect, it } from 'vitest'
import { createAgentToolClient, parseAgentToolFetch, parseAgentToolSearch } from '../src/agenttool.ts'
import { createWorkBuddyNativeWeb } from '../src/native-web.ts'
import type { WorkBuddyDualCredentialStore } from '../src/auth.ts'
import type { WorkBuddyCredential, WorkBuddyRegion } from '../src/types.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'token-1',
  refreshToken: 'refresh-1',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.workbuddy.ai',
  uid: 'uid-1',
  source: 'pool',
  region: 'global',
}

describe('parseAgentToolSearch', () => {
  it('keeps citeable sources, drops duplicates and applies the cap', () => {
    const result = parseAgentToolSearch({
      provider: '0',
      results: [
        { title: 'A', url: 'https://a.example', snippet: 'aa' },
        { title: 'A again', url: 'https://a.example' },
        { title: 'No url' },
        { title: 'B', url: 'https://b.example' },
      ],
    }, 1)

    expect(result.sources).toEqual([{ url: 'https://a.example', title: 'A', snippet: 'aa' }])
    expect(result.truncated).toBe(true)
  })

  it('returns an empty result rather than throwing on a shapeless answer', () => {
    expect(parseAgentToolSearch({})).toEqual({ sources: [], truncated: false })
  })
})

describe('parseAgentToolFetch', () => {
  it('normalises the hosted reader answer', () => {
    const page = parseAgentToolFetch({
      url: 'https://example.com',
      title: 'Example',
      content: '# hi',
      content_type: 'text/markdown',
    })
    expect(page).toEqual({
      url: 'https://example.com',
      content: '# hi',
      title: 'Example',
      contentType: 'text/markdown',
    })
  })

  it('rejects a page without readable content', () => {
    expect(() => parseAgentToolFetch({ url: 'https://example.com', content: '   ' })).toThrow(/no readable content/u)
  })
})

describe('createWorkBuddyNativeWeb', () => {
  function storeWith(read: (region: WorkBuddyRegion) => WorkBuddyCredential | undefined, tokens: string[] = ['token-1']) {
    const store = {
      storeFor(region: WorkBuddyRegion) {
        return {
          async current() {
            const current = read(region)
            if (current === undefined) return undefined
            if (tokens.length > 1) return { ...current, accessToken: tokens.shift()! }
            return current
          },
        }
      },
    }
    return store as unknown as WorkBuddyDualCredentialStore
  }

  it('uses the credential of the region the model runs in', async () => {
    const seen: WorkBuddyRegion[] = []
    const web = createWorkBuddyNativeWeb({
      store: storeWith(region => ({ ...credential, region, accessToken: `${region}-token` })),
      client: {
        async search(cred, query) {
          seen.push(cred.region)
          expect(query).toBe('trimmed')
          expect(cred.accessToken).toBe('cn-token')
          return { sources: [], truncated: false }
        },
        async fetch() {
          throw new Error('unused')
        },
      },
    })

    await web.search.search('  trimmed  ', { region: 'cn' })
    expect(seen).toEqual(['cn'])
  })

  it('falls back to the region of the current model when the caller omits one', async () => {
    let used: WorkBuddyRegion | undefined
    const web = createWorkBuddyNativeWeb({
      store: storeWith(region => ({ ...credential, region })),
      client: {
        async search(cred) {
          used = cred.region
          return { sources: [], truncated: false }
        },
        async fetch() {
          throw new Error('unused')
        },
      },
      resolveRegion: () => 'cn',
    })

    await web.search.search('q')
    expect(used).toBe('cn')
  })

  it('retries once with a renewed token after an auth failure', async () => {
    const web = createWorkBuddyNativeWeb({
      store: storeWith(() => credential, ['expired-token', 'fresh-token']),
      client: {
        async search(cred) {
          if (cred.accessToken === 'expired-token') {
            const { AgentToolError } = await import('../src/agenttool.ts')
            throw new AgentToolError('401', 'auth', 401)
          }
          return { sources: [{ url: 'https://example.com' }], truncated: false }
        },
        async fetch() {
          throw new Error('unused')
        },
      },
    })

    const result = await web.search.search('q', { region: 'global' })
    expect(result.sources).toHaveLength(1)
  })

  it('explains what to do when the region has no signed-in account', async () => {
    const web = createWorkBuddyNativeWeb({
      store: storeWith(() => undefined),
      client: createAgentToolClient(),
    })

    await expect(web.fetch.fetch('https://example.com', { region: 'global' })).rejects.toThrow(/Sign in/u)
  })
})

describe('createAgentToolClient', () => {
  it('names a CN routing-policy refusal instead of reporting a generic 403', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ code: 15021, msg: 'edgebrowser: API error: domain rejected by via routing policy' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
    try {
      const client = createAgentToolClient()
      await expect(client.fetch(credential, 'https://www.anthropic.com/pricing', undefined)).rejects.toThrow(
        /WorkBuddy Global refused to read this domain by routing policy/u,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
