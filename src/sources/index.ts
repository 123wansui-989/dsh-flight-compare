/**
 * Source registry: turn plugin configuration into the list of sources to query.
 *
 * Both sources are always registered when their credentials are present; the
 * Amadeus source is skipped when it is not configured, so an existing
 * Travelpayouts-only setup keeps working unchanged.
 *
 * @module dsh-flight-compare/sources
 */

import { createAmadeusSource } from './amadeus.js'
import { createTravelpayoutsSource } from './travelpayouts.js'
import type { FlightSource } from './types.js'

export { createAmadeusSource } from './amadeus.js'
export { createTravelpayoutsSource } from './travelpayouts.js'
export type { Flight, FlightQuery, FlightSource, FlightSourceId } from './types.js'

/** Everything the registry needs, resolved from plugin configuration. */
export interface SourceOptions {
  /** Travelpayouts Data Access API token. */
  travelpayoutsToken: string
  /** Amadeus Self-Service API key; empty disables the Amadeus source. */
  amadeusClientId: string
  /** Amadeus Self-Service API secret; empty disables the Amadeus source. */
  amadeusClientSecret: string
  /** Search Amadeus production instead of its test environment. */
  amadeusProduction: boolean
  /** Upper bound on Amadeus offers requested per search. */
  amadeusMaxResults: number
  /** Upstream request timeout in milliseconds, applied to every source. */
  timeoutMs: number
}

/**
 * Build the sources this configuration enables.
 *
 * @param options - Resolved plugin configuration.
 * @returns The enabled sources, in query order.
 */
export function createSources(options: SourceOptions): FlightSource[] {
  const sources: FlightSource[] = [
    createTravelpayoutsSource({ token: options.travelpayoutsToken, timeoutMs: options.timeoutMs }),
  ]

  if (options.amadeusClientId.length > 0 && options.amadeusClientSecret.length > 0) {
    sources.push(
      createAmadeusSource({
        clientId: options.amadeusClientId,
        clientSecret: options.amadeusClientSecret,
        production: options.amadeusProduction,
        timeoutMs: options.timeoutMs,
        maxResults: options.amadeusMaxResults,
      }),
    )
  }

  return sources
}
