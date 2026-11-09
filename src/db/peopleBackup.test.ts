import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { exportBackup, restoreFromBackup } from '@/db/queries'
import { addPersonDate, createCircle, createPerson, logInteraction } from '@/people/queries'
import { buildBackupPayload } from '@/sync/engine'

// Issue #424: People data was in no backup. The file export, the automatic
// backups and the pre-restore safety snapshot all held only the chore tables,
// so moving to a new device by backup file lost every person, interaction,
// date and circle.

function installGlobals(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  ;(globalThis as { window?: unknown }).window = globalThis
  if (!('dispatchEvent' in globalThis)) {
    ;(globalThis as Record<string, unknown>).dispatchEvent = () => true
  }
}
installGlobals()

const CAT = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'

async function clearAll(): Promise<void> {
  await Promise.all([
    db.categories.clear(), db.chores.clear(), db.completionEvents.clear(), db.tombstones.clear(), db.users.clear(),
    db.people.clear(), db.interactions.clear(), db.personDates.clear(),
    db.personCircles.clear(), db.peopleTombstones.clear(),
  ])
}

async function seed() {
  await db.categories.add({
    sync_id: CAT, name: 'Home', sort_order: 0, parent_sync_id: null,
    updated_at: '2026-01-01T00:00:00.000Z', assigned_user_sync_ids: [],
  } as never)
  const circle = await createCircle('Family', 'Heart')
  const sam = await createPerson({ name: 'Sam', circle_sync_id: circle.sync_id, target_cadence_days: 14 })
  const alex = await createPerson({ name: 'Alex' })
  const call = await logInteraction({ person_sync_ids: [sam.sync_id, alex.sync_id], channel: 'call', note: 'Caught up' })
  const bday = await addPersonDate({ person_sync_id: sam.sync_id, kind: 'birthday', month: 3, day: 14, year: 1990 })
  return { circle, sam, alex, call, bday }
}

beforeEach(clearAll)

describe('People in backups (#424)', () => {
  it('the file export carries every People table', async () => {
    const { circle, sam, alex, call, bday } = await seed()
    const backup = await exportBackup()
    expect(backup.version).toBe(3)
    expect(backup.people?.people.map(p => p.id).sort()).toEqual([sam.sync_id, alex.sync_id].sort())
    expect(backup.people?.interactions.map(i => i.id)).toEqual([call.sync_id])
    expect(backup.people?.personDates.map(d => d.id)).toEqual([bday.sync_id])
    expect(backup.people?.personCircles.map(c => c.id)).toEqual([circle.sync_id])
  })

  it('the automatic backup payload carries People too', async () => {
    const { sam } = await seed()
    const payload = await buildBackupPayload()
    expect(payload.categories.map(c => c.id)).toEqual([CAT])
    expect(payload.people.people.map(p => p.id)).toContain(sam.sync_id)
  })

  it('a file export restores People on a fresh device', async () => {
    const { sam, call, bday, circle } = await seed()
    const file = JSON.parse(JSON.stringify(await exportBackup()))
    await clearAll()

    const result = await restoreFromBackup(file)
    expect(result.people).toBe(2)
    expect(result.interactions).toBe(1)

    const restoredSam = await db.people.where('sync_id').equals(sam.sync_id).first()
    expect(restoredSam?.name).toBe('Sam')
    expect(restoredSam?.circle_sync_id).toBe(circle.sync_id)
    expect(restoredSam?.target_cadence_days).toBe(14)
    // Created stays; updated is stamped now so the restore wins the sync merge.
    expect(restoredSam?.created_at).toBe(sam.created_at)
    expect(Date.parse(restoredSam!.updated_at)).toBeGreaterThanOrEqual(Date.parse(sam.updated_at))

    const restoredCall = await db.interactions.where('sync_id').equals(call.sync_id).first()
    expect(restoredCall?.note).toBe('Caught up')
    expect(restoredCall?.occurred_at).toBe(call.occurred_at)
    expect(restoredCall?.person_sync_ids).toHaveLength(2)
    expect((await db.personDates.where('sync_id').equals(bday.sync_id).first())?.year).toBe(1990)
    expect(await db.personCircles.count()).toBe(1)
  })

  it('an automatic (WebDAV) backup restores People', async () => {
    const { sam } = await seed()
    const snapshot = JSON.parse(JSON.stringify(await buildBackupPayload()))
    await clearAll()
    await restoreFromBackup(snapshot)
    expect((await db.people.where('sync_id').equals(sam.sync_id).first())?.name).toBe('Sam')
    expect(await db.interactions.count()).toBe(1)
  })

  it('tombstones People the backup does not have, so the deletion syncs out', async () => {
    const { alex } = await seed()
    const file = JSON.parse(JSON.stringify(await exportBackup()))
    file.people.people = file.people.people.filter((p: { id: string }) => p.id !== alex.sync_id)
    file.people.interactions = []
    const extra = await createPerson({ name: 'Added after the backup' })

    await restoreFromBackup(file)
    expect(await db.people.where('sync_id').equals(alex.sync_id).count()).toBe(0)
    expect(await db.people.where('sync_id').equals(extra.sync_id).count()).toBe(0)
    expect(await db.interactions.count()).toBe(0)
    const tombstoned = (await db.peopleTombstones.toArray()).map(t => t.id)
    expect(tombstoned).toEqual(expect.arrayContaining([alex.sync_id, extra.sync_id]))
  })

  it('a backup from before People were included leaves local People alone', async () => {
    const { sam } = await seed()
    const old = JSON.parse(JSON.stringify(await exportBackup()))
    delete old.people
    old.version = 2

    await restoreFromBackup(old)
    expect((await db.people.where('sync_id').equals(sam.sync_id).first())?.name).toBe('Sam')
    expect(await db.interactions.count()).toBe(1)
    expect(await db.peopleTombstones.count()).toBe(0)
  })

  it('a backup holding only People is not rejected as empty', async () => {
    await seed()
    const file = JSON.parse(JSON.stringify(await exportBackup()))
    file.categories = []
    await clearAll()
    await expect(restoreFromBackup(file)).resolves.toMatchObject({ people: 2 })
  })

  it('rejects a backup with a malformed person instead of half-restoring', async () => {
    await seed()
    const file = JSON.parse(JSON.stringify(await exportBackup()))
    file.people.people[0].name = ''
    await expect(restoreFromBackup(file)).rejects.toThrow('invalid person')
    expect(await db.people.count()).toBe(2)
  })
})
