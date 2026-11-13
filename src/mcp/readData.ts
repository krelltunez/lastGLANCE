import { db } from '@/db/client'
import { getPeople } from '@/people/queries'
import { getMeUserSyncId, getMultiUserEnabled } from '@/multiuser/settings'
import { isReciprocityShown } from '@/people/settings'
import type { McpReadData } from './readModel'

// What the MCP read model reads (readModel.ts), loaded from the database on
// each request: the server always answers from what is stored, never from a
// screen's state, so a hidden window answers as well as a visible one. People
// are loaded only for a request that reads them.
export async function loadMcpReadData(withPeople: boolean, now: Date = new Date()): Promise<McpReadData> {
  const [categories, chores, events, users] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
    db.users.toArray(),
  ])
  const [people, interactions, dates, circles] = withPeople
    ? await Promise.all([
      getPeople({ includeArchived: true }),
      db.interactions.toArray(),
      db.personDates.toArray(),
      db.personCircles.toArray(),
    ])
    : [[], [], [], []]
  return {
    now,
    categories,
    chores,
    events,
    users,
    multiUserEnabled: getMultiUserEnabled(),
    meUserSyncId: getMeUserSyncId(),
    people,
    interactions,
    dates,
    circles,
    showReciprocity: isReciprocityShown(),
  }
}
