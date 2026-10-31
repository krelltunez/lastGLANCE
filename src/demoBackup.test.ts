import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/db/client'
import { restoreFromBackup } from '@/db/queries'

/**
 * public/demo-backup.json is a hand-made export served from public/ and
 * imported through Settings > Backup & Restore. Nothing in the app reads it; it
 * exists so a link can be handed to someone who wants to see lastGLANCE
 * populated.
 *
 * That is exactly why it rotted unnoticed. By October 2026 its newest
 * completion was 158 days old, so importing it showed every chore months
 * overdue and the whole board red — an app about recency demoing itself with
 * stale data. `npm run demo-backup` re-dates it; these tests are what make the
 * rot loud instead of silent.
 */
const FILE = join(__dirname, '../public/demo-backup.json')
const backup = JSON.parse(readFileSync(FILE, 'utf8')) as {
  version: number
  exportedAt: string
  categories: { id?: number; sync_id: string }[]
  chores: { id?: number; sync_id: string; created_at: string; category_sync_id?: string; category_id?: number }[]
  // This fixture is a version 1 export: its events link by NUMERIC chore_id,
  // not chore_sync_id. normalizeBackup accepts either, and so does the link
  // check below, rather than quietly passing because a field is absent.
  completionEvents: { sync_id: string; chore_sync_id?: string; chore_id?: number; completed_at: string }[]
}

const DAY = 86400000
const newest = Math.max(...backup.completionEvents.map((e) => Date.parse(e.completed_at)))

describe('public/demo-backup.json freshness', () => {
  /**
   * Six months. The fixture is genuinely useful for a few weeks after a
   * re-date and merely tired after a couple of months, so this is not "still
   * good" — it is the point at which it has become embarrassing, chosen so the
   * tripwire fires at most twice a year rather than monthly.
   *
   * It WILL one day go red on a pull request that did not touch the fixture.
   * That is the design: the defect being guarded is nobody noticing for five
   * months, and a test that only fails when someone happens to look would not
   * have caught it either.
   */
  const MAX_AGE_DAYS = 180

  it('has a recent completion', () => {
    const ageDays = (Date.now() - newest) / DAY
    expect(
      ageDays,
      `The newest completion is ${Math.round(ageDays)} days old, so importing this ` +
        'fixture shows a board of overdue red. Run `npm run demo-backup` and commit ' +
        'the result.',
    ).toBeLessThan(MAX_AGE_DAYS)
  })

  it('has no completion in the future', () => {
    // A device west of whoever regenerated the file would otherwise show a
    // chore completed tomorrow, which reads as a bug rather than a demo.
    const future = backup.completionEvents.filter((e) => Date.parse(e.completed_at) > Date.now())
    expect(future).toEqual([])
  })

  it('still spans about a year, so the re-date did not flatten it', () => {
    // The heatmap's window is the past year. A re-dater that moved only the
    // newest event, or collapsed the intervals, would pass the freshness check
    // above while gutting the thing the fixture exists to show.
    const oldest = Math.min(...backup.completionEvents.map((e) => Date.parse(e.completed_at)))
    expect((newest - oldest) / DAY).toBeGreaterThan(300)
  })

  it('created each chore before that chore was completed', () => {
    // Per chore, not globally: the generator slides each chore's history
    // independently, so one chore's created_at is readily later than another
    // chore's oldest completion. What must never happen is a chore whose own
    // history starts before it existed.
    const byChore = new Map<number | string, number>()
    for (const e of backup.completionEvents) {
      const key = e.chore_sync_id ?? e.chore_id!
      const t = Date.parse(e.completed_at)
      if (!byChore.has(key) || t < byChore.get(key)!) byChore.set(key, t)
    }
    const impossible = backup.chores.filter((c) => {
      const oldest = byChore.get(c.sync_id) ?? byChore.get(c.id!)
      return oldest !== undefined && Date.parse(c.created_at) > oldest
    })
    expect(impossible.map((c) => (c as { name?: string }).name ?? c.sync_id)).toEqual([])
  })
})

describe('public/demo-backup.json integrity', () => {
  it('links every chore to a category and every completion to a chore', () => {
    const catSyncIds = new Set(backup.categories.map((c) => c.sync_id))
    const catIds = new Set(backup.categories.map((c) => c.id))
    const choreSyncIds = new Set(backup.chores.map((c) => c.sync_id))
    const choreIds = new Set(backup.chores.map((c) => c.id))

    const strandedChores = backup.chores.filter((c) =>
      c.category_sync_id !== undefined ? !catSyncIds.has(c.category_sync_id) : !catIds.has(c.category_id))
    const strandedEvents = backup.completionEvents.filter((e) =>
      e.chore_sync_id !== undefined ? !choreSyncIds.has(e.chore_sync_id) : !choreIds.has(e.chore_id))

    expect(strandedChores).toEqual([])
    expect(strandedEvents).toEqual([])
  })

  it('imports', async () => {
    // The fixture's whole job. Run through the real restore rather than
    // inspected, because restoreFromBackup validates sync_id and timestamp
    // shapes and throws on anything it will not accept — which is the failure
    // a person discovers by pasting the file into a running app.
    await db.delete()
    await db.open()
    const result = await restoreFromBackup(backup)
    expect(result.categories).toBe(backup.categories.length)
    expect(result.chores).toBe(backup.chores.length)
    expect(result.completionEvents).toBe(backup.completionEvents.length)
  })
})
