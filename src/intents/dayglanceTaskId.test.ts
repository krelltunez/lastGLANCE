import { describe, expect, it } from 'vitest'
import { dayglanceTaskId } from './dayglanceTaskId'

// Ids dayGLANCE's own deterministicTaskId(createKey(...)) produced for these
// inputs (src/intents/handleIntent.js there, 2026-11-14). If dayGLANCE changes
// how it makes the id, these fail here first.
describe('the dayGLANCE task id a send will get', () => {
  const chore = '33333333-3333-3333-3333-333333333333'
  it('matches dayGLANCE for a timed, an all-day and an inbox send', async () => {
    expect(await dayglanceTaskId(chore, '2026-11-15T09:00:00-07:00')).toBe('fd071633-95dc-4088-a29f-6ccd56ea72e1')
    expect(await dayglanceTaskId(chore, '2026-11-15')).toBe('ad49bb95-aaa1-4dd1-9fa5-14d82a98362f')
    expect(await dayglanceTaskId(chore, undefined)).toBe('f25285b0-e601-4900-bbea-c4a8c8915b5f')
  })
})
