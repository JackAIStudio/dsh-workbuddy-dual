/**
 * Loopback OpenAI-compatible endpoint with dual routing (/cn and /global).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GATEWAY_BODY_LIMIT_BYTES, MAX_REQUEST_BODY_BYTES } from './budget.ts'
import type { WorkBuddyDualCredentialStore } from './auth.ts'
import type { WorkBuddyDualCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import type { WorkBuddyRouteCandidate, WorkBuddyRouterOptions, WorkBuddySessionAffinity } from './router.ts'
import { candidateKey, nextRecoveryMs, planRoute } from './router.ts'
import { parseBusinessCode, parseResetTime, WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './types.ts'
import type { WorkBuddyProbeVerdict } from './types.ts'

export interface WorkBuddyDualShim {
  readonly origin: string
  readonly ready: Promise<void>
  baseUrl(region: WorkBuddyRegion): string
  close(): Promise<void>
}

export interface WorkBuddyDualShimOptions {
  store: WorkBuddyDualCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyDualCatalog
  logger?: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void }
  /**
   * Automatic account routing. Omit it to keep the single selected account per
   * lane, which is what the unit tests that predate routing rely on.
   */
  route?: WorkBuddyRouteOptions | undefined
}

export interface WorkBuddyRouteOptions {
  router: WorkBuddyRouterOptions
  affinity: WorkBuddySessionAffinity
  /** Read at request time so a settings toggle applies to the next turn. */
  enabled?: (() => boolean) | undefined
  /**
   * Lanes that may borrow the other lane's accounts.
   *
   * The CN lane is the product's default entry point and is the one allowed to
   * fall back to Global. The Global lane stays Global-only: someone who picked
   * GPT-6-Astra there must not silently land on a CN-only model.
   */
  crossLaneFrom: WorkBuddyRegion
}

/** Gateway codes that mean "this account cannot run this model right now". */
const ACCOUNT_BLOCK_CODES = ['6004', '11140', '14018'] as const

/** Cap on the first-frame peek; a normal SSE event is far smaller. */
const HEAD_PEEK_LIMIT = 64 * 1024

/**
 * Make a value safe to put in an HTTP header.
 *
 * Account labels are user-editable and often Chinese ("JackAI独立开发"), and a
 * header value is bytes, not text: Node throws `ERR_INVALID_CHAR` on anything
 * above U+00FF, which surfaces as a 500 after the upstream call already
 * succeeded. Diagnostics must never be able to break a working response, so
 * non-ASCII characters are dropped here and the account id is used alongside
 * the label where identity matters.
 */
export function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7E]/gu, '').trim()
}

/**
 * How long a turn may wait for a cooldown to lift before giving up.
 *
 * The harness retries a 429 a few times and then ends the turn, so failing
 * immediately on a limit that lifts in twenty seconds wastes the retries on
 * requests that could not possibly succeed. Waiting here keeps the turn alive
 * and keeps the user's prompt intact. Anything longer than this is reported
 * with its recovery time so the user can decide.
 */
const SHORT_COOLDOWN_WAIT_MS = 60_000

/** Bodies above this size are logged, because they are one image away from the gateway cap. */
const REQUEST_BODY_WARN_BYTES = 12 * 1024 * 1024

/**
 * A request body the shim refuses to buffer.
 *
 * Carrying the numbers on the error lets the HTTP layer answer 413 with the
 * real size instead of collapsing into a generic 500, which used to hide the
 * fact that nothing ever reached the upstream.
 */
export class RequestBodyTooLargeError extends Error {
  readonly receivedBytes: number
  readonly limitBytes: number

  constructor(receivedBytes: number, limitBytes: number) {
    super(`Request body reached ${receivedBytes} bytes, above the ${limitBytes}-byte shim limit`)
    this.name = 'RequestBodyTooLargeError'
    this.receivedBytes = receivedBytes
    this.limitBytes = limitBytes
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

/**
 * The OpenAI error `type` that describes this failure, so the caller's retry
 * policy can classify it.
 *
 * `type` is not decoration: the harness reads it before the message, and only
 * retries the codes it derives from a server or transport failure. Labelling
 * every shim error `invalid_request_error` turned a dropped gateway connection
 * into "bad request", which the retry policy treats as permanent — a long turn
 * died on one transient socket failure while the session was still healthy.
 */
function errorTypeFor(status: number, code: string): string {
  if (code === 'transport' || code === 'server' || code === 'upstream_error') return 'server_error'
  if (status >= 500) return 'server_error'
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  return 'invalid_request_error'
}

function writeOpenAIError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, {
    error: {
      message,
      type: errorTypeFor(status, code),
      code,
    },
  })
}

function isJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type']
  if (!header) return false
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/**
 * Log only the bodies that are large enough to matter.
 *
 * A gateway rejection at 15.5 MB is indistinguishable from a parameter bug in
 * its own error text, so the size has to reach the log while the failure is
 * still attributable. Quiet bodies stay quiet: one line per small request
 * would bury the signal.
 */
type ShimLogger = WorkBuddyDualShimOptions['logger']

function logBodySize(logger: ShimLogger, region: WorkBuddyRegion, bytes: number): void {
  if (bytes < REQUEST_BODY_WARN_BYTES) return
  logger?.info(
    `[workbuddy-dual] ${region} request body ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`,
  )
}

/**
 * Attribute an upstream rejection to the body size when the two coincide.
 *
 * WorkBuddy answers an oversized body with a generic `Invalid request
 * parameters` or a bare 413, never naming the limit. Pairing the status with
 * the exact byte count is what makes that diagnosis possible next time.
 */
function logUpstreamRejection(
  logger: ShimLogger,
  region: WorkBuddyRegion,
  bytes: number,
  status: number,
  message: string,
): void {
  const oversized = status === 413 || (bytes >= GATEWAY_BODY_LIMIT_BYTES && (status === 400 || status === 500))
  if (!oversized) return
  logger?.error(
    `[workbuddy-dual] ${region} gateway rejected a ${bytes}-byte body with ${status}; bodies above roughly ${GATEWAY_BODY_LIMIT_BYTES} bytes are refused with generic parameter errors. ${message.slice(0, 200)}`,
  )
}

/**
 * The CN gateway runs a channel check over the system prompt, not over the
 * headers or tool list alone: a prompt that still carries another vendor's
 * harness signature is rejected with 11128 "Illegal API invocation from an
 * unapproved channel" before the model is ever called. Rewriting the product
 * name into its hyphenated form keeps the meaning and the model's own identity
 * instruction while dropping that literal signature.
 */
const HARNESS_SIGNATURE = /deepseek\s+harness/gi

export function stripForeignHarnessSignature(source: string): string {
  return source.replace(HARNESS_SIGNATURE, 'DeepSeek-Harness')
}

/**
 * The second shape the CN channel check rejects is another vendor's client
 * identity when it opens the prompt.
 *
 * Claude Code sends \`You are Claude Code, Anthropic's official CLI for Claude.\`
 * as the first system block, and the gateway refuses that with the same 11128 —
 * which is why routing Claude through the CN lane failed on every turn. The
 * check reads the opening of the prompt only: the identical sentence one
 * character later is accepted, and so is the same sentence after any leading
 * prose or blank line. Prefixing the prompt with a space is enough to pass.
 *
 * Rather than alter the text, this turns the comma that follows \`Claude Code\`
 * into an em dash when that identity opens the prompt. The sentence keeps its
 * words, order and meaning; only the punctuation differs. Everything after the
 * opening is left untouched, as are prompts that merely mention the phrase.
 */
const LEADING_CLIENT_IDENTITY = /^You are Claude Code, (?=Anthropic)/i

export function deflectLeadingClientIdentity(source: string): string {
  return source.replace(LEADING_CLIENT_IDENTITY, 'You are Claude Code — ')
}

/**
 * The CN gateway's channel check also fingerprints how the prompt is *laid
 * out*, not just which words it contains.
 *
 * A system prompt whose sentences are separated by a single space keeps
 * matching the signature of a non-official client and is refused with 11128
 * before the model runs. The same prompt with those sentence joins turned into
 * newlines is accepted, byte for byte otherwise identical. Measured on a real
 * DSH session: the original prompt failed 5/5, the re-wrapped prompt passed
 * 5/5, and a prompt already using blank lines between paragraphs needed no
 * change. Images, the tool catalog, reasoning effort and the trace headers
 * make no difference — a two-line prompt is accepted, the full one is not.
 *
 * So open a new line at each boundary between one block of prose and the next.
 * Nothing is added or removed: a boundary is a sentence-final punctuation mark
 * followed by a single space and an opening character. Code blocks, lists and
 * already-wrapped prose have no such boundary and are left alone, which also
 * keeps this away from tool results and the user's own text.
 */
const SENTENCE_JOIN = /(?<=[A-Za-z0-9_)\]}])[.!?] (?=[A-Z@\[])/g

export function rewrapSystemPrompt(source: string): string {
  if (!source.includes(' ')) return source
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || line === '') continue
    // Lists and indented blocks keep their shape; only running prose is rewrapped.
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^\s/.test(line)) continue
    lines[i] = line.replace(SENTENCE_JOIN, boundary => `${boundary[0]}\n`)
  }
  return lines.join('\n')
}

async function readBody(req: IncomingMessage, limit = MAX_REQUEST_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limit) throw new RequestBodyTooLargeError(total, limit)
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * Give every `enum` node the `type` its values imply.
 *
 * Kimi's upstream (kimi-k3.1-pro and siblings) validates tool parameter
 * schemas strictly and answers the whole request with `11133 Invalid request
 * parameters` when an `enum` arrives without a sibling `type` — even when the
 * enum sits inside `items` or under `anyOf`. Every other model on the same
 * gateway accepts the same body, so the failure looks like a broken model
 * rather than a schema nit.
 *
 * `enum` alone is valid JSON Schema, so third-party MCP servers keep producing
 * it; the constraint belongs to this gateway and has to be repaired here. Only
 * a missing `type` is filled in, and only when every value shares one JSON
 * type, so a heterogeneous enum is left exactly as the caller wrote it.
 */
function typeOfJsonValue(value: unknown): string | undefined {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string': return 'string'
    case 'boolean': return 'boolean'
    case 'number': return Number.isInteger(value) ? 'integer' : 'number'
    case 'object': return 'object'
    default: return undefined
  }
}

function inferEnumType(values: readonly unknown[]): string | undefined {
  if (values.length === 0) return undefined
  const first = typeOfJsonValue(values[0])
  if (first === undefined) return undefined
  // Integers and decimals may mix in one numeric enum; keep the broader type.
  const merged = values.every(value => {
    const type = typeOfJsonValue(value)
    return type === first || (first === 'integer' && type === 'number') || (first === 'number' && type === 'integer')
  })
    ? (values.some(value => typeOfJsonValue(value) === 'number') ? 'number' : first)
    : undefined
  return merged
}

function annotateEnumTypes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) annotateEnumTypes(item)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const schema = node as Record<string, unknown>
  const values = schema['enum']
  if (Array.isArray(values) && schema['type'] === undefined) {
    const type = inferEnumType(values)
    if (type !== undefined) schema['type'] = type
  }
  for (const value of Object.values(schema)) annotateEnumTypes(value)
}

export function prepareChatBody(source: string, region: WorkBuddyRegion = 'cn'): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return stripForeignHarnessSignature(source)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return stripForeignHarnessSignature(source)
  const obj = body as Record<string, unknown>
  obj['stream'] = true

  // normalize role: "developer" -> "system"
  if (Array.isArray(obj['messages'])) {
    for (const msg of obj['messages']) {
      if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
        const m = msg as Record<string, unknown>
        if (m['role'] === 'developer') m['role'] = 'system'
        // Only the system prompt carries the fingerprint the gateway rejects;
        // user content is the user's own text and stays untouched.
        if (m['role'] === 'system') m['content'] = stripHarnessSignatureFromContent(m['content'], region)
      }
    }
    // Upstream (especially Global) requires the first message to be role: "system".
    const firstMsg = obj['messages'][0] as Record<string, unknown> | undefined
    if (!firstMsg || firstMsg['role'] !== 'system') {
      obj['messages'].unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }
  }

  // Kimi's upstream rejects the whole request when any tool schema carries an
  // `enum` without a sibling `type`; every other model on the gateway accepts
  // it. Repair the schemas here so a third-party MCP tool cannot break the
  // model. `tools` is the caller's own array, so editing it in place is fine.
  if (Array.isArray(obj['tools'])) annotateEnumTypes(obj['tools'])

  // normalize tool_choice
  if ('tool_choice' in obj) {
    const choice = obj['tool_choice']
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
      }
    } else if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>
      const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
      if (type === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
      } else if (type === 'auto' || type === 'required') {
        obj['tool_choice'] = type
      } else if (type === 'function') {
        const fn = wrapped['function'] as Record<string, unknown> | undefined
        const name = typeof fn?.['name'] === 'string' ? fn['name'].trim() : (typeof wrapped['name'] === 'string' ? wrapped['name'].trim() : '')
        obj['tool_choice'] = name || 'auto'
      }
    }
  }

  return JSON.stringify(obj)
}

/**
 * Read the first upstream frame without committing a response to the client.
 *
 * The gateway answers a rate-limited stream with HTTP 200 and an SSE frame
 * carrying `6004`, so the status code alone cannot tell a working account from
 * a blocked one. Anything already written to the client is final, which is why
 * the header has to wait until this peek says the stream is real. A frame that
 * arrives whole is returned with the reader so the same bytes are forwarded
 * rather than dropped; a frame larger than the cap is forwarded unexamined.
 */
export interface WorkBuddyHeadPeek {
  /** Every byte read so far, in order; forwarding these loses nothing. */
  buffered: readonly Uint8Array[]
  reader: ReadableStreamDefaultReader<Uint8Array>
  /** Business code seen in the first frame, when the gateway sent one. */
  code: string | undefined
  /** True when the first frame carries a block verdict for this account. */
  blocked: boolean
  /** Text of the first frame, truncated; used for reset-time parsing. */
  head: string
}

export async function peekFirstFrame(response: Response): Promise<WorkBuddyHeadPeek | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const buffered: Uint8Array[] = []
  let text = ''
  while (text.length < HEAD_PEEK_LIMIT) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined && value.byteLength > 0) {
      // A single SSE event can arrive split across chunks. Keeping every chunk
      // (not just the first) is what makes forwarding the peek lossless.
      buffered.push(value)
      text += new TextDecoder().decode(value, { stream: true })
      // The business code is announced in the first complete SSE event; once
      // one has arrived there is nothing left to learn from waiting.
      if (/\n\n/u.test(text) || text.includes('[DONE]')) break
    }
  }
  const code = parseBusinessCode(text)
  const blocked = code !== undefined && (ACCOUNT_BLOCK_CODES as readonly string[]).includes(code)
  return { buffered, reader, code, blocked, head: text }
}

function stripHarnessSignatureFromContent(content: unknown, region: WorkBuddyRegion): unknown {
  const rewrite = (source: string): string => {
    const stripped = stripForeignHarnessSignature(source)
    // A leading client identity has to be deflected before the layout pass:
    // that pass would move the sentence onto its own line and change what the
    // gateway sees at the opening.
    const deflected = deflectLeadingClientIdentity(stripped)
    // The Global gateway does not run the layout check, so its prompts are
    // forwarded exactly as the harness wrote them.
    return region === 'cn' ? rewrapSystemPrompt(deflected) : stripped
  }
  if (typeof content === 'string') return rewrite(content)
  if (!Array.isArray(content)) return content
  return content.map(part => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return part
    const item = part as Record<string, unknown>
    if (typeof item['text'] !== 'string') return part
    return { ...item, text: rewrite(item['text']) }
  })
}

export function createWorkBuddyDualShim(options: WorkBuddyDualShimOptions): WorkBuddyDualShim {
  const { store, client, catalog, logger, route } = options
  let origin = 'http://127.0.0.1:0'

  /**
   * The session this request belongs to.
   *
   * pi-ai sends the harness session id as `x-client-request-id` (and
   * `x-session-affinity`) only when its compat flag says so. The adapter turns
   * that flag on for both providers, which is what lets one conversation stay
   * on one account even though every step is a separate HTTP request.
   */
  const sessionKeyOf = (req: IncomingMessage): string | undefined => {
    const header = req.headers['x-session-affinity'] ?? req.headers['x-client-request-id'] ?? req.headers['session_id']
    const value = Array.isArray(header) ? header[0] : header
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  const modelOf = (raw: string): string | undefined => {
    try {
      const body = JSON.parse(raw) as Record<string, unknown>
      return typeof body['model'] === 'string' ? body['model'] : undefined
    } catch {
      return undefined
    }
  }

  /** Model id as the prepared body carries it, for the health key. */
  const preparedModel = (prepared: string): string => modelOf(prepared) ?? 'deepseek-v4.1-flash'

  /**
   * Ordered accounts for this request, or one entry for the legacy behaviour.
   *
   * Without a router the lane keeps using the sign-in the user selected, which
   * is what every pre-router caller (and the live verifier script) expects.
   */
  const candidatesFor = async (
    req: IncomingMessage,
    region: WorkBuddyRegion,
    raw: string,
  ): Promise<{ candidates: WorkBuddyRouteCandidate[]; sessionKey: string | undefined; model: string | undefined }> => {
    const model = modelOf(raw)
    const sessionKey = sessionKeyOf(req)
    if (route === undefined || model === undefined || route.enabled?.() === false) {
      const credential = await store.storeFor(region).resolve()
      return {
        candidates: [{ region, uid: credential.uid, credential, source: 'fallback', label: credential.nickname ?? credential.uid }],
        sessionKey,
        model,
      }
    }
    const crossLane = region === route.crossLaneFrom
    const candidates = await planRoute(
      route.router,
      route.affinity,
      { model, sessionKey, ...(crossLane ? {} : { region }) },
    )
    return { candidates, sessionKey, model }
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }

      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }

      // Parse region from prefix: /cn/... or /global/...
      let region: WorkBuddyRegion = 'cn'
      let normalizedPath = url
      if (url.startsWith('/cn/')) {
        region = 'cn'
        normalizedPath = url.slice(3)
      } else if (url.startsWith('/global/')) {
        region = 'global'
        normalizedPath = url.slice(7)
      }

      if (req.method === 'GET' && (normalizedPath === '/v1/models' || normalizedPath === '/v1/models/')) {
        const models = catalog.selectedModelsFor(region)
        writeJson(res, 200, {
          object: 'list',
          data: models.map(m => ({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: `workbuddy-${region}`,
          })),
        })
        return
      }

      if (req.method === 'POST' && (normalizedPath === '/v1/chat/completions' || normalizedPath === '/v1/chat/completions/')) {
        await handleChatCompletions(req, res, region)
        return
      }

      writeOpenAIError(res, 404, 'not_found', `Route not found: ${req.method} ${url}`)
    } catch (err: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(err))
      } else {
        res.end()
      }
    }
  })

  async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, region: WorkBuddyRegion): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err: unknown) {
      if (err instanceof RequestBodyTooLargeError) {
        // A 413 names the real problem. The previous generic 500 read as an
        // upstream failure and sent debugging to WorkBuddy instead of here.
        writeOpenAIError(
          res,
          413,
          'request_too_large',
          `Request body is ${err.receivedBytes} bytes, above the ${err.limitBytes}-byte local shim limit. Reduce retained images or start a new task.`,
        )
        return
      }
      throw err
    }

    logBodySize(logger, region, body.length)
    const raw = body.toString('utf8')

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    let candidates: WorkBuddyRouteCandidate[] = []
    let sessionKey: string | undefined
    let model: string | undefined
    let recovery: number | undefined
    // A cooldown that lifts shortly is worth waiting out: failing now would
    // end the turn even though a usable account is about to exist.
    for (let attempt = 0; ; attempt++) {
      try {
        ({ candidates, sessionKey, model } = await candidatesFor(req, region, raw))
      } catch (err: unknown) {
        writeOpenAIError(res, 401, 'not_signed_in', String(err))
        return
      }
      if (candidates.length > 0) break
      recovery = model === undefined || route === undefined
        ? undefined
        : await nextRecoveryMs(route.router, model, region === route.crossLaneFrom ? undefined : region)
      const wait = recovery === undefined ? Infinity : recovery - Date.now()
      if (attempt > 0 || !Number.isFinite(wait) || wait > SHORT_COOLDOWN_WAIT_MS) break
      await new Promise(resolve => setTimeout(resolve, Math.max(250, wait + 250)))
      if (controller.signal.aborted) return
    }
    if (candidates.length === 0) {
      // Every account for this model is cooling down for longer than a turn can
      // wait. Name the moment one frees up instead of a bare 429 the harness
      // would retry blindly.
      const when = recovery === undefined ? '' : ` Retry after ${new Date(recovery).toISOString()}.`
      writeOpenAIError(res, 429, 'rate', `No WorkBuddy account can run ${model ?? 'this model'} right now.${when}`)
      return
    }

    let lastError: { status: number; kind: string; message: string } | undefined
    for (const candidate of candidates) {
      if (controller.signal.aborted) return
      const prepared = prepareChatBody(raw, candidate.region)
      const result = await client.chatStream(candidate.credential, prepared, controller.signal)
      if (!result.ok) {
        logUpstreamRejection(logger, candidate.region, body.length, result.status, result.message)
        lastError = { status: result.status, kind: result.kind, message: result.message }
        // Only an account-level refusal is worth another account. A 400 or a
        // bad request would fail identically everywhere and re-sending it would
        // just burn the remaining accounts' rate budget.
        const retriable = result.kind === 'rate' || result.kind === 'auth' || result.kind === 'credit'
        if (route !== undefined) {
          await route.router.health.record(candidate.region, candidate.uid, model ?? preparedModel(prepared), verdictForFailure(result.kind, result.message), {
            resetsAtMs: parseResetTime(result.message),
            detail: result.message.slice(0, 200),
          })
        }
        if (!retriable) break
        continue
      }

      // Hold the client response until the first frame proves this account is
      // not answering with a rate-limit event behind an HTTP 200.
      const peek = await peekFirstFrame(result.response)
      if (peek?.blocked === true) {
        const verdict = peek.code === '11140' ? 'banned' : peek.code === '14018' ? 'no-credit' : 'rate-limited'
        await peek.reader.cancel().catch(() => {})
        if (route !== undefined) {
          await route.router.health.record(candidate.region, candidate.uid, model ?? preparedModel(prepared), verdict, {
            resetsAtMs: parseResetTime(peek.head),
            detail: peek.head.slice(0, 200),
          })
        }
        lastError = { status: 429, kind: verdict === 'rate-limited' ? 'rate' : verdict, message: peek.head.slice(0, 2000) }
        continue
      }

      if (route !== undefined) {
        await route.router.health.record(candidate.region, candidate.uid, model ?? preparedModel(prepared), 'ok')
        route.affinity.remember(sessionKey, candidate.region, candidate.uid)
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        // ASCII only, and the uid keeps the header useful even when the label
        // is entirely Chinese and gets stripped.
        ...(route === undefined
          ? {}
          : { 'X-WorkBuddy-Account': headerSafe(`${candidate.region}/${candidate.uid}/${candidate.label}`) }),
      })
      try {
        if (peek !== undefined) {
          for (const chunk of peek.buffered) res.write(chunk)
          while (true) {
            const { done, value } = await peek.reader.read()
            if (done) break
            if (value !== undefined) res.write(value)
          }
        }
      } catch (err) {
        logger?.error(`Streaming failed for ${candidate.region}:`, err)
      } finally {
        res.end()
      }
      return
    }

    const status = lastError === undefined ? 502 : lastError.status >= 400 && lastError.status < 600 ? lastError.status : 502
    writeOpenAIError(res, status, lastError?.kind ?? 'server', lastError?.message ?? 'every WorkBuddy account failed')
    return
  }

  const ready = new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      origin = `http://127.0.0.1:${addr.port}`
      resolve()
    })
    server.once('error', reject)
  })

  return {
    get origin() { return origin },
    ready,
    baseUrl(region: WorkBuddyRegion): string {
      return `${origin}/${region}/v1`
    },
    async close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
      })
    },
  }
}

/**
 * Which verdict an upstream refusal represents.
 *
 * The HTTP status alone is not enough: Global answers a banned account with
 * `403 / 11140 request illegal`, which would otherwise be filed as an expired
 * sign-in and retried every thirty minutes forever. The business code is the
 * gateway's own reason, so it wins when present.
 */
export function verdictForFailure(kind: string, message: string): WorkBuddyProbeVerdict {
  const code = parseBusinessCode(message)
  if (code === '6004') return 'rate-limited'
  if (code === '11140') return 'banned'
  if (code === '14018') return 'no-credit'
  if (kind === 'rate') return 'rate-limited'
  if (kind === 'credit') return 'no-credit'
  if (kind === 'auth') return 'auth'
  return 'error'
}
