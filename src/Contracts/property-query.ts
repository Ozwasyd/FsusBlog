import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request, siteSessionHeader } from './client.ts'
import { propertyKinds, readPropertyOperand, writeValue, type PropertyKind, type PropertyOption, type PropertyValue } from './property-values.ts'
import {
  decodePropertyCommandReceipt, encodePropertyFilterabilityCommand, FrameType, WireLimits, WireRoutes,
  type PropertyFilterabilityCommand,
} from './wire.generated.ts'

export type FilterField = Readonly<{
  id: string; revision: bigint; machineKey: string; label: string; kind: PropertyKind
  enabled: boolean; deprecated: boolean; options: readonly PropertyOption[]
  searchEligible?: boolean; sortable?: boolean
}>
export type FilterCatalog = Readonly<{ revision: bigint; nextKey: string; fields: readonly FilterField[] }>
export const propertyComparisons = [
  'equal', 'less-than', 'at-most', 'greater-than', 'at-least', 'is-present', 'multi-select-any-of', 'single-select-any-of', 'reference-any-of',
] as const
export type PropertyComparison = typeof propertyComparisons[number]
export type PropertyCondition = Readonly<{ field: FilterField; comparison: PropertyComparison; value: PropertyValue; anyOf?: boolean }>
export type PropertyQueryOperand = Readonly<{
  definitionId: string; definitionRevision: bigint; comparison: PropertyComparison; value: PropertyValue; anyOf?: boolean
}>
export type PropertyQuery = Readonly<{ schema: bigint; conditions: readonly PropertyCondition[]; cursor: string; keyword?: string }>
export type PropertyMatches = Readonly<{
  nextCursor: string; rows: readonly Readonly<{ id: number; revision: bigint; title: string }>[]
}>

export function propertyFilterCatalog(signal?: AbortSignal, after?: { key: string; schema: bigint },
  session?: string, projection = false): Promise<FilterCatalog> {
  const params = new URLSearchParams(after ? { after: after.key, schema: String(after.schema) } : undefined)
  if (projection) params.set('projection', '1')
  const url = `${WireRoutes.PropertyFilterCatalog}${params.size ? `?${params}` : ''}`
  const frame = projection ? FrameType.PropertyProjectionCatalog : FrameType.PropertyFilterCatalog
  return request(url, frame, bytes => {
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
      const field = { id, revision: fieldRevision, machineKey, label, kind, enabled, deprecated, options }
      if (projection) {
        const searchEligible = input.bool(), sortable = input.bool()
        if (searchEligible && (deprecated || kind !== 'text') || sortable && (deprecated || kind === 'article-reference' || kind === 'url'))
          throw new ProtocolError('Invalid property projection flags')
        fields.push({ ...field, searchEligible, sortable })
      } else fields.push(field)
      previous = machineKey
    }
    input.finish()
    if (nextKey && (count !== WireLimits.PropertyPageSize || nextKey !== previous))
      throw new ProtocolError('Invalid property catalog continuation')
    return { revision, nextKey, fields }
  }, signal, 'GET', undefined, siteSessionHeader(session))
}

export function setPropertyFilterable(input: PropertyFilterabilityCommand, signal?: AbortSignal) {
  return request(WireRoutes.PropertyFilterability, FrameType.PropertyCommandReceipt, decodePropertyCommandReceipt, signal,
    'POST', encodeFrame(FrameType.PropertyFilterabilityCommand, encodePropertyFilterabilityCommand(input)))
}

export function encodePropertyQuery(query: PropertyQuery) {
  const keyword = query.keyword ?? ''
  if (keyword.length > WireLimits.AuthorArticleKeywordChars || /(^\p{Z}|\p{Z}$|\p{Cc}|\p{Cs})/u.test(keyword))
    throw new ProtocolError('Invalid article keyword')
  const output = new PodWriter()
  output.i64(query.schema)
  if (keyword) output.text(keyword, WireLimits.AuthorArticleKeywordChars * 4)
  writePropertyConditions(output, query.schema, query.conditions)
  output.text(query.cursor, WireLimits.PropertyQueryCursorChars)
  return encodeFrame(keyword ? FrameType.PropertyKeywordQuery : FrameType.PropertyArticleQueryGroup, output.finish())
}

type EmptyPropertySchema = 'disallowed' | 'zero' | 'positive'
const anyOfPropertyFlag = 0x100

export function writePropertyConditions(
  output: PodWriter, schema: bigint, conditions: readonly PropertyCondition[], emptySchema: EmptyPropertySchema = 'disallowed',
): void {
  validateConditionCount(schema, conditions.length, emptySchema)
  const seen = new Set<string>()
  validateAlternatives(conditions.map(({ field, anyOf }) => ({ definitionId: field.id, definitionRevision: field.revision, anyOf })))
  output.i32(conditions.length)
  for (const { field, comparison, value, anyOf } of conditions) {
    if ((comparison === 'multi-select-any-of' && field.kind !== 'multi-select') ||
        (comparison === 'single-select-any-of' && field.kind !== 'single-select') ||
        (comparison === 'reference-any-of' && field.kind !== 'article-reference'))
      throw new ProtocolError('Invalid filter comparison for property field')
    const index = validateCondition(schema, { definitionId: field.id, definitionRevision: field.revision, comparison, value, anyOf }, seen)
    output.uuid(field.id)
    output.i64(field.revision)
    output.i32(index | (anyOf ? anyOfPropertyFlag : 0))
    writeValue(output, value)
  }
}

export function readPropertyConditions(
  input: PodReader, schema: bigint, emptySchema: EmptyPropertySchema = 'disallowed',
): PropertyQueryOperand[] {
  const count = input.i32()
  validateConditionCount(schema, count, emptySchema)
  const seen = new Set<string>()
  const conditions = Array.from({ length: count }, () => {
    const definitionId = input.uuid(), definitionRevision = input.i64()
    const code = input.i32()
    const comparison = propertyComparisons[code & ~anyOfPropertyFlag]
    const operand = { definitionId, definitionRevision, comparison, value: readPropertyOperand(input),
      ...(code & anyOfPropertyFlag ? { anyOf: true } : {}) }
    validateCondition(schema, operand, seen)
    return operand
  })
  validateAlternatives(conditions)
  return conditions
}

function validateConditionCount(schema: bigint, count: number, emptySchema: EmptyPropertySchema): void {
  const valid = count === 0
    ? emptySchema === 'zero' ? schema === 0n : emptySchema === 'positive' && schema > 0n
    : schema > 0n
  if (!valid || count < 0 || count > WireLimits.PropertyQueryConditionCount)
    throw new ProtocolError('Invalid property condition count or schema revision')
}

function validateCondition(schema: bigint, condition: PropertyQueryOperand, seen: Set<string>): number {
  const { definitionId, definitionRevision, comparison, value, anyOf } = condition
  const index = propertyComparisons.indexOf(comparison)
  const operand = value.kind === 'multi-select' || value.kind === 'article-reference'
    ? { ...value, value: [...value.value].sort() } : value
  const key = `${definitionId.toLowerCase()}:${index}:${anyOf ? JSON.stringify(operand) : ''}`
  if (definitionId === '00000000-0000-0000-0000-000000000000' ||
      definitionRevision <= 0n || definitionRevision > schema || seen.has(key) ||
      !validComparison(comparison, value))
    throw new ProtocolError('Invalid property condition')
  seen.add(key)
  return index
}

function validateAlternatives(conditions: ReadonlyArray<Pick<PropertyQueryOperand, 'definitionId' | 'definitionRevision' | 'anyOf'>>): void {
  for (const condition of conditions) {
    if (!condition.anyOf) continue
    const group = conditions.filter(candidate => candidate.definitionId.toLowerCase() === condition.definitionId.toLowerCase())
    if (group.length < 2 || group.some(candidate => !candidate.anyOf || candidate.definitionRevision !== condition.definitionRevision))
      throw new ProtocolError('Invalid same-field property alternatives')
  }
}

function validComparison(comparison: PropertyComparison, value: PropertyValue): boolean {
  switch (comparison) {
    case 'equal': return true
    case 'is-present': return value.kind === 'missing'
    case 'multi-select-any-of': return value.kind === 'multi-select'
    case 'single-select-any-of': return value.kind === 'multi-select' && value.value.length > 0
    case 'reference-any-of': return value.kind === 'article-reference'
    case 'less-than': case 'at-most': case 'greater-than': case 'at-least':
      return value.kind === 'number' || value.kind === 'date'
    default: return false
  }
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

export function queryPropertyArticles(query: PropertyQuery, signal?: AbortSignal, session?: string): Promise<PropertyMatches> {
  return request(WireRoutes.PropertyArticleQuery, FrameType.PropertyArticlePage, decodePropertyMatches,
    signal, 'POST', encodePropertyQuery(query), query.keyword ? siteSessionHeader(session) : undefined)
}
