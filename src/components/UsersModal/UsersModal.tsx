import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Plus, Pencil, Trash2, Check, Users, RefreshCw } from 'lucide-react'
import { getUsers, createUser, updateUser, deleteUser } from '@/db/queries'
import { getMultiUserEnabled, setMultiUserEnabled, getMeUserSyncId, setMeUserSyncId, getUsersPath, setUsersPath as saveUsersPath } from '@/multiuser/settings'
import { syncSharedUsers } from '@/multiuser/sharedUsers'
import { getSyncWebdavConfig } from '@/sync/engine'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import type { SyncEngine } from '@glance-apps/sync'
import type { User } from '@/types'

interface Props {
  engine: SyncEngine | null
  onClose: () => void
}

export function UsersModal({ engine, onClose }: Props) {
  const [enabled, setEnabled] = useState(getMultiUserEnabled)
  const [users, setUsers] = useState<User[]>([])
  const [meId, setMeId] = useState<string | null>(getMeUserSyncId)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [addingName, setAddingName] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState('')
  const [usersPath, setUsersPath] = useState(() => getUsersPath())
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'ok' | 'error'>('idle')

  useEscapeKey(onClose)

  async function loadUsers() {
    setUsers(await getUsers())
  }

  useEffect(() => { loadUsers() }, [])

  function handleToggle() {
    const next = !enabled
    setEnabled(next)
    setMultiUserEnabled(next)
  }

  async function handleAdd() {
    const name = addingName.trim()
    if (!name) { setError('Name is required'); return }
    if (users.some(u => u.name.toLowerCase() === name.toLowerCase())) {
      setError('A user with that name already exists'); return
    }
    try {
      const id = await createUser(name)
      setAddingName('')
      setIsAdding(false)
      setError('')
      const fresh = await getUsers()
      setUsers(fresh)
      // Auto-set as "me" if this is the first user
      const created = fresh.find(u => u.id === id)
      if (created && fresh.length === 1) {
        setMeUserSyncId(created.sync_id)
        setMeId(created.sync_id)
      }
    } catch (e) {
      setError(`Failed to save user: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleSaveEdit() {
    const name = editingName.trim()
    if (!name) { setError('Name is required'); return }
    if (users.some(u => u.name.toLowerCase() === name.toLowerCase() && u.id !== editingId)) {
      setError('A user with that name already exists'); return
    }
    try {
      await updateUser(editingId!, { name })
      setEditingId(null)
      setEditingName('')
      setError('')
      setUsers(await getUsers())
    } catch (e) {
      setError(`Failed to save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleDelete(user: User) {
    if (user.sync_id === meId) {
      setMeUserSyncId(null)
      setMeId(null)
    }
    await deleteUser(user.id)
    await loadUsers()
  }

  function handleSetMe(user: User) {
    const next = meId === user.sync_id ? null : user.sync_id
    setMeUserSyncId(next)
    setMeId(next)
  }

  function handleUsersPathChange(val: string) {
    setUsersPath(val)
    saveUsersPath(val)
  }

  async function handleSyncNow() {
    setSyncing(true)
    setSyncStatus('idle')
    try {
      const syncConfig = getSyncWebdavConfig(engine)
      if (!syncConfig) {
        setError('Cloud sync is not configured. Set up WebDAV under Settings → Cloud Sync first.')
        setSyncStatus('error')
        setTimeout(() => setSyncStatus('idle'), 4000)
        return
      }
      const fresh = await getUsers()
      const result = await syncSharedUsers(syncConfig, usersPath, fresh)
      if (result) {
        // Upsert any new/updated users from remote into local DB
        for (const ru of result.merged) {
          const existing = fresh.find(u => u.sync_id === ru.id)
          if (!existing) {
            await createUser(ru.name)
          } else if (ru.name !== existing.name && ru.updatedAt > existing.updated_at) {
            await updateUser(existing.id, { name: ru.name })
          }
        }
        await loadUsers()
      }
      setSyncStatus('ok')
      setTimeout(() => setSyncStatus('idle'), 3000)
    } catch {
      setSyncStatus('error')
      setTimeout(() => setSyncStatus('idle'), 4000)
    } finally {
      setSyncing(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-md bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700/40 shrink-0">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-green-400" />
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">Users</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">

          {/* Toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-slate-700 dark:text-slate-200 font-medium">Multi-user mode</span>
              <span className="text-xs text-slate-400 dark:text-slate-500">Tag chores with specific household members</span>
            </div>
            <button
              type="button"
              onClick={handleToggle}
              className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ml-4 ${enabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
              aria-checked={enabled}
              role="switch"
              aria-label="Toggle multi-user mode"
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
            </button>
          </div>

          {enabled && (
            <>
              {/* User list */}
              <div className="space-y-1.5">
                {users.map(user => (
                  <div key={user.id} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-700/40">
                    {editingId === user.id ? (
                      <>
                        <input
                          type="text"
                          value={editingName}
                          onChange={e => { setEditingName(e.target.value); setError('') }}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') { setEditingId(null); setError('') } }}
                          autoFocus
                          className="flex-1 min-w-0 bg-white dark:bg-slate-700 rounded-lg px-2 py-1 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                        />
                        <button
                          onClick={handleSaveEdit}
                          className="p-1.5 rounded-lg text-green-400 hover:bg-green-400/10 transition-colors shrink-0"
                          aria-label="Save"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => { setEditingId(null); setError('') }}
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"
                          aria-label="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                          meId === user.sync_id
                            ? 'bg-green-400 text-white'
                            : 'bg-slate-200 dark:bg-slate-600 text-slate-500 dark:text-slate-400'
                        }`}>
                          {user.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="text-sm text-slate-700 dark:text-slate-200 truncate flex-1 min-w-0">{user.name}</span>
                        <button
                          onClick={() => handleSetMe(user)}
                          className={`shrink-0 px-2 py-0.5 rounded-md text-xs font-medium border transition-colors ${
                            meId === user.sync_id
                              ? 'bg-green-400/15 border-green-400/50 text-green-500 dark:text-green-400'
                              : 'border-slate-300 dark:border-slate-600 text-slate-400 dark:text-slate-500 hover:border-green-400/50 hover:text-green-500 dark:hover:text-green-400'
                          }`}
                          aria-label={meId === user.sync_id ? 'Unset as me' : 'Set as me on this device'}
                        >
                          {meId === user.sync_id ? '✓ Me' : 'Me'}
                        </button>
                        <button
                          onClick={() => { setEditingId(user.id); setEditingName(user.name); setError('') }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"
                          aria-label={`Edit ${user.name}`}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(user)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"
                          aria-label={`Delete ${user.name}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                ))}

                {/* Add user row */}
                {isAdding ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-700/40">
                    <input
                      type="text"
                      value={addingName}
                      onChange={e => { setAddingName(e.target.value); setError('') }}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setIsAdding(false); setAddingName(''); setError('') } }}
                      placeholder="Name"
                      autoFocus
                      className="flex-1 min-w-0 bg-white dark:bg-slate-700 rounded-lg px-2 py-1 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                    />
                    <button
                      onClick={handleAdd}
                      className="p-1.5 rounded-lg text-green-400 hover:bg-green-400/10 transition-colors shrink-0"
                      aria-label="Add user"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={() => { setIsAdding(false); setAddingName(''); setError('') }}
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"
                      aria-label="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setIsAdding(true); setError('') }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 rounded-xl text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/40 border border-dashed border-slate-300 dark:border-slate-700/60 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
                  >
                    <Plus size={14} />
                    Add user
                  </button>
                )}

                {error && <p className="text-xs text-red-500 px-1">{error}</p>}
              </div>

              {/* Shared roster sync */}
              <div className="pt-1 border-t border-slate-100 dark:border-slate-700/40 space-y-2">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Shared users path
                  </label>
                  <input
                    type="text"
                    value={usersPath}
                    onChange={e => handleUsersPathChange(e.target.value)}
                    placeholder="/GLANCE/users/"
                    className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400 font-mono"
                  />
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                    Path on WebDAV where <code className="font-mono">glance-users.json</code> is stored. Must match across all GLANCE apps.
                  </p>
                </div>
                <button
                  onClick={handleSyncNow}
                  disabled={syncing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                    syncStatus === 'ok'
                      ? 'bg-green-500/10 border-green-400/40 text-green-500 dark:text-green-400'
                      : syncStatus === 'error'
                        ? 'bg-red-500/10 border-red-400/40 text-red-500 dark:text-red-400'
                        : 'border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-green-400/50 hover:text-green-500 dark:hover:text-green-400'
                  }`}
                >
                  <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                  {syncStatus === 'ok' ? 'Synced!' : syncStatus === 'error' ? 'Sync failed' : 'Sync now'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-700/40 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
