// How long a chore takes, in whole minutes: the dayGLANCE task length when the
// chore is sent at a set time. One rule for the form, the MCP tools and sync.

/** A day: dayGLANCE's longest block. */
export const DURATION_MAX_MINUTES = 1440

export function isDurationMinutes(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= DURATION_MAX_MINUTES
}
