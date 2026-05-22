export interface Category {
  id: number
  name: string
  sort_order: number
  icon?: string
  parent_category_id?: number
  sync_id: string
  parent_sync_id: string | null
  updated_at: string
}

export interface Chore {
  id: number
  name: string
  category_id: number
  sort_order: number
  target_cadence_days: number | null
  notify_when_overdue: boolean
  auto_schedule_to_dayglance: boolean
  preferred_schedule_behavior: 'today' | 'next_weekend' | 'next_free_day' | null
  created_at: string
  updated_at: string
  icon?: string
  sync_id: string
  category_sync_id: string | null
}

export interface CompletionEvent {
  id: number
  chore_id: number
  completed_at: string
  note: string | null
  source: 'manual' | 'dayglance'
  sync_id: string
}

export interface Tombstone {
  id: string
  deleted_at: string
}

export interface ChoreWithLastCompletion extends Chore {
  last_completed_at: string | null
  elapsed_days: number | null
}
