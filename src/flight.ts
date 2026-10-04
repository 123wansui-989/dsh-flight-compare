/**
 * Pure pricing model for `flight_compare`: the canonical output contract, the
 * offer-to-row aggregation, and the Markdown projection.
 *
 * This module imports nothing, so the aggregation and the rendering can be
 * exercised in isolation.
 *
 * @module dsh-flight-compare/flight
 */

/** One offer exactly as the Travelpayouts month-matrix endpoint returns it. */
export interface TravelpayoutsOffer {
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
export interface TravelpayoutsEnvelope {
  success?: boolean
  data?: TravelpayoutsOffer[] | null
  error?: string | null
  currency?: string
}

/** One aggregated flight/date group. */
export interface FlightRow {
  flightNumber: string
  airline: string
  date: string
  departTime: string
  transfers: number
  price: number
  returnAt: string
  expiresAt: string
}

/**
 * Canonical output contract: the value `execute` returns, and the exact shape
 * the registry validates it against before `render` runs.
 *
 * The value-schema DSL has no `required` keyword, so `execute` declares its
 * return type as {@link FlightCompareValue} to keep every field present — see
 * the explicit signature in `index.ts`.
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: { type: 'string' },
    destination: { type: 'string' },
    month: { type: 'string' },
    departDate: { type: 'string' },
    currency: { type: 'string' },
    source: { type: 'string' },
    total: { type: 'integer' },
    matched: { type: 'integer' },
    truncated: { type: 'boolean' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flightNumber: { type: 'string' },
          airline: { type: 'string' },
          date: { type: 'string' },
          departTime: { type: 'string' },
          transfers: { type: 'integer' },
          price: { type: 'number' },
          returnAt: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
    },
  },
} as const

/** Canonical aggregated result: the declared `output.schema` shape. */
export interface FlightCompareValue {
  origin: string
  destination: string
  month: string
  departDate: string
  currency: string
  source: string
  total: number
  matched: number
  truncated: boolean
  rows: FlightRow[]
}

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

/** Coerce a Travelpayouts flight number to a stable string, or `''`. */
export function flightNumber(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return ''
}

/** Human-readable transfer count for the Markdown table. */
function transfersLabel(transfers: number): string {
  return transfers <= 0 ? '直飞' : `${transfers} 次`
}

/** Escape a value for a Markdown table cell (pipes and newlines). */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/**
 * Collapse offers into one row per flight number + departure date, keeping the
 * lowest price and the details of the offer that carried it.
 *
 * @param offers - Raw provider offers.
 * @param departDate - Optional `YYYY-MM-DD` filter.
 * @returns Aggregated rows sorted by price ascending, plus the offer count used.
 */
export function aggregate(offers: TravelpayoutsOffer[], departDate?: string): { rows: FlightRow[]; matched: number } {
  const groups = new Map<string, FlightRow>()
  let matched = 0

  for (const offer of offers) {
    if (typeof offer.price !== 'number' || !Number.isFinite(offer.price)) continue
    const number = flightNumber(offer.flight_number)
    const date = isoDate(offer.departure_at)
    if (number.length === 0 || date.length === 0) continue
    if (departDate !== undefined && date !== departDate) continue

    matched += 1
    const key = `${number}\u0000${date}`
    const previous = groups.get(key)
    if (previous === undefined || offer.price < previous.price) {
      groups.set(key, {
        flightNumber: number,
        airline: offer.airline ?? '',
        date,
        departTime: isoTime(offer.departure_at),
        transfers: typeof offer.transfers === 'number' ? offer.transfers : 0,
        price: offer.price,
        returnAt: offer.return_at ?? '',
        expiresAt: offer.expires_at ?? '',
      })
    }
  }

  const rows = [...groups.values()].sort((left, right) => {
    if (left.price !== right.price) return left.price - right.price
    if (left.date !== right.date) return left.date < right.date ? -1 : 1
    return left.flightNumber.localeCompare(right.flightNumber)
  })

  return { rows, matched }
}

/**
 * Build the Markdown table a model and a reader both consume.
 *
 * @param args - Validated tool arguments.
 * @param value - Canonical aggregated result.
 * @returns One Markdown document.
 */
export function renderMarkdown(
  args: { origin: string; destination: string; departDate?: string },
  value: FlightCompareValue,
): string {
  const origin = value.origin
  const destination = value.destination
  const currency = value.currency
  const month = value.month
  const rows = value.rows

  const route = `${origin} → ${destination}`
  const scope = args.departDate === undefined ? `${month.slice(0, 7)} 整月` : args.departDate
  const lines: string[] = []

  lines.push(`# ${route} 机票比价`)
  lines.push('')
  lines.push(`数据源：Travelpayouts（缓存价格）｜出发：${scope}｜币种：${currency}`)

  if (rows.length === 0) {
    lines.push('')
    lines.push('没有找到该航线在所选时间范围内的缓存价格。')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('| 航班号 | 航司 | 日期 | 起飞 | 中转 | 价格 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    const flight = cell(`${row.airline}${row.flightNumber}`)
    lines.push(
      `| ${flight} | ${cell(row.airline) || '-'} | ${row.date} | ${row.departTime || '-'} | ${transfersLabel(row.transfers)} | ${currency} ${row.price} |`,
    )
  }

  const lowest = rows[0]
  if (lowest !== undefined) {
    lines.push('')
    lines.push(`最低价：**${currency} ${lowest.price}**（${cell(`${lowest.airline}${lowest.flightNumber}`)}，${lowest.date}）`)
  }
  lines.push('')
  lines.push(`共 ${value.total} 组航班/日期，来自 ${value.matched} 条报价。`)
  if (value.truncated) {
    lines.push(`（结果已截断为 ${rows.length} 行，可通过 maxRows 配置放大上限。）`)
  }
  return lines.join('\n')
}
