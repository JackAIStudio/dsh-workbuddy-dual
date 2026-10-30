import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyDualCredentialStore } from '../src/auth.ts'
import { WorkBuddyHealthStore, cooldownFor, healthKey } from '../src/health.ts'
import { WorkBuddySessionAffinity, candidateKey, planRoute, routeOverview } from '../src/router.ts'
import { createWorkBuddyDualShim, verdictForFailure } from '../src/shim.ts'
import { WorkBuddyDualCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/types.ts'

const FLASH = 'deepseek-v4.1-flash'

let dir = ''

function credential(region: 'cn' | 'global', uid: string): WorkBuddyCredential {
  return {
    accessToken: `token-${uid}`,
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: region === 'cn' ? 'www.codebuddy.cn' : 'www.workbuddy.ai',
    uid,
    source: 'pool',
    region,
  }
}

async function buildStore(): Promise<WorkBuddyDualCredentialStore> {
  const store = new WorkBuddyDualCredentialStore({
    refreshCN: async () => ({ accessToken: 'x' }),
    refreshGlobal: async () => ({ accessToken: 'x' }),
    // Never touch the developer's real sign-ins.
    cnPathOverride: join(dir, 'no-cn.info'),
    globalPathOverride: join(dir, 'no-global.info'),
    poolPaths: { cn: join(dir, 'cn.json'), global: join(dir, 'global.json') },
  })
  return store
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workbuddy-router-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('automatic account routing', () => {
  it('prefers a CN account that can run flash, even when Global holds more credits', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))
    await store.poolFor('global').upsert(credential('global', 'gl-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const balances: Record<string, number> = { 'cn/cn-a': 179, 'global/gl-a': 1398 }
    const order = await planRoute(
      {
        store,
        client: { refreshToken: async () => ({ accessToken: 'x' }) } as never,
        health,
        credits: (region, uid) => balances[`${region}/${uid}`],
      },
      new WorkBuddySessionAffinity(),
      { model: FLASH },
    )

    // The user's rule is CN first; a larger balance elsewhere does not outrank it.
    expect(order.map(candidate => candidateKey(candidate.region, candidate.uid))).toEqual(['cn/cn-a', 'global/gl-a'])
  })

  it('skips a cooling down CN account before it spends a Global one', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-hot'))
    await store.poolFor('cn').upsert(credential('cn', 'cn-ok'))
    await store.poolFor('global').upsert(credential('global', 'gl-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    await health.record('cn', 'cn-hot', FLASH, 'rate-limited', { resetsAtMs: Date.now() + 3_600_000 })

    const balances: Record<string, number> = { 'cn/cn-hot': 5000, 'cn/cn-ok': 120, 'global/gl-a': 1398 }
    const order = await planRoute(
      {
        store,
        client: { refreshToken: async () => ({ accessToken: 'x' }) } as never,
        health,
        credits: (region, uid) => balances[`${region}/${uid}`],
      },
      new WorkBuddySessionAffinity(),
      { model: FLASH },
    )

    // Health outranks balance: the 5000-credit account is out until 6004 lifts.
    expect(order.map(candidate => candidate.uid)).toEqual(['cn-ok', 'gl-a'])
  })

  it('keeps a conversation on the account it started with', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))
    await store.poolFor('cn').upsert(credential('cn', 'cn-b'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const balances: Record<string, number> = { 'cn/cn-a': 100, 'cn/cn-b': 200 }
    const affinity = new WorkBuddySessionAffinity()
    const options = {
      store,
      client: { refreshToken: async () => ({ accessToken: 'x' }) } as never,
      health,
      credits: (region: 'cn' | 'global', uid: string) => balances[`${region}/${uid}`],
    }

    // The richer account wins the first turn.
    const first = await planRoute(options, affinity, { model: FLASH, sessionKey: 's1' })
    expect(first[0]?.uid).toBe('cn-b')
    affinity.remember('s1', 'cn', 'cn-b')

    // Balance changes must not move a running conversation to another account.
    balances['cn/cn-a'] = 9999
    const again = await planRoute(options, affinity, { model: FLASH, sessionKey: 's1' })
    expect(again[0]?.uid).toBe('cn-b')

    // A different conversation is free to take the better account.
    const other = await planRoute(options, affinity, { model: FLASH, sessionKey: 's2' })
    expect(other[0]?.uid).toBe('cn-a')
  })

  it('returns a conversation to CN as soon as CN has an account again', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))
    await store.poolFor('global').upsert(credential('global', 'gl-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    await health.record('cn', 'cn-a', FLASH, 'rate-limited', { resetsAtMs: Date.now() + 600_000 })

    const affinity = new WorkBuddySessionAffinity()
    const options = {
      store,
      client: { refreshToken: async () => ({ accessToken: 'x' }) } as never,
      health,
      credits: () => 100,
    }

    // While CN is blocked the conversation runs on Global.
    const blocked = await planRoute(options, affinity, { model: FLASH, sessionKey: 's1' })
    expect(blocked[0]?.region).toBe('global')
    affinity.remember('s1', 'global', 'gl-a')

    // CN frees up: it wins again, because its credits can be replenished.
    await health.record('cn', 'cn-a', FLASH, 'ok')
    const recovered = await planRoute(options, affinity, { model: FLASH, sessionKey: 's1' })
    expect(recovered[0]?.region).toBe('cn')
  })

  it('does not cross lanes for a model only one side serves', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))
    await store.poolFor('global').upsert(credential('global', 'gl-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const order = await planRoute(
      {
        store,
        client: { refreshToken: async () => ({ accessToken: 'x' }) } as never,
        health,
        credits: () => 100,
        hasModel: (region, model) => region === 'cn' && model === 'kimi-k3-1',
      },
      new WorkBuddySessionAffinity(),
      { model: 'kimi-k3-1' },
    )
    expect(order.map(candidate => candidate.region)).toEqual(['cn'])
  })

  it('tries a new account before writing it off for an unknown balance', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-known'))
    await store.poolFor('cn').upsert(credential('cn', 'cn-new'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const order = await planRoute(
      {
        store,
        client: { refreshToken: async () => ({ accessToken: 'x' }) } as never,
        health,
        // cn-known is nearly empty; cn-new has never been billed yet.
        credits: (_region, uid) => (uid === 'cn-known' ? 1 : undefined),
      },
      new WorkBuddySessionAffinity(),
      { model: FLASH },
    )
    expect(order[0]?.uid).toBe('cn-new')
  })

  it('reports the earliest recovery when every account is blocked', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))
    await store.poolFor('global').upsert(credential('global', 'gl-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const sooner = Date.now() + 600_000
    const later = Date.now() + 3_600_000
    await health.record('cn', 'cn-a', FLASH, 'rate-limited', { resetsAtMs: later })
    await health.record('global', 'gl-a', FLASH, 'rate-limited', { resetsAtMs: sooner })

    const view = await routeOverview(
      { store, client: { refreshToken: async () => ({ accessToken: 'x' }) } as never, health },
      FLASH,
    )
    expect(view.order).toEqual([])
    expect(view.blocked).toHaveLength(2)
    expect(view.nextRecoveryMs).toBe(sooner)
  })

  it('treats a clamped cooldown sanely and forgets a verdict once it expires', async () => {
    const now = Date.now()
    // An absurd reset time cannot park an account for a week.
    expect(cooldownFor('rate-limited', now + 30 * 24 * 3_600_000, now)).toBe(now + 60_000)
    // The gateway's own moment is used when it is plausible.
    const stated = now + 7_200_000
    expect(cooldownFor('rate-limited', stated, now)).toBe(stated)

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    await health.record('cn', 'u', FLASH, 'rate-limited', { resetsAtMs: now + 60_000 })
    expect(await health.isBlocked('cn', 'u', FLASH)).toBe(true)
    expect(await health.isBlocked('cn', 'u', 'gpt-6-astra')).toBe(false)
    await health.record('cn', 'u', FLASH, 'ok')
    expect(await health.isBlocked('cn', 'u', FLASH)).toBe(false)
  })

  it('survives a restart so a relaunch does not retry the blocked account', async () => {
    const path = join(dir, 'health.json')
    const resetsAtMs = Date.now() + 7_200_000
    const first = new WorkBuddyHealthStore({ path })
    await first.record('cn', 'cn-a', FLASH, 'rate-limited', { resetsAtMs })

    const second = new WorkBuddyHealthStore({ path })
    expect(await second.isBlocked('cn', 'cn-a', FLASH)).toBe(true)
    expect((await second.get('cn', 'cn-a', FLASH))?.cooldownUntilMs).toBe(resetsAtMs)

    const doc = JSON.parse(await readFile(path, 'utf8')) as { entries: Record<string, unknown> }
    expect(Object.keys(doc.entries)).toEqual([healthKey('cn', 'cn-a', FLASH)])
  })

  it('reads a ban written before the permanent flag as permanent', async () => {
    // Older builds stored a ban with a 24-hour cooldown and no flag. Upgrading
    // must not hand that account back to the router when the cooldown expires.
    const fs = await import('node:fs/promises')
    const path = join(dir, 'legacy-health.json')
    await fs.writeFile(path, JSON.stringify({
      version: 1,
      entries: {
        [healthKey('global', 'old-ban', FLASH)]: {
          verdict: 'banned',
          cooldownUntilMs: Date.now() + 3_600_000,
          checkedAt: Date.now() - 1_000,
        },
      },
      updatedAt: Date.now(),
    }))
    const health = new WorkBuddyHealthStore({ path })
    expect(await health.isPermanent('global', 'old-ban', FLASH)).toBe(true)
    // Even well past the stale cooldown, the ban still holds.
    const later = new WorkBuddyHealthStore({ path, now: () => Date.now() + 30 * 24 * 3_600_000 })
    expect(await later.isBlocked('global', 'old-ban', FLASH)).toBe(true)
  })

  it('never shortens an existing block with a second bare 429', async () => {
    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const long = Date.now() + 7_200_000
    await health.record('cn', 'u', FLASH, 'rate-limited', { resetsAtMs: long })
    await health.record('cn', 'u', FLASH, 'rate-limited')
    expect((await health.get('cn', 'u', FLASH))?.cooldownUntilMs).toBe(long)
  })
})

describe('shim switches accounts before answering', () => {
  function sseBlocked(): Response {
    const body = `data: {"code":6004,"msg":"usage exceeds frequency limit, your usage will reset at 2099-01-01 00:00:00 UTC+8"}\n\n`
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }), { status: 200 })
  }

  function sseOk(text: string): Response {
    const body = `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }), { status: 200 })
  }

  it('retries on the next account when the first answers 6004 inside a 200 stream', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-blocked'))
    await store.poolFor('global').upsert(credential('global', 'gl-ok'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const calls: string[] = []
    const client = {
      async refreshToken() { return { accessToken: 'x' } },
      async chatStream(cred: WorkBuddyCredential) {
        calls.push(`${cred.region}/${cred.uid}`)
        return cred.uid === 'cn-blocked'
          ? { ok: true as const, response: sseBlocked() }
          : { ok: true as const, response: sseOk('hello') }
      },
    }

    const catalog = new WorkBuddyDualCatalog()
    const shim = createWorkBuddyDualShim({
      store,
      client: client as never,
      catalog,
      route: {
        router: {
          store,
          client: client as never,
          health,
          credits: (region, uid) => (uid === 'cn-blocked' ? 5000 : 100),
        },
        affinity: new WorkBuddySessionAffinity(),
        crossLaneFrom: 'cn',
      },
    })

    await shim.ready
    try {
      const response = await fetch(`${shim.origin}/cn/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-affinity': 's1' },
        body: JSON.stringify({ model: FLASH, messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-workbuddy-account')).toBe('global/gl-ok')
      // The client sees the healthy stream, not the 6004 frame that would have
      // stalled the harness after its 200 header went out.
      expect(await response.text()).toContain('hello')
      expect(calls).toEqual(['cn/cn-blocked', 'global/gl-ok'])

      // The blocked account is remembered for this model, not for every model.
      expect(await health.isBlocked('cn', 'cn-blocked', FLASH)).toBe(true)
      expect(await health.isBlocked('cn', 'cn-blocked', 'gpt-6-astra')).toBe(false)
    } finally {
      await shim.close()
    }
  })

  it('returns 429 with the next recovery when no account is left', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const resetsAtMs = Date.now() + 1_800_000
    await health.record('cn', 'cn-a', FLASH, 'rate-limited', { resetsAtMs })

    let calls = 0
    const client = {
      async refreshToken() { return { accessToken: 'x' } },
      async chatStream() { calls++; return { ok: true as const, response: sseOk('unexpected') } },
    }
    const shim = createWorkBuddyDualShim({
      store,
      client: client as never,
      catalog: new WorkBuddyDualCatalog(),
      route: {
        router: { store, client: client as never, health, credits: () => 10 },
        affinity: new WorkBuddySessionAffinity(),
        crossLaneFrom: 'cn',
      },
    })

    await shim.ready
    try {
      const response = await fetch(`${shim.origin}/cn/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: FLASH, messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(response.status).toBe(429)
      const payload = (await response.json()) as { error: { message: string; type: string } }
      expect(payload.error.type).toBe('rate_limit_error')
      // The body names when to come back, so the harness can wait instead of
      // guessing and the user keeps the prompt.
      expect(payload.error.message).toContain(new Date(resetsAtMs).toISOString())
      expect(calls).toBe(0)
    } finally {
      await shim.close()
    }
  })

  it('waits out a cooldown that lifts within the turn instead of failing', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    // Half a second is a stand-in for a limit that is about to clear.
    await health.record('cn', 'cn-a', FLASH, 'rate-limited', { resetsAtMs: Date.now() + 400 })

    const client = {
      async refreshToken() { return { accessToken: 'x' } },
      async chatStream() { return { ok: true as const, response: sseOk('after the wait') } },
    }
    const shim = createWorkBuddyDualShim({
      store,
      client: client as never,
      catalog: new WorkBuddyDualCatalog(),
      route: {
        router: { store, client: client as never, health, credits: () => 10 },
        affinity: new WorkBuddySessionAffinity(),
        crossLaneFrom: 'cn',
      },
    })

    await shim.ready
    try {
      const response = await fetch(`${shim.origin}/cn/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: FLASH, messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('after the wait')
    } finally {
      await shim.close()
    }
  })
})

describe('panel probes feed the router', () => {
  it('makes a checked verdict apply to the next request', async () => {
    const store = await buildStore()
    await store.poolFor('cn').upsert(credential('cn', 'cn-a'))

    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const resetsAtMs = Date.now() + 3_600_000
    const { createAccountRouteState, workBuddyAccountsRefresh } = await import('../src/account-route.ts')
    const state = createAccountRouteState()
    state.onProbe = async (region, uid, model, probe) => {
      await health.record(region, uid, model, probe.verdict, {
        ...(probe.resetsAtMs === undefined ? {} : { resetsAtMs: probe.resetsAtMs }),
      })
    }

    const fakeClient = {
      async fetchCredits() { return { accounts: [], totalBalance: 42 } },
      async probeModel() {
        return { verdict: 'rate-limited' as const, code: '6004', resetsAtMs, elapsedMs: 1, checkedAt: Date.now() }
      },
    }
    await workBuddyAccountsRefresh({ store, client: fakeClient as never }, state)

    // The row's verdict is now the router's verdict: the next turn will not
    // waste a request discovering the same 6004 again.
    expect(await health.isBlocked('cn', 'cn-a', FLASH)).toBe(true)
    expect((await health.get('cn', 'cn-a', FLASH))?.cooldownUntilMs).toBe(resetsAtMs)
  })
})

describe('failure classification', () => {
  it('reads the business code, not just the HTTP status', () => {
    // Global answers a banned account with 403; filing that as an expired
    // sign-in would retry a permanently dead account every half hour.
    expect(verdictForFailure('auth', '{"code":11140,"msg":"request illegal"}')).toBe('banned')
    expect(verdictForFailure('rate', '{"code":6004,"msg":"频率限制"}')).toBe('rate-limited')
    expect(verdictForFailure('client', '{"code":14018,"msg":"insufficient credit"}')).toBe('no-credit')
    // A bare status still classifies, since not every failure carries a code.
    expect(verdictForFailure('rate', 'too many requests')).toBe('rate-limited')
    expect(verdictForFailure('auth', 'token expired')).toBe('auth')
  })

  it('keeps a banned account out of rotation for good', async () => {
    const health = new WorkBuddyHealthStore({ path: join(dir, 'health.json') })
    const store = await buildStore()
    await store.poolFor('global').upsert(credential('global', 'banned-a'))
    await health.record('global', 'banned-a', FLASH, 'banned')

    // No timer brings it back: the gateway's ban is not a cooldown.
    expect(await health.isBlocked('global', 'banned-a', FLASH)).toBe(true)
    expect(await health.isPermanent('global', 'banned-a', FLASH)).toBe(true)

    // A day later it is still out, unlike a rate limit.
    const later = new WorkBuddyHealthStore({
      path: join(dir, 'health.json'),
      now: () => Date.now() + 7 * 24 * 3_600_000,
    })
    expect(await later.isBlocked('global', 'banned-a', FLASH)).toBe(true)

    // It is not counted as "recovering soon", so a request will not wait on it.
    const overview = await routeOverview(
      { store, client: { refreshToken: async () => ({ accessToken: 'x' }) } as never, health },
      FLASH,
    )
    expect(overview.blocked.map(e => e.uid)).not.toContain('banned-a')
    expect(overview.disabled.map(e => e.uid)).toContain('banned-a')
  })
})
