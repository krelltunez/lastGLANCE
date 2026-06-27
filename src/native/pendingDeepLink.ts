import { consumeDeepLink } from './widgetBridge'
import { setPendingOpenChore } from './pendingOpenChore'

// Route a widget body-tap target captured natively (see MainActivity). A chore
// tap reuses the durable pending-open mechanism (the Ribbon consumes it once its
// data has loaded, so cold-start ordering doesn't matter); a "soon" tap asks the
// app to switch on the attention filter.
export async function routeWidgetDeepLink(): Promise<void> {
  const link = await consumeDeepLink()
  if (!link) return
  if (link.startsWith('chore:')) {
    setPendingOpenChore(link.slice('chore:'.length))
    window.dispatchEvent(new Event('lg:open-chore-pending'))
  } else if (link === 'filter:soon') {
    window.dispatchEvent(new Event('lg:widget-filter-soon'))
  }
}
