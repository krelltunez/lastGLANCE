import { useEffect } from 'react'
import dayjs from 'dayjs'
import { getAllCompletionCounts, getCategories, getChoresForCategory } from '@/db/queries'
import { getAllPersonDates, getCircles, getPeople, PEOPLE_CHANGED_EVENT } from '@/people/queries'
import { getMeUserSyncId, getMultiUserEnabled } from '@/multiuser/settings'
import { buildLauncherSnapshot, launcherSnapshotFingerprint } from '@/native/launcherSnapshot'
import { pushLauncherSnapshot, touchLauncherHeartbeat } from '@/native/launcherBridge'
import { LAUNCHER_WRITE_HANDLED_EVENT, readLauncherLedger } from '@/intents/launcherWrites'
import { isAndroid } from '@/native/platform'

// The content of the last push, so a rebuild that changes nothing the launcher
// reads is not pushed and the snapshot's stamp only moves on a real change.
let lastFingerprint: string | null = null

// When a sync road last completed, as the app reports it; set by App through
// configureLauncherHeartbeat so this module needs no engine refs.
let syncedAtSource: () => string | null = () => null

// The latest of the roads' last-synced stamps (ISO), or null without one.
export function latestSyncedAt(stamps: (string | null | undefined)[]): string | null {
  const valid = stamps.filter((v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)))
  if (!valid.length) return null
  return new Date(Math.max(...valid.map(v => Date.parse(v)))).toISOString()
}

export function configureLauncherHeartbeat(getSyncedAt: () => string | null): void {
  syncedAtSource = getSyncedAt
}

// The heartbeat rides every build, changed or not: the launcher measures
// staleness from it (docs/launcher-integration.md, "Freshness").
export async function touchHeartbeatNow(): Promise<void> {
  await touchLauncherHeartbeat({ checkedAt: Date.now(), syncedAt: syncedAtSource() })
}

// Loads the data, builds the launcher snapshot and hands it to native when it
// changed, then touches the heartbeat either way. Best-effort, never throws.
export async function pushLauncherSnapshotNow(): Promise<void> {
  try {
    const categories = await getCategories()
    const [choresByCat, people, dates, circles, completionCounts] = await Promise.all([
      Promise.all(categories.map(c => getChoresForCategory(c.id))),
      getPeople(),
      getAllPersonDates(),
      getCircles(),
      getAllCompletionCounts(),
    ])
    const snapshot = buildLauncherSnapshot({
      now: new Date(),
      categories,
      chores: choresByCat.flat(),
      people,
      dates,
      circles,
      multiUserEnabled: getMultiUserEnabled(),
      meId: getMeUserSyncId(),
      handledWrites: readLauncherLedger(),
      completionCounts,
    })
    const fingerprint = launcherSnapshotFingerprint(snapshot)
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint
      await pushLauncherSnapshot(JSON.stringify(snapshot))
    }
    await touchHeartbeatNow()
  } catch {
    // The launcher keeps its last snapshot; the app is unaffected.
  }
}

// Keeps the GLANCElauncher's snapshot fresh (docs/launcher-integration.md) on
// the widget snapshot's triggers (useWidgetSnapshot), plus the day rolling
// over and a launcher write landing. Android only: the launcher is an Android
// home screen. The widget snapshot itself is untouched.
export function useLauncherSnapshot(): void {
  useEffect(() => {
    if (!isAndroid()) return
    void pushLauncherSnapshotNow()

    const onChange = () => { void pushLauncherSnapshotNow() }
    window.addEventListener('lg:chore-logged', onChange)
    window.addEventListener('lg:sync-applied', onChange)
    window.addEventListener(LAUNCHER_WRITE_HANDLED_EVENT, onChange)
    let peopleTimer: ReturnType<typeof setTimeout> | undefined
    const onPeople = () => {
      clearTimeout(peopleTimer)
      peopleTimer = setTimeout(onChange, 500)
    }
    window.addEventListener(PEOPLE_CHANGED_EVENT, onPeople)

    // `today` is part of the snapshot, so a day that rolls over while the app
    // is open gets a push on the next foreground.
    let lastDay = dayjs().format('YYYY-MM-DD')
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { void pushLauncherSnapshotNow(); return }
      const day = dayjs().format('YYYY-MM-DD')
      if (day !== lastDay) { lastDay = day; void pushLauncherSnapshotNow() } else void touchHeartbeatNow()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('lg:chore-logged', onChange)
      window.removeEventListener('lg:sync-applied', onChange)
      window.removeEventListener(LAUNCHER_WRITE_HANDLED_EVENT, onChange)
      window.removeEventListener(PEOPLE_CHANGED_EVENT, onPeople)
      clearTimeout(peopleTimer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
