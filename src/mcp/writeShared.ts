import type { McpError } from './readModel'

// What both MCP write models share (writeModel.ts for chores, peopleWriteModel.ts
// for People): the result shapes, the typed refusal, and the small checks the
// forms apply everywhere.

export interface UndoRecord<Op = unknown> { summary: string; op: Op }
export type WriteResult<Op = unknown> =
  | { ok: true; data: Record<string, unknown>; undo?: UndoRecord<Op> }
  | { ok: false; error: McpError }

export interface WriteContext {
  /** The device's Me, who a completion is by, as in the app. */
  meUserSyncId: string | null
  /** Multi-user mode: with it on, only this user's People can be written, as the People screens show them. */
  multiUserEnabled: boolean
  now: () => Date
  /** After a change: what the app's screens and widgets listen for. */
  changed: () => void
  /** A line in the activity log. */
  activity: (message: string) => void
}

export const NAME_MAX = 500

export const ok = <Op>(data: Record<string, unknown>, undo?: UndoRecord<Op>): WriteResult<Op> => ({ ok: true, data, ...(undo && { undo }) })
export const fail = (code: McpError['code'], message: string): WriteResult<never> => ({ ok: false, error: { code, message } })
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
export const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
export const quote = (name: string) => `“${name}”`

export class Refusal extends Error {
  constructor(readonly code: McpError['code'], message: string) { super(message) }
}
export const refuse = (code: McpError['code'], message: string): never => { throw new Refusal(code, message) }

export const bool = (v: unknown, name: string): boolean => (typeof v === 'boolean' ? v : refuse('validation', `${name} must be true or false.`))

export function checkName(name: unknown, what = 'name'): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) refuse('validation', `${what} is required.`)
  if (n.length > NAME_MAX) refuse('validation', `${what} is at most ${NAME_MAX} characters.`)
  return n
}

/** Optional text: trimmed, empty is null, null clears. */
export function checkText(v: unknown, what: string, max: number): string | null {
  if (v === null) return null
  if (typeof v !== 'string') refuse('validation', `${what} must be text, or null to clear it.`)
  const t = (v as string).trim()
  if (t.length > max) refuse('validation', `${what} is at most ${max} characters.`)
  return t || null
}

export function checkPosition(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) refuse('validation', 'position must be a whole number, 0 for first.')
  return v as number
}

/** Move one row to `position` among its siblings (past the end means last). */
export function placed<T extends { id: number }>(rows: T[], id: number, position: number): number[] {
  const rest = rows.map(r => r.id).filter(x => x !== id)
  rest.splice(Math.min(position, rest.length), 0, id)
  return rest
}

/**
 * A UUID-shaped id derived from a seed: the same seed always gives the same id,
 * and sync accepts it (both tiers check ids against the UUID pattern). Main's
 * idFromKey (electron/mcpWriteTools.ts) builds ids the same way.
 */
export async function idFromSeed(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)))
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
