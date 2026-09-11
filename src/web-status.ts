/**
 * Same-origin status route for the WorkBuddy Dual plugin card:
 * returns status and balance for both CN and Global accounts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyDualCredentialStore } from './auth.ts'
import type { WorkBuddyDualCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import {
  WORKBUDDY_DUAL_STATUS_PATH,
  type WorkBuddyDualWebStatus,
  type WorkBuddyRegionWebStatus,
  type WorkBuddyWebModelBadge,
} from './status-paths.ts'
import type { WorkBuddyRegion } from './types.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

export { WORKBUDDY_DUAL_STATUS_PATH } from './status-paths.ts'

export interface WorkBuddyDualStatusRouteOptions {
  store: WorkBuddyDualCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  catalog: WorkBuddyDualCatalog
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

async function resolveRegionWebStatus(
  region: WorkBuddyRegion,
  deps: WorkBuddyDualStatusRouteOptions,
): Promise<WorkBuddyRegionWebStatus> {
  const regionStore = deps.store.storeFor(region)
  const authStatus = await regionStore.status()
  if (authStatus.state !== 'signed-in') {
    return { status: 'signed-out', region }
  }

  const models = deps.catalog.modelsFor(region)
  const modelsBadge: WorkBuddyWebModelBadge[] = models
    .filter(m => m.billing?.free === true || (m.billing?.badges?.length ?? 0) > 0)
    .map(m => ({
      id: m.id,
      name: m.name,
      ...(m.billing?.free !== undefined ? { free: m.billing.free } : {}),
      ...(m.billing?.badges !== undefined ? { badges: m.billing.badges } : {}),
      ...(m.billing?.credits !== undefined ? { credits: m.billing.credits } : {}),
    }))

  const baseStatus: WorkBuddyRegionWebStatus = {
    status: 'signed-in',
    region,
    ...(authStatus.nickname ? { nickname: authStatus.nickname } : {}),
    ...(authStatus.domain ? { domain: authStatus.domain } : {}),
    ...(authStatus.expiresAtMs ? { expiresAt: authStatus.expiresAtMs } : {}),
    ...(modelsBadge.length > 0 ? { models: modelsBadge } : {}),
  }

  try {
    const cred = await regionStore.current()
    if (cred) {
      const credits = await deps.client.fetchCredits(cred)
      return {
        ...baseStatus,
        credits: {
          total: credits.totalBalance,
          accounts: credits.accounts,
        },
      }
    }
  } catch (err) {
    return { ...baseStatus, creditsError: safeMessage(err) }
  }

  return baseStatus
}

export async function workBuddyDualWebStatus(
  deps: WorkBuddyDualStatusRouteOptions,
): Promise<WorkBuddyDualWebStatus> {
  const [cn, global] = await Promise.all([
    resolveRegionWebStatus('cn', deps),
    resolveRegionWebStatus('global', deps),
  ])
  return { cn, global }
}

export function workBuddyDualStatusHandler(
  deps: WorkBuddyDualStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await workBuddyDualWebStatus(deps))
    } catch (err: unknown) {
      json(res, 500, { error: safeMessage(err) })
    }
  }
}

export function registerWorkBuddyDualStatusRoute(ctx: Context, deps: WorkBuddyDualStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_DUAL_STATUS_PATH,
      handler: workBuddyDualStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-dual: Web status route')
}
