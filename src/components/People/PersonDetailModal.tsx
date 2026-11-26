import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { formatDateTime, formatMonthDay } from '@/utils/datetime'
import { formatElapsed } from '@/utils/cadence'
import {
  deletePerson, getDatesForPerson, getInteractionsForPerson, PEOPLE_CHANGED_EVENT, updatePerson,
} from '@/people/queries'
import { daysToWeeks, dueDate, isSnoozed, nextOccurrence } from '@/people/home'
import { hasEnoughForBalance, RECIPROCITY_WINDOW_DAYS } from '@/people/reciprocity'
import { useShowReciprocity } from '@/people/settings'
import { listFormat } from '@/people/reminders'
import { normalizeDirection } from '@/people/types'
import type { ContactLink, Interaction, PersonCircle, PersonDate, PersonWithLastInteraction } from '@/people/types'
import dayjs from 'dayjs'
import { CHANNEL_ICONS, CHANNEL_LABEL_KEYS, DIRECTION_ICONS, DIRECTION_LABEL_KEYS } from './channels'
import { ConfirmDelete } from './ConfirmDelete'
import { ContactActions } from './ContactActions'
import { ContactsModal } from './ContactsModal'
import { PersonFormModal } from './PersonFormModal'
import { QuickLogSheet } from './QuickLogSheet'
import { dateKindLabel, daysUntilLabel } from './labels'

interface Props {
  person: PersonWithLastInteraction
  // Everyone visible, for naming the others on a shared interaction and for
  // tagging when logging.
  people: PersonWithLastInteraction[]
  circles: PersonCircle[]
  // Phone contacts are on and available on this device.
  contactsAvailable?: boolean
  links?: ContactLink[]
  onClose: () => void
}

export function PersonDetailModal({ person, people, circles, contactsAvailable = false, links = [], onClose }: Props) {
  const { t, i18n } = useTranslation()
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [dates, setDates] = useState<PersonDate[]>([])
  const [editing, setEditing] = useState(false)
  const [logging, setLogging] = useState(false)
  const [editInteraction, setEditInteraction] = useState<Interaction | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [linking, setLinking] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const link = links.find(l => l.person_sync_id === person.sync_id) ?? null
  const showReciprocity = useShowReciprocity()
  useEscapeKey(onClose)

  const load = useCallback(async () => {
    const [i, d] = await Promise.all([getInteractionsForPerson(person.sync_id), getDatesForPerson(person.sync_id)])
    setInteractions(i)
    setDates(d)
  }, [person.sync_id])

  useEffect(() => {
    void load()
    const onChange = () => { void load() }
    window.addEventListener(PEOPLE_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(PEOPLE_CHANGED_EVENT, onChange)
  }, [load])

  const circle = circles.find(c => c.sync_id === person.circle_sync_id)
  const nameOf = (id: string) => people.find(p => p.sync_id === id)?.name
  const last = person.last_interaction_at
    ? formatElapsed(t, person.elapsed_days, person.last_interaction_at)
    : t('people.row.noContactYet')
  const PreferredIcon = person.preferred_channel ? CHANNEL_ICONS[person.preferred_channel] : null
  const today = dayjs().startOf('day')
  const due = dueDate(person)
  const snoozed = isSnoozed(person)
  const r = person.reciprocity
  const directed = r.outbound + r.inbound

  const meta: string[] = []
  if (circle) meta.push(circle.name)
  if (person.target_cadence_days) meta.push(t('people.detail.everyNWeeks', { n: daysToWeeks(person.target_cadence_days) }))

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg max-h-[90svh] flex flex-col bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 pt-6 pb-3">
          {photo && <img src={photo} alt="" className="shrink-0 w-12 h-12 rounded-full object-cover" />}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 truncate">
              {person.name}
              {person.nickname && <span className="ml-2 text-sm font-normal text-slate-400 dark:text-slate-500">{person.nickname}</span>}
            </h2>
            {meta.length > 0 && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{meta.join(' · ')}</p>}
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t('people.detail.lastContact', { last })}</p>
            {due && !person.archived && (
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{t('people.detail.catchUpBy', { date: formatMonthDay(due) })}</p>
            )}
            {snoozed && (
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                {t('people.detail.snoozedUntil', { date: formatMonthDay(dayjs(person.snoozed_until)) })}
                {' · '}
                <button
                  onClick={() => updatePerson(person.sync_id, { snoozed_until: null })}
                  className="text-green-500 dark:text-green-400 hover:underline"
                >
                  {t('people.detail.unsnooze')}
                </button>
              </p>
            )}
            {person.archived && <p className="text-xs text-amber-500 mt-1">{t('people.detail.archived')}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              aria-label={t('people.detail.edit')}
              data-tooltip={t('people.detail.edit')}
            >
              <Pencil size={15} />
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" aria-label={t('people.close')}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-5">
          <button
            onClick={() => setLogging(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 transition-colors"
          >
            <Plus size={15} /> {t('people.detail.logContact')}
          </button>

          {contactsAvailable && (
            <ContactActions person={person} link={link} onLink={() => setLinking(true)} onPhoto={setPhoto} />
          )}

          {PreferredIcon && (
            <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <PreferredIcon size={12} />
              {t('people.detail.prefers', { channel: t(CHANNEL_LABEL_KEYS[person.preferred_channel!]) })}
            </p>
          )}

          {dates.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">{t('people.detail.dates')}</h3>
              <ul className="space-y-1">
                {dates.map(d => {
                  const on = nextOccurrence(d.month, d.day, today)
                  const turning = d.year !== null && on.year() > d.year ? on.year() - d.year : null
                  return (
                    <li key={d.sync_id} className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-200">
                      <span>
                        {dateKindLabel(t, d)}
                        {turning !== null && <span className="text-slate-400 dark:text-slate-500"> ({turning})</span>}
                      </span>
                      <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                        {daysUntilLabel(t, on.diff(today, 'day'))}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {person.details && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">{t('people.detail.notes')}</h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words rounded-lg bg-slate-50 dark:bg-slate-700/40 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
                {person.details}
              </p>
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">{t('people.detail.timeline')}</h3>
            {/* Plain counts, no bar or percentage, and only once there is
                enough logged for the split to mean something. */}
            {showReciprocity && directed > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                {hasEnoughForBalance(r)
                  ? t('people.detail.balance', { you: r.outbound, them: r.inbound, days: RECIPROCITY_WINDOW_DAYS })
                  : t('people.detail.balanceTooFew')}
              </p>
            )}
            {interactions.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-slate-500">{t('people.detail.noInteractions')}</p>
            ) : (
              <ul className="space-y-2">
                {interactions.map(i => {
                  const Icon = CHANNEL_ICONS[i.channel]
                  const direction = normalizeDirection(i.direction)
                  const DirectionIcon = showReciprocity && direction ? DIRECTION_ICONS[direction] : null
                  const others = i.person_sync_ids.filter(id => id !== person.sync_id).map(nameOf).filter(Boolean)
                  return (
                    <li key={i.sync_id}>
                      <button
                        onClick={() => setEditInteraction(i)}
                        className="w-full text-left flex gap-3 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-700/40 border border-slate-100 dark:border-slate-700/60 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                      >
                        <Icon size={15} className="shrink-0 mt-0.5 text-slate-400 dark:text-slate-500" />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="text-sm text-slate-700 dark:text-slate-200 flex items-center gap-1.5 min-w-0">
                              {t(CHANNEL_LABEL_KEYS[i.channel])}
                              {DirectionIcon && (
                                <span className="inline-flex items-center gap-0.5 text-xs text-slate-400 dark:text-slate-500 truncate">
                                  <DirectionIcon size={11} className="shrink-0" />
                                  {t(DIRECTION_LABEL_KEYS[direction!])}
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums shrink-0">{formatDateTime(i.occurred_at)}</span>
                          </span>
                          {others.length > 0 && (
                            <span className="block text-xs text-slate-400 dark:text-slate-500">{t('people.detail.with', { names: listFormat(i18n.resolvedLanguage || i18n.language, others) })}</span>
                          )}
                          {i.note && <span className="block text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words mt-0.5">{i.note}</span>}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="shrink-0 px-6 pt-3 pb-6 border-t border-slate-100 dark:border-slate-700/40 flex gap-3">
          <button
            onClick={async () => { await updatePerson(person.sync_id, { archived: !person.archived }); onClose() }}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            {person.archived ? <><ArchiveRestore size={14} /> {t('people.detail.unarchive')}</> : <><Archive size={14} /> {t('people.detail.archive')}</>}
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium text-red-500 bg-slate-100 dark:bg-slate-700 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={14} /> {t('people.delete')}
          </button>
        </div>
      </div>

      {editing && (
        <PersonFormModal person={person} dates={dates} circles={circles} onClose={() => setEditing(false)} />
      )}
      {logging && (
        <QuickLogSheet people={people} initialPersonIds={[person.sync_id]} onClose={() => setLogging(false)} />
      )}
      {editInteraction && (
        <QuickLogSheet people={people} interaction={editInteraction} onClose={() => setEditInteraction(null)} />
      )}
      {linking && (
        <ContactsModal mode="link" person={person} personDates={dates} links={links} circles={circles} onClose={() => setLinking(false)} />
      )}
      {confirmDelete && (
        <ConfirmDelete
          message={t('people.detail.deleteConfirm', { name: person.name })}
          detail={t('people.detail.deleteDetail')}
          onConfirm={async () => { await deletePerson(person.sync_id); onClose() }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>,
    document.body,
  )
}
