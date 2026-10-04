/**
 * `flight_compare` — compare cached flight prices for one route from Travelpayouts.
 *
 * The only data source is the Travelpayouts Flight Data Access API
 * (`GET /v2/prices/month-matrix`). The API token is read from the plugin
 * configuration, which `cordis.patch.yml` fills from the
 * `TRAVELPAYOUTS_TOKEN` environment variable — it is never hardcoded.
 *
 * Offers are aggregated by flight number + departure date: every offer in a
 * group collapses into the lowest price for that flight on that day. The
 * resulting rows are sorted by price ascending and rendered as a Markdown table.
 *
 * `apply` returns the disposer from `ctx.tools.register`, which Cordis runs when
 * the plugin's fiber disposes.
 *
 * @module dsh-flight-compare
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  OUTPUT_SCHEMA,
  aggregate,
  isDateInput,
  monthStart,
  normalizeCode,
  renderMarkdown,
} from './flight.js'
import type { FlightCompareValue, TravelpayoutsEnvelope, TravelpayoutsOffer } from './flight.js'

/** Plugin name used by Cordis (exported so the patch and the manifest agree). */
export const name = 'dsh-flight-compare'

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools']

/** Plugin configuration, validated by Cordis when the row activates. */
export const Config = Schema.object({
  /** Travelpayouts API token. Required; supply it through the environment. */
  token: Schema.string().required().description('Travelpayouts API token (X-Access-Token).'),
  /** Currency of the returned prices. The API defaults to RUB. */
  currency: Schema.string().default('RUB').description('ISO currency code for prices, for example RUB or USD.'),
  /** Upper bound on rows in the rendered table. */
  maxRows: Schema.natural().default(30).description('Maximum number of aggregated rows to return.'),
  /** Upstream request timeout in milliseconds. */
  timeoutMs: Schema.natural().default(20000).description('Travelpayouts request timeout in milliseconds.'),
})

/** Resolved configuration passed to `apply`. */
export interface FlightCompareConfig {
  /** Travelpayouts API token sent as `X-Access-Token`. */
  token: string
  /** Currency of the returned prices. */
  currency: string
  /** Upper bound on rows in the rendered table. */
  maxRows: number
  /** Upstream request timeout in milliseconds. */
  timeoutMs: number
}

/** Travelpayouts month-matrix endpoint — the plugin's only data source. */
const API_BASE = 'https://api.travelpayouts.com/v2/prices/month-matrix'

/**
 * Fetch the cached month matrix for one route.
 *
 * @param origin - IATA code of the departure city.
 * @param destination - IATA code of the destination city.
 * @param month - First day of the requested month (`YYYY-MM-DD`).
 * @param config - Resolved plugin configuration.
 * @param signal - Caller cancellation signal, forwarded to the request.
 * @returns The offers the provider returned for that month.
 * @throws Error when the provider answers with a non-2xx status or an error envelope.
 */
async function fetchMonthMatrix(
  origin: string,
  destination: string,
  month: string,
  config: FlightCompareConfig,
  signal: AbortSignal,
): Promise<TravelpayoutsOffer[]> {
  const url = new URL(API_BASE)
  url.searchParams.set('origin', origin)
  url.searchParams.set('destination', destination)
  url.searchParams.set('month', month)
  url.searchParams.set('currency', config.currency)
  url.searchParams.set('show_to_affiliates', 'true')

  const timeout = AbortSignal.timeout(config.timeoutMs)
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-access-token': config.token,
    },
    signal: AbortSignal.any([signal, timeout]),
  })

  if (!response.ok) {
    throw new Error(`Travelpayouts request failed with HTTP ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as TravelpayoutsEnvelope
  if (payload.success === false || payload.error) {
    throw new Error(`Travelpayouts rejected the request: ${payload.error ?? 'unknown error'}`)
  }
  if (!Array.isArray(payload.data)) return []
  return payload.data
}

/**
 * Register `flight_compare` on the Cordis context.
 *
 * @param ctx - Cordis context providing the `tools` service.
 * @param config - Resolved plugin configuration.
 * @returns The disposer that unregisters the tool.
 */
export function apply(ctx: Context, config: FlightCompareConfig): () => void {
  const maxRows = Math.max(1, Math.trunc(config.maxRows))
  const currency = config.currency.trim().toUpperCase() || 'RUB'

  const tool = defineTool({
    name: 'flight_compare',
    description:
      'Compare cached flight prices for one route with Travelpayouts and return the lowest price per flight number and departure date, sorted by price ascending.',
    parameters: {
      origin: {
        type: 'string',
        required: true,
        description: 'IATA code of the departure city, for example MOW or PEK.',
      },
      destination: {
        type: 'string',
        required: true,
        description: 'IATA code of the destination city, for example HKT or BCN.',
      },
      departDate: {
        type: 'string',
        description: 'Optional departure filter: YYYY-MM for a month or YYYY-MM-DD for a single day.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text' as const, text: renderMarkdown(args, value as FlightCompareValue) }],
    },
    async execute(args, exec) {
      const origin = normalizeCode(args.origin)
      const destination = normalizeCode(args.destination)
      if (!/^[A-Z]{2,3}$/.test(origin)) throw new Error(`origin must be a 2-3 letter IATA code, received "${args.origin}"`)
      if (!/^[A-Z]{2,3}$/.test(destination)) {
        throw new Error(`destination must be a 2-3 letter IATA code, received "${args.destination}"`)
      }
      if (origin === destination) throw new Error('origin and destination must differ')

      const rawDate = args.departDate?.trim()
      if (rawDate !== undefined && rawDate.length > 0 && !isDateInput(rawDate)) {
        throw new Error(`departDate must be YYYY-MM or YYYY-MM-DD, received "${args.departDate}"`)
      }
      const requested = rawDate !== undefined && rawDate.length > 0 ? rawDate : undefined
      const month = monthStart(requested ?? new Date().toISOString().slice(0, 7))
      // `YYYY-MM` selects the month to query; only a `YYYY-MM-DD` narrows to one day.
      const departDate = requested !== undefined && requested.length === 10 ? requested : undefined

      const offers = await fetchMonthMatrix(origin, destination, month, { ...config, currency }, exec.signal)
      const { rows, matched } = aggregate(offers, departDate)
      const truncated = rows.length > maxRows

      return {
        origin,
        destination,
        month,
        departDate: departDate ?? '',
        currency,
        source: 'travelpayouts',
        total: rows.length,
        matched,
        truncated,
        rows: rows.slice(0, maxRows),
      }
    },
  })

  return ctx.tools.register(tool)
}
