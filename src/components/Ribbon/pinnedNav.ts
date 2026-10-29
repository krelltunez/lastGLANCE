// The phone header's Pinned button and the Ribbon talk through these: the
// button dispatches SHOW_PINNED_EVENT and the Ribbon moves to its Pinned tab;
// the Ribbon reports PinnedState back so the button can disable itself when
// there is no Pinned tab (nothing pinned, or edit mode) and light up while
// Pinned is the tab on screen.
export const SHOW_PINNED_EVENT = 'lg:show-pinned'

export interface PinnedState {
  available: boolean
  showing: boolean
}

// lastglance://pinned (GLANCElauncher's Pinned list): Chores, with Soon off,
// on the Pinned tab. App switches the mode and turns Soon off; the Ribbon
// holds the request until the pages are drawn without Soon, since turning
// Soon off can be what brings the Pinned tab back.
export const OPEN_PINNED_EVENT = 'lg:open-pinned'

// What the Ribbon does with a held request: keep waiting, jump to the Pinned
// tab (index 0), or drop it because there is nothing pinned to show.
export function settlePinnedRequest(s: {
  attentionOnly: boolean
  pagesReady: boolean
  pinnedOffset: number
}): 'wait' | 'jump' | 'drop' {
  if (s.attentionOnly || !s.pagesReady) return 'wait'
  return s.pinnedOffset > 0 ? 'jump' : 'drop'
}
