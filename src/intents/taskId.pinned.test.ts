import { describe, expect, it } from 'vitest'
import { SOURCE_APPS, taskIdFor } from '@glance-apps/intents'

// The id dayGLANCE gives the task it makes from a lastGLANCE create, which
// lastglance_send_to_dayglance hands back before dayGLANCE has seen the intent.
// Both apps take it from @glance-apps/intents (taskIdFor, 1.5.0). These are
// the ids dayGLANCE produced before the calculation moved into the package; the
// package and dayGLANCE pin the same values. If one changes, the id this app
// returns no longer names the task dayGLANCE makes.
describe('the dayGLANCE task id a send will get', () => {
  const chore = '33333333-3333-3333-3333-333333333333'
  it('matches dayGLANCE for a timed, an all-day and an inbox send', async () => {
    expect(await taskIdFor(SOURCE_APPS.LASTGLANCE, chore, '2026-11-15T09:00:00-07:00')).toBe('fd071633-95dc-4088-a29f-6ccd56ea72e1')
    expect(await taskIdFor(SOURCE_APPS.LASTGLANCE, chore, '2026-11-15')).toBe('ad49bb95-aaa1-4dd1-9fa5-14d82a98362f')
    expect(await taskIdFor(SOURCE_APPS.LASTGLANCE, chore, undefined)).toBe('f25285b0-e601-4900-bbea-c4a8c8915b5f')
  })
})
