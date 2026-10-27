export interface SyncUser {
  id: string        // sync_id
  name: string
  updatedAt: string
}

export interface SyncChore {
  id: string                    // sync_id
  name: string
  categorySyncId: string | null
  sortOrder: number
  targetCadenceDays: number | null
  notifyWhenOverdue: boolean
  autoScheduleToDayglance: boolean
  preferredScheduleBehavior: 'today' | 'next_weekend' | 'next_free_day' | null
  seasonalStart: string | null | undefined
  seasonalEnd: string | null | undefined
  details: string | null | undefined
  // Optional: payloads from builds before pinning lack it. Readers treat a
  // missing value as "unknown" and keep the local flag rather than unpinning.
  pinned?: boolean
  icon: string | undefined
  assignedUserSyncIds: string[]
  createdAt: string
  updatedAt: string             // maps to chore.updated_at
}

export interface SyncCategory {
  id: string          // sync_id
  name: string
  sortOrder: number
  icon: string | undefined
  parentId: string | null  // parent_sync_id
  assignedUserSyncIds: string[]
  updatedAt: string   // maps to category.updated_at
}

export interface SyncCompletionEvent {
  id: string          // sync_id
  choreSyncId: string
  completedAt: string
  note: string | null
  source: 'manual' | 'dayglance'
  completedByUserSyncId: string | null
  // Note-edit propagation (events are otherwise immutable). Optional so
  // payloads written by older builds keep validating; readers fall back to
  // completedAt, which is what pre-edit rows effectively carry anyway.
  updatedAt?: string
}

export interface SyncSettings {
  multiUserEnabled: boolean
}

export interface SyncPayload {
  chores: SyncChore[]
  categories: SyncCategory[]
  completionEvents: SyncCompletionEvent[]
  users: SyncUser[]
  settings: SyncSettings
  tombstones: Record<string, string>   // sync_id → deletedAt ISO string
}
