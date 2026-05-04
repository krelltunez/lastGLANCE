import Dexie, { type Table } from 'dexie'
import type { Category, Chore, CompletionEvent } from '@/types'

class LastGlanceDB extends Dexie {
  categories!: Table<Category, number>
  chores!: Table<Chore, number>
  completionEvents!: Table<CompletionEvent, number>

  constructor() {
    super('lastglance')
    this.version(1).stores({
      categories: '++id, sort_order',
      chores: '++id, category_id',
      completionEvents: '++id, chore_id, completed_at',
    })

    this.on('populate', async () => {
      const catIds = (await this.categories.bulkAdd(
        SEED_CATEGORIES as unknown as Category[],
        { allKeys: true }
      )) as unknown as number[]

      await this.chores.bulkAdd(
        SEED_CHORES.map(({ _catIndex, ...rest }) => ({
          ...rest,
          category_id: catIds[_catIndex],
        })) as unknown as Chore[]
      )
    })
  }
}

const now = new Date().toISOString()

const SEED_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Home',       sort_order: 0 },
  { name: 'Pets',       sort_order: 1 },
  { name: 'Vehicle',    sort_order: 2 },
  { name: 'Deep clean', sort_order: 3 },
]

const SEED_CHORES: (Omit<Chore, 'id' | 'category_id'> & { _catIndex: number })[] = [
  { name: 'Mop kitchen',        _catIndex: 0, target_cadence_days: 14, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Clean bathrooms',    _catIndex: 0, target_cadence_days: 7,  auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Vacuum',             _catIndex: 0, target_cadence_days: 7,  auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Take out trash',     _catIndex: 0, target_cadence_days: 3,  auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Change cat litter',  _catIndex: 1, target_cadence_days: 2,  auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Feed fish',          _catIndex: 1, target_cadence_days: 1,  auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Oil change',         _catIndex: 2, target_cadence_days: 90, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Wash car',           _catIndex: 2, target_cadence_days: 30, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Clean oven',         _catIndex: 3, target_cadence_days: 60, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
  { name: 'Wipe down cabinets', _catIndex: 3, target_cadence_days: 30, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, created_at: now, updated_at: now },
]

export const db = new LastGlanceDB()
