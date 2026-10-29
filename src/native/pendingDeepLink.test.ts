import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the imports, so the mocks it closes over must be too.
const bridge = vi.hoisted(() => ({
  consumeDeepLink: vi.fn(async (): Promise<string | null> => null),
  consumeSharedChore: vi.fn(async (): Promise<string | null> => null),
}))
vi.mock('./widgetBridge', () => bridge)
vi.mock('./pendingOpenChore', () => ({ setPendingOpenChore: vi.fn() }))
vi.mock('./pendingOpenPerson', () => ({
  OPEN_PERSON_PENDING_EVENT: 'lg:open-person-pending',
  setPendingOpenPerson: vi.fn(),
}))

import { routeWidgetDeepLink } from './pendingDeepLink'

// lastglance://chores is the chores counterpart of lastglance://people: a
// launcher's Chores card fires it, and without it a plain launch stayed on
// whichever mode was last open. The native shells map the host to the "chores"
// token; the router turns that into the event App switches modes on.

const events = (): string[] => {
  const seen: string[] = []
  window.addEventListener('lg:open-chores', () => seen.push('lg:open-chores'))
  window.addEventListener('lg:widget-filter-soon', () => seen.push('lg:widget-filter-soon'))
  window.addEventListener('lg:open-pinned', () => seen.push('lg:open-pinned'))
  return seen
}

// The suite runs in node; the router only needs window as an event target.
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('routeWidgetDeepLink', () => {
  it('"chores" dispatches the mode switch and nothing else', async () => {
    const seen = events()
    bridge.consumeDeepLink.mockResolvedValueOnce('chores')
    await routeWidgetDeepLink()
    expect(seen).toEqual(['lg:open-chores'])
  })

  it('"pinned" fires the Pinned request, not the Soon filter', async () => {
    const seen = events()
    bridge.consumeDeepLink.mockResolvedValueOnce('pinned')
    await routeWidgetDeepLink()
    expect(seen).toEqual(['lg:open-pinned'])
  })

  it('"filter:soon" still fires its own event', async () => {
    const seen = events()
    bridge.consumeDeepLink.mockResolvedValueOnce('filter:soon')
    await routeWidgetDeepLink()
    expect(seen).toEqual(['lg:widget-filter-soon'])
  })
})
