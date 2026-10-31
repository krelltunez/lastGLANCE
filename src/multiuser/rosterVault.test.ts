import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import type { User } from '@/types'
import {
  applyRemoteRosterEntity,
  applyRemoteRosterDelete,
  getLocalRosterEntity,
  getRosterEntityLastModified,
  isRosterEntity,
  ROSTER_VAULT_APP,
} from './rosterVault'

const T1 = '2026-10-01T10:00:00.000Z'
const T2 = '2026-10-02T10:00:00.000Z'
const T3 = '2026-10-03T10:00:00.000Z'

const byId = (id: string) => db.users.where('sync_id').equals(id).first()

describe('household roster on GLANCEvault (glance-users)', () => {
  beforeEach(async () => {
    await db.users.clear()
    await db.tombstones.clear()
  })

  it('syncs the shared app every GLANCE app reads', () => {
    expect(ROSTER_VAULT_APP).toBe('glance-users')
  })

  it("speaks glance-users.json's SharedUser shape", async () => {
    await db.users.add({ sync_id: 'u1', name: 'Maggie', updated_at: T1 } as User)
    expect(await getLocalRosterEntity('u1')).toEqual({ id: 'u1', name: 'Maggie', updatedAt: T1 })
    expect(await getLocalRosterEntity('nobody')).toBeNull()
    expect(getRosterEntityLastModified({ id: 'u1', name: 'Maggie', updatedAt: T1 })).toBe(T1)
    expect(isRosterEntity({ id: 'u1', name: '  ', updatedAt: T1 })).toBe(false)
    expect(isRosterEntity({ name: 'Maggie', updatedAt: T1 })).toBe(false)
  })

  it('adds a member another app introduced, keyed by its sync id', async () => {
    await applyRemoteRosterEntity('u1', { id: 'u1', name: 'Maggie', updatedAt: T1 })
    expect(await byId('u1')).toMatchObject({ name: 'Maggie', updated_at: T1 })
  })

  it('renames on a newer edit and keeps a newer local one', async () => {
    await db.users.add({ sync_id: 'u1', name: 'Mags', updated_at: T2 } as User)
    await applyRemoteRosterEntity('u1', { id: 'u1', name: 'Maggie', updatedAt: T1 })
    expect((await byId('u1'))?.name).toBe('Mags')
    await applyRemoteRosterEntity('u1', { id: 'u1', name: 'Margaret', updatedAt: T3 })
    expect(await byId('u1')).toMatchObject({ name: 'Margaret', updated_at: T3 })
    expect(await db.users.count()).toBe(1)
  })

  it('ignores a row whose id does not match its entity id, or a malformed one', async () => {
    await applyRemoteRosterEntity('u1', { id: 'u2', name: 'Maggie', updatedAt: T1 })
    await applyRemoteRosterEntity('u1', { name: 'Maggie' })
    expect(await db.users.count()).toBe(0)
  })

  it('removes a member deleted elsewhere, and an older edit does not bring it back', async () => {
    await db.users.add({ sync_id: 'u1', name: 'Maggie', updated_at: T1 } as User)
    await applyRemoteRosterDelete('u1')
    expect(await byId('u1')).toBeUndefined()
    await applyRemoteRosterEntity('u1', { id: 'u1', name: 'Maggie', updatedAt: T1 })
    expect(await byId('u1')).toBeUndefined()
  })

  it('restores a member re-added after the deletion', async () => {
    await db.tombstones.put({ id: 'u1', deleted_at: T1 })
    await applyRemoteRosterEntity('u1', { id: 'u1', name: 'Maggie', updatedAt: T2 })
    expect(await byId('u1')).toMatchObject({ name: 'Maggie' })
    expect(await db.tombstones.get('u1')).toBeUndefined()
  })
})
