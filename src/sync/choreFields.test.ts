import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { updateChore } from '@/db/queries'
import { applyPayload, buildPayload, mergePayloads } from './engine'
import { applyRemoteEntity, getLocalEntity } from './dbEngine'
import { applyLaterChoreFields, carryLaterFields, laterChoreFields, unknownChoreFields, withUnknownFields } from './choreFields'
import type { SyncCategory, SyncChore, SyncPayload } from './types'

// A device running this version is, to the next version, the older client: it
// receives chores carrying fields it does not know, and edits them. Both sync
// paths must send those fields on with its edit, not drop them
// (choreFields.ts, rule 1). Rule 2, the later fields an older-than-this device
// drops, is checked on its functions here with a field of the test's own; the
// first real one (a chore's duration) brings its own end-to-end scenario.

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
  if (!('dispatchEvent' in globalThis)) (globalThis as Record<string, unknown>).dispatchEvent = () => true
}
installGlobals()

const CAT_ID = 'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4'
const CHORE_ID = 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5'
const T0 = '2026-11-01T10:00:00.000Z'

const category: SyncCategory = { id: CAT_ID, name: 'Home', sortOrder: 0, icon: 'House', parentId: null, assignedUserSyncIds: [], updatedAt: T0 }
const plainChore: SyncChore = {
  id: CHORE_ID, name: 'Mop kitchen', categorySyncId: CAT_ID, sortOrder: 0, targetCadenceDays: 14,
  notifyWhenOverdue: false, autoScheduleToDayglance: false, preferredScheduleBehavior: null,
  seasonalStart: null, seasonalEnd: null, details: null, pinned: false, icon: 'Droplets', assignedUserSyncIds: [],
  createdAt: T0, updatedAt: T0,
}
/** The chore as a newer version sends it: with fields this version has never heard of. */
const fromNewerVersion = { ...plainChore, energyLevel: 'low', checklist: [{ id: 'k1', text: 'Corners' }] } as unknown as SyncChore

const emptyPayload = (over: Partial<SyncPayload> = {}): SyncPayload =>
  ({ categories: [], chores: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {}, ...over }) as SyncPayload

beforeEach(async () => {
  await Promise.all([db.chores.clear(), db.categories.clear(), db.completionEvents.clear(), db.users.clear()])
})

async function editHere(): Promise<void> {
  const row = await db.chores.where('sync_id').equals(CHORE_ID).first()
  await updateChore(row!.id!, { name: 'Mop kitchen floor' })
}

describe('an older client keeps the fields it does not know', () => {
  it('through the file payload: applied, edited here, and sent on with the edit', async () => {
    await applyPayload(emptyPayload({ categories: [category], chores: [fromNewerVersion] }), { allowEmpty: false })
    await editHere()
    const sent = (await buildPayload()).chores.find(c => c.id === CHORE_ID) as unknown as Record<string, unknown>
    expect(sent).toMatchObject({ name: 'Mop kitchen floor', energyLevel: 'low', checklist: [{ id: 'k1', text: 'Corners' }] })
    // Its own fields are its own: an unknown one cannot overwrite them.
    expect(sent.updatedAt).not.toBe(T0)
  })

  it('through the vault rows: pulled, edited here, and pushed with the edit', async () => {
    await applyRemoteEntity(CAT_ID, category)
    await applyRemoteEntity(CHORE_ID, fromNewerVersion)
    await editHere()
    expect(await getLocalEntity(CHORE_ID)).toMatchObject({ name: 'Mop kitchen floor', energyLevel: 'low', checklist: [{ id: 'k1', text: 'Corners' }] })
  })

  it('takes the newest record\'s unknown fields, and drops them when a newer record no longer has them', async () => {
    await applyRemoteEntity(CAT_ID, category)
    await applyRemoteEntity(CHORE_ID, fromNewerVersion)
    await applyRemoteEntity(CHORE_ID, { ...fromNewerVersion, energyLevel: 'high', updatedAt: '2026-11-02T10:00:00.000Z' } as SyncChore)
    expect(await getLocalEntity(CHORE_ID)).toMatchObject({ energyLevel: 'high' })
    await applyRemoteEntity(CHORE_ID, { ...plainChore, updatedAt: '2026-11-03T10:00:00.000Z' })
    expect(await getLocalEntity(CHORE_ID)).not.toHaveProperty('energyLevel')
  })

  it('a chore that never had any carries nothing extra', async () => {
    await applyPayload(emptyPayload({ categories: [category], chores: [plainChore] }), { allowEmpty: false })
    const row = await db.chores.where('sync_id').equals(CHORE_ID).first()
    expect(row!.sync_extra).toBeUndefined()
    expect(Object.keys((await buildPayload()).chores[0]).sort()).toEqual(Object.keys(plainChore).sort())
  })

  it('the file merge keeps them on whichever copy wins', () => {
    const newerHere = { ...fromNewerVersion, name: 'Renamed here', updatedAt: '2026-11-05T10:00:00.000Z' }
    const merged = mergePayloads(emptyPayload({ categories: [category], chores: [newerHere] }), emptyPayload({ categories: [category], chores: [fromNewerVersion] }))
    expect((merged.data as SyncPayload).chores[0]).toMatchObject({ name: 'Renamed here', energyLevel: 'low' })
  })
})

describe('the rules, on their own', () => {
  it('unknown fields are everything outside the known set', () => {
    expect(unknownChoreFields(fromNewerVersion)).toEqual({ energyLevel: 'low', checklist: [{ id: 'k1', text: 'Corners' }] })
    expect(unknownChoreFields(plainChore)).toBeUndefined()
    // Beneath the record's own: an unknown field named like a known one cannot win.
    expect(withUnknownFields(plainChore, { sync_extra: { name: 'stale', extra: 1 } })).toMatchObject({ name: 'Mop kitchen', extra: 1 })
  })

  // A later field: one its version always writes, null when empty.
  const LATER = { minutes: 'minutes_col' }

  it('a later field is always written, null when empty', () => {
    expect(laterChoreFields({ ['minutes_col' as never]: 25 } as never, LATER)).toEqual({ minutes: 25 })
    expect(laterChoreFields({}, LATER)).toEqual({ minutes: null })
  })

  it('applying: present (null included) sets it; absent keeps ours, and says so', () => {
    const ours = { minutes_col: 25 } as never
    expect(applyLaterChoreFields({ ...plainChore, minutes: 40 } as never, ours, LATER)).toEqual({ columns: { minutes_col: 40 }, kept: false })
    expect(applyLaterChoreFields({ ...plainChore, minutes: null } as never, ours, LATER)).toEqual({ columns: { minutes_col: null }, kept: false })
    expect(applyLaterChoreFields(plainChore, ours, LATER)).toEqual({ columns: {}, kept: true })
    expect(applyLaterChoreFields(plainChore, {}, LATER)).toEqual({ columns: {}, kept: false })
  })

  it('merging: the winner takes a later field only the other copy has', () => {
    const fromOld = { ...plainChore, name: 'Edited on an old device' }
    const fromNew = { ...plainChore, minutes: 25 }
    expect(carryLaterFields(fromOld, fromNew, LATER)).toEqual({ record: { ...fromOld, minutes: 25 }, changed: true })
    // A winner that cleared it (null) keeps its null.
    expect(carryLaterFields({ ...fromOld, minutes: null }, fromNew, LATER).changed).toBe(false)
    expect(carryLaterFields(fromOld, undefined, LATER).changed).toBe(false)
  })
})
