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
