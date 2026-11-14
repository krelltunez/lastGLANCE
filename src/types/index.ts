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
  details: string | null         // free-text notes for the chore itself
  pinned: boolean                // shown in the Pinned row/tab as well as its own category
  created_at: string
  updated_at: string
  icon?: string
  sync_id: string
  category_sync_id: string | null
  assigned_user_sync_ids: string[]
  // How long the chore takes, in minutes (1 to 1440), or null when not set.
  // The task length when the chore goes to dayGLANCE at a set time
  // (lastglance_send_to_dayglance). Optional: rows from before it have none.
  // Synced as a later field (src/sync/choreFields.ts).
  duration_minutes?: number | null
  // Fields a newer version's sync record held that this version does not know,
  // kept so they go out again with the chore (src/sync/choreFields.ts). Never
  // read here; absent when there were none.
  sync_extra?: Record<string, unknown>
}

export interface CompletionEvent {
  id: number
  chore_id: number
  completed_at: string
  note: string | null
  source: 'manual' | 'dayglance'
  completed_by_user_sync_id: string | null
  sync_id: string
  // When the row last changed. Events are otherwise immutable, but the NOTE is
  // editable after the fact, and note edits sync last-write-wins on this
  // timestamp. Optional because rows written before the field existed lack it;
  // every reader falls back to completed_at.
  updated_at?: string
}

export interface Tombstone {
  id: string
  deleted_at: string
}

export interface ChoreWithLastCompletion extends Chore {
  last_completed_at: string | null
  elapsed_days: number | null
}
