export interface Category {
  id: number
  name: string
  sort_order: number
}

export interface Chore {
  id: number
  name: string
  category_id: number
  target_cadence_days: number | null
  auto_schedule_to_dayglance: boolean
  preferred_schedule_behavior: 'today' | 'next_weekend' | 'next_free_day' | null
  created_at: string
  updated_at: string
}

export interface CompletionEvent {
  id: number
  chore_id: number
  completed_at: string
  note: string | null
  source: 'manual' | 'dayglance'
}

export interface ChoreWithLastCompletion extends Chore {
  last_completed_at: string | null
  elapsed_days: number | null
}
