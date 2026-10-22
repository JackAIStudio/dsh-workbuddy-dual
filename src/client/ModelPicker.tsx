import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  WORKBUDDY_DUAL_MODELS_PATH,
  type WorkBuddyDualWebModels,
  type WorkBuddyLaneMode,
  type WorkBuddyLanePreference,
  type WorkBuddyWebModelOption,
} from '../model-paths.ts'
import type { WorkBuddyDualSettingsKey } from './locales.ts'

export interface ModelPickerInjected {
  t: (key: WorkBuddyDualSettingsKey, params?: Record<string, unknown>) => string
}

export interface ModelPickerProps extends Partial<ModelPickerInjected> {}

type Lane = 'cn' | 'global'
type Notice = { kind: 'ok' | 'error'; text: string } | undefined

const LANES: readonly Lane[] = ['cn', 'global']

/** Ids currently checked in a lane's staged draft. */
export function selectedIds(models: readonly WorkBuddyWebModelOption[]): string[] {
  return models.filter(model => model.selected).map(model => model.id)
}

function formatContext(contextWindow: number): string {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return ''
  if (contextWindow >= 1_000_000) return `${Math.round(contextWindow / 100_000) / 10}M`
  return `${Math.round(contextWindow / 1000)}K`
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {}
  return `HTTP ${response.status}`
}

function LaneModelList({
  lane,
  draft,
  onToggle,
  onSelectAll,
  onSelectNone,
  t,
}: {
  lane: Lane
  draft: WorkBuddyWebModelOption[]
  onToggle: (id: string) => void
  onSelectAll: () => void
  onSelectNone: () => void
  t: ModelPickerInjected['t']
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = needle === ''
    ? draft
    : draft.filter(model => model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))

  const checkedCount = draft.filter(model => model.selected).length
  const allChecked = draft.length > 0 && checkedCount === draft.length
  const someChecked = checkedCount > 0 && !allChecked

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
          {t('selectedCount', { count: checkedCount, total: draft.length })}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={onSelectAll} disabled={allChecked} style={miniButtonStyle}>
            {t('selectAll')}
          </button>
          <button type="button" onClick={onSelectNone} disabled={checkedCount === 0} style={miniButtonStyle}>
            {t('selectNone')}
          </button>
        </div>
      </div>

      <input
        type="search"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder={t('searchModels')}
        aria-label={t('searchModels')}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          borderRadius: 7,
          border: '1px solid var(--border-color, #e5e7eb)',
          background: 'transparent',
          color: 'inherit',
          fontSize: 13,
        }}
      />

      <div
        role="group"
        aria-label={lane === 'cn' ? t('cnSection') : t('globalSection')}
        style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto', paddingRight: 4 }}
      >
        {visible.length === 0 && (
          <div style={{ padding: '18px 4px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
            {draft.length === 0 ? t('noModels') : t('noMatches')}
          </div>
        )}
        {visible.map(model => (
          <label
            key={model.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '7px 6px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={model.selected}
              onChange={() => onToggle(model.id)}
              style={{ margin: 0, flex: 'none' }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {model.name}
            </span>
            {model.free && (
              <span style={{ fontSize: 11, color: '#22c55e', flex: 'none' }}>{t('freeModel')}</span>
            )}
            {model.credits && (
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)', flex: 'none' }}>
                {model.credits}
              </span>
            )}
            <span
              style={{
                fontSize: 11,
                color: 'var(--dsw-alias-label-secondary, #6b7280)',
                width: 42,
                textAlign: 'right',
                flex: 'none',
              }}
            >
              {formatContext(model.contextWindow)}
            </span>
          </label>
        ))}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', paddingTop: 2 }}>
        <input
          type="checkbox"
          checked={allChecked}
          ref={node => {
            if (node !== null) node.indeterminate = someChecked
          }}
          onChange={event => (event.target.checked ? onSelectAll() : onSelectNone())}
          style={{ margin: 0 }}
        />
        {t('selectAllHint')}
      </label>
    </div>
  )
}

export function ModelPicker({ t }: ModelPickerProps) {
  if (!t) return null

  const [view, setView] = useState<WorkBuddyDualWebModels | null>(null)
  const [drafts, setDrafts] = useState<Record<Lane, WorkBuddyWebModelOption[]> | null>(null)
  const [baseline, setBaseline] = useState<Record<Lane, WorkBuddyWebModelOption[]> | null>(null)
  const [enabled, setEnabled] = useState<Record<Lane, boolean>>({ cn: true, global: true })
  const [mode, setMode] = useState<Record<Lane, WorkBuddyLaneMode>>({ cn: 'all', global: 'all' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(undefined)
  const mounted = useRef(true)

  const hydrate = (next: WorkBuddyDualWebModels): void => {
    setView(next)
    setDrafts({ cn: [...next.cn.models], global: [...next.global.models] })
    setBaseline({ cn: [...next.cn.models], global: [...next.global.models] })
    setEnabled({ cn: next.cn.enabled, global: next.global.enabled })
    setMode({ cn: next.cn.mode, global: next.global.mode })
  }

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await fetch(WORKBUDDY_DUAL_MODELS_PATH, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(await readError(response))
      const next = (await response.json()) as WorkBuddyDualWebModels
      if (mounted.current) {
        hydrate(next)
        setNotice(undefined)
      }
    } catch (error: unknown) {
      if (mounted.current) {
        setNotice({
          kind: 'error',
          text: error instanceof Error && error.message === t('requestFailed')
            ? t('loadFailedHint')
            : t('loadFailed', { error: error instanceof Error ? error.message : String(error) }),
        })
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [])

  const dirty = useMemo(() => {
    if (!view || !drafts || !baseline) return false
    return LANES.some(lane => {
      const stored = view[lane]
      if (stored.enabled !== enabled[lane] || stored.mode !== mode[lane]) return true
      // Compare against the last saved draft, not against `stored.models`:
      // a lane in `all` mode reports every row selected even though its stored
      // list is empty, so that comparison would claim a false dirty state.
      const now = new Set(selectedIds(drafts[lane]))
      const before = new Set(selectedIds(baseline[lane]))
      return now.size !== before.size || [...now].some(id => !before.has(id))
    })
  }, [view, drafts, baseline, enabled, mode])

  const updateDraft = (lane: Lane, change: (models: WorkBuddyWebModelOption[]) => WorkBuddyWebModelOption[]): void => {
    setDrafts(current => (current === null ? current : { ...current, [lane]: change(current[lane]) }))
    setNotice(undefined)
  }

  const markSelected = (lane: Lane, ids: readonly string[]): void => {
    const wanted = new Set(ids)
    updateDraft(lane, models => models.map(model => ({ ...model, selected: wanted.has(model.id) })))
  }

  const save = async (): Promise<void> => {
    if (!drafts) return
    const payload: { cn?: WorkBuddyLanePreference; global?: WorkBuddyLanePreference } = {}
    for (const lane of LANES) {
      payload[lane] = {
        enabled: enabled[lane],
        mode: mode[lane],
        models: mode[lane] === 'all' ? [] : selectedIds(drafts[lane]),
      }
    }
    setSaving(true)
    setNotice(undefined)
    try {
      const response = await fetch(WORKBUDDY_DUAL_MODELS_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(await readError(response))
      const next = (await response.json()) as WorkBuddyDualWebModels & { ok?: boolean }
      if (mounted.current) {
        hydrate(next)
        setNotice({ kind: 'ok', text: t('saved') })
      }
    } catch (error: unknown) {
      if (mounted.current) setNotice({ kind: 'error', text: t('saveFailed', { error: String(error) }) })
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  if (loading && view === null) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
        {t('loading')}
      </div>
    )
  }

  if (view === null || drafts === null) {
    return (
      <div style={{ padding: 16, fontSize: 13 }}>
        <div style={{ marginBottom: 10 }}>{notice?.text ?? t('loadFailedHint')}</div>
        <button type="button" onClick={() => void load()} style={miniButtonStyle}>{t('retry')}</button>
      </div>
    )
  }

  return (
    <section
      style={{
        border: '1px solid var(--border-color, #e5e7eb)',
        borderRadius: 10,
        padding: '16px 18px 18px',
        background: 'var(--bg-panel, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 3 }}>{t('pickerTitle')}</div>
          <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
            {t('pickerIntro')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
          <button type="button" onClick={() => void load()} disabled={loading || saving} style={miniButtonStyle}>
            {loading ? t('refreshing') : t('refreshList')}
          </button>
          <button type="button" onClick={() => void save()} disabled={saving || !dirty} style={primaryButtonStyle(saving || !dirty)}>
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </header>

      {notice && (
        <div
          role="status"
          style={{
            fontSize: 13,
            padding: '8px 10px',
            borderRadius: 7,
            color: notice.kind === 'ok' ? '#16a34a' : '#dc2626',
            background: notice.kind === 'ok' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.1)',
          }}
        >
          {notice.text}
        </div>
      )}

      {LANES.map(lane => {
        const stored = view[lane]
        return (
          <div
            key={lane}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              paddingTop: lane === 'global' ? 16 : 2,
              borderTop: lane === 'global' ? '1px solid var(--border-color, #e5e7eb)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{lane === 'cn' ? t('cnSection') : t('globalSection')}</span>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
                  {!stored.signedIn ? t('signedOut') : stored.live ? t('liveCatalog') : t('fallbackCatalog')}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={enabled[lane]}
                    onChange={event => {
                      setEnabled(current => ({ ...current, [lane]: event.target.checked }))
                      setNotice(undefined)
                    }}
                    style={{ margin: 0 }}
                  />
                  {t('laneEnabled')}
                </label>
                <div
                  role="radio-group"
                  aria-label={t('modeLabel')}
                  style={{
                    display: 'flex',
                    border: '1px solid var(--border-color, #e5e7eb)',
                    borderRadius: 7,
                    overflow: 'hidden',
                  }}
                >
                  {(['all', 'selected'] as const).map(option => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={mode[lane] === option}
                      onClick={() => {
                        setMode(current => ({ ...current, [lane]: option }))
                        setNotice(undefined)
                      }}
                      style={{
                        fontSize: 12,
                        padding: '5px 10px',
                        border: 'none',
                        cursor: 'pointer',
                        background: mode[lane] === option ? 'var(--dsw-alias-interactive-bg-hover, #eef2ff)' : 'transparent',
                        color: 'inherit',
                        fontWeight: mode[lane] === option ? 600 : 400,
                      }}
                    >
                      {option === 'all' ? t('modeAll') : t('modeSelected')}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {!enabled[lane] ? (
              <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>{t('laneDisabledHint')}</div>
            ) : mode[lane] === 'all' ? (
              <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
                {t('modeAllHint', { total: drafts[lane].length })}
              </div>
            ) : (
              <LaneModelList
                lane={lane}
                draft={drafts[lane]}
                onToggle={id => updateDraft(lane, models => models.map(model => (model.id === id ? { ...model, selected: !model.selected } : model)))}
                onSelectAll={() => markSelected(lane, drafts[lane].map(model => model.id))}
                onSelectNone={() => markSelected(lane, [])}
                t={t}
              />
            )}
          </div>
        )
      })}

      <footer style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
        {t('pickerFoot')}
      </footer>
    </section>
  )
}

const miniButtonStyle: CSSProperties = {
  fontSize: 12,
  padding: '5px 9px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--border-color, #d1d5db)',
  background: 'transparent',
  color: 'inherit',
}

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    fontSize: 12,
    padding: '5px 12px',
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: '1px solid transparent',
    background: disabled ? 'rgba(59, 130, 246, 0.25)' : 'rgb(37, 99, 235)',
    color: '#ffffff',
  }
}
