import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request } from './client.ts'
import { propertyKinds, writeValue, type PropertyKind, type PropertyOption, type PropertyValue } from './property-values.ts'
import {
  decodePropertyCommandReceipt, encodePropertyFilterabilityCommand, FrameType, WireLimits, WireRoutes,
  type PropertyFilterabilityCommand,
} from './wire.generated.ts'

export type FilterField = Readonly<{
  id: string; revision: bigint; machineKey: string; label: string; kind: PropertyKind
  enabled: boolean; deprecated: boolean; options: readonly PropertyOption[]
}>
export type FilterCatalog = Readonly<{ revision: bigint; nextKey: string; fields: readonly FilterField[] }>
export const propertyComparisons = [
  'equal', 'less-than', 'at-most', 'greater-than', 'at-least', 'is-present', 'multi-select-any-of', 'single-select-any-of',
] as const
export type PropertyComparison = typeof propertyComparisons[number]
export type PropertyCondition = Readonly<{ field: FilterField; comparison: PropertyComparison; value: PropertyValue }>
export type PropertyQuery = Readonly<{ schema: bigint; conditions: readonly PropertyCondition[]; cursor: string }>
export type PropertyMatches = Readonly<{
  nextCursor: string; rows: readonly Readonly<{ id: number; revision: bigint; title: string }>[]
}>

export function propertyFilterCatalog(signal?: AbortSignal, after?: { key: string; schema: bigint }): Promise<FilterCatalog> {
  const url = after ? WireRoutes.PropertyFilterCatalog + '?' + new URLSearchParams({ after: after.key, schema: String(after.schema) })
    : WireRoutes.PropertyFilterCatalog
  return request(url, FrameType.PropertyFilterCatalog, bytes => {
    const input = new PodReader(bytes)
    const revision = input.i64(), nextKey = input.text(WireLimits.PropertyKeyBytes), count = input.i32()
    if (revision < 0n || (after && after.schema !== revision) || count < 0 || count > WireLimits.PropertyPageSize)
      throw new ProtocolError('Invalid property catalog')
    const fields: FilterField[] = []
    let previous = after?.key ?? ''
    for (let i = 0; i < count; ++i) {
      const id = input.uuid(), fieldRevision = input.i64(), machineKey = input.text(WireLimits.PropertyKeyBytes)
      const label = input.text(WireLimits.PropertyLabelBytes), kind = propertyKinds[input.i32()]
      const enabled = input.bool(), deprecated = input.bool(), optionCount = input.i32()
      if (!kind || fieldRevision <= 0n || fieldRevision > revision || machineKey <= previous || !label ||
          (enabled && deprecated) || optionCount < 0 || optionCount > WireLimits.PropertyOptionCount)
        throw new ProtocolError('Invalid property field')
      const options: PropertyOption[] = []
      for (let option = 0; option < optionCount; option++)
        options.push({ id: input.uuid(), label: input.text(WireLimits.PropertyLabelBytes) })
      fields.push({ id, revision: fieldRevision, machineKey, label, kind, enabled, deprecated, options })
      previous = machineKey
    }
    input.finish()
    if (nextKey && (count !== WireLimits.PropertyPageSize || nextKey !== previous))
      throw new ProtocolError('Invalid property catalog continuation')
    return { revision, nextKey, fields }
  }, signal)
}

export function setPropertyFilterable(input: PropertyFilterabilityCommand, signal?: AbortSignal) {
  return request(WireRoutes.PropertyFilterability, FrameType.PropertyCommandReceipt, decodePropertyCommandReceipt, signal,
    'POST', encodeFrame(FrameType.PropertyFilterabilityCommand, encodePropertyFilterabilityCommand(input)))
}

export function encodePropertyQuery(query: PropertyQuery) {
  if (!query.conditions.length || query.conditions.length > WireLimits.PropertyQueryConditionCount)
    throw new ProtocolError('Invalid property condition count')
  const output = new PodWriter()
  output.i64(query.schema)
  output.i32(query.conditions.length)
  for (const condition of query.conditions) {
    if (condition.comparison === 'is-present' && condition.value.kind !== 'missing')
      throw new ProtocolError('Property presence does not accept a value')
    if (condition.comparison === 'multi-select-any-of' &&
        (condition.field.kind !== 'multi-select' || condition.value.kind !== 'multi-select'))
      throw new ProtocolError('Property overlap requires a multi-select field and alternatives')
    if (condition.comparison === 'single-select-any-of' &&
        (condition.field.kind !== 'single-select' || condition.value.kind !== 'multi-select' || condition.value.value.length === 0))
      throw new ProtocolError('Single-select matching requires at least one alternative')
    output.uuid(condition.field.id)
    output.i64(condition.field.revision)
    output.i32(propertyComparisons.indexOf(condition.comparison))
    writeValue(output, condition.value)
  }
  output.text(query.cursor, WireLimits.PropertyQueryCursorChars)
  return encodeFrame(FrameType.PropertyArticleQueryGroup, output.finish())
}

export function decodePropertyMatches(bytes: Uint8Array): PropertyMatches {
  const input = new PodReader(bytes)
  const nextCursor = input.text(WireLimits.PropertyQueryCursorChars), count = input.i32()
  if (count < 0 || count > WireLimits.PropertyPageSize || nextCursor &&
      (count !== WireLimits.PropertyPageSize || !/^[A-Za-z0-9_-]{48}$/.test(nextCursor)))
    throw new ProtocolError('Invalid property query page')
  const rows: { id: number; revision: bigint; title: string }[] = []
  for (let i = 0; i < count; ++i) {
    const id = input.i32(), revision = input.i64(), title = input.text(WireLimits.TitleBytes)
    if (id <= 0 || (i > 0 && id >= rows[i - 1].id) || revision <= 0n || !title)
      throw new ProtocolError('Invalid property query entry')
    rows.push({ id, revision, title })
  }
  input.finish()
  return { nextCursor, rows }
}

export function queryPropertyArticles(query: PropertyQuery, signal?: AbortSignal): Promise<PropertyMatches> {
  return request(WireRoutes.PropertyArticleQuery, FrameType.PropertyArticlePage, decodePropertyMatches,
    signal, 'POST', encodePropertyQuery(query))
}
