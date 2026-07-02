// Android / Tasker intents transport — constants.
//
// lastGLANCE can be driven by another Android app (Tasker, MacroDroid, Automate,
// …) via Android intents. This mirrors the dayGLANCE design (see
// docs/tasker-intents-architecture.md) but under the `app.lastglance.*`
// namespace so the two apps never cross-talk when installed together.
//
// The *short* action constants (`create`, `complete`, …) come from the shared
// @glance-apps/intents package and are IDENTICAL across the GLANCE apps, so the
// pure handler and the file transports stay compatible. Only the fully-qualified
// Android action strings and the Tasker return-variable names are app-specific.

import { ACTIONS } from '@glance-apps/intents'

// Fully-qualified Android actions a sender uses. Registered in the manifest both
// as a broadcast <receiver> (works while backgrounded/killed) and as <activity>
// intent-filters (so a sender can foreground the app on a cold start).
export const LG_ANDROID_ACTIONS = {
  CREATE: 'app.lastglance.CREATE',
  COMPLETE: 'app.lastglance.COMPLETE',
  OPEN: 'app.lastglance.OPEN',
  QUERY: 'app.lastglance.QUERY',
} as const

// Outbound broadcasts lastGLANCE fires back to the sender.
export const LG_ANDROID_OUTBOUND = {
  // The outcome of a handled inbound action (also the QUERY reply / liveness ack).
  RESULT: 'app.lastglance.RESULT',
  // Fired when a chore is completed via the COMPLETE action, so automation can react.
  NOTIFY: 'app.lastglance.NOTIFY',
} as const

// THE ACTION-STRING GOTCHA (see architecture doc §5): native stores the
// fully-qualified action (`app.lastglance.COMPLETE`), but handleIntent switches
// on the SHORT constants (`complete`). Map at the bridge; report RESULT back
// under the ORIGINAL action so the sender's %action matches what it sent.
//
// Typed as Record<string, Action> so a missing case is caught at the call site.
export const BROADCAST_ACTION_MAP: Record<string, string> = {
  [LG_ANDROID_ACTIONS.CREATE]: ACTIONS.CREATE,
  [LG_ANDROID_ACTIONS.COMPLETE]: ACTIONS.COMPLETE,
  [LG_ANDROID_ACTIONS.OPEN]: ACTIONS.OPEN,
  [LG_ANDROID_ACTIONS.QUERY]: ACTIONS.QUERY,
}

// QUERY reply variables, Tasker-style `%`-prefixed so they read naturally after
// the receiving profile parses the RESULT JSON. lastGLANCE-specific (`%lg_`),
// distinct from dayGLANCE's `%dg_` set, and named for a chore/cadence app rather
// than a task/due-date app.
export const LG_QUERY_VARS = {
  // Chores that have aged into the amber/red "needs attention" zone (soon+overdue).
  COUNT_DUE: '%lg_count_due',
  // Chores past their cadence (actually overdue).
  COUNT_OVERDUE: '%lg_count_overdue',
  // Completions logged today (local calendar day).
  COUNT_DONE_TODAY: '%lg_count_done_today',
  // Total chores across all categories.
  COUNT_TOTAL: '%lg_count_total',
} as const
