import type { SyncErrorCode } from '@glance-apps/sync'
import type { TFunction } from 'i18next'

// Localizes a cloud-sync error using the typed error CODE the sync engine already
// emits alongside its English message. The @glance-apps/sync onError callback —
// on BOTH the file tier (WebDAV) and the DB tier (GLANCEvault) — passes
// (message, code, ...); historically the client either discarded the code and
// showed the raw English `message`, or ran a small hardcoded code->English map.
// This helper replaces both: it looks up `sync.errors.<CODE>` and falls back to
// the engine's own message when there is no translation (or no code).
//
// Takes the CALLER's own `t` (rather than a module-global) so the text reflects
// the language active at RENDER time — call it from the component that displays
// the error, not at the moment the error is captured into state.
//
// Contract:
//   - message null  -> null. A null message is the engine's "clear the error"
//                      signal, not text to localize.
//   - code present  -> t(`sync.errors.<code>`, { defaultValue: message }); an
//                      unmapped/unknown code therefore renders the raw message.
//   - code absent   -> the raw message (nothing to key on).
//
// KNOWN EXCEPTION — Test Connection stays English: engine.test()/testConnection()
// resolves to { success, error } with NO code, so that result can't be keyed and
// is intentionally left rendering its raw `error` string.
export function syncErrorText(
  t: TFunction,
  message: string | null,
  code: SyncErrorCode | null | undefined,
): string | null {
  if (!message) return null
  if (code) return t(`sync.errors.${code}`, { defaultValue: message })
  return message
}
