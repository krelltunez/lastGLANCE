// React lifecycle wrapper for the GLANCEvault SSE push client.
//
// Opens the authenticated /events stream when the vault is enabled AND the app
// is visible, turns nudges into instant drains of the EXISTING sync/intents
// drains (debounced, seq-deduped), reconnects with jittered backoff on any
// drop, reconciles via the server's `ready` frame on every (re)connect, and
// tears the connection down cleanly on background / unmount. The pure transport
// lives in @/sync/vaultEventStream; this file only wires it to React + the app.
//
// CORE INVARIANT: purely ADDITIVE. It never starts, stops, or slows the
// existing poll cadences (the 5-minute sync interval + focus in App.tsx, and
// the intents poller's interval + focus). Those keep running as the correctness
// backstop, so a missed nudge or an SSE-down window is always caught by the
// next poll. If SSE is unavailable (native shell, old server, buffering proxy)
// or throws, the app degrades to exactly today's polling behavior.
//
// Keyed on mount only: a vault enable/disable/edit reloads the app (see
// SyncSettingsModal's save path), so the isVaultEnabled() read at mount stays
// current — the same lifecycle contract the DB engine construction relies on.

import { useEffect, useRef } from 'react'
import { getVaultConfig, isVaultEnabled } from '@/sync/vaultConfig'
import { vaultSseBridge } from '@/native/vaultSse'
import {
  createBridgeSseClient,
  createNudgeCoalescer,
  createVaultEventClient,
  detectSseTransport,
  openWebSseStream,
  type SseClientState,
  type VaultSseConnection,
} from '@/sync/vaultEventStream'

interface VaultSseDiag {
  state: SseClientState | 'idle'
  transport: string
  connects: number
  events: number
  drains: number
  lastEventSeq: number | null
  lastError: string | null
  stalled: boolean
  // A terminal code from the native reader ('auth' | 'insecure' |
  // 'unsupported'): native stopped and will NOT reconnect. Fixing the config
  // reloads the app, which starts a fresh reader.
  terminal: string | null
  lastConnectedAt: string | null
}

export function useVaultEventStream({ drainSync, drainIntents }: {
  drainSync: () => void
  drainIntents: () => void
}): void {
  // Keep the drain callbacks fresh without re-running the effect (which would
  // tear down and re-open the connection on every render).
  const drainSyncRef = useRef(drainSync)
  drainSyncRef.current = drainSync
  const drainIntentsRef = useRef(drainIntents)
  drainIntentsRef.current = drainIntents

  useEffect(() => {
    if (!isVaultEnabled()) return undefined

    const transport = detectSseTransport()
    if (transport !== 'web' && transport !== 'native-bridge') {
      // 'native-unsupported' (a shell without the VaultSse plugin) / 'none'
      // (SSR): nothing to open, nothing to clean up — polling backstop only.
      if (import.meta.env?.DEV) {
        console.info('[vault-sse] streaming unavailable on', transport, '— polling backstop only')
      }
      return undefined
    }

    // Observability: a live, inspectable snapshot so SSE health can be checked
    // in a packaged build with no devtools — run `window.__glanceVaultSse` in
    // the console (same incantation as dayGLANCE, deliberately). Counters make
    // a reconnect storm (many connects, few events) immediately obvious;
    // `stalled: true` is the buffering-reverse-proxy signature (stream opened,
    // no `ready` frame arrived). Per-transition console lines are gated behind
    // the `lastglance-debug-push` localStorage flag; genuine errors and the
    // stalled diagnostic still log unconditionally.
    const diag: VaultSseDiag = {
      state: 'idle', transport, connects: 0, events: 0, drains: 0,
      lastEventSeq: null, lastError: null, stalled: false, terminal: null,
      lastConnectedAt: null,
    }
    ;(window as unknown as Record<string, unknown>).__glanceVaultSse = diag

    const sseDebug = () => {
      try { return localStorage.getItem('lastglance-debug-push') === '1' } catch { return false }
    }

    const coalescer = createNudgeCoalescer({
      onDrain: (kind) => {
        diag.drains += 1
        if (sseDebug()) console.info('[vault-sse] drain →', kind)
        if (kind === 'sync') drainSyncRef.current()
        else drainIntentsRef.current()
      },
      onDrainError: (msg, err) => console.warn('[vault-sse]', msg, err instanceof Error ? err.message : err),
    })

    const onStateChange = (state: SseClientState, detail?: unknown) => {
      diag.state = state
      if (state === 'connecting') diag.connects += 1
      if (state === 'open') { diag.lastConnectedAt = new Date().toISOString(); diag.stalled = false }
      if (state === 'stalled') {
        // A healthy path delivers `ready` immediately; an open-but-silent
        // stream almost certainly means a buffering reverse proxy. Polling
        // masks this completely, so say it out loud once per occurrence.
        diag.stalled = true
        console.warn('[vault-sse] stream opened but no frame arrived — a reverse proxy is likely buffering /events; SSE is inert and polling is covering')
      } else if (state === 'error') {
        const coded = detail as { message?: string; code?: string } | null
        diag.lastError = detail instanceof Error ? detail.message
          : coded?.message ?? String(detail ?? 'error')
        // A coded error from the native reader is TERMINAL: native stopped and
        // will not reconnect ('auth' / 'insecure' / 'unsupported'). It surfaces
        // exactly once — warn loudly; fixing the config reloads the app, which
        // starts a fresh reader. Polling covers meanwhile.
        if (coded && typeof coded === 'object' && coded.code) {
          diag.terminal = coded.code
          console.warn(`[vault-sse] terminal error (${coded.code}) — native reader stopped, not reconnecting:`, diag.lastError)
        } else {
          console.warn('[vault-sse] error:', diag.lastError)
        }
      } else if (state === 'unsupported-server') {
        console.warn('[vault-sse] this GLANCEvault server predates /events — push disabled, polling covers')
      } else if (sseDebug()) {
        console.info('[vault-sse]', state, `(connects=${diag.connects} events=${diag.events} drains=${diag.drains})`)
      }
    }

    const getConnection = (): VaultSseConnection | null => {
      const c = getVaultConfig()
      return c && c.vaultUrl && c.vaultToken && c.accountId
        ? { vaultUrl: c.vaultUrl, vaultToken: c.vaultToken, accountId: c.accountId }
        : null
    }

    const onEvent = (evt: unknown) => {
      diag.events += 1
      const seq = (evt as { seq?: number } | null)?.seq
      if (typeof seq === 'number') diag.lastEventSeq = seq
      coalescer.handleEvent(evt)
    }

    // ── NATIVE-BRIDGE: the shell owns the socket + reconnect + fg/bg ─────────
    if (transport === 'native-bridge') {
      // The phones' VaultSse plugin, or the desktop's main process.
      const bridge = vaultSseBridge()
      if (!bridge) return undefined
      const client = createBridgeSseClient({
        getConnection,
        // JS → native: hand over the connection and say "SSE desired on". The
        // shell connects only while the Activity is foreground and reconnects
        // with backoff — all invisible here.
        startNative: (c) => {
          bridge.start({ vaultUrl: c.vaultUrl, vaultToken: c.vaultToken, accountId: c.accountId })
            .catch(err => onStateChange('error', err instanceof Error ? err.message : String(err)))
        },
        stopNative: () => { bridge.stop().catch(() => { /* teardown is best-effort */ }) },
        onEvent,
        onStateChange,
      })
      // Native → JS: every reader message arrives through the bridge.
      const unlisten = bridge.listen(client.receive)
      // No visibilitychange wiring here: the native shell owns
      // foreground/background (Activity lifecycle) and reconnect. The renderer
      // only declares intent and hands over the connection.
      client.start()

      return () => {
        client.stop()
        unlisten()
        coalescer.cancel()
      }
    }

    // ── WEB: JS owns the fetch stream + reconnect/backoff ────────────────────
    const client = createVaultEventClient({
      getConnection,
      openStream: openWebSseStream,
      onEvent,
      onStateChange,
    })

    // Drop SSE on background, reopen on foreground. The (re)connect delivers a
    // fresh `ready` seq that reconciles anything missed while hidden; the
    // focus-triggered polls cover the gap regardless.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') client.start()
      else client.stop()
    }
    document.addEventListener('visibilitychange', onVisibility)

    if (document.visibilityState !== 'hidden') client.start()

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      client.stop()
      coalescer.cancel()
    }
    // Mount-once by design; see the header note on the reload contract.
  }, [])
}
