import { useEffect, useMemo, useState } from 'react'
import { BookUser } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { contactsPermission, listDeviceContacts, type DeviceContactSummary } from '@/native/contacts'
import { matchByName } from '@/people/contacts'
import { setContactLink } from '@/people/queries'
import type { PeopleContacts } from '@/people/useContacts'
import type { PersonWithLastInteraction } from '@/people/types'
import { getActiveLocale } from '@/utils/datetime'
import { listFormat } from '@/people/reminders'

interface Props {
  contacts: PeopleContacts
  people: PersonWithLastInteraction[]
}

// The two things contacts can ask of the user on the People home: linking
// people to this phone's contacts by name (a second phone has no links, since
// contact ids are per device), and taking a birthday that changed in
// Contacts. Renders nothing when there is neither.
export function ContactsNotices({ contacts, people }: Props) {
  const { t } = useTranslation()
  const { available, links, offers, acceptOffer, dismissOffer } = contacts
  const [deviceContacts, setDeviceContacts] = useState<DeviceContactSummary[] | null>(null)
  const [dismissedMatches, setDismissedMatches] = useState(false)
  const unlinked = people.filter(p => !p.archived && !links.some(l => l.person_sync_id === p.sync_id)).length

  // Only read the address book when there is someone to match, and only with
  // permission already given: this never raises the system prompt.
  useEffect(() => {
    if (!available || unlinked === 0 || deviceContacts) return
    let live = true
    void contactsPermission().then(async state => {
      if (state !== 'granted') return
      const list = await listDeviceContacts().catch(() => null)
      if (live && list) setDeviceContacts(list)
    })
    return () => { live = false }
  }, [available, unlinked, deviceContacts])

  const matches = useMemo(
    () => (deviceContacts ? matchByName(people, deviceContacts, links) : []),
    [people, deviceContacts, links],
  )
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(getActiveLocale(), { month: 'long' }), [])

  const showMatches = matches.length > 0 && !dismissedMatches
  if (!available || (!showMatches && offers.length === 0)) return null

  const names = matches.slice(0, 3).map(m => m.person.name)
  if (matches.length > 3) names.push(t('people.reminders.more', { count: matches.length - 3 }))
  const btn = 'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors'

  return (
    <section className="bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-2xl p-4 sm:p-5 space-y-4">
      <h2 className="text-base font-bold text-green-400 tracking-tight flex items-center gap-2">
        <BookUser size={16} /> {t('people.contacts.cardTitle')}
      </h2>
      {showMatches && (
        <div className="space-y-2">
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('people.contacts.matches', { count: matches.length })}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {listFormat(getActiveLocale(), names)}
          </p>
          <div className="flex gap-2">
            <button
              onClick={async () => { for (const m of matches) await setContactLink(m.person.sync_id, m.contact.key) }}
              className={`${btn} text-green-400 border border-green-400/40 hover:bg-green-400/10`}
            >
              {t('people.contacts.linkThem')}
            </button>
            <button onClick={() => setDismissedMatches(true)} className={`${btn} text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700`}>
              {t('people.contacts.notNow')}
            </button>
          </div>
        </div>
      )}
      {offers.map(o => {
        const name = people.find(p => p.sync_id === o.personSyncId)?.name ?? ''
        const date = `${monthFmt.format(new Date(2000, o.next.month - 1, 1))} ${o.next.day}${o.next.year ? `, ${o.next.year}` : ''}`
        return (
          <div key={o.personSyncId} className="space-y-2">
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('people.contacts.birthdayChanged', { name, date })}</p>
            <div className="flex gap-2">
              <button onClick={() => acceptOffer(o)} className={`${btn} text-green-400 border border-green-400/40 hover:bg-green-400/10`}>
                {t('people.contacts.update')}
              </button>
              <button onClick={() => dismissOffer(o)} className={`${btn} text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700`}>
                {t('people.contacts.keep')}
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
