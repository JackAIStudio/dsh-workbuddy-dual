import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WorkBuddyDualCard, type WorkBuddyDualCardInjected } from './DualPluginCard.tsx'
import { en, zh, type WorkBuddyDualSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.workbuddy-dual': WorkBuddyDualSettingsKey
  }
}

export const name = 'dsh-workbuddy-dual-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy-dual'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-dual: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyDualCardInjected['t']
    ctx.slots.inject('settings.plugin.item', () =>
      ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: 'workbuddy-dual',
          priority: 35,
          inject: (): WorkBuddyDualCardInjected => ({ t }),
        },
        WorkBuddyDualCard,
      ),
    )
  } catch (error: unknown) {
    console.error('[dsh-workbuddy-dual] client card failed to load (host provider unaffected):', error)
  }
}
