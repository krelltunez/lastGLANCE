import { useState, useEffect, useCallback, useRef } from 'react'
import { Pencil, Check, Sun, Moon, Archive, Plug, Cloud, CloudOff, RefreshCw, HelpCircle, Users, Settings, UserCircle, Clock } from 'lucide-react'
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
import { ToastProvider, useToast } from '@/components/Toast/Toast'
import { UsersModal } from '@/components/UsersModal/UsersModal'
import { UsersContext } from '@/multiuser/UsersContext'
import { useUsers } from '@/multiuser/useUsers'
import { useNotifications } from '@/hooks/useNotifications'
import { useWidgetSnapshot } from '@/hooks/useWidgetSnapshot'
import { useIntentsPoller } from '@/hooks/useIntentsPoller'
import { useDbIntentsPoller } from '@/hooks/useDbIntentsPoller'
import { useOutboxFlush } from '@/hooks/useOutboxFlush'
import { IntentsProvider, useIntents } from '@/intents/IntentsContext'
import { getAllCompletionCounts } from '@/db/queries'
import { createEngine, initSessionKey, setupEncryptionKey, runAutoBackups, ensureSyncFolder, CRYPTO_CONFIG, getSyncWebdavConfig } from '@/sync/engine'
import { createDbEngine, vaultErrorMessage } from '@/sync/dbEngine'
import { registerDbEngine } from '@/sync/dirtyTracker'
import { isVaultEnabled } from '@/sync/vaultConfig'
import { applyStatusBarTheme, initFullScreenInLandscape } from '@/native/statusBar'
import { hasDbRootKey, initDbRootKey, getSyncPassphrase } from '@glance-apps/sync'
import type { SyncEngine, SyncStatus, DbSyncEngine } from '@glance-apps/sync'
import { syncSharedUsers } from '@/multiuser/sharedUsers'
import { getUsersPath, getMultiUserEnabled } from '@/multiuser/settings'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  const { showToast } = useToast()
  useNotifications()
  useWidgetSnapshot()
  const { refreshConfig } = useIntents()
  const usersCtx = useUsers()
  const reloadUsers = usersCtx.reload
  const { multiUserEnabled, meId, filter, setFilter, attentionOnly, setAttentionOnly } = usersCtx
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
  // GLANCEvault DB transport engine, null unless the vault config is enabled.
  // Runs alongside the file engine; does not affect the file sync path.
  const dbEngineRef = useRef<DbSyncEngine | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncHalted, setSyncHalted] = useState(false)
  // Latest GLANCEvault (DB transport) error, surfaced from its onError callback.
  // dbSyncCycle swallows errors internally and reports them here rather than
  // throwing, so this is how the Cloud Sync modal shows what went wrong.
  const [vaultSyncError, setVaultSyncError] = useState<string | null>(null)
  // Durable count of rows the last vault cycle could not decrypt (1.5.0 per-row
  // quarantine). Survives after the transient toast dismisses so a key mismatch on
  // some rows stays visible in the Cloud Sync settings panel.
  const [vaultSkipped, setVaultSkipped] = useState(0)

  // showToast is stable, but the mount effect that builds the engine reads it from
  // a ref so the onRowsSkipped closure always calls the live one.
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  // Runs one DB sync cycle when the vault transport is enabled. No-op otherwise.
  // Fired on the same triggers as the file engine; errors are surfaced through
  // the engine's onError callback (logged, non-fatal to the file tier). The cycle
  // resolves to { applied, skipped, ... }; mirror its skip count into the durable
  // signal so a clean cycle clears it and a quarantining one keeps it visible.
  const runDbSync = useCallback(() => {
    const eng = dbEngineRef.current
    if (eng) {
      eng.dbSyncCycle()
        .then(res => setVaultSkipped(res?.skipped ?? 0))
        .catch(() => {/* surfaced via onError */})
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('theme', isDark ? 'dark' : 'light')
    applyStatusBarTheme(isDark)
  }, [isDark])

  // Full-screen (hide the status bar) in landscape, restore it in portrait.
  useEffect(() => initFullScreenInLandscape(), [])

  // Initialize sync engine on mount
  useEffect(() => {
    navigator.storage?.persist?.()
    initSessionKey(CRYPTO_CONFIG)
      .catch(() => false)
      .then(async () => {
        // First-time vault bootstrap needs the passphrase to derive the root key.
        // On returning loads the root key is restored from lastglance-crypto-db
        // via initDbRootKey, so the prompt is skipped. The in-memory hasDbRootKey
        // is always false at mount, so we attempt the restore before deciding.
        if (!isVaultEnabled()) return
        const hasRoot = hasDbRootKey() || await initDbRootKey(CRYPTO_CONFIG)
        if (!hasRoot && getSyncPassphrase() === null) setShowPassphrase(true)
      })
      .catch(() => {/* non-fatal */})
    const engine = createEngine(import.meta.env.VITE_WEBDAV_PROXY_URL, {
      onStatusChange: (status) => {
        setSyncStatus(status)
        if (status === 'success') {
          // A completed sync clears any stale error so the cloud indicator
          // doesn't stay amber after a transient failure that has recovered.
          // (The engine only clears the error at the *start* of the next
          // attempt, which can be far off under error backoff.)
          setSyncError(null)
          if (engineRef.current) {
            runAutoBackups(engineRef.current).catch(() => {/* non-fatal */})
            runSharedUserSync().catch(() => {/* non-fatal */})
          }
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

    // Construct the DB transport engine alongside the file engine when the vault
    // is enabled. It shares the local data but uses an entirely separate cycle.
    const dbEngine = createDbEngine({
      onError: (msg, code) => {
        // A missing passphrase isn't a sync failure — prompt for it the same way
        // the file engine's onPassphraseRequired does, and surface no error.
        if (code === 'PASSPHRASE_REQUIRED') {
          setVaultSyncError(null)
          setShowPassphrase(true)
          return
        }
        // Map the typed DB-transport codes (KEY_MISMATCH / VERIFIER_UNSUPPORTED /
        // ACCOUNT_ID_REQUIRED) to plain-language text; other codes pass through.
        // A wrong key fails fast and uploads NOTHING, so the account is never
        // polluted; ACCOUNT_ID_REQUIRED is retryable and phrased as "not ready yet".
        const display = vaultErrorMessage(msg, code)
        setVaultSyncError(display)
        if (display) console.warn('[lastglance] vault sync error:', display)
      },
      onRowsSkipped: (count) => {
        // Durable: keep the count visible in the sync settings panel after the toast.
        setVaultSkipped(count)
        // Transient: nudge the user toward the settings where the count lives.
        showToastRef.current({
          title: `${count} ${count === 1 ? 'item' : 'items'} couldn’t be read`,
          body: 'Some synced rows couldn’t be decrypted. Check Cloud Sync settings.',
        })
      },
    })
    dbEngineRef.current = dbEngine
    registerDbEngine(dbEngine)

    deduplicateUsers()
      .catch(() => {})
      .then(() => ensureSyncFolder(engine))
      .then(() => engine.sync())
      .catch(() => {/* errors surfaced via onError */})
    runDbSync()

    return () => { registerDbEngine(null) }
  }, [runDbSync])

  // Shared user roster sync — fire-and-forget, non-fatal
  const sharedUserSyncRunning = useRef(false)
  const runSharedUserSync = useCallback(async () => {
    if (!getMultiUserEnabled()) return
    if (sharedUserSyncRunning.current) return
    sharedUserSyncRunning.current = true
    try {
      await deduplicateUsers()
      const syncConfig = getSyncWebdavConfig(engineRef.current)
      if (!syncConfig) return
      const localUsers = await getDBUsers()
      const result = await syncSharedUsers(syncConfig, getUsersPath(), localUsers)
      if (result) {
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
        runDbSync()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    const interval = setInterval(() => {
      if (engineRef.current) {
        const eng = engineRef.current
        ensureSyncFolder(eng).then(() => eng.sync()).catch(() => {/* errors surfaced via onError */})
      }
      runDbSync()
    }, 5 * 60 * 1000)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(interval)
    }
  }, [runDbSync])

  const loadHeatmap = useCallback(async () => {
    const counts = await getAllCompletionCounts()
    setHeatmapWeeks(buildHeaderHeatmap(counts))
    setWaveKey(k => k + 1)
  }, [])

  useIntentsPoller(loadHeatmap)
  // GLANCEvault DB intents transport — gated by isDbIntentsEnabled(); a no-op
  // unless the per-user opt-in is on. WebDAV intents above remain the default.
  useDbIntentsPoller(loadHeatmap)
  // OUTBOUND: drain the durable intents outbox on mount, on focus, and on the
  // poll cadence (enqueue also triggers a flush). Guarantees queued intents are
  // delivered/retried and never lost across restarts.
  useOutboxFlush()

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

  const settingsItems = [
    { label: t('app.cloudSync'), icon: syncHalted || syncError ? <CloudOff size={15} /> : syncStatus === 'uploading' || syncStatus === 'downloading' ? <RefreshCw size={15} className="animate-spin" /> : <Cloud size={15} />, onClick: () => { setShowSyncSettings(true); setShowSettingsSheet(false) }, warn: !!(syncHalted || syncError) },
    { label: t('app.dayglanceIntegration'), icon: <Plug size={22} />, onClick: () => { setShowIntegration(true); setShowSettingsSheet(false) } },
    { label: t('app.users'), icon: <Users size={15} />, onClick: () => { setShowUsers(true); setShowSettingsSheet(false) } },
    { label: isDark ? t('app.lightMode') : t('app.darkMode'), icon: isDark ? <Sun size={15} /> : <Moon size={15} />, onClick: () => { toggleTheme(); setShowSettingsSheet(false) } },
    { label: t('app.backupRestore'), icon: <Archive size={15} />, onClick: () => { setShowBackup(true); setShowSettingsSheet(false) } },
    { label: t('app.helpFeedback'), icon: <HelpCircle size={15} />, onClick: () => { setShowHelp(true); setShowSettingsSheet(false) } },
  ]

  return (
    <UsersContext.Provider value={usersCtx}>
    <div
      className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col"
      style={{
        // Edge-to-edge: the background fills behind the transparent gesture nav;
        // this keeps content clear of it. (The status-bar inset is handled on
        // the header so it doesn't stack with the header's own top padding.)
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <header className="app-safe-top shrink-0 px-5 pb-4 border-b border-slate-200 dark:border-slate-800/80 flex items-end justify-between gap-4">
        {/* Logo + heatmap */}
        <div className="flex items-end gap-5 min-w-0">
          <div className="shrink-0">
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight leading-none text-slate-900 dark:text-slate-100">
              last<span className="italic text-green-400">GLANCE</span>
            </h1>
            <p className="text-xs text-slate-400 dark:text-slate-600 mt-1 tracking-wide">{t('app.tagline')}</p>
          </div>

          {heatmapWeeks.length > 0 && (
            <>
              {/* 26 weeks on landscape mobile / small screens */}
              <div className="hidden min-[828px]:block min-[1140px]:hidden pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks.slice(-26)} />
              </div>
              {/* 52 weeks on large screens */}
              <div className="hidden min-[1140px]:block pb-0.5 opacity-80">
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
                aria-label={t('app.settings')}
              >
                <Settings size={15} />
              </button>
              {showSettingsSheet && (
                <>
                  {/* backdrop */}
                  <div className="fixed inset-0 z-40" onClick={() => setShowSettingsSheet(false)} />
                  {/* sheet */}
                  <div className="absolute right-0 top-full mt-2 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-3 flex flex-col gap-1 min-w-[160px]">
                    {settingsItems.map(item => (
                      <button
                        key={item.label}
                        onClick={item.onClick}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left w-full transition-colors hover:bg-slate-100 dark:hover:bg-slate-700 ${(item as { warn?: boolean }).warn ? 'text-amber-400' : 'text-slate-600 dark:text-slate-300'}`}
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
              aria-label={editMode ? t('app.doneEditing') : t('app.editCategoriesChores')}
            >
              {editMode ? <><Check size={14} /> {t('app.done')}</> : <><Pencil size={14} /> {t('app.edit')}</>}
            </button>
          </div>

          {/* ── Desktop: two-row layout ── */}
          <div className="hidden sm:flex flex-col items-end gap-1.5">
            {/* Row 1: filter (if multi-user) + soon + edit */}
            <div className="flex items-center gap-2">
              {multiUserEnabled && meId && !editMode && (
                <button
                  onClick={() => setFilter(filter === 'mine' ? 'all' : 'mine')}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    filter === 'mine'
                      ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60'
                      : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                  aria-label={t('app.toggleMyTasksFilter')}
                >
                  <UserCircle size={14} />
                  {filter === 'mine' ? t('app.mine') : t('app.all')}
                </button>
              )}
              {!editMode && (
                <button
                  onClick={() => setAttentionOnly(!attentionOnly)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    attentionOnly
                      ? 'text-amber-400 border-amber-400/40 hover:text-amber-300 hover:bg-amber-400/10 hover:border-amber-400/60'
                      : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                  aria-pressed={attentionOnly}
                  aria-label={t('app.toggleSoonFilter')}
                  title={t('app.soonTooltip')}
                >
                  <Clock size={14} />
                  {t('app.soon')}
                </button>
              )}
              <button
                onClick={() => setEditMode(e => !e)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${editMode ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60' : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                aria-label={editMode ? t('app.doneEditing') : t('app.editCategoriesChores')}
              >
                {editMode ? <><Check size={14} /> {t('app.done')}</> : <><Pencil size={14} /> {t('app.edit')}</>}
              </button>
            </div>
            {/* Row 2: sync, intents, multi-user, theme, archive, help */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSyncSettings(true)}
                className={`p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors ${syncHalted || syncError ? 'text-amber-400 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'}`}
                aria-label={t('app.cloudSync')}
              >
                {syncStatus === 'uploading' || syncStatus === 'downloading' ? <RefreshCw size={15} className="animate-spin" /> : syncHalted || syncError ? <CloudOff size={15} /> : <Cloud size={15} />}
              </button>
              <button onClick={() => setShowIntegration(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label={t('app.dayglanceIntegration')}><Plug size={15} /></button>
              <button onClick={() => setShowUsers(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label={t('app.users')}><Users size={15} /></button>
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
                aria-label={t('app.toggleTheme')}
              >
                {isDark ? <Sun size={15} /> : <Moon size={15} />}
              </button>
              <button onClick={() => setShowBackup(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label={t('app.backupRestore')}><Archive size={15} /></button>
              <button onClick={() => setShowHelp(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label={t('app.helpFeedback')}><HelpCircle size={15} /></button>
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
          dbEngine={dbEngineRef.current}
          syncError={syncError}
          vaultSyncError={vaultSyncError}
          vaultSkipped={vaultSkipped}
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
            // The DB engine derives its root key from the same passphrase (now
            // cached in the sync session). ensureRootKey fetches or registers the
            // per-account salt with the vault automatically on first use.
            const dbEng = dbEngineRef.current
            if (dbEng) {
              dbEng.ensureRootKey()
                .then(() => dbEng.dbSyncCycle())
                .catch((err) => console.warn('[lastglance] vault root key setup failed:', err))
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
