import Dexie, { type Table } from 'dexie'
import type { Category, Chore, CompletionEvent, Tombstone } from '@/types'

class LastGlanceDB extends Dexie {
  categories!: Table<Category, number>
  chores!: Table<Chore, number>
  completionEvents!: Table<CompletionEvent, number>
  tombstones!: Table<Tombstone, string>

  constructor() {
    super('lastglance')
    this.version(1).stores({
      categories: '++id, sort_order',
      chores: '++id, category_id',
      completionEvents: '++id, chore_id, completed_at',
    })

    this.version(2)
      .stores({ chores: '++id, category_id, sort_order' })
      .upgrade(tx =>
        tx.table('chores').toCollection().modify((chore: Chore) => {
          if ((chore as { sort_order?: number }).sort_order === undefined) {
            chore.sort_order = chore.id
          }
        })
      )

    this.version(3)
      .stores({})
      .upgrade(tx =>
        tx.table('chores').toCollection().modify((chore: Chore) => {
          if ((chore as { notify_when_overdue?: boolean }).notify_when_overdue === undefined) {
            chore.notify_when_overdue = false
          }
        })
      )

    // Adds parent_category_id index to support subcategories and efficient cascade deletes.
    this.version(4)
      .stores({ categories: '++id, sort_order, parent_category_id' })

    // Adds sync_id fields and tombstones table.
    this.version(5)
      .stores({
        categories: '++id, sort_order, parent_category_id, sync_id',
        chores: '++id, category_id, sort_order, sync_id',
        completionEvents: '++id, chore_id, completed_at, sync_id',
        tombstones: 'id',
      })
      .upgrade(async tx => {
        const now = new Date().toISOString()

        // Step 1: assign sync_ids to all categories and build local_id → sync_id map
        const catSyncIdMap = new Map<number, string>()
        const categories = await tx.table('categories').toArray()
        for (const cat of categories) {
          const sync_id = crypto.randomUUID()
          catSyncIdMap.set(cat.id as number, sync_id)
          await tx.table('categories').update(cat.id as number, { sync_id, updated_at: now })
        }

        // Step 2: resolve parent_sync_id for each category
        for (const cat of categories) {
          const parent_sync_id = cat.parent_category_id != null
            ? (catSyncIdMap.get(cat.parent_category_id as number) ?? null)
            : null
          await tx.table('categories').update(cat.id as number, { parent_sync_id })
        }

        // Step 3: assign sync_ids and category_sync_id to chores
        const chores = await tx.table('chores').toArray()
        for (const chore of chores) {
          const category_sync_id = chore.category_id != null
            ? (catSyncIdMap.get(chore.category_id as number) ?? null)
            : null
          await tx.table('chores').update(chore.id as number, {
            sync_id: crypto.randomUUID(),
            category_sync_id,
          })
        }

        // Step 4: assign sync_ids to completion events
        await tx.table('completionEvents').toCollection().modify((evt: CompletionEvent) => {
          evt.sync_id = crypto.randomUUID()
        })
      })

    // Adds seasonal_start and seasonal_end fields.
    this.version(6)
      .stores({})
      .upgrade(tx =>
        tx.table('chores').toCollection().modify((chore: Chore) => {
          if ((chore as { seasonal_start?: string | null }).seasonal_start === undefined) {
            chore.seasonal_start = null
          }
          if ((chore as { seasonal_end?: string | null }).seasonal_end === undefined) {
            chore.seasonal_end = null
          }
        })
      )

    this.on('populate', async () => {
      const catIds = (await this.categories.bulkAdd(
        SEED_CATEGORIES.map((cat) => ({
          ...cat,
          parent_sync_id: null,
          updated_at: SEED_TIMESTAMP,
        })) as unknown as Category[],
        { allKeys: true }
      )) as unknown as number[]

      await this.chores.bulkAdd(
        SEED_CHORES.map(({ _catIndex, ...rest }, i) => ({
          ...rest,
          sort_order: i,
          category_id: catIds[_catIndex],
          category_sync_id: SEED_CATEGORIES[_catIndex].sync_id,
        })) as unknown as Chore[]
      )
    })
  }
}

// Stable timestamp and sync_ids for seed data — every fresh install produces
// identical records so cross-device merges deduplicate instead of doubling.
const SEED_TIMESTAMP = '2024-01-01T00:00:00.000Z'

const SEED_CATEGORIES: Omit<Category, 'id' | 'parent_sync_id' | 'updated_at'>[] = [
  { name: 'Home',       sort_order: 0, sync_id: '00000000-0000-0000-0000-000000000001' },
  { name: 'Pets',       sort_order: 1, sync_id: '00000000-0000-0000-0000-000000000002' },
  { name: 'Vehicle',    sort_order: 2, sync_id: '00000000-0000-0000-0000-000000000003' },
  { name: 'Deep clean', sort_order: 3, sync_id: '00000000-0000-0000-0000-000000000004' },
]

const SEED_CHORES: (Omit<Chore, 'id' | 'category_id' | 'sort_order' | 'category_sync_id'> & { _catIndex: number })[] = [
  { name: 'Mop kitchen',        _catIndex: 0, sync_id: '00000000-0000-0000-0000-000000000011', target_cadence_days: 14, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Clean bathrooms',    _catIndex: 0, sync_id: '00000000-0000-0000-0000-000000000012', target_cadence_days: 7,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Vacuum',             _catIndex: 0, sync_id: '00000000-0000-0000-0000-000000000013', target_cadence_days: 7,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Take out trash',     _catIndex: 0, sync_id: '00000000-0000-0000-0000-000000000014', target_cadence_days: 3,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Change cat litter',  _catIndex: 1, sync_id: '00000000-0000-0000-0000-000000000021', target_cadence_days: 2,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Feed fish',          _catIndex: 1, sync_id: '00000000-0000-0000-0000-000000000022', target_cadence_days: 1,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Oil change',         _catIndex: 2, sync_id: '00000000-0000-0000-0000-000000000031', target_cadence_days: 90, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Wash car',           _catIndex: 2, sync_id: '00000000-0000-0000-0000-000000000032', target_cadence_days: 30, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Clean oven',         _catIndex: 3, sync_id: '00000000-0000-0000-0000-000000000041', target_cadence_days: 60, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Wipe down cabinets', _catIndex: 3, sync_id: '00000000-0000-0000-0000-000000000042', target_cadence_days: 30, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
]

export const db = new LastGlanceDB()
