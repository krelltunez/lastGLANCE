import { consumeDeepLink, consumeSharedChore } from './widgetBridge'
import { setPendingOpenChore } from './pendingOpenChore'
import { OPEN_PERSON_PENDING_EVENT, setPendingOpenPerson, type PendingPeopleOpen } from './pendingOpenPerson'

// Route a target captured natively from a widget tap or launcher shortcut (see
// MainActivity). A chore tap reuses the durable pending-open mechanism (the
// Ribbon consumes it once its data has loaded, so cold-start ordering doesn't
// matter); a "soon" tap switches on the attention filter; the action targets open
// search / the new-chore form (Ribbon owns both and handles cold-start retry);
// "chores" only switches the mode (App listens for it with the other chore
// events); "pinned" does that with Soon off, on the Pinned tab (pinnedNav.ts). People widget taps (person:, log:, people) go through the People
// pending request, like a People notification tap.
export async function routeWidgetDeepLink(): Promise<void> {
  const link = await consumeDeepLink()
  if (link) {
    if (link.startsWith('chore:')) {
      setPendingOpenChore(link.slice('chore:'.length))
      window.dispatchEvent(new Event('lg:open-chore-pending'))
    } else if (link === 'filter:soon') {
      window.dispatchEvent(new Event('lg:widget-filter-soon'))
    } else if (link === 'action:search') {
      window.dispatchEvent(new Event('lg:open-search'))
    } else if (link === 'action:add') {
      window.dispatchEvent(new Event('lg:new-chore'))
    } else if (link === 'chores') {
      window.dispatchEvent(new Event('lg:open-chores'))
    } else if (link === 'pinned') {
      window.dispatchEvent(new Event('lg:open-pinned'))
    } else {
      const people = peopleRequest(link)
      if (people) {
        setPendingOpenPerson(people)
        window.dispatchEvent(new Event(OPEN_PERSON_PENDING_EVENT))
      }
    }
  }

  // A share from another app opens the new-chore form pre-filled with the shared
  // title/text as the chore name (same handler as the Add entry points).
  const shared = await consumeSharedChore()
  if (shared) {
    window.dispatchEvent(new CustomEvent('lg:new-chore', { detail: { name: shared } }))
  }
}

// A People widget token: "person:<id>" opens the person, "log:<id>" the
// quick-log sheet for them, "people" the People home, "action:add-person" the
// add-person form (the launcher's Add person).
export function peopleRequest(link: string): PendingPeopleOpen | null {
  if (link === 'people') return { action: 'home' }
  if (link === 'action:add-person') return { action: 'add' }
  const [kind, id] = [link.slice(0, link.indexOf(':')), link.slice(link.indexOf(':') + 1)]
  if (!id || link.indexOf(':') < 0) return null
  if (kind === 'person') return { action: 'open', personSyncId: id }
  if (kind === 'log') return { action: 'log', personSyncId: id }
  return null
}
