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
import { registerWorkBuddyDualAccountRoutes } from './account-route.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { createAgentToolClient } from './agenttool.ts'
import { createWorkBuddyNativeWeb, provideWorkBuddyNativeWeb } from './native-web.ts'
import type { WorkBuddyModelInfo, WorkBuddyRegion } from './types.ts'

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
export { WorkBuddyAccountPool, poolDocumentPath, toCredential } from './accounts.ts'
export {
  createWorkBuddyNativeWeb,
  provideWorkBuddyNativeWeb,
  WORKBUDDY_NATIVE_FETCH_SERVICE,
  WORKBUDDY_NATIVE_SEARCH_SERVICE,
} from './native-web.ts'
export { AgentToolError, createAgentToolClient } from './agenttool.ts'
export { WORKBUDDY_DUAL_ACCOUNTS_PATH, WORKBUDDY_FLASH_MODEL } from './account-paths.ts'
export { createAccountRouteState, readAuthFile, workBuddyAccountsView } from './account-route.ts'
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

  /**
   * Region of the model this turn runs, read the same way web-search-follow
   * reads its route: the live request header first, then the last selection.
   * Only used to pick which WorkBuddy sign-in pays for a hosted web tool.
   */
  const currentRegion = (): WorkBuddyRegion | undefined => {
    const agents = ctx.get('agents') as
      | { currentInitiator?: () => { session?: { requestHeader?: () => unknown }; options?: { provider?: unknown } } | undefined }
      | undefined
    const agent = typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : undefined
    const readProvider = (value: unknown): string | undefined => {
      if (typeof value !== 'object' || value === null) return undefined
      const record = value as Record<string, unknown>
      const header = typeof record['header'] === 'object' && record['header'] !== null
        ? record['header'] as Record<string, unknown>
        : record
      const inner = typeof header['config'] === 'object' && header['config'] !== null
        ? header['config'] as Record<string, unknown>
        : header
      return typeof inner['provider'] === 'string' ? inner['provider'] : undefined
    }
    let provider: string | undefined
    try {
      provider = readProvider(agent?.session?.requestHeader?.())
    } catch {}
    provider ??= readProvider(agent?.options)
    if (provider === WORKBUDDY_GLOBAL_PROVIDER) return 'global'
    if (provider === WORKBUDDY_CN_PROVIDER) return 'cn'
    return undefined
  }

  const nativeWeb = createWorkBuddyNativeWeb({
    store,
    client: createAgentToolClient(),
    resolveRegion: currentRegion,
    logger: ctx.logger,
  })
  provideWorkBuddyNativeWeb(ctx, nativeWeb)

  let stopped = false
  let invalidate: (() => void) | undefined

  /** Rebuild the adapter generation and tell every picker to re-read. */
  const publishSelection = (next: WorkBuddyDualSelection): void => {
    catalog.setSelection(next)
    invalidate?.()
    ctx.events.emit('llm/adapters-updated')
  }

  /**
   * Adopt a freshly fetched upstream catalog.
   *
   * `invalidate()` alone only rebuilds the adapter's provider profiles; the
   * model picker keeps rendering the names it already loaded until it hears
   * `llm/adapters-updated`. Without the event a startup fetch that lands after
   * the first picker read leaves the fallback credits (and badges) on screen
   * for the rest of the session, even though every later request is billed at
   * the live rate.
   */
  const adoptCatalog = (region: 'cn' | 'global', models: readonly WorkBuddyModelInfo[]): void => {
    if (models.length === 0) return
    catalog.setModels(region, models)
    invalidate?.()
    ctx.events.emit('llm/adapters-updated')
  }

  ctx.inject(['webServer'], webCtx => {
    registerWorkBuddyDualStatusRoute(webCtx, { store, client, catalog })
    registerWorkBuddyDualAccountRoutes(webCtx, {
      store,
      client,
      onAccountChange(region) {
        // A different account can carry a different model catalog (an
        // enterprise sign-in may expose models a personal one does not), so
        // re-read the catalog and let every picker refresh.
        //
        // This is deliberately not awaited: switching accounts already costs a
        // pool write, and making the click wait on a gateway catalog read adds
        // a round trip to a button that used to feel instant. The picker
        // refreshes when the answer lands.
        void (async () => {
          try {
            const credential = await store.storeFor(region).current()
            if (credential === undefined) return
            const models = await client.fetchModels(credential)
            adoptCatalog(region, models)
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-workbuddy-dual: could not refresh the ${region} catalog after switching accounts`, error)
          }
        })()
      },
    })
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
            adoptCatalog('cn', models)
          }
        } catch (err) {
          ctx.logger.warn('dsh-workbuddy-dual: failed to fetch dynamic CN models; fallback active', err)
        }

        // Fetch Global models
        try {
          const globalCred = await store.global.current()
          if (globalCred) {
            const models = await client.fetchModels(globalCred)
            adoptCatalog('global', models)
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
