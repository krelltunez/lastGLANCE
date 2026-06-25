import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { syncErrorText } from './syncErrorText'

// Minimal fake translator: returns a value from `dict` when the key exists,
// otherwise the provided defaultValue — mirroring i18next's { defaultValue }
// behavior, which is all syncErrorText relies on.
function makeT(dict: Record<string, string>): TFunction {
  const t = (key: string, opts?: { defaultValue?: string }) =>
    key in dict ? dict[key] : (opts?.defaultValue ?? key)
  return t as unknown as TFunction
}

describe('syncErrorText', () => {
  const t = makeT({
    'sync.errors.KEY_MISMATCH': 'Wrong sync passphrase.',
    'sync.errors.NETWORK_ERROR': 'Could not reach the sync server.',
  })

  it('localizes a mapped code, ignoring the raw English message', () => {
    expect(syncErrorText(t, 'aes-gcm decrypt failed', 'KEY_MISMATCH')).toBe('Wrong sync passphrase.')
  })

  it('falls back to the raw message for an unmapped/unknown code', () => {
    // VERIFIER_UNSUPPORTED has no entry in this dict -> defaultValue (the message).
    expect(syncErrorText(t, 'server too old', 'VERIFIER_UNSUPPORTED')).toBe('server too old')
  })

  it('returns the raw message when there is no code', () => {
    expect(syncErrorText(t, 'some raw error', null)).toBe('some raw error')
    expect(syncErrorText(t, 'some raw error', undefined)).toBe('some raw error')
  })

  it('returns null for a null message (the engine clear-error signal)', () => {
    expect(syncErrorText(t, null, 'KEY_MISMATCH')).toBeNull()
    expect(syncErrorText(t, null, null)).toBeNull()
  })
})
