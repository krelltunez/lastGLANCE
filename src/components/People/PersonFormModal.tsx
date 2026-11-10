import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Bell, BookUser, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useIntents } from '@/intents/IntentsContext'
import { requestNotificationPermission } from '@/hooks/useNotifications'
import { isNativeShell } from '@/native/platform'
import { getActiveLocale } from '@/utils/datetime'
import {
  addPersonDate, createPerson, deletePersonDate, updatePerson, updatePersonDate,
} from '@/people/queries'
import { daysToWeeks, weeksToDays } from '@/people/home'
import { INTERACTION_CHANNELS } from '@/people/types'
import type { InteractionChannel, Person, PersonCircle, PersonDate, PersonDateKind } from '@/people/types'
import { CHANNEL_LABEL_KEYS } from './channels'

interface Props {
  person?: Person
  dates?: PersonDate[]
  circles: PersonCircle[]
  // Circle preselected for a new person (added from a circle's header).
  initialCircleId?: string | null
  onClose: () => void
  onSaved?: (person: Person) => void
  // Offered on a new person when phone contacts are on.
  onImport?: () => void
}

interface DraftDate {
  key: string
  sync_id: string | null
  kind: PersonDateKind
  label: string
  month: number
  day: number
  year: string
  remind: number
}

const DATE_KINDS: PersonDateKind[] = ['birthday', 'anniversary', 'custom']
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
// Heads-up choices, in days before the date. Every date also notifies on the
// day itself.
const HEADS_UP_DAYS = [0, 1, 2, 3, 7, 14]

function toDraft(d: PersonDate): DraftDate {
  return {
    key: d.sync_id, sync_id: d.sync_id, kind: d.kind, label: d.label ?? '',
    month: d.month, day: d.day, year: d.year !== null ? String(d.year) : '',
    remind: d.remind_days_before,
  }
}

function parseYear(year: string): number | null | 'invalid' {
  if (!year.trim()) return null
  const n = Number(year.trim())
  return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : 'invalid'
}

export function PersonFormModal({ person, dates = [], circles, initialCircleId = null, onClose, onSaved, onImport }: Props) {
  const { t } = useTranslation()
  const isEdit = Boolean(person)
  const [name, setName] = useState(person?.name ?? '')
  const [nickname, setNickname] = useState(person?.nickname ?? '')
  const [circleId, setCircleId] = useState<string>(person?.circle_sync_id ?? initialCircleId ?? '')
  const [weeks, setWeeks] = useState(daysToWeeks(person?.target_cadence_days ?? null))
  const [channel, setChannel] = useState<InteractionChannel | ''>(person?.preferred_channel ?? '')
  const [details, setDetails] = useState(person?.details ?? '')
  const [notify, setNotify] = useState(person?.notify_when_overdue ?? false)
  const [notifyBlocked, setNotifyBlocked] = useState(false)
  const [toDayglance, setToDayglance] = useState(person?.add_to_dayglance_when_overdue ?? false)
  const [toLifeglance, setToLifeglance] = useState(person?.send_to_lifeglance ?? false)
  const { isConfigured: intentsOn } = useIntents()
  const [drafts, setDrafts] = useState<DraftDate[]>(() => dates.map(toDraft))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEscapeKey(onClose)

  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(getActiveLocale(), { month: 'short' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)))
  }, [])

  function patchDraft(key: string, patch: Partial<DraftDate>) {
    setDrafts(ds => ds.map(d => {
      if (d.key !== key) return d
      const next = { ...d, ...patch }
      next.day = Math.min(next.day, DAYS_IN_MONTH[next.month - 1])
      return next
    }))
    setError('')
  }

  function addDraft() {
    const kind: PersonDateKind = drafts.some(d => d.kind === 'birthday') ? 'custom' : 'birthday'
    setDrafts(ds => [...ds, { key: crypto.randomUUID(), sync_id: null, kind, label: '', month: 1, day: 1, year: '', remind: 0 }])
  }

  async function handleSave() {
    if (!name.trim()) { setError(t('people.form.nameRequired')); return }
    const cadence = weeks.trim() ? weeksToDays(weeks) : null
    if (weeks.trim() && cadence === null) { setError(t('people.form.cadenceInvalid')); return }
    for (const d of drafts) {
      if (parseYear(d.year) === 'invalid') { setError(t('people.form.yearInvalid')); return }
    }

    setSaving(true)
    try {
      const fields = {
        name,
        nickname: nickname.trim() || null,
        circle_sync_id: circleId || null,
        target_cadence_days: cadence,
        preferred_channel: channel || null,
        details: details.trim() || null,
        notify_when_overdue: notify,
        add_to_dayglance_when_overdue: toDayglance,
        send_to_lifeglance: toLifeglance,
      }
      let saved: Person
      if (person) {
        await updatePerson(person.sync_id, fields)
        saved = { ...person, ...fields, name: name.trim() }
      } else {
        saved = await createPerson(fields)
      }

      const kept = new Set(drafts.map(d => d.sync_id).filter(Boolean))
      for (const d of dates) if (!kept.has(d.sync_id)) await deletePersonDate(d.sync_id)
      for (const d of drafts) {
        const row = {
          kind: d.kind,
          label: d.kind === 'custom' ? d.label.trim() || null : null,
          month: d.month,
          day: d.day,
          year: parseYear(d.year) as number | null,
          remind_days_before: d.remind,
        }
        if (!d.sync_id) {
          await addPersonDate({ person_sync_id: saved.sync_id, ...row })
          continue
        }
        const before = dates.find(x => x.sync_id === d.sync_id)
        if (before && (before.kind !== row.kind || before.label !== row.label || before.month !== row.month ||
          before.day !== row.day || before.year !== row.year || before.remind_days_before !== row.remind_days_before)) {
          await updatePersonDate(d.sync_id, row)
        }
      }
      onSaved?.(saved)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const label = 'block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1'
  const input = 'w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400'
  const small = 'bg-slate-100 dark:bg-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400'
  const optional = <span className="text-slate-400 dark:text-slate-500">{t('people.form.optional')}</span>

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-md max-h-[90svh] flex flex-col bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="shrink-0 flex items-center justify-between px-6 pt-6 pb-3">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {isEdit ? t('people.form.editTitle') : t('people.form.addTitle')}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" aria-label={t('people.close')}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-1 space-y-3">
          {!isEdit && onImport && (
            <button
              onClick={onImport}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700/60 transition-colors"
            >
              <BookUser size={15} /> {t('people.contacts.importButton')}
            </button>
          )}
          <div>
            <label className={label}>{t('people.form.name')}</label>
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setError('') }}
              autoFocus
              className={input}
            />
          </div>

          <div>
            <label className={label}>{t('people.form.nickname')} {optional}</label>
            <input type="text" value={nickname} onChange={e => setNickname(e.target.value)} className={input} />
          </div>

          <div>
            <label className={label}>{t('people.form.circle')}</label>
            <select value={circleId} onChange={e => setCircleId(e.target.value)} className={input}>
              <option value="">{t('people.form.noCircle')}</option>
              {circles.map(c => <option key={c.sync_id} value={c.sync_id}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <label className={label}>{t('people.form.cadence')} {optional}</label>
            <input
              type="number"
              min="1"
              step="any"
              inputMode="decimal"
              value={weeks}
              onChange={e => { setWeeks(e.target.value); setError('') }}
              placeholder={t('people.form.cadencePlaceholder')}
              className={input}
            />
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{t('people.form.cadenceHint')}</p>
          </div>

          {weeks.trim() && (
            <div>
              <div className="flex items-center justify-between py-1">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Bell size={13} className={notify ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
                    <span className="text-sm text-slate-600 dark:text-slate-300">{t('people.form.notifyOverdue')}</span>
                  </div>
                  <span className="text-xs text-slate-400 dark:text-slate-500 pl-5">{t('people.form.notifyHint')}</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!notify) {
                      const perm = await requestNotificationPermission()
                      if (perm === 'denied') { setNotifyBlocked(true); return }
                      setNotifyBlocked(false)
                    }
                    setNotify(v => !v)
                  }}
                  className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ml-3 ${notify ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                  aria-checked={notify}
                  aria-label={t('people.form.notifyOverdue')}
                  role="switch"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${notify ? 'translate-x-4' : ''}`} />
                </button>
              </div>
              {notifyBlocked && (
                <p className="text-xs text-amber-500 dark:text-amber-400">{t(isNativeShell() ? 'choreForm.notifyBlockedDevice' : 'choreForm.notifyBlocked')}</p>
              )}
              {intentsOn && (
                <IntentSwitch
                  on={toDayglance}
                  onToggle={() => setToDayglance(v => !v)}
                  label={t('people.form.autoSendDayglance')}
                  hint={t('people.form.autoSendDayglanceHint')}
                />
              )}
            </div>
          )}

          {intentsOn && (
            <IntentSwitch
              on={toLifeglance}
              onToggle={() => setToLifeglance(v => !v)}
              label={t('people.form.sendToLifeglance')}
              hint={t('people.form.sendToLifeglanceHint')}
            />
          )}

          <div>
            <label className={label}>{t('people.form.preferredChannel')}</label>
            <select value={channel} onChange={e => setChannel(e.target.value as InteractionChannel | '')} className={input}>
              <option value="">{t('people.form.noPreference')}</option>
              {INTERACTION_CHANNELS.map(c => <option key={c} value={c}>{t(CHANNEL_LABEL_KEYS[c])}</option>)}
            </select>
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-slate-700/40 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('people.form.dates')}</span>
              <button
                type="button"
                onClick={addDraft}
                className="flex items-center gap-1 text-xs font-medium text-green-500 dark:text-green-400 hover:text-green-400"
              >
                <Plus size={12} /> {t('people.form.addDate')}
              </button>
            </div>
            {drafts.map(d => (
              <div key={d.key} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={d.kind}
                    onChange={e => patchDraft(d.key, { kind: e.target.value as PersonDateKind })}
                    className={`${small} flex-1`}
                    aria-label={t('people.form.dateKind')}
                  >
                    {DATE_KINDS.map(k => <option key={k} value={k}>{t(`people.dateKind.${k}`)}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => setDrafts(ds => ds.filter(x => x.key !== d.key))}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 transition-colors"
                    aria-label={t('people.form.removeDate')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {d.kind === 'custom' && (
                  <input
                    type="text"
                    value={d.label}
                    onChange={e => patchDraft(d.key, { label: e.target.value })}
                    placeholder={t('people.form.dateLabelPlaceholder')}
                    className={`${small} w-full`}
                  />
                )}
                <div className="flex items-center gap-2">
                  <select
                    value={d.month}
                    onChange={e => patchDraft(d.key, { month: Number(e.target.value) })}
                    className={`${small} w-24`}
                    aria-label={t('people.form.month')}
                  >
                    {monthNames.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                  <select
                    value={d.day}
                    onChange={e => patchDraft(d.key, { day: Number(e.target.value) })}
                    className={`${small} w-16`}
                    aria-label={t('people.form.day')}
                  >
                    {Array.from({ length: DAYS_IN_MONTH[d.month - 1] }, (_, i) => i + 1).map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={d.year}
                    onChange={e => patchDraft(d.key, { year: e.target.value })}
                    placeholder={t('people.form.yearPlaceholder')}
                    className={`${small} w-24`}
                    aria-label={t('people.form.year')}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Bell size={12} className={`shrink-0 ${d.remind ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'}`} />
                  <select
                    value={d.remind}
                    onChange={e => patchDraft(d.key, { remind: Number(e.target.value) })}
                    className={`${small} flex-1`}
                    aria-label={t('people.form.headsUp')}
                  >
                    {HEADS_UP_DAYS.map(n => (
                      <option key={n} value={n}>
                        {n === 0 ? t('people.form.onTheDay') : t('people.form.daysBefore', { count: n })}
                      </option>
                    ))}
                    {!HEADS_UP_DAYS.includes(d.remind) && (
                      <option value={d.remind}>{t('people.form.daysBefore', { count: d.remind })}</option>
                    )}
                  </select>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-slate-700/40">
            <label className={label}>{t('people.form.details')} {optional}</label>
            <textarea
              value={details}
              onChange={e => setDetails(e.target.value)}
              placeholder={t('people.form.detailsPlaceholder')}
              rows={3}
              className={`${input} resize-y`}
            />
          </div>
        </div>

        <div className="shrink-0 px-6 pt-4 pb-6 border-t border-slate-100 dark:border-slate-700/40 space-y-2">
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              {t('people.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-50 transition-colors"
            >
              {saving ? t('people.saving') : isEdit ? t('people.save') : t('people.form.add')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// A switch row for sending to another GLANCE app, as on the chore form.
function IntentSwitch({ on, onToggle, label, hint }: { on: boolean; onToggle: () => void; label: string; hint: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <ArrowUpRight size={13} className={on ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
          <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
        </div>
        <span className="text-xs text-slate-400 dark:text-slate-500 pl-5">{hint}</span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ml-3 ${on ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
        aria-checked={on}
        aria-label={label}
        role="switch"
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
      </button>
    </div>
  )
}
