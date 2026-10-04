/**
 * Pure comparison model for `flight_compare`: the canonical output contract,
 * the cross-source aggregation, and the Markdown projection.
 *
 * This module imports only types and small helpers, so the aggregation and the
 * rendering can be exercised without any network or registry dependency.
 *
 * @module dsh-flight-compare/flight
 */

import { isoTime } from './util.js'
import type { Flight, FlightSourceId } from './sources/types.js'

/**
 * Canonical output contract: the value `execute` returns, and the exact shape
 * the registry validates it against before `render` runs.
 *
 * The value-schema DSL has no `required` keyword, so `execute` declares its
 * return type as {@link FlightCompareValue} to keep every field present.
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
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          ok: { type: 'boolean' },
          flights: { type: 'integer' },
          error: { type: 'string' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flightNumber: { type: 'string' },
          carrier: { type: 'string' },
          date: { type: 'string' },
          departTime: { type: 'string' },
          transfers: { type: 'integer' },
          price: { type: 'number' },
          currency: { type: 'string' },
          source: { type: 'string' },
          otherPrices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string' },
                price: { type: 'number' },
                currency: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const

/** One competing price for the same flight on the same day. */
export interface FlightRowOffer {
  source: FlightSourceId
  price: number
  currency: string
}

/** One aggregated flight/date group: its lowest price, and who offered what. */
export interface FlightRow {
  flightNumber: string
  carrier: string
  date: string
  departTime: string
  transfers: number
  price: number
  currency: string
  source: FlightSourceId
  otherPrices: FlightRowOffer[]
}

/** Per-source outcome, so one broken source does not hide the others. */
export interface SourceOutcome {
  name: FlightSourceId
  label: string
  ok: boolean
  flights: number
  error: string
}

/** Canonical result: the declared `output.schema` shape. */
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
  sources: SourceOutcome[]
  warnings: string[]
  rows: FlightRow[]
}

/** Comparison key: flight number + departure date, with carrier as a tiebreaker. */
function groupKey(flight: Flight): string {
  return `${flight.flightNumber}\u0000${flight.departDate}`
}

/** Project one offer onto the competing-price record kept per source. */
function offerOf(flight: Flight): FlightRowOffer {
  return { source: flight.source, price: flight.price, currency: flight.currency }
}

/** Sort two competing offers: price ascending, then source id for stability. */
function byPriceThenSource(left: FlightRowOffer, right: FlightRowOffer): number {
  if (left.price !== right.price) return left.price - right.price
  return left.source.localeCompare(right.source)
}

/**
 * Collapse every source's offers into one row per flight number + departure
 * date, keeping the lowest price across all sources and recording the winner.
 *
 * The winning offer supplies the row's carrier, departure time, and stop count,
 * so the details always describe the itinerary the lowest price belongs to.
 * When the same source returns a flight twice at different prices the cheaper
 * offer wins, so a row never lists one source more than once.
 *
 * @param flights - Normalized offers from every source, in any order.
 * @returns Rows sorted by lowest price ascending, plus the offer count used.
 */
export function aggregate(flights: Flight[]): { rows: FlightRow[]; matched: number } {
  const groups = new Map<string, { bySource: Map<FlightSourceId, FlightRowOffer>; best: Flight }>()
  let matched = 0

  for (const flight of flights) {
    if (!Number.isFinite(flight.price) || flight.flightNumber.length === 0 || flight.departDate.length === 0) continue
    matched += 1

    const key = groupKey(flight)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { bySource: new Map([[flight.source, offerOf(flight)]]), best: flight })
      continue
    }

    const previous = group.bySource.get(flight.source)
    if (previous === undefined || flight.price < previous.price) {
      group.bySource.set(flight.source, offerOf(flight))
    }
    if (flight.price < group.best.price) {
      group.best = flight
    }
  }

  const rows: FlightRow[] = []
  for (const [key, group] of groups) {
    const ranked = [...group.bySource.values()].sort(byPriceThenSource)
    const winner = ranked[0]
    if (winner === undefined) continue
    rows.push({
      flightNumber: key.slice(0, key.indexOf('\u0000')),
      carrier: group.best.carrier,
      date: group.best.departDate,
      departTime: isoTime(group.best.departureAt),
      transfers: group.best.transfers,
      price: winner.price,
      currency: winner.currency,
      source: winner.source,
      otherPrices: ranked.slice(1),
    })
  }

  rows.sort((left, right) => {
    if (left.price !== right.price) return left.price - right.price
    if (left.date !== right.date) return left.date < right.date ? -1 : 1
    return left.flightNumber.localeCompare(right.flightNumber)
  })

  return { rows, matched }
}

/** Human-readable transfer count for the Markdown table. */
function transfersLabel(transfers: number): string {
  return transfers <= 0 ? '直飞' : `${transfers} 次`
}

/** Escape a value for a Markdown table cell (pipes and newlines). */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** Render the per-row source attribution, adding competitors when there are any. */
function sourceLabel(row: FlightRow, labelOf: (source: FlightSourceId) => string): string {
  const winner = `${labelOf(row.source)} ★`
  if (row.otherPrices.length === 0) return winner
  const others = row.otherPrices.map((offer) => `${labelOf(offer.source)} ${offer.price}`).join(' / ')
  return `${winner}（其他：${others}）`
}

/**
 * Build the Markdown table a model and a reader both consume.
 *
 * @param args - Validated tool arguments.
 * @param value - Canonical comparison result.
 * @returns One Markdown document.
 */
export function renderMarkdown(
  args: { origin: string; destination: string; departDate?: string },
  value: FlightCompareValue,
): string {
  const route = `${value.origin} → ${value.destination}`
  const scope = args.departDate === undefined ? `${value.month.slice(0, 7)} 整月` : args.departDate
  const labels = new Map(value.sources.map((source) => [source.name, source.label] as const))
  const labelOf = (source: FlightSourceId): string => labels.get(source) ?? source
  const lines: string[] = []

  lines.push(`# ${route} 机票比价`)
  lines.push('')
  lines.push(`数据源：${value.source}｜出发：${scope}｜币种：${value.currency}`)

  if (value.sources.length > 0) {
    lines.push('')
    for (const source of value.sources) {
      const status = source.ok ? `${source.flights} 条报价` : `不可用：${source.error}`
      lines.push(`- ${source.label}（\`${source.name}\`）：${status}`)
    }
  }

  if (value.rows.length === 0) {
    lines.push('')
    lines.push('没有找到该航线在所选时间范围内的价格。')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('| 航班号 | 航司 | 日期 | 起飞 | 中转 | 最低价 | 来源 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of value.rows) {
    const flight = cell(`${row.carrier}${row.flightNumber}`)
    lines.push(
      `| ${flight} | ${cell(row.carrier) || '-'} | ${row.date} | ${row.departTime || '-'} | ${transfersLabel(row.transfers)} | ${row.currency} ${row.price} | ${sourceLabel(row, labelOf)} |`,
    )
  }

  const lowest = value.rows[0]
  if (lowest !== undefined) {
    const flight = cell(`${lowest.carrier}${lowest.flightNumber}`)
    lines.push('')
    lines.push(
      `最低价：**${lowest.currency} ${lowest.price}**（${flight}，${lowest.date}，来源 ${labelOf(lowest.source)}）`,
    )
  }
  lines.push('')
  lines.push(`共 ${value.total} 组航班/日期，来自 ${value.matched} 条报价。`)
  if (value.truncated) {
    lines.push(`（结果已截断为 ${value.rows.length} 行，可通过 maxRows 配置放大上限。）`)
  }
  if (value.warnings.length > 0) {
    lines.push('')
    lines.push('注意：')
    for (const warning of value.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}
