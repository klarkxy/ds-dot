/**
 * Pure payload validation for the board's task RPCs. Extracted from the RPC
 * dispatch in {@link ../index.ts} so the guards can be tested without standing
 * up the whole plugin. Each function returns `null` when the payload is valid,
 * or an error message string the dispatch returns to the client.
 */

/** `task.review` needs a real boolean `pass`; anything else is rejected before the service is touched. */
export function reviewPayload(payload: unknown): { pass: boolean; note?: string } | string {
  const field = (key: string): unknown => payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined
  const pass = field('pass')
  if (typeof pass !== 'boolean') return 'pass must be a boolean'
  const note = field('note')
  return { pass, ...(typeof note === 'string' ? { note: note.slice(0, 2_000) } : {}) }
}
