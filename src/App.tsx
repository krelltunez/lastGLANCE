import { useState, useEffect, useCallback, useRef } from 'react'
import { Pencil, Check, Sun, Moon, Archive, Plug, Cloud, CloudOff, RefreshCw, HelpCircle, Users, Settings, UserCircle } from 'lucide-react'
import { Ribbon } from '@/components/Ribbon/Ribbon'
import { BackupModal } from '@/components/BackupModal/BackupModal'
import { WelcomeModal } from '@/components/WelcomeModal/WelcomeModal'
import { clearSeedData, getUsers as getDBUsers, deduplicateUsers } from '@/db/queries'
import { IntegrationSettingsModal } from '@/components/IntegrationSettingsModal/IntegrationSettingsModal'
import { SyncSettingsModal } from '@/components/SyncSettingsModal/SyncSettingsModal'
import { PassphraseModal } from '@/components/PassphraseModal/PassphraseModal'
import { HelpModal } from '@/components/HelpModal/HelpModal'
import { ShortcutsModal } from '@/components/ShortcutsModal/ShortcutsModal'
import { ActivityLogModal } from '@/components/ActivityLogModal/ActivityLogModal'
import { ToastProvider } from '@/components/Toast/Toast'
import { UsersModal } from '@/components/UsersModal/UsersModal'
import { UsersContext } from '@/multiuser/UsersContext'
import { useUsers } from '@/multiuser/useUsers'
import { useNotifications } from '@/hooks/useNotifications'
import { useIntentsPoller } from '@/hooks/useIntentsPoller'
import { IntentsProvider, useIntents } from '@/intents/IntentsContext'
import { getAllCompletionCounts } from '@/db/queries'
import { createEngine, initSessionKey, setupEncryptionKey, runAutoBackups, ensureSyncFolder, CRYPTO_CONFIG, getSyncWebdavConfig } from '@/sync/engine'
import type { SyncEngine, SyncStatus } from '@glance-apps/sync'
import { syncSharedUsers } from '@/multiuser/sharedUsers'
import { getUsersPath } from '@/multiuser/settings'
import dayjs from 'dayjs'

// ── Header heatmap ─────────────────────────────────────────────────────────────

type HeatDay = { date: string; count: number; isFuture: boolean }

function buildHeaderHeatmap(counts: Map<string, number>): HeatDay[][] {
  const today = dayjs()
  const start = today.subtract(51, 'week').startOf('week')
  const weeks: HeatDay[][] = []
  let cur = start
  for (let w = 0; w < 52; w++) {
    const week: HeatDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = cur.format('YYYY-MM-DD')
      week.push({ date, count: counts.get(date) ?? 0, isFuture: cur.isAfter(today) })
      cur = cur.add(1, 'day')
    }
    weeks.push(week)
  }
  return weeks
}

function heatCellColor(day: HeatDay): string {
  if (day.isFuture) return 'transparent'
  if (day.count === 0) return 'rgba(71,85,105,0.4)'
  if (day.count === 1) return '#166534'
  if (day.count === 2) return '#16a34a'
  if (day.count <= 4) return '#22c55e'
  return '#4ade80'
}

const WAVE_WIDTH = 14
const WAVE_DURATION = 1500

function getWaveColor(wi: number, di: number, day: HeatDay, wavePos: number): string {
  if (day.isFuture) return 'transparent'
  const dist = wavePos - wi - di * 0.6
  if (dist < 0) return 'rgba(71,85,105,0.15)'
  if (dist >= WAVE_WIDTH) return heatCellColor(day)
  const t = dist / WAVE_WIDTH
  if (t < 0.15) return '#86efac'
  if (t < 0.40) return '#4ade80'
  if (t < 0.65) return '#22c55e'
  if (t < 0.85) return '#16a34a'
  return heatCellColor(day)
}

function HeaderHeatmap({ weeks }: { weeks: HeatDay[][] }) {
  const [wavePos, setWavePos] = useState(-WAVE_WIDTH)

  useEffect(() => {
    const start = performance.now()
    const totalRange = 52 + WAVE_WIDTH * 2
    let raf: number

    function step(now: number) {
      const pos = ((now - start) / WAVE_DURATION) * totalRange - WAVE_WIDTH
      setWavePos(pos)
      if (pos < 52 + WAVE_WIDTH) raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="flex gap-[3px] items-end">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-[3px]">
          {week.map((day, di) => (
            <div
              key={di}
              title={day.isFuture ? '' : `${day.date}${day.count > 0 ? ` · ${day.count}` : ''}`}
              className="w-[9px] h-[9px] rounded-[2px]"
              style={{ backgroundColor: getWaveColor(wi, di, day, wavePos) }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

function AppInner() {
  useNotifications()
  const { refreshConfig } = useIntents()
  const usersCtx = useUsers()
  const reloadUsers = usersCtx.reload
  const { multiUserEnabled, meId, filter, setFilter } = usersCtx
  const [editMode, setEditMode] = useState(false)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('lg-welcome-dismissed'))
  const [welcomeClearing, setWelcomeClearing] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  const [showIntegration, setShowIntegration] = useState(false)
  const [showSyncSettings, setShowSyncSettings] = useState(false)
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showActivityLog, setShowActivityLog] = useState(false)
  const [showUsers, setShowUsers] = useState(false)
  const [showSettingsSheet, setShowSettingsSheet] = useState(false)
  const [ribbonKey, setRibbonKey] = useState(0)
  const [heatmapWeeks, setHeatmapWeeks] = useState<HeatDay[][]>([])
  const [waveKey, setWaveKey] = useState(0)
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )

  // Sync engine
  const engineRef = useRef<SyncEngine | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncHalted, setSyncHalted] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('theme', isDark ? 'dark' : 'light')
  }, [isDark])

  // Initialize sync engine on mount
  useEffect(() => {
    navigator.storage?.persist?.()
    initSessionKey(CRYPTO_CONFIG).catch(() => {/* non-fatal */})
    const engine = createEngine(import.meta.env.VITE_WEBDAV_PROXY_URL, {
      onStatusChange: (status) => {
        setSyncStatus(status)
        if (status === 'success' && engineRef.current) {
          runAutoBackups(engineRef.current).catch(() => {/* non-fatal */})
        }
      },
      onError: (msg, _code, isHardStop) => {
        setSyncError(msg)
        if (isHardStop) setSyncHalted(true)
      },
      onLastSyncedChange: () => {/* last synced stored internally */},
      onPassphraseRequired: () => setShowPassphrase(true),
    })
    engineRef.current = engine
    deduplicateUsers()
      .catch(() => {})
      .then(() => ensureSyncFolder(engine))
      .then(() => engine.sync())
      .catch(() => {/* errors surfaced via onError */})
  }, [])

  // Shared user roster sync — fire-and-forget, non-fatal
  const sharedUserSyncRunning = useRef(false)
  const runSharedUserSync = useCallback(async () => {
    if (sharedUserSyncRunning.current) return
    sharedUserSyncRunning.current = true
    try {
      await deduplicateUsers()
      const syncConfig = getSyncWebdavConfig(engineRef.current)
      if (!syncConfig) return
      const localUsers = await getDBUsers()
      const result = await syncSharedUsers(syncConfig, getUsersPath(), localUsers)
      if (result) {
        // Upsert remote-only or updated users into local DB
        const { createUser, updateUser } = await import('@/db/queries')
        for (const ru of result.merged) {
          const existing = localUsers.find(u => u.sync_id === ru.id)
          if (!existing) {
            await createUser(ru.name, ru.id)
          } else if (ru.name !== existing.name && ru.updatedAt > existing.updated_at) {
            await updateUser(existing.id, { name: ru.name })
          }
        }
        reloadUsers()
      }
    } catch { /* non-fatal */ }
    finally { sharedUserSyncRunning.current = false }
  }, [reloadUsers])

  // Auto-sync on mount
  useEffect(() => {
    runSharedUserSync()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-sync on tab focus and on a recurring interval
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && engineRef.current) {
        const eng = engineRef.current
        ensureSyncFolder(eng).then(() => eng.sync()).catch(() => {/* errors surfaced via onError */})
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    const interval = setInterval(() => {
      if (engineRef.current) {
        const eng = engineRef.current
        ensureSyncFolder(eng).then(() => eng.sync()).catch(() => {/* errors surfaced via onError */})
      }
    }, 5 * 60 * 1000)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(interval)
    }
  }, [])

  const loadHeatmap = useCallback(async () => {
    const counts = await getAllCompletionCounts()
    setHeatmapWeeks(buildHeaderHeatmap(counts))
    setWaveKey(k => k + 1)
  }, [])

  useIntentsPoller(loadHeatmap)

  useEffect(() => { loadHeatmap() }, [loadHeatmap])

  useEffect(() => {
    window.addEventListener('lg:chore-logged', loadHeatmap)
    return () => window.removeEventListener('lg:chore-logged', loadHeatmap)
  }, [loadHeatmap])

  useEffect(() => {
    window.addEventListener('lg:sync-applied', loadHeatmap)
    return () => window.removeEventListener('lg:sync-applied', loadHeatmap)
  }, [loadHeatmap])

  function toggleTheme() {
    setIsDark(d => !d)
  }

  // Global keyboard shortcuts (D, E, I, S, A, L, ?)
  // Uses a ref for the "any modal open" guard so the effect never re-registers.
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = (
    showWelcome || showBackup || showIntegration || showSyncSettings ||
    showPassphrase || showHelp || showShortcuts || showActivityLog || showUsers
  )
  const filterRef = useRef(filter)
  filterRef.current = filter
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return
      if (anyModalOpenRef.current || e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'd': case 'D': setIsDark(d => !d); break
        case 'e': case 'E': setEditMode(m => !m); break
        case 'i': case 'I': setShowIntegration(true); break
        case 's': case 'S': setShowSyncSettings(true); break
        case 'a': case 'A': setShowBackup(true); break
        case 'l': case 'L': setShowActivityLog(true); break
        case 'm': case 'M':
          if (multiUserEnabled && meId && !editMode) setFilter(filterRef.current === 'mine' ? 'all' : 'mine')
          break
        case '?':           setShowShortcuts(true); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <UsersContext.Provider value={usersCtx}>
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <header className="shrink-0 px-5 pt-5 pb-4 border-b border-slate-200 dark:border-slate-800/80 flex items-end justify-between gap-4">
        {/* Logo + heatmap */}
        <div className="flex items-end gap-5 min-w-0">
          <div className="shrink-0">
            <h1 className="text-3xl md:text-4xl font-black tracking-tight leading-none text-slate-900 dark:text-slate-100">
              last<span className="italic text-green-400">GLANCE</span>
            </h1>
            <p className="text-xs text-slate-400 dark:text-slate-600 mt-1 tracking-wide">when did you last...?</p>
          </div>

          {heatmapWeeks.length > 0 && (
            <>
              {/* 26 weeks on landscape mobile / small screens */}
              <div className="hidden md:block min-[1060px]:hidden pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks.slice(-26)} />
              </div>
              {/* 52 weeks on large screens */}
              <div className="hidden min-[1060px]:block pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks} />
              </div>
            </>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">

          {/* ── Mobile: settings gear + Edit ── */}
          <div className="flex items-center gap-2 sm:hidden">
            <div className="relative">
              <button
                onClick={() => setShowSettingsSheet(s => !s)}
                className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
                aria-label="Settings"
              >
                <Settings size={15} />
              </button>
              {showSettingsSheet && (
                <>
                  {/* backdrop */}
                  <div className="fixed inset-0 z-40" onClick={() => setShowSettingsSheet(false)} />
                  {/* sheet */}
                  <div className="absolute right-0 top-full mt-2 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-3 flex flex-col gap-1 min-w-[160px]">
                    {[
                      { label: 'Users', icon: <Users size={15} />, onClick: () => { setShowUsers(true); setShowSettingsSheet(false) } },
                      { label: 'dayGLANCE Integration', icon: <Plug size={15} />, onClick: () => { setShowIntegration(true); setShowSettingsSheet(false) } },
                      { label: 'Cloud Sync', icon: syncHalted || syncError ? <CloudOff size={15} /> : syncStatus === 'uploading' || syncStatus === 'downloading' ? <RefreshCw size={15} className="animate-spin" /> : <Cloud size={15} />, onClick: () => { setShowSyncSettings(true); setShowSettingsSheet(false) }, warn: !!(syncHalted || syncError) },
                      { label: 'Backup & Restore', icon: <Archive size={15} />, onClick: () => { setShowBackup(true); setShowSettingsSheet(false) } },
                      { label: 'Help & Feedback', icon: <HelpCircle size={15} />, onClick: () => { setShowHelp(true); setShowSettingsSheet(false) } },
                      { label: isDark ? 'Light mode' : 'Dark mode', icon: isDark ? <Sun size={15} /> : <Moon size={15} />, onClick: () => { toggleTheme(); setShowSettingsSheet(false) } },
                    ].map(item => (
                      <button
                        key={item.label}
                        onClick={item.onClick}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left w-full transition-colors hover:bg-slate-100 dark:hover:bg-slate-700 ${item.warn ? 'text-amber-400' : 'text-slate-600 dark:text-slate-300'}`}
                      >
                        {item.icon}
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => setEditMode(e => !e)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${editMode ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60' : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
              aria-label={editMode ? 'Done editing' : 'Edit categories and chores'}
            >
              {editMode ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Edit</>}
            </button>
          </div>

          {/* ── Desktop: two-row layout ── */}
          <div className="hidden sm:flex flex-col items-end gap-1.5">
            {/* Row 1: theme + filter (if multi-user) + edit */}
            <div className="flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
                aria-label="Toggle theme"
              >
                {isDark ? <Sun size={15} /> : <Moon size={15} />}
              </button>
              {multiUserEnabled && meId && !editMode && (
                <button
                  onClick={() => setFilter(filter === 'mine' ? 'all' : 'mine')}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    filter === 'mine'
                      ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60'
                      : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                  aria-label="Toggle my tasks filter"
                >
                  <UserCircle size={14} />
                  {filter === 'mine' ? 'Mine' : 'All'}
                </button>
              )}
              <button
                onClick={() => setEditMode(e => !e)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${editMode ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60' : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                aria-label={editMode ? 'Done editing' : 'Edit categories and chores'}
              >
                {editMode ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Edit</>}
              </button>
            </div>
            {/* Row 2: users, intents, sync, archive, help */}
            <div className="flex items-center gap-2">
              <button onClick={() => setShowUsers(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label="Users"><Users size={15} /></button>
              <button onClick={() => setShowIntegration(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label="dayGLANCE Integration"><Plug size={15} /></button>
              <button
                onClick={() => setShowSyncSettings(true)}
                className={`p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors ${syncHalted || syncError ? 'text-amber-400 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'}`}
                aria-label="Cloud Sync"
              >
                {syncStatus === 'uploading' || syncStatus === 'downloading' ? <RefreshCw size={15} className="animate-spin" /> : syncHalted || syncError ? <CloudOff size={15} /> : <Cloud size={15} />}
              </button>
              <button onClick={() => setShowBackup(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label="Backup & Restore"><Archive size={15} /></button>
              <button onClick={() => setShowHelp(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label="Help & Feedback"><HelpCircle size={15} /></button>
            </div>
          </div>

        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden">
        <Ribbon key={ribbonKey} editMode={editMode} onLogged={loadHeatmap} />
      </main>

      {showWelcome && (
        <WelcomeModal
          clearing={welcomeClearing}
          onGetStarted={() => {
            localStorage.setItem('lg-welcome-dismissed', '1')
            setShowWelcome(false)
          }}
          onClearSample={async () => {
            setWelcomeClearing(true)
            try {
              await clearSeedData()
              localStorage.setItem('lg-welcome-dismissed', '1')
              localStorage.setItem('lg-seed-cleared', '1')
              setShowWelcome(false)
              setRibbonKey(k => k + 1)
              loadHeatmap()
            } finally {
              setWelcomeClearing(false)
            }
          }}
        />
      )}

      {showBackup && (
        <BackupModal
          engine={engineRef.current}
          onClose={() => setShowBackup(false)}
          onImported={() => { loadHeatmap(); setRibbonKey(k => k + 1) }}
        />
      )}

      {showIntegration && (
        <IntegrationSettingsModal
          onClose={() => setShowIntegration(false)}
          onSaved={() => { refreshConfig(); setShowIntegration(false) }}
        />
      )}

      {showSyncSettings && (
        <SyncSettingsModal
          engine={engineRef.current}
          onClose={() => { setShowSyncSettings(false); runSharedUserSync() }}
        />
      )}

      {showHelp && (
        <HelpModal
          onClose={() => setShowHelp(false)}
          onOpenShortcuts={() => setShowShortcuts(true)}
        />
      )}

      {showActivityLog && (
        <ActivityLogModal onClose={() => setShowActivityLog(false)} />
      )}

      {showShortcuts && (
        <ShortcutsModal onClose={() => setShowShortcuts(false)} />
      )}

      {showPassphrase && (
        <PassphraseModal
          onSubmit={async (passphrase) => {
            await setupEncryptionKey(passphrase, CRYPTO_CONFIG)
            setShowPassphrase(false)
            if (engineRef.current) {
              const eng = engineRef.current
              ensureSyncFolder(eng).then(() => eng.sync()).catch(() => {/* errors surfaced via onError */})
            }
          }}
          onClose={() => setShowPassphrase(false)}
        />
      )}

      {showUsers && (
        <UsersModal
          engine={engineRef.current}
          onUserMutated={runSharedUserSync}
          onClose={() => { setShowUsers(false); usersCtx.reload() }}
        />
      )}
    </div>
    </UsersContext.Provider>
  )
}

export default function App() {
  return (
    <IntentsProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </IntentsProvider>
  )
}
