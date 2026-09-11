import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  WORKBUDDY_DUAL_STATUS_PATH,
  type WorkBuddyDualWebStatus,
  type WorkBuddyRegionWebStatus,
} from '../status-paths.ts'
import type { WorkBuddyDualSettingsKey } from './locales.ts'

export interface WorkBuddyDualCardInjected {
  t: (key: WorkBuddyDualSettingsKey, params?: Record<string, unknown>) => string
}

export interface WorkBuddyDualCardProps extends Partial<WorkBuddyDualCardInjected> {}

function dotStyle(status: 'signed-in' | 'signed-out' | 'error'): CSSProperties {
  const color = status === 'signed-in' ? '#22c55e' : status === 'error' ? '#ef4444' : '#9ca3af'
  return {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: color,
    marginRight: 6,
  }
}

function RegionCard({
  title,
  data,
  t,
}: {
  title: string
  data?: WorkBuddyRegionWebStatus | undefined
  t: WorkBuddyDualCardInjected['t']
}) {
  const isSignIn = data && data.status === 'signed-in'
  const status = data ? data.status : 'signed-out'

  return (
    <div
      style={{
        flex: '1 1 240px',
        padding: '12px 14px',
        borderRadius: 8,
        border: '1px solid var(--border-color, #e5e7eb)',
        background: 'var(--card-bg, rgba(255, 255, 255, 0.03))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        <span style={{ fontSize: 12, display: 'flex', alignItems: 'center' }}>
          <span style={dotStyle(status)} />
          {isSignIn ? t('signedInAs', { nickname: data.nickname ?? 'OK' }) : t('signedOut')}
        </span>
      </div>

      {isSignIn && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', lineHeight: 1.6 }}>
          {data.credits && <div>{t('creditsTotal', { total: data.credits.total })}</div>}
          {data.creditsError && <div style={{ color: '#ef4444' }}>{data.creditsError}</div>}
          {data.expiresAt && (
            <div>{t('accessTokenExpires', { time: new Date(data.expiresAt).toLocaleDateString() })}</div>
          )}
          {data.models && data.models.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {data.models.slice(0, 4).map((m: { id: string; name: string; free?: boolean | undefined; credits?: string | undefined }) => (
                <span
                  key={m.id}
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: m.free ? 'rgba(34, 197, 94, 0.15)' : 'rgba(156, 163, 175, 0.15)',
                    color: m.free ? '#22c55e' : 'inherit',
                  }}
                >
                  {m.name} {m.free ? `(${t('freeModel')})` : m.credits ? `(${m.credits})` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function WorkBuddyDualCard({ t }: WorkBuddyDualCardProps) {
  if (!t) return null

  const [status, setStatus] = useState<WorkBuddyDualWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const mounted = useRef(true)

  const fetchStatus = async () => {
    setLoading(true)
    try {
      const res = await fetch(WORKBUDDY_DUAL_STATUS_PATH, { credentials: 'same-origin' })
      if (res.ok && mounted.current) {
        setStatus((await res.json()) as WorkBuddyDualWebStatus)
      }
    } catch {}
    if (mounted.current) setLoading(false)
  }

  useEffect(() => {
    mounted.current = true
    void fetchStatus()
    return () => {
      mounted.current = false
    }
  }, [])

  return (
    <div
      style={{
        padding: '16px',
        borderRadius: 10,
        border: '1px solid var(--border-color, #e5e7eb)',
        background: 'var(--bg-panel, #ffffff)',
        marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{t('title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', marginTop: 2 }}>
            {t('intro')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => void fetchStatus()}
            disabled={loading}
            style={{
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              border: '1px solid var(--border-color, #d1d5db)',
              background: 'transparent',
            }}
          >
            {loading ? t('refreshing') : t('refresh')}
          </button>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              border: '1px solid var(--border-color, #d1d5db)',
              background: 'transparent',
            }}
          >
            {expanded ? t('collapse') : t('expand')}
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <RegionCard title={t('cnSection')} data={status?.cn} t={t} />
          <RegionCard title={t('globalSection')} data={status?.global} t={t} />
        </div>
      )}
    </div>
  )
}
