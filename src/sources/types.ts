/**
 * The data-source seam: one interface every flight price source implements, and
 * the per-row `Flight` object they all normalize to.
 *
 * Adding a source means adding one module that exports a {@link FlightSource}
 * and registering it in `sources/index.ts`; the comparison logic never learns
 * where a price came from.
 *
 * @module dsh-flight-compare/sources/types
 */

/** Where one offer came from. */
export type FlightSourceId = 'travelpayouts' | 'amadeus'

/** One normalized offer: what a single source knows about a single itinerary. */
export interface Flight {
  /** Provider that returned this offer. */
  source: FlightSourceId
  /** Marketing carrier IATA code, for example `SU`. */
  carrier: string
  /** Flight number as the carrier assigned it, for example `571`. */
  flightNumber: string
  /** Departure airport or city IATA code. */
  origin: string
  /** Arrival airport or city IATA code. */
  destination: string
  /** Local departure date, `YYYY-MM-DD`. */
  departDate: string
  /** Departure timestamp as the provider reported it. */
  departureAt: string
  /** Arrival timestamp as the provider reported it, `''` when the provider omits it. */
  arrivalAt: string
  /** Number of stops, `0` for a non-stop itinerary. */
  transfers: number
  /** Total price for one adult in {@link currency}. */
  price: number
  /** ISO 4217 currency code of {@link price}. */
  currency: string
  /** Round-trip return timestamp, `''` for a one-way offer. */
  returnAt: string
  /** When the provider considers this price stale, `''` when unknown. */
  expiresAt: string
}

/** One source's request for offers on a route. */
export interface FlightQuery {
  /** Origin IATA code, already normalized and validated. */
  origin: string
  /** Destination IATA code, already normalized and validated. */
  destination: string
  /** Requested departure filter: `YYYY-MM` for a month or `YYYY-MM-DD` for a day. */
  departDate?: string
  /** Anchors a whole-month request when `departDate` is a month or absent. */
  month: string
  /** Currency the caller wants prices in. */
  currency: string
  /** Cooperative cancellation, forwarded to every upstream request. */
  signal: AbortSignal
}

/** A pluggable flight price source. */
export interface FlightSource {
  /** Stable id, also used as the `source` of every flight it returns. */
  name: FlightSourceId
  /** Human-readable label for the Markdown summary. */
  label: string
  /**
   * Fetch this source's offers for one route.
   *
   * @param query - Normalized route, date filter, currency, and cancellation signal.
   * @returns Normalized offers; an empty array when the source has no cached data.
   * @throws Error when the source is unreachable, misconfigured, or rejects the request.
   */
  search(query: FlightQuery): Promise<Flight[]>
}
