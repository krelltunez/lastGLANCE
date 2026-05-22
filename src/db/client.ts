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

    this.on('populate', async () => {
      const seedNow = new Date().toISOString()

      // Assign sync_ids upfront for seed categories so we can use them for chores
      const seedCatSyncIds = SEED_CATEGORIES.map(() => crypto.randomUUID())

      const catIds = (await this.categories.bulkAdd(
        SEED_CATEGORIES.map((cat, i) => ({
          ...cat,
          sync_id: seedCatSyncIds[i],
          parent_sync_id: null,
          updated_at: seedNow,
        })) as unknown as Category[],
        { allKeys: true }
      )) as unknown as number[]

      await this.chores.bulkAdd(
        SEED_CHORES.map(({ _catIndex, ...rest }, i) => ({
          ...rest,
          sort_order: i,
          category_id: catIds[_catIndex],
          sync_id: crypto.randomUUID(),
          category_sync_id: seedCatSyncIds[_catIndex],
        })) as unknown as Chore[]
      )
    })
  }
}

const now = new Date().toISOString()

const SEED_CATEGORIES: Omit<Category, 'id' | 'sync_id' | 'parent_sync_id' | 'updated_at'>[] = [
  { name: 'Home',       sort_order: 0 },
  { name: 'Pets',       sort_order: 1 },
  { name: 'Vehicle',    sort_order: 2 },
  { name: 'Deep clean', sort_order: 3 },
]

const SEED_CHORES: (Omit<Chore, 'id' | 'category_id' | 'sort_order' | 'sync_id' | 'category_sync_id'> & { _catIndex: number })[] = [
  { name: 'Mop kitchen',        _catIndex: 0, target_cadence_days: 14, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Clean bathrooms',    _catIndex: 0, target_cadence_days: 7,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Vacuum',             _catIndex: 0, target_cadence_days: 7,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Take out trash',     _catIndex: 0, target_cadence_days: 3,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Change cat litter',  _catIndex: 1, target_cadence_days: 2,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Feed fish',          _catIndex: 1, target_cadence_days: 1,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Oil change',         _catIndex: 2, target_cadence_days: 90, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Wash car',           _catIndex: 2, target_cadence_days: 30, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Clean oven',         _catIndex: 3, target_cadence_days: 60, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Wipe down cabinets', _catIndex: 3, target_cadence_days: 30, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
]

export const db = new LastGlanceDB()
