const textEncoder = new TextEncoder()

export const RUM_MAX_FRAME_BYTES = 8192
export const RUM_MAX_BATCH_METRICS = 16
export const RUM_MAX_METRIC_VALUES = 4
export const RUM_MAX_DIMENSIONS = 4

const RUM_BATCH_HEADER_SIZE = 36
const RUM_METRIC_ITEM_SIZE = 36
const RUM_METRIC_VALUE_SIZE = 16
const RUM_METRIC_DIMENSION_SIZE = 16
const RUM_INGEST_RESPONSE_SIZE = 12

type Utf8Part = { bytes: Uint8Array; offset: number; length: number }

export type RumMetricBatch = {
  pageType: string
  routeKey: string
  aotSource: string
  metrics: RumMetricBatchItem[]
}

export type RumMetricBatchItem = {
  name: string
  value?: number
  timestamp?: string
  metrics?: Record<string, number>
  dimensions?: Record<string, string>
}

export type RumMetricIngestResponse = {
  accepted: boolean
  acceptedCount: number
  rejectedCount: number
}

export function encodeRumMetricBatchRequest(batch: RumMetricBatch): Uint8Array {
  const metrics = batch.metrics.slice(0, RUM_MAX_BATCH_METRICS)
  const metricValueEntries = metrics.flatMap((item) => Object.entries(item.metrics ?? {}).slice(0, RUM_MAX_METRIC_VALUES))
  const dimensionEntries = metrics.flatMap((item) => Object.entries(item.dimensions ?? {}).slice(0, RUM_MAX_DIMENSIONS))
  const textValues = [
    batch.pageType,
    batch.routeKey,
    batch.aotSource,
    ...metrics.map((item) => item.name),
    ...metricValueEntries.map(([key]) => key),
    ...dimensionEntries.flatMap(([key, value]) => [key, value])
  ]
  const { blob, parts } = buildBlob(textValues)
  const payloadLength =
    RUM_BATCH_HEADER_SIZE +
    metrics.length * RUM_METRIC_ITEM_SIZE +
    metricValueEntries.length * RUM_METRIC_VALUE_SIZE +
    dimensionEntries.length * RUM_METRIC_DIMENSION_SIZE +
    4 +
    blob.byteLength
  const payload = new Uint8Array(payloadLength)
  const view = new DataView(payload.buffer)
  let partIndex = 0
  view.setInt32(0, metrics.length, true)
  view.setInt32(4, metricValueEntries.length, true)
  view.setInt32(8, dimensionEntries.length, true)
  writeSliceRef(view, 12, parts[partIndex++])
  writeSliceRef(view, 20, parts[partIndex++])
  writeSliceRef(view, 28, parts[partIndex++])

  let cursor = RUM_BATCH_HEADER_SIZE
  for (const item of metrics) {
    const values = Object.entries(item.metrics ?? {}).slice(0, RUM_MAX_METRIC_VALUES)
    const dimensions = Object.entries(item.dimensions ?? {}).slice(0, RUM_MAX_DIMENSIONS)
    const hasValue = typeof item.value === 'number' && Number.isFinite(item.value)
    const timestampUnixMs = parseTimestampUnixMs(item.timestamp)
    view.setFloat64(cursor, hasValue ? item.value as number : 0, true)
    view.setBigInt64(cursor + 8, BigInt(timestampUnixMs ?? 0), true)
    view.setInt32(cursor + 16, values.length, true)
    view.setInt32(cursor + 20, dimensions.length, true)
    payload[cursor + 24] = hasValue ? 1 : 0
    payload[cursor + 25] = timestampUnixMs == null ? 0 : 1
    writeSliceRef(view, cursor + 28, parts[partIndex++])
    cursor += RUM_METRIC_ITEM_SIZE
  }

  for (const item of metrics) {
    for (const [key, value] of Object.entries(item.metrics ?? {}).slice(0, RUM_MAX_METRIC_VALUES)) {
      view.setFloat64(cursor, value, true)
      writeSliceRef(view, cursor + 8, parts[partIndex++])
      cursor += RUM_METRIC_VALUE_SIZE
    }
  }

  for (const item of metrics) {
    for (const [key, value] of Object.entries(item.dimensions ?? {}).slice(0, RUM_MAX_DIMENSIONS)) {
      writeSliceRef(view, cursor, parts[partIndex++])
      writeSliceRef(view, cursor + 8, parts[partIndex++])
      cursor += RUM_METRIC_DIMENSION_SIZE
    }
  }

  view.setInt32(cursor, blob.byteLength, true)
  payload.set(blob, cursor + 4)
  return payload
}

export function decodeRumMetricIngestResponse(payload: Uint8Array): RumMetricIngestResponse | null {
  if (payload.byteLength !== RUM_INGEST_RESPONSE_SIZE) {
    return null
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const accepted = payload[8] === 1
  return {
    accepted,
    acceptedCount: view.getInt32(0, true),
    rejectedCount: view.getInt32(4, true)
  }
}

function buildBlob(values: string[]): { blob: Uint8Array; parts: Utf8Part[] } {
  let offset = 0
  const parts = values.map((value) => {
    const bytes = textEncoder.encode(value)
    const part = { bytes, offset, length: bytes.byteLength }
    offset += bytes.byteLength
    return part
  })

  const blob = new Uint8Array(offset)
  for (const part of parts) {
    blob.set(part.bytes, part.offset)
  }

  return { blob, parts }
}

function writeSliceRef(view: DataView, offset: number, part: Utf8Part | undefined): void {
  view.setInt32(offset, part?.offset ?? 0, true)
  view.setInt32(offset + 4, part?.length ?? 0, true)
}

function parseTimestampUnixMs(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
