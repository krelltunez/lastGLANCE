import { useState, useEffect, useCallback, useRef } from 'react'
import { Pencil, Check, Cloud, CloudOff, RefreshCw, HelpCircle, Settings, UserCircle, Clock, NotebookText } from 'lucide-react'
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
import { JournalModal } from '@/components/JournalModal/JournalModal'
import { TooltipHost } from '@/components/Tooltip/Tooltip'
import { ToastProvider, useToast } from '@/components/Toast/Toast'
import { PaywallModal } from '@/components/PaywallModal/PaywallModal'
import { SettingsPanel, type ThemePref, type SettingsSection } from '@/components/SettingsPanel/SettingsPanel'
import { getTimeFormat, setTimeFormat as applyTimeFormat, type TimeFormat } from '@/utils/datetime'
import { ReviewerBanner } from '@/components/ReviewerBanner/ReviewerBanner'
import { useSubscription, exitReviewerMode } from '@/billing/billing'
import { UsersContext } from '@/multiuser/UsersContext'
import { useUsers } from '@/multiuser/useUsers'
import { useNotifications } from '@/hooks/useNotifications'
import { useWidgetSnapshot } from '@/hooks/useWidgetSnapshot'
import { useReminders } from '@/hooks/useReminders'
import { usePendingCompletions } from '@/hooks/usePendingCompletions'
import { usePendingDeepLink } from '@/hooks/usePendingDeepLink'
import { useIntentsPoller } from '@/hooks/useIntentsPoller'
import { useDbIntentsPoller, drainDbIntents } from '@/hooks/useDbIntentsPoller'
import { useVaultEventStream } from '@/hooks/useVaultEventStream'
import { useDirectAccessSync } from '@/hooks/useDirectAccessSync'
import { useAndroidIntentBridge } from '@/hooks/useAndroidIntentBridge'
import { useOutboxFlush } from '@/hooks/useOutboxFlush'
import { useDayRollover } from '@/hooks/useDayRollover'
import { IntentsProvider, useIntents } from '@/intents/IntentsContext'
import { getAllCompletionCounts } from '@/db/queries'
import { formatDate } from '@/utils/datetime'
import { completionsLabel } from '@/utils/completionsLabel'
import { createEngine, initSessionKey, setupEncryptionKey, runAutoBackups, ensureSyncFolder, CRYPTO_CONFIG, DB_CRYPTO_CONFIG, getSyncWebdavConfig } from '@/sync/engine'
import { createDbEngine } from '@/sync/dbEngine'
import { registerDbEngine } from '@/sync/dirtyTracker'
import { isVaultEnabled } from '@/sync/vaultConfig'
import { applyStatusBarTheme, initFullScreenInLandscape } from '@/native/statusBar'
import { hasDbRootKey, initDbRootKey, getSyncPassphrase } from '@glance-apps/sync'
import type { SyncEngine, SyncStatus, DbSyncEngine, SyncErrorCode } from '@glance-apps/sync'
import { syncSharedUsers } from '@/multiuser/sharedUsers'
import { getUsersPath, getMultiUserEnabled } from '@/multiuser/settings'
import dayjs from 'dayjs'
import i18n from 'i18next'
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

function HeaderHeatmap({ weeks, onSelectDay }: { weeks: HeatDay[][]; onSelectDay: (date: string) => void }) {
  const { t } = useTranslation()
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
            <button
              key={di}
              type="button"
              disabled={day.isFuture}
              onClick={() => onSelectDay(day.date)}
              data-tooltip={day.isFuture ? undefined : formatDate(day.date)}
              data-tooltip-detail={day.isFuture ? undefined : completionsLabel(t, day.count)}
              aria-label={`${formatDate(day.date)}, ${completionsLabel(t, day.count)}`}
              className="w-[9px] h-[9px] rounded-[2px] transition-transform hover:scale-150 disabled:cursor-default disabled:hover:scale-100"
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
  useReminders()
  usePendingCompletions()
  usePendingDeepLink()
  const { refreshConfig } = useIntents()
  const usersCtx = useUsers()
  const reloadUsers = usersCtx.reload
  const { multiUserEnabled, meId, filter, setFilter, attentionOnly, setAttentionOnly } = usersCtx
  // Billing/paywall — inert off the Play channel (adapter is null there, so
  // gated stays false and the hard gate below never renders).
  const billing = useSubscription()
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
  // Journal. `journalDate` is the day a heatmap cell handed off, or null when
  // opened from the toolbar (which lands on the default range instead).
  const [showJournal, setShowJournal] = useState(false)
  const [journalDate, setJournalDate] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Set while a window opened from Settings is up (Cloud Sync, Integrations,
  // Shortcuts): closing it, by Back, Escape or its X, reopens Settings on the
  // section it was opened from. Cleared when Settings itself closes.
  const [settingsReturn, setSettingsReturn] = useState<SettingsSection | null>(null)
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getTimeFormat)
  const [ribbonKey, setRibbonKey] = useState(0)
  const [heatmapWeeks, setHeatmapWeeks] = useState<HeatDay[][]>([])
  const [waveKey, setWaveKey] = useState(0)
  // 'system' follows the OS live. No stored value means a first launch, which
  // main.tsx already painted from the OS, so it starts on 'system' too.
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    const saved = localStorage.getItem('theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const isDark = themePref === 'dark' || (themePref === 'system' && systemDark)
  const isDarkRef = useRef(isDark)
  isDarkRef.current = isDark

  // Sync engine
  const engineRef = useRef<SyncEngine | null>(null)
  // GLANCEvault DB transport engine, null unless the vault config is enabled.
  // Runs alongside the file engine; does not affect the file sync path.
  const dbEngineRef = useRef<DbSyncEngine | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncHalted, setSyncHalted] = useState(false)
  // The typed code that accompanies each error message (null when the engine sent
  // none). Stored alongside the raw message so the Cloud Sync modal can localize
  // it via syncErrorText AT RENDER TIME — keeping the raw message in state means
  // the existing cloud-indicator truthiness checks below stay unchanged.
  const [syncErrorCode, setSyncErrorCode] = useState<SyncErrorCode | null>(null)
  // Latest GLANCEvault (DB transport) error, surfaced from its onError callback.
  // dbSyncCycle swallows errors internally and reports them here rather than
  // throwing, so this is how the Cloud Sync modal shows what went wrong.
  const [vaultSyncError, setVaultSyncError] = useState<string | null>(null)
  const [vaultSyncErrorCode, setVaultSyncErrorCode] = useState<SyncErrorCode | null>(null)
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
    applyStatusBarTheme(isDark)
  }, [isDark])

  useEffect(() => {
    localStorage.setItem('theme', themePref)
  }, [themePref])

  // The formatter swap is synchronous, so the re-render this state change
  // triggers already paints every time on the new clock.
  const changeTimeFormat = useCallback((pref: TimeFormat) => {
    applyTimeFormat(pref)
    setTimeFormatState(pref)
  }, [])

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
        const hasRoot = hasDbRootKey() || await initDbRootKey(DB_CRYPTO_CONFIG)
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
          setSyncErrorCode(null)
          if (engineRef.current) {
            runAutoBackups(engineRef.current).catch(() => {/* non-fatal */})
            runSharedUserSync().catch(() => {/* non-fatal */})
          }
        }
      },
      onError: (msg, code, isHardStop) => {
        // Keep the raw message + its typed code; the Cloud Sync modal localizes
        // via syncErrorText at render time (file tier now USES the code instead
        // of discarding it).
        setSyncError(msg)
        setSyncErrorCode(code)
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
          setVaultSyncErrorCode(null)
          setShowPassphrase(true)
          return
        }
        // Store the raw message + typed code (KEY_MISMATCH / VERIFIER_UNSUPPORTED /
        // ACCOUNT_ID_REQUIRED / …); the Cloud Sync modal localizes via syncErrorText
        // at render time. A wrong key fails fast and uploads NOTHING, so the account
        // is never polluted; ACCOUNT_ID_REQUIRED is retryable ("not ready yet").
        setVaultSyncError(msg)
        setVaultSyncErrorCode(code)
        if (msg) console.warn('[lastglance] vault sync error:', code ?? '(no code)', msg)
      },
      onRowsSkipped: (count) => {
        // Durable: keep the count visible in the sync settings panel after the toast.
        setVaultSkipped(count)
        // Transient: nudge the user toward the settings where the count lives.
        showToastRef.current({
          title: i18n.t('notifications.rowsSkippedTitle', { count }),
          body: i18n.t('notifications.rowsSkippedBody'),
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
    // Mount-once engine init; runSharedUserSync is a stable callback invoked
    // imperatively elsewhere and intentionally not a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Same reload, without bumping waveKey. The wave is a flourish for a *user*
  // action landing (a chore logged, a backup imported); the rollover refresh is
  // ambient bookkeeping, and replaying a 1.5s animation every time the tab
  // regains focus would read as the app churning for no reason.
  const refreshHeatmapQuietly = useCallback(async () => {
    const counts = await getAllCompletionCounts()
    setHeatmapWeeks(buildHeaderHeatmap(counts))
  }, [])

  // The heatmap bakes the current date into every cell (which column is today,
  // which days are still in the future), so it goes stale the same way the
  // chore rows do.
  useDayRollover(refreshHeatmapQuietly)

  useIntentsPoller(loadHeatmap)
  // GLANCEvault DB intents transport — gated by isDbIntentsEnabled(); a no-op
  // unless the per-user opt-in is on. WebDAV intents above remain the default.
  useDbIntentsPoller(loadHeatmap)
  // GLANCEvault SSE push: nudges from the vault trigger the SAME drains the
  // polls run (runDbSync for the sync tier, the intents poller's drain for the
  // intents tier), so remote changes land in seconds instead of at the next
  // poll. Purely additive — every poll cadence above stays untouched as the
  // correctness backstop, and a no-op when the vault is disabled or the
  // transport can't stream (native shell, pre-/events server).
  useVaultEventStream({ drainSync: runDbSync, drainIntents: drainDbIntents })
  // Direct Access (docs/direct-access.md): the snapshot file in a folder a
  // third-party tool keeps in step. Its own poll and guard; the apply is the
  // same applyPayload the WebDAV tier runs, so the UI refresh events come
  // with it. An envelope this device has no key for raises the same
  // passphrase prompt the other tiers use; the entered passphrase derives the
  // file key from the file's own salt on the next cycle.
  const directAccessSync = useDirectAccessSync({
    onEncryptedUnreadable: () => showToastRef.current({
      title: i18n.t('sync.directAccess.title'),
      body: i18n.t('sync.errors.directAccessEncrypted'),
    }),
    onKeyNeeded: () => setShowPassphrase(true),
  })
  const runDirectAccessSync = directAccessSync.runSync
  // Android/Tasker intents transport — lets another Android app drive lastGLANCE
  // via app.lastglance.* intents. No-op off native Android.
  useAndroidIntentBridge(loadHeatmap)
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

  // A widget "Soon" tap (heatmap, or the empty single-chore tile) switches on the
  // attention filter once the app is foregrounded.
  useEffect(() => {
    function onFilterSoon() { setAttentionOnly(true) }
    window.addEventListener('lg:widget-filter-soon', onFilterSoon)
    return () => window.removeEventListener('lg:widget-filter-soon', onFilterSoon)
  }, [setAttentionOnly])

  // The D shortcut flips to an explicit light/dark, leaving 'system'.
  const toggleTheme = useCallback(() => {
    setThemePref(isDarkRef.current ? 'light' : 'dark')
  }, [])

  // Global keyboard shortcuts (D, E, I, S, A, L, ?)
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = (
    showWelcome || showBackup || showIntegration || showSyncSettings ||
    showPassphrase || showHelp || showShortcuts || showActivityLog ||
    showJournal || showSettings
  )
  const filterRef = useRef(filter)
  filterRef.current = filter
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return
      if (anyModalOpenRef.current || e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'd': case 'D': toggleTheme(); break
        case 'e': case 'E': setEditMode(m => !m); break
        case 'i': case 'I': setShowIntegration(true); break
        case 's': case 'S': setShowSyncSettings(true); break
        case 'a': case 'A': setShowBackup(true); break
        case 'l': case 'L': setShowActivityLog(true); break
        case 'j': case 'J': setJournalDate(null); setShowJournal(true); break
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

  const openJournal = useCallback((date: string | null) => {
    setJournalDate(date)
    setShowJournal(true)
  }, [])

  // Every launcher in the settings panel closes it first, so modals never
  // stack on top of it.
  const fromSettings = (section: SettingsSection, open: () => void) => () => {
    setSettingsReturn(section)
    setShowSettings(false)
    open()
  }
  const backToSettings = () => { if (settingsReturn) setShowSettings(true) }

  const handleImported = () => { loadHeatmap(); setRibbonKey(k => k + 1) }

  const syncWarn = !!(syncHalted || syncError)
  const syncIcon = syncStatus === 'uploading' || syncStatus === 'downloading'
    ? <RefreshCw size={15} className="animate-spin" />
    : syncWarn ? <CloudOff size={15} /> : <Cloud size={15} />


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
            <h1 className="text-2xl min-[360px]:text-3xl sm:text-4xl font-black tracking-tight leading-none text-slate-900 dark:text-slate-100">
              last<span className="italic text-green-400">GLANCE</span>
            </h1>
            <p className="text-xs text-slate-400 dark:text-slate-600 mt-1 tracking-wide">{t('app.tagline')}</p>
          </div>

          {heatmapWeeks.length > 0 && (
            <>
              {/* 26 weeks on landscape mobile / small screens */}
              <div className="hidden min-[828px]:block min-[1140px]:hidden pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks.slice(-26)} onSelectDay={openJournal} />
              </div>
              {/* 52 weeks on large screens */}
              <div className="hidden min-[1140px]:block pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks} onSelectDay={openJournal} />
              </div>
            </>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">

          {/* ── Mobile: journal + settings + Edit. The heatmap is hidden at
              this width, so the journal gets its own button rather than
              hiding inside settings. ── */}
          <div className="flex items-center gap-2 sm:hidden">
            <button
              onClick={() => openJournal(null)}
              className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
              aria-label={t('app.journal')}
            >
              <NotebookText size={15} />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className={`p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors ${syncWarn ? 'text-amber-400' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'}`}
              aria-label={t('app.settings')}
            >
              <Settings size={15} />
            </button>
            {/* Icon-only, the same size as its neighbours. With a label the
                controls ran into the logo: below 375px in English, and on
                every phone in languages with a long word for it ("Bearbeiten",
                "Редагувати"). */}
            <button
              onClick={() => setEditMode(e => !e)}
              className={`p-2 rounded-lg transition-colors border ${editMode ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60' : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
              aria-label={editMode ? t('app.doneEditing') : t('app.editCategoriesChores')}
            >
              {editMode ? <Check size={15} /> : <Pencil size={15} />}
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
                    data-tooltip={t('app.soonTooltip')}
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
            {/* Row 2: sync (doubles as the status light), journal, help,
                settings. Every control here is icon-only, so each carries a
                tooltip. Set-once panels (integration, users, backup, theme,
                language, time format) live in the settings panel. */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSyncSettings(true)}
                className={`p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors ${syncWarn ? 'text-amber-400 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'}`}
                aria-label={t('app.cloudSync')}
                data-tooltip={t('app.cloudSync')}
              >
                {syncIcon}
              </button>
              <button onClick={() => openJournal(null)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label={t('app.journal')} data-tooltip={t('app.journalTooltip')}><NotebookText size={15} /></button>
              <button onClick={() => setShowHelp(true)} className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors" aria-label={t('app.helpFeedback')} data-tooltip={t('app.helpFeedback')}><HelpCircle size={15} /></button>
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
                aria-label={t('app.settings')}
                data-tooltip={t('app.settings')}
              >
                <Settings size={15} />
              </button>
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
          onImported={handleImported}
        />
      )}

      {showIntegration && (
        <IntegrationSettingsModal
          onClose={() => { setShowIntegration(false); backToSettings() }}
          onSaved={() => { refreshConfig(); setShowIntegration(false); backToSettings() }}
        />
      )}

      {showSyncSettings && (
        <SyncSettingsModal
          engine={engineRef.current}
          dbEngine={dbEngineRef.current}
          syncError={syncError}
          syncErrorCode={syncErrorCode}
          vaultSyncError={vaultSyncError}
          vaultSyncErrorCode={vaultSyncErrorCode}
          vaultSkipped={vaultSkipped}
          directAccess={directAccessSync}
          onClose={() => { setShowSyncSettings(false); runSharedUserSync(); backToSettings() }}
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

      {showJournal && (
        <JournalModal
          // Remount when the requested day changes, so tapping a second heatmap
          // cell while the Journal is open re-seeds its range instead of being
          // swallowed by the initial-state-only prop.
          key={journalDate ?? 'default'}
          initialDate={journalDate ?? undefined}
          onChanged={loadHeatmap}
          onClose={() => setShowJournal(false)}
        />
      )}

      {showShortcuts && (
        <ShortcutsModal onClose={() => { setShowShortcuts(false); backToSettings() }} />
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
            // The folder's envelope, if that is what asked: read it now with the passphrase.
            void runDirectAccessSync()
          }}
          onClose={() => setShowPassphrase(false)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          initialSection={settingsReturn ?? undefined}
          onClose={() => { setShowSettings(false); setSettingsReturn(null); usersCtx.reload() }}
          themePref={themePref}
          onThemeChange={setThemePref}
          timeFormat={timeFormat}
          onTimeFormatChange={changeTimeFormat}
          syncIcon={syncIcon}
          syncWarn={syncWarn}
          onOpenSync={fromSettings('sync', () => setShowSyncSettings(true))}
          onOpenIntegration={fromSettings('integrations', () => setShowIntegration(true))}
          onOpenShortcuts={fromSettings('about', () => setShowShortcuts(true))}
          engine={engineRef.current}
          billing={billing}
          onUserMutated={() => { void runSharedUserSync(); usersCtx.reload() }}
          onImported={handleImported}
        />
      )}

      {/* Reviewer-mode banner — shown while unlocked via the store-review
          bypass code (never for paying customers). Its exit action is the
          reviewer's way back to the wall to test the IAPs; without it the
          review gets rejected for unlocatable purchases (learned on
          dayGLANCE). Never visible with the gate below: isReviewerUnlocked
          implies isUnlocked. */}
      {billing.isReviewerUnlocked && (
        <ReviewerBanner onExit={exitReviewerMode} />
      )}

      <TooltipHost />

      {/* Hard paywall — last in the tree and z-[80], above every other surface.
          Only ever true on the Play channel; the engine's provisional unlock
          keeps previously-entitled installs from ever flashing this. */}
      {billing.gated && !billing.isUnlocked && (
        <PaywallModal billing={billing} />
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
