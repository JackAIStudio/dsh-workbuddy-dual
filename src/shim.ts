/**
 * Loopback OpenAI-compatible endpoint with dual routing (/cn and /global).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WorkBuddyDualCredentialStore } from './auth.ts'
import type { WorkBuddyDualCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import type { WorkBuddyRegion } from './types.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'

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
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

function writeOpenAIError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, {
    error: {
      message,
      type: 'invalid_request_error',
      code,
    },
  })
}

function isJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type']
  if (!header) return false
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

async function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limit) throw new Error('Request body exceeds limit')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true

  // normalize role: "developer" -> "system"
  if (Array.isArray(obj['messages'])) {
    for (const msg of obj['messages']) {
      if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
        const m = msg as Record<string, unknown>
        if (m['role'] === 'developer') m['role'] = 'system'
      }
    }
    // Upstream (especially Global) requires the first message to be role: "system".
    const firstMsg = obj['messages'][0] as Record<string, unknown> | undefined
    if (!firstMsg || firstMsg['role'] !== 'system') {
      obj['messages'].unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }
  }

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

export function createWorkBuddyDualShim(options: WorkBuddyDualShimOptions): WorkBuddyDualShim {
  const { store, client, catalog, logger } = options
  let origin = 'http://127.0.0.1:0'

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
        const models = catalog.modelsFor(region)
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

    let credential
    try {
      credential = await store.storeFor(region).resolve()
    } catch (err: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(err))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const result = await client.chatStream(credential, prepared, controller.signal)
    if (!result.ok) {
      const status = result.status >= 400 && result.status < 600 ? result.status : 502
      writeOpenAIError(res, status, result.kind, result.message)
      return
    }

    // Stream SSE to client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    if (!result.response.body) {
      res.end('data: [DONE]\n\n')
      return
    }

    const reader = result.response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) res.write(value)
      }
    } catch (err) {
      logger?.error(`Streaming failed for ${region}:`, err)
    } finally {
      res.end()
    }
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
