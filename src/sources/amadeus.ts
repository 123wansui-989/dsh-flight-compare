/**
 * Amadeus source: the official Self-Service Flight Offers Search API.
 *
 * Two calls per search — an OAuth2 client-credentials token, then the offer
 * search. The token is cached until shortly before it expires, so repeated tool
 * calls reuse it.
 *
 * @module dsh-flight-compare/sources/amadeus
 */

import { isoDate } from '../util.js'
import type { Flight, FlightQuery, FlightSource } from './types.js'

/** Amadeus OAuth2 token endpoint (test host). */
const TEST_TOKEN_URL = 'https://test.api.amadeus.com/v1/security/oauth2/token'
/** Amadeus Flight Offers Search endpoint (test host). */
const TEST_SEARCH_URL = 'https://test.api.amadeus.com/v2/shopping/flight-offers'
/** Amadeus OAuth2 token endpoint (production host). */
const PROD_TOKEN_URL = 'https://api.amadeus.com/v1/security/oauth2/token'
/** Amadeus Flight Offers Search endpoint (production host). */
const PROD_SEARCH_URL = 'https://api.amadeus.com/v2/shopping/flight-offers'

/** Refresh the token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000

/** Token response body. */
interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/** Amadeus error envelope, returned with a non-2xx status. */
interface AmadeusErrorEnvelope {
  errors?: { status?: number; code?: number; title?: string; detail?: string }[]
}

/** One endpoint of an itinerary segment. */
interface AmadeusEndpoint {
  iataCode?: string
  terminal?: string
  at?: string
}

/** One leg of an itinerary. */
interface AmadeusSegment {
  departure?: AmadeusEndpoint
  arrival?: AmadeusEndpoint
  carrierCode?: string
  number?: string
  numberOfStops?: number
}

/** One itinerary: an ordered list of segments in one direction. */
interface AmadeusItinerary {
  duration?: string
  segments?: AmadeusSegment[]
}

/** One priced offer. */
interface AmadeusOffer {
  id?: string
  itineraries?: AmadeusItinerary[]
  price?: { currency?: string; total?: string; grandTotal?: string }
  validatingAirlineCodes?: string[]
  lastTicketingDate?: string
}

/** Successful search response. */
interface AmadeusSearchResponse {
  data?: AmadeusOffer[]
}

/** Amadeus credentials and request budget. */
export interface AmadeusOptions {
  /** Self-Service API key (client id). */
  clientId: string
  /** Self-Service API secret (client secret). */
  clientSecret: string
  /** Use `api.amadeus.com` instead of `test.api.amadeus.com`. */
  production: boolean
  /** Upstream request timeout in milliseconds. */
  timeoutMs: number
  /** Upper bound on offers requested per search. */
  maxResults: number
}

/** A cached access token. */
let cachedToken: { credentials: string; value: string; expiresAt: number } | undefined

/**
 * Return a valid access token, reusing the cached one until it is close to expiry.
 *
 * @param options - Amadeus credentials and timeout.
 * @param signal - Caller cancellation signal.
 * @returns A bearer token.
 * @throws Error when Amadeus rejects the credentials.
 */
async function accessToken(options: AmadeusOptions, signal: AbortSignal): Promise<string> {
  const credentials = `${options.clientId}\u0000${options.clientSecret}\u0000${options.production}`
  const now = Date.now()
  if (cachedToken !== undefined && cachedToken.credentials === credentials && cachedToken.expiresAt > now) {
    return cachedToken.value
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: options.clientId,
    client_secret: options.clientSecret,
  })

  const tokenUrl = options.production ? PROD_TOKEN_URL : TEST_TOKEN_URL
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
  })
  const payload = (await response.json()) as TokenResponse

  if (!response.ok || typeof payload.access_token !== 'string') {
    const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
    throw new Error(`authorization failed: ${reason}`)
  }

  const lifetimeMs = typeof payload.expires_in === 'number' ? payload.expires_in * 1000 : 0
  cachedToken = {
    credentials,
    value: payload.access_token,
    expiresAt: now + Math.max(0, lifetimeMs - TOKEN_SKEW_MS),
  }
  return cachedToken.value
}

/** Read a finite number out of an Amadeus string amount, or `undefined`. */
function amount(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Flatten one offer into one row per dated segment.
 *
 * Amadeus prices the whole itinerary, so every segment of the same direction
 * carries the itinerary total; the first segment reports the trip's stop count
 * and `''` as its arrival when the provider omits one.
 *
 * @param offer - One priced offer.
 * @param currency - Currency to fall back on when the offer omits one.
 * @returns One normalized flight per dated segment.
 */
function flightsFromOffer(offer: AmadeusOffer, currency: string): Flight[] {
  const price = amount(offer.price?.grandTotal) ?? amount(offer.price?.total)
  if (price === undefined) return []
  const offerCurrency = offer.price?.currency?.toUpperCase() ?? currency
  const itinerary = offer.itineraries?.[0]
  const segments = itinerary?.segments ?? []

  const flights: Flight[] = []
  segments.forEach((segment, index) => {
    const departureAt = segment.departure?.at ?? ''
    const departDate = isoDate(departureAt)
    const number = segment.number?.trim() ?? ''
    if (departDate.length === 0 || number.length === 0) return

    flights.push({
      source: 'amadeus',
      carrier: segment.carrierCode ?? offer.validatingAirlineCodes?.[0] ?? '',
      flightNumber: number,
      origin: segment.departure?.iataCode ?? '',
      destination: segment.arrival?.iataCode ?? '',
      departDate,
      departureAt,
      // An itinerary's last segment has no meaningful onward arrival time.
      arrivalAt: index === segments.length - 1 ? '' : (segment.arrival?.at ?? ''),
      transfers: index === 0 ? Math.max(0, segments.length - 1) : 0,
      price,
      currency: offerCurrency,
      returnAt: '',
      expiresAt: offer.lastTicketingDate ?? '',
    })
  })
  return flights
}

/** Build the Amadeus source. */
export function createAmadeusSource(options: AmadeusOptions): FlightSource {
  return {
    name: 'amadeus',
    label: 'Amadeus 实时搜索',

    async search(query: FlightQuery): Promise<Flight[]> {
      // This endpoint searches exactly one departure date, so it needs a day.
      if (query.departDate === undefined || query.departDate.length !== 10) return []

      const token = await accessToken(options, query.signal)
      const url = new URL(options.production ? PROD_SEARCH_URL : TEST_SEARCH_URL)
      url.searchParams.set('originLocationCode', query.origin)
      url.searchParams.set('destinationLocationCode', query.destination)
      url.searchParams.set('departureDate', query.departDate)
      url.searchParams.set('adults', '1')
      url.searchParams.set('currencyCode', query.currency)
      url.searchParams.set('max', String(options.maxResults))

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.amadeus+json',
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.any([query.signal, AbortSignal.timeout(options.timeoutMs)]),
      })

      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as AmadeusErrorEnvelope
        const issue = detail.errors?.[0]
        const reason = issue?.detail ?? issue?.title ?? `${response.status} ${response.statusText}`
        throw new Error(`HTTP ${response.status}: ${reason}`)
      }

      const payload = (await response.json()) as AmadeusSearchResponse
      if (!Array.isArray(payload.data)) return []

      const flights: Flight[] = []
      for (const offer of payload.data) {
        flights.push(...flightsFromOffer(offer, query.currency))
      }
      return flights
    },
  }
}
