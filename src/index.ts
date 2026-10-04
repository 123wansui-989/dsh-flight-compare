/**
 * `flight_compare` — compare flight prices for one route across sources.
 *
 * Two sources are wired in, behind one interface (`sources/types.ts`):
 * Travelpayouts cached prices (`GET /v2/prices/month-matrix`) and the Amadeus
 * Self-Service Flight Offers Search API (`GET /v2/shopping/flight-offers`).
 * Both read their credentials from plugin configuration, which
 * `cordis.patch.yml` fills from the environment — nothing is hardcoded.
 *
 * Every source's offers are normalized to one `Flight` shape, then aggregated
 * by flight number + departure date with the lowest price across sources
 * winning. A source that fails is reported instead of failing the whole call.
 *
 * `apply` returns the disposer from `ctx.tools.register`, which Cordis runs when
 * the plugin's fiber disposes.
 *
 * @module dsh-flight-compare
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { OUTPUT_SCHEMA, aggregate, renderMarkdown } from './flight.js'
import type { FlightCompareValue, SourceOutcome } from './flight.js'
import { createSources } from './sources/index.js'
import type { Flight, FlightQuery, FlightSource } from './sources/index.js'
import { isDateInput, monthStart, normalizeCode } from './util.js'

/** Plugin name used by Cordis (exported so the patch and the manifest agree). */
export const name = 'dsh-flight-compare'

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools']

/** Plugin configuration, validated by Cordis when the row activates. */
export const Config = Schema.object({
  /** Travelpayouts Data Access API token. Required; supply it through the environment. */
  travelpayoutsToken: Schema.string().required().description('Travelpayouts token (X-Access-Token).'),
  /**
   * Legacy alias for {@link Config.travelpayoutsToken}. 0.1.0 rows used `token`;
   * it is still honored when `travelpayoutsToken` is absent, so upgrading the
   * package does not break an existing profile patch.
   */
  token: Schema.string().description('Deprecated alias of travelpayoutsToken, kept for 0.1.0 rows.'),
  /** Amadeus Self-Service API key; leave empty to disable that source. */
  amadeusClientId: Schema.string().default('').description('Amadeus API key (client id).'),
  /** Amadeus Self-Service API secret; leave empty to disable that source. */
  amadeusClientSecret: Schema.string().default('').description('Amadeus API secret (client secret).'),
  /** Use the Amadeus production host instead of the test host. */
  amadeusProduction: Schema.boolean().default(false).description('Query api.amadeus.com instead of test.api.amadeus.com.'),
  /** Upper bound on Amadeus offers requested per search. */
  amadeusMaxResults: Schema.natural().default(20).description('Maximum Amadeus offers per search.'),
  /** Currency of the returned prices. The Travelpayouts API defaults to RUB. */
  currency: Schema.string().default('RUB').description('ISO currency code for prices, for example RUB or USD.'),
  /** Upper bound on rows in the rendered table. */
  maxRows: Schema.natural().default(30).description('Maximum number of aggregated rows to return.'),
  /** Upstream request timeout in milliseconds. */
  timeoutMs: Schema.natural().default(20000).description('Per-source request timeout in milliseconds.'),
})

/** Resolved configuration passed to `apply`. */
export interface FlightCompareConfig {
  /** Travelpayouts Data Access API token. */
  travelpayoutsToken: string
  /** Legacy 0.1.0 token field, read only when `travelpayoutsToken` is empty. */
  token?: string
  /** Amadeus API key; empty disables the Amadeus source. */
  amadeusClientId: string
  /** Amadeus API secret; empty disables the Amadeus source. */
  amadeusClientSecret: string
  /** Use the Amadeus production host. */
  amadeusProduction: boolean
  /** Upper bound on Amadeus offers requested per search. */
  amadeusMaxResults: number
  /** Currency of the returned prices. */
  currency: string
  /** Upper bound on rows in the rendered table. */
  maxRows: number
  /** Per-source request timeout in milliseconds. */
  timeoutMs: number
}

/**
 * Query one source, converting any failure into a reported outcome.
 *
 * @param source - The source to query.
 * @param query - Normalized route, date filter, currency, and cancellation signal.
 * @returns The source's flights plus its outcome row.
 */
async function collect(
  source: FlightSource,
  query: FlightQuery,
): Promise<{ flights: Flight[]; outcome: SourceOutcome }> {
  try {
    const flights = await source.search(query)
    return { flights, outcome: { name: source.name, label: source.label, ok: true, flights: flights.length, error: '' } }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { flights: [], outcome: { name: source.name, label: source.label, ok: false, flights: 0, error: reason } }
  }
}

/**
 * Build one source query, omitting `departDate` when the caller did not pin a
 * day (`exactOptionalPropertyTypes` treats an explicit `undefined` as a value).
 *
 * @param input - Route, optional day filter, month anchor, currency, and signal.
 * @returns A query every source accepts.
 */
function buildQuery(input: {
  origin: string
  destination: string
  departDate: string | undefined
  month: string
  currency: string
  signal: AbortSignal
}): FlightQuery {
  const { departDate, ...rest } = input
  return departDate === undefined ? rest : { ...rest, departDate }
}

/** Register `flight_compare` on the Cordis context. */
export function apply(ctx: Context, config: FlightCompareConfig): () => void {
  const maxRows = Math.max(1, Math.trunc(config.maxRows))
  const currency = config.currency.trim().toUpperCase() || 'RUB'
  const travelpayoutsToken = config.travelpayoutsToken.trim() || (config.token ?? '').trim()
  if (travelpayoutsToken.length === 0) {
    throw new Error('no Travelpayouts token configured: set travelpayoutsToken (or the legacy token) on the plugin row')
  }
  const sources = createSources({
    travelpayoutsToken,
    amadeusClientId: config.amadeusClientId.trim(),
    amadeusClientSecret: config.amadeusClientSecret.trim(),
    amadeusProduction: config.amadeusProduction,
    amadeusMaxResults: Math.max(1, Math.trunc(config.amadeusMaxResults)),
    timeoutMs: config.timeoutMs,
  })
  const sourceSummary = sources.map((source) => source.label).join(' + ')

  const tool = defineTool({
    name: 'flight_compare',
    description:
      'Compare flight prices for one route across Travelpayouts and Amadeus, and return the lowest price per flight number and departure date with the source that offered it, sorted by price ascending.',
    parameters: {
      origin: {
        type: 'string',
        required: true,
        description: 'IATA code of the departure city or airport, for example MOW or PEK.',
      },
      destination: {
        type: 'string',
        required: true,
        description: 'IATA code of the destination city or airport, for example HKT or BCN.',
      },
      departDate: {
        type: 'string',
        description:
          'Departure date: YYYY-MM-DD for one day, or YYYY-MM for a whole month. Defaults to today. Amadeus needs a day, so a whole-month request only compares Travelpayouts.',
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
      // Older builds made `departDate` optional, so an absent value still works:
      // it anchors on today and queries the whole month.
      const departDate = requested !== undefined && requested.length === 10 ? requested : undefined
      const anchorDate = departDate ?? new Date().toISOString().slice(0, 10)
      const month = monthStart(anchorDate)

      const results = await Promise.all(
        sources.map((source) => collect(source, buildQuery({ origin, destination, departDate, month, currency, signal: exec.signal }))),
      )

      const flights = results.flatMap((result) => result.flights)
      const outcomes = results.map((result) => result.outcome)
      const warnings = outcomes.filter((outcome) => !outcome.ok).map((outcome) => `${outcome.label} 查询失败：${outcome.error}`)
      if (departDate === undefined) {
        warnings.push('未指定具体日期，只按整月与 Travelpayouts 比对；Amadeus 需要 YYYY-MM-DD 才能查询。')
      }

      const { rows, matched } = aggregate(flights)
      const truncated = rows.length > maxRows

      return {
        origin,
        destination,
        month,
        departDate: departDate ?? '',
        currency,
        source: sourceSummary,
        total: rows.length,
        matched,
        truncated,
        sources: outcomes,
        warnings,
        rows: rows.slice(0, maxRows),
      }
    },
  })

  return ctx.tools.register(tool)
}
