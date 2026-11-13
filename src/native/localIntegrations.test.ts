import { describe, expect, it } from 'vitest'
import {
  assistantLabelKey, claudeCodeCommand, claudeSetupMessage, consentsForTier, offersClaudeDesktopSetup, statusErrorKey, LOCAL_INTEGRATIONS_UI, maskToken, parsePortInput, tierAction, transitionErrorKey, writesAction,
} from './localIntegrations'

describe('the local integrations panel', () => {
  it('is mounted (phase 7)', () => {
    expect(LOCAL_INTEGRATIONS_UI).toBe(true)
  })

  it('words the assistant indicator, and shows nothing when it is off', () => {
    expect(assistantLabelKey('on')).toBe('localIntegrations.assistantOn')
    expect(assistantLabelKey('undo')).toBe('localIntegrations.assistantUndo')
    expect(assistantLabelKey('paused')).toBe('localIntegrations.assistantPaused')
    expect(assistantLabelKey('off')).toBeNull()
    expect(assistantLabelKey(undefined)).toBeNull()
  })

  it('asks for the consents a tier change needs, and only those', () => {
    expect(consentsForTier('off', 'chores')).toEqual(['base'])
    expect(consentsForTier('off', 'chores_people')).toEqual(['base', 'people'])
    expect(consentsForTier('chores', 'chores_people')).toEqual(['people'])
    expect(consentsForTier('chores_people', 'chores')).toEqual([])
    expect(consentsForTier('chores', 'off')).toEqual([])
    expect(consentsForTier('chores', 'chores')).toEqual([])
  })

  it('sends a consent flag only for a consent the person accepted', () => {
    expect(tierAction('chores', [])).toEqual({ type: 'set-mcp-read-tier', tier: 'chores' })
    expect(tierAction('chores_people', ['base', 'people'])).toEqual({
      type: 'set-mcp-read-tier', tier: 'chores_people', consentConfirmed: true, peopleConsentConfirmed: true,
    })
    expect(writesAction(true, [])).toEqual({ type: 'set-mcp-writes', enabled: true })
    expect(writesAction(true, ['writes'])).toEqual({ type: 'set-mcp-writes', enabled: true, writesConsentConfirmed: true })
    expect(writesAction(false, ['writes'])).toEqual({ type: 'set-mcp-writes', enabled: false })
  })

  it('reads the port field', () => {
    expect(parsePortInput('')).toEqual({ ok: true, port: null })
    expect(parsePortInput(' 8123 ')).toEqual({ ok: true, port: 8123 })
    for (const bad of ['0', '65536', '81.5', '-1', 'abc', '123456']) expect(parsePortInput(bad), bad).toEqual({ ok: false })
  })

  it('masks the token and builds the Claude Code line', () => {
    expect(maskToken('0123456789abcdef')).toBe('0123••••••••cdef')
    expect(maskToken('abc')).toBe('•••')
    expect(claudeCodeCommand('http://127.0.0.1:7900/mcp', 'tok'))
      .toBe('claude mcp add --transport http lastglance http://127.0.0.1:7900/mcp --header "Authorization: Bearer tok"')
  })

  it('names a message for every refusal', () => {
    expect(transitionErrorKey('invalid_port')).toBe('localIntegrations.errorInvalidPort')
    expect(transitionErrorKey('port_reserved')).toBe('localIntegrations.errorPortReserved')
    expect(transitionErrorKey('consent_required')).toBe('localIntegrations.errorGeneric')
    expect(statusErrorKey('port_in_use')).toBe('localIntegrations.errorPortInUse')
    expect(statusErrorKey('permission_denied')).toBe('localIntegrations.errorPortDenied')
    expect(statusErrorKey('bind_failed')).toBe('localIntegrations.errorBindFailed')
  })

  it('offers the Claude Desktop setup on direct builds for macOS and Windows only', () => {
    expect(offersClaudeDesktopSetup('darwin', false)).toBe(true)
    expect(offersClaudeDesktopSetup('win32', false)).toBe(true)
    expect(offersClaudeDesktopSetup('linux', false)).toBe(false)
    expect(offersClaudeDesktopSetup('darwin', true)).toBe(false)
  })

  it('says what the setup did, and hands over the snippet when it could not write', () => {
    expect(claudeSetupMessage({ ok: true, action: 'created', path: '/c', backupPath: null })).toEqual({ key: 'localIntegrations.claudeDesktopDone', manual: null, error: false })
    expect(claudeSetupMessage({ ok: true, action: 'merged', path: '/c', backupPath: '/c.bak' }).key).toBe('localIntegrations.claudeDesktopDoneBackup')
    expect(claudeSetupMessage({ ok: false, reason: 'unparseable', path: '/c', manualEntry: '{}' })).toEqual({ key: 'localIntegrations.claudeDesktopManual', manual: '{}', error: true })
    expect(claudeSetupMessage({ ok: false, reason: 'bridge_missing', path: '/c' }).key).toBe('localIntegrations.claudeDesktopBridgeMissing')
  })
})
