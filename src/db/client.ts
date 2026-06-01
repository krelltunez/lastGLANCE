import Dexie, { type Table } from 'dexie'
import type { Category, Chore, CompletionEvent, Tombstone, User } from '@/types'

class LastGlanceDB extends Dexie {
  categories!: Table<Category, number>
  chores!: Table<Chore, number>
  completionEvents!: Table<CompletionEvent, number>
  tombstones!: Table<Tombstone, string>
  users!: Table<User, number>

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

    // Re-derives category_sync_id from category_id for all chores, fixing cases
    // where updateChore was called with a new category_id but category_sync_id
    // was not updated alongside it.
    this.version(7)
      .stores({})
      .upgrade(async tx => {
        const categories = await tx.table('categories').toArray()
        const catSyncIdMap = new Map<number, string>(
          categories.map((c: Category) => [c.id as number, c.sync_id as string])
        )
        const chores = await tx.table('chores').toArray()
        for (const chore of chores) {
          const category_sync_id = chore.category_id != null
            ? (catSyncIdMap.get(chore.category_id as number) ?? null)
            : null
          await tx.table('chores').update(chore.id as number, { category_sync_id })
        }
      })

    // Adds users table; adds assigned_user_sync_ids to chores;
    // adds completed_by_user_sync_id to completionEvents.
    this.version(8)
      .stores({
        users: '++id, sync_id',
        chores: '++id, category_id, sort_order, sync_id',
        completionEvents: '++id, chore_id, completed_at, sync_id',
      })
      .upgrade(tx => {
        tx.table('chores').toCollection().modify((chore: Chore) => {
          if ((chore as { assigned_user_sync_ids?: string[] }).assigned_user_sync_ids === undefined) {
            chore.assigned_user_sync_ids = []
          }
        })
        tx.table('completionEvents').toCollection().modify((evt: CompletionEvent) => {
          if ((evt as { completed_by_user_sync_id?: string | null }).completed_by_user_sync_id === undefined) {
            evt.completed_by_user_sync_id = null
          }
        })
      })

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

export const SEED_CAT_SYNC_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
]

export const SEED_CHORE_SYNC_IDS = [
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000012',
  '00000000-0000-0000-0000-000000000013',
  '00000000-0000-0000-0000-000000000014',
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-000000000022',
  '00000000-0000-0000-0000-000000000023',
  '00000000-0000-0000-0000-000000000031',
  '00000000-0000-0000-0000-000000000032',
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000042',
  '00000000-0000-0000-0000-000000000043',
]

const SEED_CATEGORIES: Omit<Category, 'id' | 'parent_sync_id' | 'updated_at'>[] = [
  { name: 'Home',     sort_order: 0, icon: 'House',      sync_id: '00000000-0000-0000-0000-000000000001' },
  { name: 'Health',   sort_order: 1, icon: 'HeartPulse', sync_id: '00000000-0000-0000-0000-000000000002' },
  { name: 'Vehicle',  sort_order: 2, icon: 'Car',        sync_id: '00000000-0000-0000-0000-000000000003' },
  { name: 'Finances', sort_order: 3, icon: 'PiggyBank',  sync_id: '00000000-0000-0000-0000-000000000004' },
]

const SEED_CHORES: (Omit<Chore, 'id' | 'category_id' | 'sort_order' | 'category_sync_id'> & { _catIndex: number })[] = [
  { name: 'Mop kitchen',        _catIndex: 0, icon: 'House',      sync_id: '00000000-0000-0000-0000-000000000011', target_cadence_days: 14,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Clean bathrooms',    _catIndex: 0, icon: 'House',      sync_id: '00000000-0000-0000-0000-000000000012', target_cadence_days: 7,   notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Vacuum',             _catIndex: 0, icon: 'House',      sync_id: '00000000-0000-0000-0000-000000000013', target_cadence_days: 7,   notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Take out trash',     _catIndex: 0, icon: 'House',      sync_id: '00000000-0000-0000-0000-000000000014', target_cadence_days: 3,   notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Dentist cleaning',   _catIndex: 1, icon: 'HeartPulse', sync_id: '00000000-0000-0000-0000-000000000021', target_cadence_days: 180, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Annual physical',    _catIndex: 1, icon: 'HeartPulse', sync_id: '00000000-0000-0000-0000-000000000022', target_cadence_days: 365, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Eye exam',           _catIndex: 1, icon: 'HeartPulse', sync_id: '00000000-0000-0000-0000-000000000023', target_cadence_days: 365, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Oil change',         _catIndex: 2, icon: 'Car',        sync_id: '00000000-0000-0000-0000-000000000031', target_cadence_days: 90,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Wash car',           _catIndex: 2, icon: 'Car',        sync_id: '00000000-0000-0000-0000-000000000032', target_cadence_days: 30,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Review budget',      _catIndex: 3, icon: 'PiggyBank',  sync_id: '00000000-0000-0000-0000-000000000041', target_cadence_days: 30,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Check bank statements', _catIndex: 3, icon: 'PiggyBank', sync_id: '00000000-0000-0000-0000-000000000042', target_cadence_days: 30, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
  { name: 'Check credit score',  _catIndex: 3, icon: 'PiggyBank',  sync_id: '00000000-0000-0000-0000-000000000043', target_cadence_days: 90,  notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, assigned_user_sync_ids: [], created_at: SEED_TIMESTAMP, updated_at: SEED_TIMESTAMP },
]

export const db = new LastGlanceDB()
