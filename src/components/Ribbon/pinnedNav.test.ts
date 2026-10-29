import { describe, expect, it } from 'vitest'
import { OPEN_PINNED_EVENT, settlePinnedRequest } from './pinnedNav'

describe('settlePinnedRequest', () => {
  it('waits while Soon is still on, since turning it off can bring the Pinned tab back', () => {
    expect(settlePinnedRequest({ attentionOnly: true, pagesReady: true, pinnedOffset: 1 })).toBe('wait')
    expect(settlePinnedRequest({ attentionOnly: true, pagesReady: true, pinnedOffset: 0 })).toBe('wait')
  })

  it('waits until the pages are drawn, as on a cold start', () => {
    expect(settlePinnedRequest({ attentionOnly: false, pagesReady: false, pinnedOffset: 0 })).toBe('wait')
  })

  it('jumps to the Pinned tab when there is one, and drops the request when nothing is pinned', () => {
    expect(settlePinnedRequest({ attentionOnly: false, pagesReady: true, pinnedOffset: 1 })).toBe('jump')
    expect(settlePinnedRequest({ attentionOnly: false, pagesReady: true, pinnedOffset: 0 })).toBe('drop')
  })

  it('names the event the router fires for lastglance://pinned', () => {
    expect(OPEN_PINNED_EVENT).toBe('lg:open-pinned')
  })
})
