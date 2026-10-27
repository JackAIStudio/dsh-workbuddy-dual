/**
 * WorkBuddy's hosted search and fetch, exposed as Harness services.
 *
 * `dsh-web-search-follow` picks its backend from the session's current model.
 * WorkBuddy models reach the Harness through this plugin, so the hosted tools
 * belong here: the same sign-in, the same region, and the same account that
 * pays for the turn. Exposing two small services keeps the routing decision in
 * one place (`dsh-web-search-follow`) and the vendor call in another.
 *
 * `available()` answers from local state only: the Harness resolves providers
 * on every call, so a network probe here would add latency to every turn.
 */

import type { Context } from '@deepseek-ai/cordis'
import { AgentToolError, type AgentToolClient, type AgentToolFetchResult, type AgentToolSearchResult } from './agenttool.ts'
import type { WorkBuddyDualCredentialStore } from './auth.ts'
import type { WorkBuddyCredential, WorkBuddyRegion } from './types.ts'

export const WORKBUDDY_NATIVE_SEARCH_SERVICE = 'workbuddyNativeSearch'
export const WORKBUDDY_NATIVE_FETCH_SERVICE = 'workbuddyNativeFetch'

/** Search and fetch are advertised for both provider ids this plugin registers. */
export const WORKBUDDY_SEARCH_PROVIDERS: readonly string[] = ['workbuddy-cn', 'workbuddy-global']

export interface WorkBuddyNativeSearch {
  available(): boolean
  search(query: string, options?: { region?: WorkBuddyRegion; model?: string; maxResults?: number; signal?: AbortSignal }): Promise<AgentToolSearchResult>
}

export interface WorkBuddyNativeFetch {
  available(): boolean
  fetch(url: string, options?: { region?: WorkBuddyRegion; signal?: AbortSignal }): Promise<AgentToolFetchResult>
}

export interface WorkBuddyNativeWebOptions {
  store: WorkBuddyDualCredentialStore
  client: AgentToolClient
  /** Region of the model this turn is running, so one credential serves both. */
  resolveRegion?: () => WorkBuddyRegion | undefined
  logger?: { warn: (message: string, ...args: unknown[]) => void }
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof AgentToolError && error.kind === 'auth'
}

/**
 * Resolve the credential a hosted tool should spend.
 *
 * A stale token surfaces as 401 on the tool endpoint even though the model
 * stream refreshed it moments ago, so one retry against a freshly resolved
 * credential saves the whole call. `current()` already refreshes near expiry.
 */
async function withCredential<T>(
  options: WorkBuddyNativeWebOptions,
  region: WorkBuddyRegion | undefined,
  run: (credential: WorkBuddyCredential, region: WorkBuddyRegion) => Promise<T>,
): Promise<T> {
  const preferred = region ?? options.resolveRegion?.() ?? 'global'
  const store = options.store.storeFor(preferred)
  const credential = await store.current()
  if (credential === undefined) {
    throw new Error(
      `dsh-workbuddy-dual: WorkBuddy ${preferred === 'global' ? 'Global' : 'CN'} has no signed-in account, so its web tools cannot run. Sign in from the plugin settings first.`,
    )
  }
  try {
    return await run(credential, preferred)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await store.current()
    if (refreshed === undefined || refreshed.accessToken === credential.accessToken) throw error
    options.logger?.warn(`dsh-workbuddy-dual: retrying ${preferred} web tool with a renewed token`)
    return await run(refreshed, preferred)
  }
}

export function createWorkBuddyNativeWeb(options: WorkBuddyNativeWebOptions): {
  search: WorkBuddyNativeSearch
  fetch: WorkBuddyNativeFetch
} {
  const search: WorkBuddyNativeSearch = {
    available() {
      return true
    },
    async search(query, searchOptions) {
      const optionsOfCall = searchOptions ?? {}
      const trimmed = query.trim()
      if (trimmed.length === 0) throw new Error('workbuddy web search: query must be non-empty')
      return withCredential(options, optionsOfCall.region, (credential) =>
        options.client.search(credential, trimmed, optionsOfCall.maxResults, optionsOfCall.signal),
      )
    },
  }

  const fetchApi: WorkBuddyNativeFetch = {
    available() {
      return true
    },
    async fetch(url, fetchOptions) {
      const optionsOfCall = fetchOptions ?? {}
      const trimmed = url.trim()
      if (trimmed.length === 0) throw new Error('workbuddy web fetch: url must be non-empty')
      return withCredential(options, optionsOfCall.region, (credential) =>
        options.client.fetch(credential, trimmed, optionsOfCall.signal),
      )
    },
  }

  return { search, fetch: fetchApi }
}

/** Publish both services on the plugin context, the way `dsh-grok-oauth` does. */
export function provideWorkBuddyNativeWeb(ctx: Context, web: {
  search: WorkBuddyNativeSearch
  fetch: WorkBuddyNativeFetch
}): void {
  const provide = (key: string, value: unknown): void => {
    if (typeof ctx.provide === 'function') ctx.provide(key, value)
    else (ctx as unknown as Record<string, unknown>)[key] = value
  }
  provide(WORKBUDDY_NATIVE_SEARCH_SERVICE, web.search)
  provide(WORKBUDDY_NATIVE_FETCH_SERVICE, web.fetch)
}
