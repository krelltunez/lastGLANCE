import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookUser, Check, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { getActiveLocale } from '@/utils/datetime'
import { listFormat } from '@/people/reminders'
import {
  contactsPermission, listDeviceContacts, requestContactsPermission, type DeviceContactSummary,
} from '@/native/contacts'
import { contactDates, newDates, type ContactDate } from '@/people/contacts'
import { addPersonDate, createPerson, setContactLink } from '@/people/queries'
import type { ContactLink, PersonCircle, PersonDate, PersonWithLastInteraction } from '@/people/types'
import { dateKindLabel } from './labels'

type Props = {
  links: ContactLink[]
  circles: PersonCircle[]
  onClose: () => void
} & (
  | { mode: 'import'; initialCircleId?: string | null }
  | { mode: 'link'; person: PersonWithLastInteraction; personDates: PersonDate[] }
  // Just the disclosure and the system prompt, from the Settings switch.
  | { mode: 'permission'; onGranted: () => void }
)

type Step = 'checking' | 'disclosure' | 'denied' | 'loading' | 'list' | 'error'

const dateKey = (d: ContactDate) => `${d.kind}|${d.label ?? ''}|${d.month}|${d.day}`

// Import people from the phone's contacts, or link one existing person to a
// contact. Opens on the in-app disclosure when permission has not been given,
// so the system prompt only ever follows the user tapping Continue (Play's
// prominent-disclosure rule). Nothing is imported until the user picks.
export function ContactsModal(props: Props) {
  const { t } = useTranslation()
  const { links, circles, onClose } = props
  const [step, setStep] = useState<Step>('checking')
  const [contacts, setContacts] = useState<DeviceContactSummary[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  // Dates the user unticked, per contact key.
  const [skipped, setSkipped] = useState<Record<string, string[]>>({})
  const [circleId, setCircleId] = useState(props.mode === 'import' ? props.initialCircleId ?? '' : '')
  const [saving, setSaving] = useState(false)
  useEscapeKey(onClose)

  async function load() {
    if (props.mode === 'permission') { props.onGranted(); onClose(); return }
    setStep('loading')
    try {
      setContacts(await listDeviceContacts())
      setStep('list')
    } catch {
      setStep('error')
    }
  }

  useEffect(() => {
    let live = true
    void contactsPermission().then(state => {
      if (!live) return
      if (state === 'granted') void load()
      else setStep('disclosure')
    })
    return () => { live = false }
  // Checks once, when the window opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function allow() {
    const state = await requestContactsPermission().catch(() => 'denied' as const)
    if (state === 'granted') void load()
    else setStep('denied')
  }

  const linkedKeys = useMemo(() => new Set(links.map(l => l.device_contact_key)), [links])
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return q ? contacts.filter(c => c.name.toLocaleLowerCase().includes(q)) : contacts
  }, [contacts, query])
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(getActiveLocale(), { month: 'short' }), [])
  const dateText = (d: ContactDate) =>
    `${dateKindLabel(t, d)} · ${monthFmt.format(new Date(2000, d.month - 1, 1))} ${d.day}${d.year ? `, ${d.year}` : ''}`

  const datesFor = (c: DeviceContactSummary) => {
    const all = contactDates(c.events)
    return props.mode === 'link' ? newDates(props.personDates, all) : all
  }
  const keptDates = (c: DeviceContactSummary) => datesFor(c).filter(d => !(skipped[c.key] ?? []).includes(dateKey(d)))

  function toggle(key: string) {
    if (props.mode === 'link') setSelected(s => (s[0] === key ? [] : [key]))
    else setSelected(s => (s.includes(key) ? s.filter(k => k !== key) : [...s, key]))
  }
  function toggleDate(key: string, d: ContactDate) {
    const id = dateKey(d)
    setSkipped(s => {
      const cur = s[key] ?? []
      return { ...s, [key]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }
    })
  }

  async function save() {
    if (selected.length === 0 || saving) return
    setSaving(true)
    try {
      const byKey = new Map(contacts.map(c => [c.key, c]))
      for (const key of selected) {
        const c = byKey.get(key)
        if (!c) continue
        const personId = props.mode === 'link'
          ? props.person.sync_id
          : (await createPerson({ name: c.name, circle_sync_id: circleId || null })).sync_id
        for (const d of keptDates(c)) {
          await addPersonDate({ person_sync_id: personId, kind: d.kind, label: d.label, month: d.month, day: d.day, year: d.year })
        }
        await setContactLink(personId, key)
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const title = props.mode === 'link' ? t('people.contacts.linkTitle', { name: props.person.name })
    : props.mode === 'permission' ? t('settings.phoneContacts')
    : t('people.contacts.importTitle')
  const btn = 'flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors'
  const secondary = `${btn} text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600`
  const primary = `${btn} text-green-400 border border-green-400/40 hover:bg-green-400/10 disabled:opacity-40 disabled:hover:bg-transparent`

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg max-h-[90svh] flex flex-col bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="shrink-0 flex items-center justify-between gap-3 px-6 pt-6 pb-3">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 truncate">{title}</h2>
          <button onClick={onClose} className="p-2 -m-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" aria-label={t('people.close')}>
            <X size={18} />
          </button>
        </div>

        {step === 'disclosure' && (
          <div className="px-6 pb-6 space-y-4">
            <div className="flex items-start gap-3">
              <BookUser size={22} className="shrink-0 text-green-400 mt-0.5" />
              <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
                <p>{t('people.contacts.disclosure1')}</p>
                <p>{t('people.contacts.disclosure2')}</p>
                <p>{t('people.contacts.disclosure3')}</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={onClose} className={secondary}>{t('people.cancel')}</button>
              <button onClick={allow} className={primary}>{t('people.contacts.continue')}</button>
            </div>
          </div>
        )}

        {step === 'denied' && (
          <div className="px-6 pb-6 space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('people.contacts.denied')}</p>
            <button onClick={onClose} className={`${secondary} w-full`}>{t('people.close')}</button>
          </div>
        )}

        {(step === 'checking' || step === 'loading') && (
          <p className="px-6 pb-6 text-sm text-slate-400 dark:text-slate-500">{step === 'loading' ? t('people.contacts.loading') : ' '}</p>
        )}

        {step === 'error' && (
          <div className="px-6 pb-6 space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('people.contacts.error')}</p>
            <button onClick={onClose} className={`${secondary} w-full`}>{t('people.close')}</button>
          </div>
        )}

        {step === 'list' && (
          <>
            <div className="shrink-0 px-6 pb-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t('people.contacts.search')}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
              </div>
            </div>
            <ul className="flex-1 min-h-0 overflow-y-auto px-6 pb-3 space-y-1.5">
              {visible.length === 0 && (
                <li className="text-sm text-slate-400 dark:text-slate-500 py-2">{t('people.contacts.none')}</li>
              )}
              {visible.map(c => {
                const taken = linkedKeys.has(c.key)
                const on = selected.includes(c.key)
                const dates = datesFor(c)
                return (
                  <li key={c.key}>
                    <button
                      disabled={taken}
                      onClick={() => toggle(c.key)}
                      role={props.mode === 'link' ? 'radio' : 'checkbox'}
                      aria-checked={on}
                      className={`w-full text-left flex items-center gap-3 rounded-lg px-3 py-2 border transition-colors ${
                        on ? 'border-green-400/60 bg-green-400/10' : 'border-slate-100 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-700/40 hover:border-slate-300 dark:hover:border-slate-600'
                      } disabled:opacity-50`}
                    >
                      <span className={`shrink-0 w-4 h-4 rounded ${props.mode === 'link' ? 'rounded-full' : ''} border flex items-center justify-center ${
                        on ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300 dark:border-slate-500'
                      }`}>
                        {on && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-slate-700 dark:text-slate-200 truncate">{c.name}</span>
                        {taken
                          ? <span className="block text-xs text-slate-400 dark:text-slate-500">{t('people.contacts.alreadyAdded')}</span>
                          : !on && dates.length > 0 && (
                            <span className="block text-xs text-slate-400 dark:text-slate-500 truncate">{listFormat(getActiveLocale(), dates.map(dateText))}</span>
                          )}
                      </span>
                    </button>
                    {on && dates.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pl-10 pt-1.5">
                        {dates.map(d => {
                          const kept = !(skipped[c.key] ?? []).includes(dateKey(d))
                          return (
                            <button
                              key={dateKey(d)}
                              role="checkbox"
                              aria-checked={kept}
                              onClick={() => toggleDate(c.key, d)}
                              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs border transition-colors ${
                                kept ? 'border-green-400/50 text-green-500 dark:text-green-400' : 'border-slate-200 dark:border-slate-600 text-slate-400 line-through'
                              }`}
                            >
                              {kept && <Check size={11} />}
                              {dateText(d)}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="shrink-0 px-6 pt-3 pb-6 border-t border-slate-100 dark:border-slate-700/40 space-y-3">
              {props.mode === 'import' && circles.length > 0 && (
                <select
                  value={circleId}
                  onChange={e => setCircleId(e.target.value)}
                  aria-label={t('people.form.circle')}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                >
                  <option value="">{t('people.form.noCircle')}</option>
                  {circles.map(c => <option key={c.sync_id} value={c.sync_id}>{c.name}</option>)}
                </select>
              )}
              <div className="flex gap-3">
                <button onClick={onClose} className={secondary}>{t('people.cancel')}</button>
                <button onClick={save} disabled={selected.length === 0 || saving} className={primary}>
                  {props.mode === 'link'
                    ? t('people.contacts.link')
                    : t('people.contacts.importN', { count: selected.length })}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
