/**
 * DSH WorkBuddy Dual - Host Entry Point.
 *
 * Registers both 'workbuddy-cn' and 'workbuddy-global' LLM providers,
 * and mounts the dual status route for the Web settings card.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { WorkBuddyDualCredentialStore } from './auth.ts'
import { WorkBuddyDualCatalog } from './catalog.ts'
import { WorkBuddyDualSelectionStore } from './selection-store.ts'
import type { WorkBuddyDualSelection } from './selection.ts'
import { registerWorkBuddyDualModelRoutes } from './model-route.ts'
import {
  createWorkBuddyDualAdapter,
  WORKBUDDY_CN_PROVIDER,
  WORKBUDDY_GLOBAL_PROVIDER,
} from './adapter.ts'
import { createWorkBuddyDualShim } from './shim.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyDualStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export {
  WORKBUDDY_CN_PROVIDER,
  WORKBUDDY_GLOBAL_PROVIDER,
  createWorkBuddyDualAdapter,
} from './adapter.ts'
export { WorkBuddyDualCredentialStore } from './auth.ts'
export { WorkBuddyDualCatalog } from './catalog.ts'
export { WorkBuddyUpstreamClient } from './upstream.ts'
export { createWorkBuddyDualShim } from './shim.ts'
export { WorkBuddyDualSelectionStore } from './selection-store.ts'
export {
  defaultSelection,
  filterModels,
  normalizeLanePreference,
  normalizeSelection,
  advertisedModelIds,
  type WorkBuddyDualSelection,
} from './selection.ts'

export const WORKBUDDY_DUAL_SETTINGS_NS = 'workbuddy-dual'

export interface WorkBuddyDualConfig {
  cnAuthFile?: string
  globalAuthFile?: string
}

export const Config: z<WorkBuddyDualConfig> = z.object({
  cnAuthFile: z.string().description('WorkBuddy CN auth file (defaults to workbuddy-desktop.info)'),
  globalAuthFile: z.string().description('WorkBuddy Global auth file (defaults to workbuddy-desktop-ai.info)'),
}) as unknown as z<WorkBuddyDualConfig>

export const name = 'dsh-workbuddy-dual'
export const inject = ['llm'] as const

export function apply(ctx: Context, config: WorkBuddyDualConfig = {}): void {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyDualCredentialStore({
    refreshCN: cred => client.refreshToken(cred),
    refreshGlobal: cred => client.refreshToken(cred),
    cnPathOverride: config.cnAuthFile,
    globalPathOverride: config.globalAuthFile,
  })

  const catalog = new WorkBuddyDualCatalog()
  const selection = new WorkBuddyDualSelectionStore()
  const shim = createWorkBuddyDualShim({ store, client, catalog, logger: ctx.logger })

  let stopped = false
  let invalidate: (() => void) | undefined

  /** Rebuild the adapter generation and tell every picker to re-read. */
  const publishSelection = (next: WorkBuddyDualSelection): void => {
    catalog.setSelection(next)
    invalidate?.()
    ctx.events.emit('llm/adapters-updated')
  }

  ctx.inject(['webServer'], webCtx => {
    registerWorkBuddyDualStatusRoute(webCtx, { store, client, catalog })
    registerWorkBuddyDualModelRoutes(webCtx, {
      catalog,
      selection,
      async accountStatus(region) {
        const status = await store.storeFor(region).status()
        return status.state === 'signed-in' ? 'signed-in' : 'signed-out'
      },
      onChange(next) {
        publishSelection(next)
      },
    })
  })

  let currentConfig = () => config
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, WORKBUDDY_DUAL_SETTINGS_NS, Config, config, {
      setSource(source) { currentConfig = source },
      onChange() {
        const next = currentConfig()
        store.cn.setDesktopPath(next.cnAuthFile)
        store.global.setDesktopPath(next.globalAuthFile)
      },
    })
  })

  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready.then(() => {
    if (stopped) return

    try {
      const workbuddy = createWorkBuddyDualAdapter({
        shim,
        catalog,
        resolveAttachments: () => ctx.get('attachments'),
        mapHostPath: hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      })
      invalidate = workbuddy.invalidate
      // The stored selection must be in the catalog before the first
      // listModels read, so the picker opens with exactly the user's choice.
      void selection.get().then(publishSelection)

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        releaseAdapter = ctx.llm.registerAdapter(
          [WORKBUDDY_CN_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER],
          workbuddy.adapter,
        )
        releaseDirectory = ctx.llm.registerConfigurableProviders([
          {
            provider: WORKBUDDY_CN_PROVIDER,
            displayName: 'WorkBuddy CN',
            settingsNs: WORKBUDDY_DUAL_SETTINGS_NS,
            settingsPath: ['cnAuthFile'],
            declared: false,
          },
          {
            provider: WORKBUDDY_GLOBAL_PROVIDER,
            displayName: 'WorkBuddy Global',
            settingsNs: WORKBUDDY_DUAL_SETTINGS_NS,
            settingsPath: ['globalAuthFile'],
            declared: false,
          },
        ])
      } finally {
        if (!releaseAdapter || !releaseDirectory) {
          releaseAdapter?.()
          releaseDirectory?.()
        }
      }

      try {
        ctx.effect(() => () => {
          releaseAdapter?.()
          releaseDirectory?.()
        })
      } catch {
        releaseAdapter?.()
        releaseDirectory?.()
        return
      }

      void writeHostHeartbeat()

      // Asynchronously fetch dynamic catalog for both CN and Global
      void (async () => {
        // Fetch CN models
        try {
          const cnCred = await store.cn.current()
          if (cnCred) {
            const models = await client.fetchModels(cnCred)
            if (models.length > 0) {
              catalog.setModels('cn', models)
              invalidate?.()
            }
          }
        } catch (err) {
          ctx.logger.warn('dsh-workbuddy-dual: failed to fetch dynamic CN models; fallback active', err)
        }

        // Fetch Global models
        try {
          const globalCred = await store.global.current()
          if (globalCred) {
            const models = await client.fetchModels(globalCred)
            if (models.length > 0) {
              catalog.setModels('global', models)
              invalidate?.()
            }
          }
        } catch (err) {
          ctx.logger.warn('dsh-workbuddy-dual: failed to fetch dynamic Global models; fallback active', err)
        }
      })()
    } catch (err) {
      ctx.logger.error('dsh-workbuddy-dual: initialization error', err)
    }
  })
}
