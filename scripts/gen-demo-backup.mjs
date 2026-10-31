#!/usr/bin/env node
// Re-date public/demo-backup.json so the demo board looks like someone's live
// data rather than an archive.
//
//   npm run demo-backup
//
// The fixture is a hand-made export served from public/, imported through
// Settings > Backup & Restore. Nothing in the app reads it; it exists so a link
// can be handed to someone who wants to see lastGLANCE populated. That is
// exactly why it rotted unnoticed: by October 2026 its newest completion was
// 158 days old, so importing it showed every chore months overdue.
//
// IT DOES NOT INVENT COMPLETIONS. Every event in the file is kept, with its
// note, its source and its sync_id. What moves is the vantage point: each
// chore's history slides so that "today" falls somewhere sensible along its own
// cadence. Within a chore, every interval between completions is preserved
// exactly, so its rhythm, its gaps and its stats are whatever they already
// were.
//
// WHY PER CHORE RATHER THAN ONE SHIFT FOR THE FILE. A single delta was the
// first attempt and it is not enough. The fixture's history stops seven to
// fourteen days before its own export date, so even with its newest completion
// pinned to this morning, 52% of the board came up overdue — it was a red board
// on the day it was made, and a uniform shift faithfully reproduces that. The
// only thing a uniform shift can choose is which day of the year to call today,
// and the newest completion is already the best of those.
//
// Sliding each chore separately costs the one thing a uniform shift preserves:
// chores no longer share completion days. Nothing in the app surfaces that. The
// heatmap counts completions per day in aggregate, and every per-chore view
// shows that chore's own intervals, which are untouched.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = resolve(root, 'public/demo-backup.json')
const DAY = 86400000

// Where each chore sits along its own cadence, as elapsed/target. Walked in
// order and cycled, so the result is identical on every run and the mix is
// something you can read off the page rather than a property of the data.
//
// Roughly two thirds green, a quarter amber, a few red: enough overdue to show
// what the app is for, not so much that it reads as neglect. Tune here.
const RATIOS = [
  0.15, 0.35, 0.55, 0.25, 0.75, 0.45, 1.25, 0.10,
  0.60, 0.85, 0.30, 1.55, 0.20, 0.50, 0.40, 0.95,
  0.65, 0.05, 1.15, 0.70,
]

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const iso = (ms) => new Date(ms).toISOString()

const backup = JSON.parse(readFileSync(FILE, 'utf8'))
const events = backup.completionEvents ?? []
if (events.length === 0) throw new Error('demo-backup.json has no completionEvents')

// Events link by numeric chore_id in this file (a version 1 export) or by
// chore_sync_id in a newer one. Group by whichever is present.
const keyOf = (e) => (e.chore_sync_id !== undefined ? e.chore_sync_id : e.chore_id)
const choreKey = (c) => (events.some((e) => e.chore_sync_id !== undefined) ? c.sync_id : c.id)

const byChore = new Map()
for (const e of events) {
  const k = keyOf(e)
  const list = byChore.get(k) ?? []
  list.push(e)
  byChore.set(k, list)
}

const now = Date.now()
let moved = 0

backup.chores.forEach((chore, i) => {
  const list = byChore.get(choreKey(chore))
  if (!list || list.length === 0) return

  const last = Math.max(...list.map((e) => Date.parse(e.completed_at)))
  const cadence = chore.target_cadence_days

  // No cadence means no overdue state to aim at, so such a chore just lands
  // recently rather than at a ratio.
  const target = cadence
    ? now - RATIOS[i % RATIOS.length] * cadence * DAY
    : now - (2 + (i % 5)) * DAY

  const delta = target - last
  for (const e of list) e.completed_at = iso(Date.parse(e.completed_at) + delta)
  moved++
})

// Entity stamps follow the history rather than being shifted blind: a chore
// created after its own first completion is the kind of detail that makes a
// demo look broken. Categories take the earliest completion in the file.
const oldestOverall = Math.min(...events.map((e) => Date.parse(e.completed_at)))
for (const chore of backup.chores) {
  const list = byChore.get(choreKey(chore)) ?? []
  const oldest = list.length ? Math.min(...list.map((e) => Date.parse(e.completed_at))) : oldestOverall
  chore.created_at = iso(oldest - 30 * DAY)
  if (chore.updated_at !== undefined) chore.updated_at = chore.created_at
}
for (const category of backup.categories) {
  if (category.updated_at !== undefined) category.updated_at = iso(oldestOverall - 30 * DAY)
}
backup.exportedAt = iso(now)

// Nothing may land in the future: a device west of this machine would show a
// chore completed tomorrow, which reads as a bug rather than a demo.
const future = events.filter((e) => Date.parse(e.completed_at) > now)
if (future.length > 0) throw new Error(`${future.length} completions landed in the future`)

// Same formatting the file already had, so the diff is values only.
writeFileSync(FILE, JSON.stringify(backup, null, 2))

const state = { fresh: 0, soon: 0, overdue: 0 }
for (const chore of backup.chores) {
  const list = byChore.get(choreKey(chore)) ?? []
  if (!list.length || !chore.target_cadence_days) continue
  const days = (now - Math.max(...list.map((e) => Date.parse(e.completed_at)))) / DAY
  const ratio = days / chore.target_cadence_days
  state[ratio >= 1 ? 'overdue' : ratio >= 0.7 ? 'soon' : 'fresh']++
}
console.log(`demo-backup.json: repositioned ${events.length} completions across ${moved} chores`)
console.log(`  board now reads ${state.fresh} fresh, ${state.soon} soon, ${state.overdue} overdue`)
console.log(`  history spans ${Math.round((now - oldestOverall) / DAY)} days`)
