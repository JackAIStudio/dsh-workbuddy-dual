/**
 * Loopback routes behind the model picker page: list both lanes with the
 * current preference, then persist a partial change.
 */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyDualCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import {
  WORKBUDDY_DUAL_MODELS_PATH,
  type WorkBuddyDualWebModels,
  type WorkBuddyDualWebModelsUpdate,
  type WorkBuddyLaneMode,
  type WorkBuddyLanePreference,
  type WorkBuddyWebLaneModels,
  type WorkBuddyWebModelOption,
} from './model-paths.ts'
import type { WorkBuddyDualSelection } from './selection.ts'
import type { WorkBuddyDualSelectionStore } from './selection-store.ts'
import type { WorkBuddyModelInfo, WorkBuddyRegion } from './types.ts'

const BODY_LIMIT = 128 * 1024

export interface WorkBuddyDualModelRouteOptions {
  catalog: WorkBuddyDualCatalog
  selection: WorkBuddyDualSelectionStore
  /** Sign-in state for both lanes, so the page can explain an empty lane. */
  accountStatus?: (region: WorkBuddyRegion) => Promise<'signed-in' | 'signed-out'>
  /** Rebuild adapter routes after a persisted change. */
  onChange?: (next: WorkBuddyDualSelection) => void | Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function trusted(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > BODY_LIMIT) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toOption(info: WorkBuddyModelInfo, lane: WorkBuddyLanePreference): WorkBuddyWebModelOption {
  return {
    id: info.id,
    name: info.name,
    contextWindow: info.contextWindow,
    supportsImages: info.supportsImages,
    ...(info.billing?.free !== undefined ? { free: info.billing.free } : {}),
    ...(info.billing?.credits !== undefined ? { credits: info.billing.credits } : {}),
    ...(info.billing?.badges !== undefined ? { badges: info.billing.badges } : {}),
    selected: lane.mode === 'all' || lane.models.includes(info.id),
  }
}

/** One lane as the settings page renders it. */
export function laneModelsView(
  catalog: WorkBuddyDualCatalog,
  selection: WorkBuddyDualSelection,
  region: WorkBuddyRegion,
  signedIn = true,
): WorkBuddyWebLaneModels {
  const lane = selection[region]
  const models = catalog.modelsFor(region)
  return {
    signedIn,
    enabled: lane.enabled,
    mode: lane.mode,
    live: catalog.isLive(region),
    total: models.length,
    selectedCount: lane.mode === 'all' ? models.length : lane.models.filter(id => models.some(m => m.id === id)).length,
    models: models.map(info => toOption(info, lane)),
  }
}

export async function modelPickerView(
  catalog: WorkBuddyDualCatalog,
  selection: WorkBuddyDualSelection,
  signedIn: { cn: boolean; global: boolean } = { cn: true, global: true },
): Promise<WorkBuddyDualWebModels> {
  return {
    cn: laneModelsView(catalog, selection, 'cn', signedIn.cn),
    global: laneModelsView(catalog, selection, 'global', signedIn.global),
  }
}

async function signInState(deps: WorkBuddyDualModelRouteOptions): Promise<{ cn: boolean; global: boolean }> {
  if (!deps.accountStatus) return { cn: true, global: true }
  const [cn, global] = await Promise.all([
    deps.accountStatus('cn').catch(() => 'signed-out' as const),
    deps.accountStatus('global').catch(() => 'signed-out' as const),
  ])
  return { cn: cn === 'signed-in', global: global === 'signed-in' }
}

/** Validate and normalize one lane's patch from the browser. */
export function parseLanePatch(value: unknown): Partial<WorkBuddyLanePreference> {
  if (!isRecord(value)) throw new Error('lane patch must be an object')
  const patch: { enabled?: boolean; mode?: WorkBuddyLaneMode; models?: readonly string[] } = {}
  if ('enabled' in value) {
    if (typeof value['enabled'] !== 'boolean') throw new Error('enabled must be a boolean')
    patch.enabled = value['enabled']
  }
  if ('mode' in value) {
    if (value['mode'] !== 'all' && value['mode'] !== 'selected') throw new Error('mode must be all or selected')
    patch.mode = value['mode']
  }
  if ('models' in value) {
    const raw = value['models']
    if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string')) {
      throw new Error('models must be an array of model ids')
    }
    patch.models = raw
  }
  return patch
}

export function parseUpdate(value: unknown): WorkBuddyDualWebModelsUpdate {
  if (!isRecord(value)) throw new Error('payload must be an object')
  const update: WorkBuddyDualWebModelsUpdate = {}
  if ('cn' in value) update.cn = parseLanePatch(value['cn'])
  if ('global' in value) update.global = parseLanePatch(value['global'])
  return update
}

export function modelHandler(
  deps: WorkBuddyDualModelRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!trusted(req)) {
      sendJson(res, 403, { ok: false, error: 'request-not-trusted' })
      return
    }
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, await modelPickerView(deps.catalog, await deps.selection.get(), await signInState(deps)))
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const update = parseUpdate(await readJson(req))
      if (update.cn === undefined && update.global === undefined) {
        sendJson(res, 400, { ok: false, error: 'no lane in payload' })
        return
      }
      const next = await deps.selection.updateLanes(update)
      await deps.onChange?.(next)
      sendJson(res, 200, { ok: true, ...(await modelPickerView(deps.catalog, next, await signInState(deps))) })
    } catch (error: unknown) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Mount the same-origin model routes; safe on both Web and desktop hosts. */
export function registerWorkBuddyDualModelRoutes(ctx: Context, deps: WorkBuddyDualModelRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_DUAL_MODELS_PATH,
      handler: modelHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-dual: model picker route')
}
