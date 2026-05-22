export interface SyncChore {
  id: string                    // sync_id
  name: string
  categorySyncId: string | null
  sortOrder: number
  targetCadenceDays: number | null
  notifyWhenOverdue: boolean
  autoScheduleToDayglance: boolean
  preferredScheduleBehavior: 'today' | 'next_weekend' | 'next_free_day' | null
  icon: string | undefined
  createdAt: string
  updatedAt: string             // maps to chore.updated_at
}

export interface SyncCategory {
  id: string          // sync_id
  name: string
  sortOrder: number
  icon: string | undefined
  parentId: string | null  // parent_sync_id
  updatedAt: string   // maps to category.updated_at
}

export interface SyncCompletionEvent {
  id: string          // sync_id
  choreSyncId: string
  completedAt: string
  note: string | null
  source: 'manual' | 'dayglance'
}

export interface SyncPayload {
  chores: SyncChore[]
  categories: SyncCategory[]
  completionEvents: SyncCompletionEvent[]
  tombstones: Record<string, string>   // sync_id → deletedAt ISO string
}
