/**
 * WorkBuddy's hosted search and fetch endpoints (`/agenttool/v1/*`).
 *
 * The desktop clients already talk to these, so a WorkBuddy sign-in is enough:
 * no extra key, no separate vendor account. Both regions answer on the host
 * their chat traffic uses, with the same bearer token and the same headers.
 */

import { randomUUID } from 'node:crypto'
import type { WorkBuddyCredential, WorkBuddyRegion } from './types.ts'

export type AgentToolErrorKind = 'auth' | 'client' | 'server' | 'timeout' | 'aborted'

/** Why one `agenttool` call failed; `kind` drives the Harness retry policy. */
export class AgentToolError extends Error {
  readonly kind: AgentToolErrorKind
  readonly status: number

  constructor(message: string, kind: AgentToolErrorKind, status = 0) {
    super(message)
    this.name = 'AgentToolError'
    this.kind = kind
    this.status = status
  }
}

export interface AgentToolSearchResult {
  sources: Array<{ url: string; title?: string; snippet?: string }>
  truncated: boolean
}

export interface AgentToolFetchResult {
  url: string
  title?: string
  content: string
  contentType?: string
}

const SEARCH_PATH = '/agenttool/v1/search'
const FETCH_PATH = '/agenttool/v1/webfetch'

const SEARCH_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 60_000

/** The upstream already caps a search at five hits; keep the default aligned. */
export const AGENT_TOOL_DEFAULT_MAX_RESULTS = 5

/** Response bodies are small; this only bounds a pathological error page. */
const ERROR_BODY_LIMIT = 512

function agentToolBase(region: WorkBuddyRegion): string {
  return region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
}

/**
 * Headers the hosted tools expect.
 *
 * The gateway routes on the conversation triple, so each call mints its own.
 * `X-Agent-Intent: craft` is what the desktop app sends for a normal turn; the
 * tool endpoints reject an unknown intent.
 */
function toolHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const callId = randomUUID()
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': callId,
    'X-Request-ID': callId,
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-Domain': credential.domain || (credential.region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
    ...(credential.uid ? { 'X-User-Id': credential.uid } : {}),
    ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId } : {}),
  }
}

function classifyTransportError(error: unknown, signal: AbortSignal | undefined): AgentToolError {
  if (signal?.aborted === true) return new AgentToolError('agenttool: request aborted', 'aborted')
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new AgentToolError('agenttool: upstream timed out', 'timeout')
  }
  return new AgentToolError(`agenttool: transport error: ${String(error)}`, 'server')
}

async function postJson(
  credential: WorkBuddyCredential,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  if (signal?.aborted === true) throw new AgentToolError('agenttool: request aborted', 'aborted')

  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response: Response
  try {
    response = await fetch(`${agentToolBase(credential.region)}${path}`, {
      method: 'POST',
      headers: toolHeaders(credential),
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    throw classifyTransportError(error, signal)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const lane = credential.region === 'global' ? 'Global' : 'CN'
    const kind: AgentToolErrorKind = response.status === 401 || response.status === 403
      ? 'auth'
      : response.status >= 500 ? 'server' : 'client'
    // A 403 with the CN domain-routing code is a policy refusal, not a broken
    // token; naming it keeps the agent from retrying or blaming the sign-in.
    if (text.includes('routing policy') || text.includes('15021')) {
      throw new AgentToolError(
        `WorkBuddy ${lane} refused to read ${path === FETCH_PATH ? 'this domain' : 'this host'} by routing policy. Switch to the other lane or another URL.`,
        'client',
        response.status,
      )
    }
    throw new AgentToolError(
      `agenttool ${path} failed with HTTP ${response.status}: ${text.slice(0, ERROR_BODY_LIMIT)}`,
      kind,
      response.status,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new AgentToolError(`agenttool ${path} returned unreadable JSON: ${String(error)}`, 'server', response.status)
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new AgentToolError(`agenttool ${path} returned a non-object body`, 'server', response.status)
  }
  const record = payload as Record<string, unknown>
  // A business error rides inside a 200; `code: 0` never appears on success.
  if (typeof record['code'] === 'number' && record['code'] !== 0) {
    const msg = typeof record['msg'] === 'string' ? record['msg'] : 'unknown upstream error'
    const kind: AgentToolErrorKind = record['code'] === 401 ? 'auth' : 'server'
    throw new AgentToolError(`agenttool ${path} returned code ${record['code']}: ${msg}`, kind, response.status)
  }
  return record
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Turn a `text2text` search answer into citeable sources.
 *
 * Entries without a URL carry nothing a model can cite, and the same page can
 * appear twice, so both are dropped before the result cap applies.
 */
export function parseAgentToolSearch(payload: Record<string, unknown>, maxResults?: number): AgentToolSearchResult {
  const rows = Array.isArray(payload['results']) ? payload['results'] : []
  const seen = new Set<string>()
  const sources: AgentToolSearchResult['sources'] = []

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    const url = stringOrUndefined(item['url'])
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = stringOrUndefined(item['title'])
    const snippet = stringOrUndefined(item['snippet'])
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
    })
  }

  const limit = typeof maxResults === 'number' && maxResults > 0 ? maxResults : sources.length
  return { sources: sources.slice(0, limit), truncated: sources.length > limit }
}

export function parseAgentToolFetch(payload: Record<string, unknown>): AgentToolFetchResult {
  const url = stringOrUndefined(payload['url'])
  if (url === undefined) throw new AgentToolError('agenttool webfetch returned no url', 'server')
  const content = typeof payload['content'] === 'string' ? payload['content'] : ''
  if (content.trim().length === 0) {
    throw new AgentToolError(`agenttool webfetch returned no readable content for ${url}`, 'client')
  }
  const title = stringOrUndefined(payload['title'])
  const contentType = stringOrUndefined(payload['content_type'])
  return {
    url,
    content,
    ...(title === undefined ? {} : { title }),
    ...(contentType === undefined ? {} : { contentType }),
  }
}

export interface AgentToolClient {
  search(credential: WorkBuddyCredential, query: string, maxResults: number | undefined, signal: AbortSignal | undefined): Promise<AgentToolSearchResult>
  fetch(credential: WorkBuddyCredential, url: string, signal: AbortSignal | undefined): Promise<AgentToolFetchResult>
}

export function createAgentToolClient(): AgentToolClient {
  return {
    async search(credential, query, maxResults, signal) {
      const body = {
        query,
        type: 'text2text',
        max_results: typeof maxResults === 'number' && maxResults > 0 ? maxResults : AGENT_TOOL_DEFAULT_MAX_RESULTS,
      }
      const payload = await postJson(credential, SEARCH_PATH, body, SEARCH_TIMEOUT_MS, signal)
      return parseAgentToolSearch(payload, maxResults)
    },
    async fetch(credential, url, signal) {
      const body = { url, format: 'markdown', timeout: Math.floor(FETCH_TIMEOUT_MS / 1000), max_length: 60_000 }
      const payload = await postJson(credential, FETCH_PATH, body, FETCH_TIMEOUT_MS, signal)
      return parseAgentToolFetch(payload)
    },
  }
}
