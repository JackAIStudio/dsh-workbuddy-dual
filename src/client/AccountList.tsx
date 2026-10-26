import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  WORKBUDDY_DUAL_ACCOUNTS_PATH,
  type WorkBuddyAccountAction,
  type WorkBuddyWebAccount,
  type WorkBuddyWebAccounts,
  type WorkBuddyWebProbe,
  type WorkBuddyWebRegionAccounts,
} from '../account-paths.ts'
import type { WorkBuddyDualSettingsKey } from './locales.ts'

type Translate = (key: WorkBuddyDualSettingsKey, params?: Record<string, unknown>) => string

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

const LANES = ['cn', 'global'] as const
type Lane = (typeof LANES)[number]

function readError(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as Record<string, unknown>)['error']
    if (typeof error === 'string' && error !== '') return error
  }
  return fallback
}

/** "21:44" today, or "明天 18:47" when the reset lands on another day. */
function formatReset(resetsAtMs: number | undefined, t: Translate): string {
  if (resetsAtMs === undefined) return t('probeRateLimited', { time: '—' })
  const reset = new Date(resetsAtMs)
  const now = new Date()
  const sameDay = reset.toDateString() === now.toDateString()
  const clock = `${reset.getHours().toString().padStart(2, '0')}:${reset.getMinutes().toString().padStart(2, '0')}`
  return sameDay ? clock : `${reset.getMonth() + 1}/${reset.getDate()} ${clock}`
}

function probeStyle(probe: WorkBuddyWebProbe | undefined): CSSProperties {
  const color = probe === undefined
    ? '#9ca3af'
    : probe.verdict === 'ok'
      ? '#22c55e'
      : probe.verdict === 'rate-limited'
        ? '#f59e0b'
        : '#ef4444'
  return { color, fontWeight: 500 }
}

function probeLabel(probe: WorkBuddyWebProbe | undefined, t: Translate): string {
  if (probe === undefined) return t('probeNever')
  switch (probe.verdict) {
    case 'ok': return `✅ ${t('probeOk')}`
    case 'rate-limited': return `⛔ ${t('probeRateLimited', { time: formatReset(probe.resetsAtMs, t) })}`
    case 'banned': return `⛔ ${t('probeBanned')}`
    case 'no-credit': return `⛔ ${t('probeNoCredit')}`
    case 'auth': return `⛔ ${t('probeAuth')}`
    case 'error': return `⚠️ ${t('probeError')}`
  }
  return t('probeNever')
}

function miniButton(disabled: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 5,
    cursor: disabled ? 'default' : 'pointer',
    border: '1px solid var(--border-color, #d1d5db)',
    background: 'transparent',
    opacity: disabled ? 0.5 : 1,
    color: 'inherit',
  }
}

function AccountRow({
  account,
  busy,
  onSelect,
  onProbe,
  onRemove,
  onRelabel,
  t,
}: {
  account: WorkBuddyWebAccount
  busy: string | undefined
  onSelect: () => void
  onProbe: () => void
  onRemove: () => void
  onRelabel: (label: string) => void
  t: Translate
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label ?? '')
  const disabled = busy !== undefined

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 8px',
        borderRadius: 6,
        background: account.active ? 'rgba(34, 197, 94, 0.10)' : 'transparent',
        border: account.active ? '1px solid rgba(34, 197, 94, 0.35)' : '1px solid transparent',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          flex: 'none',
          borderRadius: '50%',
          border: `1.5px solid ${account.active ? '#22c55e' : 'var(--border-color, #9ca3af)'}`,
          boxSizing: 'border-box',
          background: account.active ? 'radial-gradient(circle, #22c55e 0 4px, transparent 4px)' : 'transparent',
        }}
      />

      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              onRelabel(draft)
              setRenaming(false)
            }
            if (event.key === 'Escape') setRenaming(false)
          }}
          placeholder={t('accountRenameHint')}
          style={{ fontSize: 12, padding: '2px 6px', width: 130, borderRadius: 4, border: '1px solid var(--border-color, #d1d5db)' }}
        />
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: account.active ? 600 : 400, minWidth: 96 }}>
          {account.displayName}
        </span>
      )}

      <span style={{ ...probeStyle(account.probe), fontSize: 11.5, minWidth: 118 }}>
        {account.probe === undefined ? '' : probeLabel(account.probe, t)}
      </span>

      <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', marginLeft: 'auto' }}>
        {account.credits === undefined ? '' : t('creditsShort', { total: account.credits })}
      </span>

      <button type="button" onClick={onProbe} disabled={disabled} style={miniButton(disabled)}>
        {busy === `probe:${account.uid}` ? t('probing') : t('probeOne')}
      </button>
      {account.active ? (
        <span style={{ fontSize: 11, color: '#22c55e' }}>{t('accountActive')}</span>
      ) : (
        <button type="button" onClick={onSelect} disabled={disabled} style={miniButton(disabled)}>
          {t('accountUse')}
        </button>
      )}
      {renaming ? (
        <button
          type="button"
          onClick={() => {
            onRelabel(draft)
            setRenaming(false)
          }}
          disabled={disabled}
          style={miniButton(disabled)}
        >
          {t('accountSave')}
        </button>
      ) : (
        <button type="button" onClick={() => setRenaming(true)} disabled={disabled} style={miniButton(disabled)}>
          {t('accountRename')}
        </button>
      )}
      <button type="button" onClick={onRemove} disabled={disabled} style={miniButton(disabled)}>
        {t('accountRemove')}
      </button>
    </div>
  )
}

function RegionAccounts({
  title,
  lane,
  data,
  busy,
  onAction,
  t,
}: {
  title: string
  lane: Lane
  data: WorkBuddyWebRegionAccounts | undefined
  busy: string | undefined
  onAction: (action: WorkBuddyAccountAction) => void
  t: Translate
}) {
  const disabled = busy !== undefined
  return (
    <div
      style={{
        flex: '1 1 380px',
        minWidth: 300,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--border-color, #e5e7eb)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>
          {data?.probeModel ?? ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => onAction({ action: 'probe', region: lane })}
            disabled={disabled}
            style={miniButton(disabled)}
          >
            {busy === `probe:${lane}` ? t('probing') : t('probeAll')}
          </button>
          <button
            type="button"
            onClick={() => onAction({ action: 'add', region: lane })}
            disabled={disabled}
            style={miniButton(disabled)}
          >
            {busy === `add:${lane}` ? t('accountImporting') : t('accountImport')}
          </button>
        </div>
      </div>

      {data === undefined ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {data.accounts.length === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary, #6b7280)', padding: '6px 0' }}>
              {t('accountsEmpty')}
            </div>
          )}
          {data.accounts.map(account => (
            <AccountRow
              key={account.uid}
              account={account}
              busy={busy}
              t={t}
              onSelect={() => onAction({ action: 'select', region: lane, uid: account.uid })}
              onProbe={() => onAction({ action: 'probe', region: lane, uid: account.uid })}
              onRemove={() => onAction({ action: 'remove', region: lane, uid: account.uid })}
              onRelabel={label => onAction({ action: 'relabel', region: lane, uid: account.uid, label })}
            />
          ))}
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--text-secondary, #6b7280)',
              padding: '6px 8px',
              borderTop: '1px dashed var(--border-color, #e5e7eb)',
              marginTop: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span>
              {data.usingFallback ? '● ' : '○ '}
              {data.fallbackSignedIn
                ? t('fallbackName', { name: data.fallbackName ?? t('accountFallback') })
                : t('signedOut')}
            </span>
            {data.fallbackProbe !== undefined && (
              <span style={probeStyle(data.fallbackProbe)}>{probeLabel(data.fallbackProbe, t)}</span>
            )}
            {data.fallbackCredits !== undefined && (
              <span>{t('creditsShort', { total: data.fallbackCredits })}</span>
            )}
            {data.usingFallback ? (
              <span style={{ color: '#22c55e' }}>{t('fallbackInUse')}</span>
            ) : (
              <button
                type="button"
                onClick={() => onAction({ action: 'select', region: lane, uid: null })}
                disabled={disabled}
                style={miniButton(disabled)}
              >
                {t('accountUse')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The account selector for both tracks.
 *
 * Rows lead with the flash verdict because that, not the credit balance, is
 * what decides whether an account is worth using: a rate-limited account can
 * hold thousands of credits and still be unusable for hours.
 */
export function WorkBuddyAccountList({ t }: { t: Translate }) {
  const [view, setView] = useState<WorkBuddyWebAccounts | null>(null)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<Notice>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void (async () => {
      try {
        const response = await fetch(WORKBUDDY_DUAL_ACCOUNTS_PATH, { credentials: 'same-origin' })
        const payload: unknown = await response.json()
        if (!response.ok) throw new Error(readError(payload, t('requestFailed')))
        if (mounted.current) setView(payload as WorkBuddyWebAccounts)
      } catch (error: unknown) {
        if (mounted.current) {
          setNotice({ kind: 'error', text: t('accountActionFailed', { error: error instanceof Error ? error.message : String(error) }) })
        }
      }
    })()
    return () => {
      mounted.current = false
    }
  }, [])

  const send = async (action: WorkBuddyAccountAction, token: string, success?: string): Promise<void> => {
    setBusy(token)
    setNotice(undefined)
    try {
      const response = await fetch(WORKBUDDY_DUAL_ACCOUNTS_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
      })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(readError(payload, t('requestFailed')))
      if (!mounted.current) return
      setView(payload as WorkBuddyWebAccounts)
      if (success !== undefined) setNotice({ kind: 'ok', text: success })
    } catch (error: unknown) {
      if (mounted.current) {
        setNotice({
          kind: 'error',
          text: t('accountActionFailed', { error: error instanceof Error ? error.message : String(error) }),
        })
      }
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const handle = (action: WorkBuddyAccountAction): void => {
    switch (action.action) {
      case 'select':
        void send(action, `select:${action.region}`, t('accountSwitched'))
        return
      case 'add':
        void send(action, `add:${action.region}`, t('accountAdded'))
        return
      case 'remove':
        void send(action, `remove:${action.uid}`, t('accountRemoved'))
        return
      case 'relabel':
        void send(action, `relabel:${action.uid}`)
        return
      case 'probe':
        void send(action, action.uid === undefined ? `probe:${action.region}` : `probe:${action.uid}`)
        return
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t('accountsTitle')}</h3>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary, #6b7280)' }}>{t('accountsIntro')}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <RegionAccounts
          title={t('cnSection')}
          lane={'cn'}
          data={view?.cn}
          busy={busy}
          onAction={handle}
          t={t}
        />
        <RegionAccounts
          title={t('globalSection')}
          lane={'global'}
          data={view?.global}
          busy={busy}
          onAction={handle}
          t={t}
        />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>{t('probeHint')}</div>
      {notice !== undefined && (
        <div style={{ fontSize: 11.5, color: notice.kind === 'error' ? '#ef4444' : '#22c55e' }}>{notice.text}</div>
      )}
    </section>
  )
}
