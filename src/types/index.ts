export interface User {
  id: number
  name: string
  sync_id: string
  updated_at: string
}

export interface Category {
  id: number
  name: string
  sort_order: number
  icon?: string
  parent_category_id?: number
  sync_id: string
  parent_sync_id: string | null
  updated_at: string
  assigned_user_sync_ids: string[]
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
  seasonal_start: string | null  // "MM-DD", e.g. "04-01"
  seasonal_end: string | null    // "MM-DD", e.g. "10-31"
  created_at: string
  updated_at: string
  icon?: string
  sync_id: string
  category_sync_id: string | null
  assigned_user_sync_ids: string[]
}

export interface CompletionEvent {
  id: number
  chore_id: number
  completed_at: string
  note: string | null
  source: 'manual' | 'dayglance'
  completed_by_user_sync_id: string | null
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
