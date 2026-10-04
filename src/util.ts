/**
 * Small date and code helpers shared by the tool, the comparison model, and the
 * data sources. This module imports nothing.
 *
 * @module dsh-flight-compare/util
 */

/** Normalize a user-supplied IATA code: trim and upper-case. */
export function normalizeCode(value: string): string {
  return value.trim().toUpperCase()
}

/** ISO timestamp -> `YYYY-MM-DD`, or an empty string when unusable. */
export function isoDate(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return match?.[0] ?? ''
}

/** ISO timestamp -> `HH:MM`, or an empty string when unusable. */
export function isoTime(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  const match = /T(\d{2}:\d{2})/.exec(value)
  return match?.[1] ?? ''
}

/** `YYYY-MM-01` for a `YYYY-MM`/`YYYY-MM-DD` string, or the string itself. */
export function monthStart(value: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]}-01` : value
}

/** `true` when the value is a `YYYY-MM` or `YYYY-MM-DD` string. */
export function isDateInput(value: string): boolean {
  return /^\d{4}-\d{2}(-\d{2})?$/.test(value)
}

/** Coerce a provider flight number (number or string) to a stable string, or `''`. */
export function flightNumber(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return ''
}
