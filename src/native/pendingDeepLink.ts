import { consumeDeepLink, consumeSharedChore } from './widgetBridge'
import { setPendingOpenChore } from './pendingOpenChore'

// Route a target captured natively from a widget tap or launcher shortcut (see
// MainActivity). A chore tap reuses the durable pending-open mechanism (the
// Ribbon consumes it once its data has loaded, so cold-start ordering doesn't
// matter); a "soon" tap switches on the attention filter; the action targets open
// search / the new-chore form (Ribbon owns both and handles cold-start retry).
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
    }
  }

  // A share from another app opens the new-chore form pre-filled with the shared
  // title/text as the chore name (same handler as the Add entry points).
  const shared = await consumeSharedChore()
  if (shared) {
    window.dispatchEvent(new CustomEvent('lg:new-chore', { detail: { name: shared } }))
  }
}
