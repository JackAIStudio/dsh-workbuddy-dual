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
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close?: () => void }
    }
  }
}

export const name = 'dsh-workbuddy-dual-client'
export const inject = ['slots', 'locale']

export interface WorkBuddySettingsSectionProps {
  t?: WorkBuddyDualCardInjected['t']
  close?: () => void
}

function WorkBuddySettingsSection({ t }: WorkBuddySettingsSectionProps) {
  if (!t) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        boxSizing: 'border-box',
        width: '100%',
        padding: '32px 32px 48px',
      }}
    >
      <header>
        <h2
          style={{
            margin: '0 0 4px',
            fontSize: 20,
            fontWeight: 600,
            lineHeight: '28px',
            color: 'var(--dsw-alias-label-primary, inherit)',
          }}
        >
          {t('nav')}
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
          }}
        >
          {t('intro')}
        </p>
      </header>
      <WorkBuddyDualCard t={t} />
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy-dual'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-dual: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyDualCardInjected['t']

    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'workbuddy-dual-section',
          order: 14,
          label: () => t('nav'),
          inject: (): WorkBuddySettingsSectionProps => ({ t }),
        },
        WorkBuddySettingsSection,
      ),
    )

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
