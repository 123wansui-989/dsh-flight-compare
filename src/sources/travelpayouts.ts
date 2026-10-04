/**
 * Travelpayouts source: the cached Flight Data Access month matrix.
 *
 * @module dsh-flight-compare/sources/travelpayouts
 */

import { flightNumber, isoDate } from '../util.js'
import type { Flight, FlightQuery, FlightSource } from './types.js'

/** Travelpayouts month-matrix endpoint. */
const API_BASE = 'https://api.travelpayouts.com/v2/prices/month-matrix'

/** One offer exactly as the Travelpayouts month-matrix endpoint returns it. */
interface TravelpayoutsOffer {
  origin?: string
  destination?: string
  price?: number
  transfers?: number
  airline?: string
  flight_number?: number | string
  departure_at?: string
  return_at?: string
  expires_at?: string
  found_at?: string
}

/** Envelope shared by every Travelpayouts Data API response. */
interface TravelpayoutsEnvelope {
  success?: boolean
  data?: TravelpayoutsOffer[] | null
  error?: string | null
  currency?: string
}

/** Travelpayouts credentials and request budget. */
export interface TravelpayoutsOptions {
  /** Data Access API token, sent as `X-Access-Token`. */
  token: string
  /** Upstream request timeout in milliseconds. */
  timeoutMs: number
}

/** Build the Travelpayouts source. */
export function createTravelpayoutsSource(options: TravelpayoutsOptions): FlightSource {
  return {
    name: 'travelpayouts',
    label: 'Travelpayouts 缓存价格',

    async search(query: FlightQuery): Promise<Flight[]> {
      const url = new URL(API_BASE)
      url.searchParams.set('origin', query.origin)
      url.searchParams.set('destination', query.destination)
      url.searchParams.set('month', query.month)
      url.searchParams.set('currency', query.currency)
      url.searchParams.set('show_to_affiliates', 'true')

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-access-token': options.token,
        },
        signal: AbortSignal.any([query.signal, AbortSignal.timeout(options.timeoutMs)]),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const payload = (await response.json()) as TravelpayoutsEnvelope
      if (payload.success === false || payload.error) {
        throw new Error(payload.error ?? 'unknown error')
      }
      if (!Array.isArray(payload.data)) return []

      const fallbackCurrency = payload.currency?.toUpperCase() ?? query.currency
      const flights: Flight[] = []
      for (const offer of payload.data) {
        if (typeof offer.price !== 'number' || !Number.isFinite(offer.price)) continue
        const number = flightNumber(offer.flight_number)
        const date = isoDate(offer.departure_at)
        if (number.length === 0 || date.length === 0) continue
        flights.push({
          source: 'travelpayouts',
          carrier: offer.airline ?? '',
          flightNumber: number,
          origin: offer.origin ?? query.origin,
          destination: offer.destination ?? query.destination,
          departDate: date,
          departureAt: offer.departure_at ?? '',
          arrivalAt: '',
          transfers: typeof offer.transfers === 'number' ? offer.transfers : 0,
          price: offer.price,
          currency: fallbackCurrency,
          returnAt: offer.return_at ?? '',
          expiresAt: offer.expires_at ?? '',
        })
      }
      return flights
    },
  }
}
