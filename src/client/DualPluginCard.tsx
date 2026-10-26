/**
 * The plugin's row in the settings list.
 *
 * It keeps the shared injection type used by every card in this plugin, and
 * summarises the whole feature in one line so the settings list stays legible.
 * The full account list lives in the plugin's own section.
 */

import type { WorkBuddyDualSettingsKey } from './locales.ts'

export interface WorkBuddyDualCardInjected {
  t: (key: WorkBuddyDualSettingsKey, params?: Record<string, unknown>) => string
}

export interface WorkBuddyDualCardProps extends Partial<WorkBuddyDualCardInjected> {}

export function WorkBuddyDualCard({ t }: WorkBuddyDualCardProps) {
  if (!t) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 0',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t('title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{t('intro')}</div>
    </div>
  )
}
