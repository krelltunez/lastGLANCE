import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Smile, Bell, ArrowUpRight, Leaf, Users } from 'lucide-react'
import type { Chore, Category } from '@/types'
import { createChore, updateChore } from '@/db/queries'
import { useUsersContext } from '@/multiuser/UsersContext'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { ICON_REGISTRY } from '@/icons/registry'
import { requestNotificationPermission } from '@/hooks/useNotifications'
import { useIntents } from '@/intents/IntentsContext'
import { useTranslation } from 'react-i18next'

interface Props {
  category: Category
  allCategories?: Category[]
  chore?: Chore
  onClose: () => void
  onSaved: () => void
}

const MONTHS = [
  ['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'],
  ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'],
  ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec'],
] as const

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))

function parseMD(s: string | null | undefined, fallback: string): { month: string; day: string } {
  if (!s) {
    const [m, d] = fallback.split('-')
    return { month: m, day: d }
  }
  const [m, d] = s.split('-')
  return { month: m ?? '01', day: d ?? '01' }
}

// Sort categories hierarchically: root → its children → next root → its children…
function sortHierarchically(categories: Category[]): Category[] {
  const roots = categories.filter(c => !c.parent_category_id)
  const childrenByParent = new Map<number, Category[]>()
  for (const cat of categories) {
    if (cat.parent_category_id) {
      const arr = childrenByParent.get(cat.parent_category_id) ?? []
      arr.push(cat)
      childrenByParent.set(cat.parent_category_id, arr)
    }
  }
  return roots.flatMap(r => [r, ...(childrenByParent.get(r.id) ?? [])])
}

export function ChoreFormModal({ category, allCategories, chore, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const isEdit = Boolean(chore)
  const [name, setName] = useState(chore?.name ?? '')
  const [cadence, setCadence] = useState(
    chore?.target_cadence_days != null ? String(chore.target_cadence_days) : ''
  )
  const [icon, setIcon] = useState<string | undefined>(chore ? chore.icon : category.icon)
  const [notify, setNotify] = useState(chore?.notify_when_overdue ?? false)
  const [autoSchedule, setAutoSchedule] = useState(chore?.auto_schedule_to_dayglance ?? false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(chore?.category_id ?? category.id)
  const [notifyBlocked, setNotifyBlocked] = useState(false)
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { isConfigured } = useIntents()

  const { multiUserEnabled, users: allUsers } = useUsersContext()
  const [assignedIds, setAssignedIds] = useState<string[]>(chore?.assigned_user_sync_ids ?? [])

  function toggleAssigned(syncId: string) {
    setAssignedIds(prev =>
      prev.includes(syncId) ? prev.filter(id => id !== syncId) : [...prev, syncId]
    )
  }

  const [isSeasonal, setIsSeasonal] = useState(Boolean(chore?.seasonal_start))
  const initStart = parseMD(chore?.seasonal_start, '04-01')
  const initEnd = parseMD(chore?.seasonal_end, '10-31')
  const [startMonth, setStartMonth] = useState(initStart.month)
  const [startDay, setStartDay] = useState(initStart.day)
  const [endMonth, setEndMonth] = useState(initEnd.month)
  const [endDay, setEndDay] = useState(initEnd.day)

  useEscapeKey(showIconPicker ? () => setShowIconPicker(false) : onClose)

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) { setError(t('choreForm.nameRequired')); return }
    const cadenceDays = cadence.trim() ? parseInt(cadence, 10) : null
    if (cadence.trim() && (isNaN(cadenceDays!) || cadenceDays! < 1)) {
      setError(t('choreForm.cadenceInvalid')); return
    }
    const seasonal_start = isSeasonal ? `${startMonth}-${startDay}` : null
    const seasonal_end = isSeasonal ? `${endMonth}-${endDay}` : null
    setSaving(true)
    try {
      if (isEdit && chore) {
        await updateChore(chore.id, { name: trimmed, target_cadence_days: cadenceDays, notify_when_overdue: notify, auto_schedule_to_dayglance: autoSchedule, icon, category_id: selectedCategoryId, seasonal_start, seasonal_end, assigned_user_sync_ids: assignedIds })
      } else {
        await createChore({
          name: trimmed,
          category_id: category.id,
          target_cadence_days: cadenceDays,
          notify_when_overdue: notify,
          auto_schedule_to_dayglance: autoSchedule,
          preferred_schedule_behavior: null,
          seasonal_start,
          seasonal_end,
          icon,
          assigned_user_sync_ids: assignedIds,
        })
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const SelectedIcon = icon ? ICON_REGISTRY[icon] : null

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div className="w-full sm:max-w-md bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-700/50">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {isEdit ? t('choreForm.editChore') : t('choreForm.addChore', { category: category.name })}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('choreForm.nameLabel')}</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => { setName(e.target.value); setError('') }}
                  placeholder={t('choreForm.namePlaceholder')}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('choreForm.iconLabel')}</label>
                <button
                  type="button"
                  onClick={() => setShowIconPicker(true)}
                  className="h-[38px] w-[38px] flex items-center justify-center bg-slate-100 dark:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 hover:border-green-400/60 transition-colors text-slate-400 hover:text-green-400"
                  title={t('choreForm.pickIcon')}
                >
                  {SelectedIcon ? <SelectedIcon size={18} className="text-green-400" /> : <Smile size={16} />}
                </button>
              </div>
            </div>

            {isEdit && allCategories && allCategories.length > 1 && (
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('choreForm.categoryLabel')}</label>
                <select
                  value={selectedCategoryId}
                  onChange={e => setSelectedCategoryId(Number(e.target.value))}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                >
                  {sortHierarchically(allCategories).map(cat => (
                    <option key={cat.id} value={cat.id}>
                      {cat.parent_category_id ? `  ${cat.name}` : cat.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('choreForm.cadenceLabel')} <span className="text-slate-400 dark:text-slate-500">{t('choreForm.cadenceOptional')}</span>
              </label>
              <input
                type="number"
                min="1"
                value={cadence}
                onChange={e => { setCadence(e.target.value); setError('') }}
                placeholder={t('choreForm.cadencePlaceholder')}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                {t('choreForm.cadenceHint')}
              </p>
            </div>

            {cadence.trim() && (
              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Bell size={13} className={notify ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
                  <span className="text-sm text-slate-600 dark:text-slate-300">{t('choreForm.notifyOverdue')}</span>
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
                  className={`relative w-10 h-6 rounded-full transition-colors ${notify ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                  aria-checked={notify}
                  role="switch"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${notify ? 'translate-x-4' : ''}`} />
                </button>
              </div>
            )}
            {notifyBlocked && (
              <p className="text-xs text-amber-500 dark:text-amber-400">{t('choreForm.notifyBlocked')}</p>
            )}

            {cadence.trim() && isConfigured && (
              <div className="flex items-center justify-between py-1">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <ArrowUpRight size={13} className={autoSchedule ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
                    <span className="text-sm text-slate-600 dark:text-slate-300">{t('choreForm.autoSendDayglance')}</span>
                  </div>
                  <span className="text-xs text-slate-400 dark:text-slate-500 pl-5">{t('choreForm.autoSendHint')}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoSchedule(v => !v)}
                  className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ml-3 ${autoSchedule ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                  aria-checked={autoSchedule}
                  role="switch"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${autoSchedule ? 'translate-x-4' : ''}`} />
                </button>
              </div>
            )}

            {multiUserEnabled && allUsers.length > 0 && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-700/40 space-y-2">
                <div className="flex items-center gap-2">
                  <Users size={13} className="text-slate-400 dark:text-slate-500" />
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('choreForm.assignedTo')}</span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">{t('choreForm.assignedHint')}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {allUsers.map(user => {
                    const active = assignedIds.includes(user.sync_id)
                    return (
                      <button
                        key={user.sync_id}
                        type="button"
                        onClick={() => toggleAssigned(user.sync_id)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                          active
                            ? 'bg-green-400/15 border-green-400/50 text-green-500 dark:text-green-400'
                            : 'bg-slate-100 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-green-400/40 hover:text-green-500'
                        }`}
                      >
                        <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${active ? 'bg-green-400 text-white' : 'bg-slate-300 dark:bg-slate-500 text-slate-600 dark:text-slate-300'}`}>
                          {user.name.charAt(0).toUpperCase()}
                        </span>
                        {user.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-slate-100 dark:border-slate-700/40 space-y-2">
              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Leaf size={13} className={isSeasonal ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
                  <span className="text-sm text-slate-600 dark:text-slate-300">{t('choreForm.seasonal')}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSeasonal(v => !v)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${isSeasonal ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                  aria-checked={isSeasonal}
                  role="switch"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${isSeasonal ? 'translate-x-4' : ''}`} />
                </button>
              </div>

              {isSeasonal && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                  {(['From', 'To'] as const).map(label => {
                    const isFrom = label === 'From'
                    const month = isFrom ? startMonth : endMonth
                    const day = isFrom ? startDay : endDay
                    const setMonth = isFrom ? setStartMonth : setEndMonth
                    const setDay = isFrom ? setStartDay : setEndDay
                    const tLabel = isFrom ? t('choreForm.seasonalFrom') : t('choreForm.seasonalTo')
                    return (
                      <div key={label} className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">{tLabel}</span>
                        <select
                          value={month}
                          onChange={e => setMonth(e.target.value)}
                          className="w-20 bg-slate-100 dark:bg-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                        >
                          {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                        <select
                          value={day}
                          onChange={e => setDay(e.target.value)}
                          className="w-14 bg-slate-100 dark:bg-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                        >
                          {DAYS.map(d => <option key={d} value={d}>{parseInt(d)}</option>)}
                        </select>
                      </div>
                    )
                  })}
                  </div>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    {t('choreForm.seasonalHint')}
                  </p>
                </div>
              )}
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>

          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              {t('choreForm.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-50 transition-colors"
            >
              {saving ? t('choreForm.saving') : isEdit ? t('choreForm.save') : t('choreForm.add')}
            </button>
          </div>
        </div>
      </div>

      {showIconPicker && (
        <IconPicker
          selected={icon}
          onSelect={name => setIcon(name)}
          onClose={() => setShowIconPicker(false)}
        />
      )}
    </>,
    document.body
  )
}
