import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request, siteSessionHeader } from './client.ts'
import { encodePropertyTextHitRequest, type PropertyTextHitRequest } from './property-text-hit.ts'
import {
  decodePropertyCommandReceipt, decodePropertyValueBatchReceipt, encodePropertyWorkspaceRequest, FrameType, WireLimits, WireRoutes,
  type PropertyDefinitionCommand, type PropertyTextCommand, type PropertyWorkspaceRequest,
} from './wire.generated.ts'
export { decodePropertyValueBatchReceipt, type PropertyValueBatchReceipt } from './wire.generated.ts'

export const propertyKinds = ['text', 'number', 'boolean', 'date', 'single-select', 'multi-select', 'article-reference', 'url'] as const
export type PropertyKind = typeof propertyKinds[number]

type StringKind = 'text' | 'number' | 'date' | 'single-select' | 'url'
type StringValue = { [Kind in StringKind]: { kind: Kind; value: string } }[StringKind]

export type PropertyValue =
  | { kind: 'missing' }
  | { kind: 'null' }
  | StringValue
  | { kind: 'boolean'; value: boolean }
  | { kind: 'multi-select'; value: string[] }
  | { kind: 'article-reference'; value: number[] }

export type PropertyReadValue = PropertyValue | { kind: 'unavailable' }

export type PropertyOption = { id: string; label: string }

export type PropertySchemaCommand = PropertyDefinitionCommand & {
  kind?: PropertyKind
  options?: readonly PropertyOption[]
}

export type PropertyValueCommand = Omit<PropertyTextCommand, 'remove' | 'value'> & { value: PropertyValue }
export type PropertyValueChange = Pick<PropertyValueCommand, 'definitionId' | 'definitionRevision' | 'value'>
export type PropertyValueBatchCommand = Omit<PropertyValueCommand, keyof PropertyValueChange> & {
  changes: readonly PropertyValueChange[]
}

export type EditableProperty = {
  definitionId: string
  definitionRevision: bigint
  machineKey: string
  label: string
  deprecated: boolean
  kind: PropertyKind
  options: PropertyOption[]
  value: PropertyReadValue
}

export type PropertyWorkspace = {
  articleId: number
  articleRevision: bigint
  schemaRevision: bigint
  valueRevision: bigint
  nextKey: string
  fields: EditableProperty[]
}

export type { PropertyWorkspaceRequest }

const maxOptions = WireLimits.PropertyOptionCount
const maxReferences = WireLimits.PropertyOptionCount
const zeroUuid = '00000000-0000-0000-0000-000000000000'
const maxDecimalCoefficient = 79_228_162_514_264_337_593_543_950_335n
const machineKey = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/
const control = /[\u0000-\u001F\u007F-\u009F]/

function requireProperty(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new ProtocolError(`Invalid AEDS property ${detail}`)
}

function uuid(value: string): string {
  requireProperty(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) && value !== zeroUuid, 'identifier')
  return value.toLowerCase()
}

function label(value: string): string {
  requireProperty(value.trim().length > 0 && value.length <= 256 && !control.test(value), 'label')
  return value
}

function key(value: string): string {
  requireProperty(machineKey.test(value) && value.length <= WireLimits.PropertyKeyBytes, 'key')
  return value
}

function limitCount(count: number, max: number): number {
  requireProperty(Number.isInteger(count) && count >= 0 && count <= max, 'collection size')
  return count
}

function unique<T>(values: readonly T[]): void {
  requireProperty(new Set(values).size === values.length, 'duplicate item')
}

function optionIds(ids: readonly string[]): string[] {
  limitCount(ids.length, maxOptions)
  const normalized = ids.map(uuid)
  unique(normalized)
  return normalized
}

function articleIds(ids: readonly number[]): void {
  limitCount(ids.length, maxReferences)
  requireProperty(ids.every(id => Number.isInteger(id) && id > 0 && id <= 0x7fffffff), 'article identity')
  unique(ids)
}

function isSelection(kind: PropertyKind): boolean {
  return kind === 'single-select' || kind === 'multi-select'
}

function checkOptions(kind: PropertyKind, options: readonly PropertyOption[]): void {
  requireProperty(isSelection(kind) === (options.length !== 0), 'options for kind')
  optionIds(options.map(option => option.id))
  for (const option of options) label(option.label)
}

function writeOptions(output: PodWriter, options: readonly PropertyOption[]): void {
  output.i32(limitCount(options.length, maxOptions))
  for (const option of options) {
    output.uuid(uuid(option.id))
    output.text(label(option.label), WireLimits.PropertyLabelBytes)
  }
}

function readOptions(input: PodReader, kind: PropertyKind): PropertyOption[] {
  const count = limitCount(input.i32(), maxOptions)
  const options = Array.from({ length: count }, () => ({
    id: uuid(input.uuid()),
    label: label(input.text(WireLimits.PropertyLabelBytes)),
  }))
  checkOptions(kind, options)
  return options
}

/** Normalize exact base 10 spelling without passing through a JavaScript number. */
export function normalizePropertyDecimal(value: string): string {
  requireProperty(value.length <= WireLimits.PropertyDecimalBytes && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value), 'decimal notation')
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const integer = whole.replace(/^0+(?=[0-9])/, '')
  const fractional = fraction.replace(/0+$/, '')
  requireProperty(fractional.length <= 28, 'decimal scale')
  const exact = BigInt(integer + fractional)
  requireProperty(exact <= maxDecimalCoefficient, 'decimal range')
  return (negative && exact !== 0n ? '-' : '') + integer + (fractional.length !== 0 ? '.' + fractional : '')
}

function canonicalDecimal(value: string): string {
  requireProperty(value === normalizePropertyDecimal(value), 'decimal canonical form')
  return value
}

function utcDate(value: string): string {
  requireProperty(/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value), 'UTC date notation')
  const date = new Date(value)
  requireProperty(Number.isFinite(date.valueOf()) && date.toISOString() === value, 'UTC date')
  return value
}

function url(value: string): string {
  requireProperty(value.length > 0 && !/[\s\\]/u.test(value) && !control.test(value), 'URL')
  return value
}

function propertyText(value: string): string {
  requireProperty(value.length <= 16_384 && !control.test(value), 'text')
  return value
}

function decodeKind(tag: number): PropertyKind {
  const kind = propertyKinds[tag]
  requireProperty(kind !== undefined, 'kind')
  return kind
}

export function writeValue(output: PodWriter, property: PropertyValue): void {
  if (property.kind === 'missing' || property.kind === 'null') {
    output.i32(property.kind === 'missing' ? -2 : -1)
    return
  }
  const tag = propertyKinds.indexOf(property.kind)
  requireProperty(tag >= 0, 'value kind')
  output.i32(tag)
  switch (property.kind) {
    case 'text':
      output.text(propertyText(property.value), WireLimits.PropertyValueBytes)
      break
    case 'number':
      output.text(canonicalDecimal(property.value), WireLimits.PropertyDecimalBytes)
      break
    case 'date':
      output.text(utcDate(property.value), WireLimits.PropertyDateBytes)
      break
    case 'url':
      output.text(url(property.value), WireLimits.PropertyUrlBytes)
      break
    case 'boolean':
      requireProperty(typeof property.value === 'boolean', 'boolean')
      output.bool(property.value)
      break
    case 'single-select':
      output.uuid(uuid(property.value))
      break
    case 'multi-select': {
      const ids = optionIds(property.value)
      output.i32(ids.length)
      for (const id of ids) output.uuid(id)
      break
    }
    case 'article-reference':
      articleIds(property.value)
      output.i32s(property.value, maxReferences)
      break
  }
}

function readValue(input: PodReader, kind: PropertyKind): PropertyReadValue {
  const tag = input.i32()
  if (tag === -3) {
    requireProperty(kind === 'article-reference', 'unavailable reference')
    return { kind: 'unavailable' }
  }
  if (tag >= 0) requireProperty(decodeKind(tag) === kind, 'definition/value kind mismatch')
  return readTaggedValue(input, tag)
}

// Query operands carry their type tag and no client-side definition metadata.
export function readPropertyOperand(input: PodReader): PropertyValue {
  return readTaggedValue(input, input.i32())
}

function readTaggedValue(input: PodReader, tag: number): PropertyValue {
  if (tag === -2) return { kind: 'missing' }
  if (tag === -1) return { kind: 'null' }
  const kind = decodeKind(tag)
  switch (kind) {
    case 'text':
      return { kind, value: propertyText(input.text(WireLimits.PropertyValueBytes)) }
    case 'number':
      return { kind, value: canonicalDecimal(input.text(WireLimits.PropertyDecimalBytes)) }
    case 'date':
      return { kind, value: utcDate(input.text(WireLimits.PropertyDateBytes)) }
    case 'url':
      return { kind, value: url(input.text(WireLimits.PropertyUrlBytes)) }
    case 'boolean':
      return { kind, value: input.bool() }
    case 'single-select':
      return { kind, value: uuid(input.uuid()) }
    case 'multi-select': {
      const count = limitCount(input.i32(), maxOptions)
      return { kind, value: optionIds(Array.from({ length: count }, () => input.uuid())) }
    }
    case 'article-reference': {
      const value = input.i32s(maxReferences)
      articleIds(value)
      return { kind, value }
    }
  }
}

function checkValueOptions(value: PropertyReadValue, options: readonly PropertyOption[]): void {
  if (value.kind !== 'single-select' && value.kind !== 'multi-select') return
  const selected = value.kind === 'single-select' ? [value.value] : value.value
  const available = new Set(options.map(item => item.id))
  requireProperty(selected.every(id => available.has(id)), 'selected option identity')
}

export function encodePropertySchemaCommand(input: PropertySchemaCommand): Uint8Array {
  requireProperty(input.operation >= 1 && input.operation <= 4 && input.schemaRevision >= 0n &&
    input.definitionRevision >= 0n && (input.operation === 1) === (input.definitionRevision === 0n) &&
    (input.operation === 1) === (input.machineKey.length !== 0) &&
    (input.operation === 1 || input.operation === 2) === (input.label.length !== 0), 'definition command')
  const creating = input.operation === 1
  const kind = input.kind ?? 'text'
  const tag = propertyKinds.indexOf(kind)
  const options = input.options ?? []
  requireProperty(tag >= 0 && (creating || tag === 0 && options.length === 0), 'definition command options')
  checkOptions(kind, options)

  const writer = new PodWriter()
  writer.i32(input.operation)
  writer.uuid(uuid(input.definitionId))
  writer.uuid(uuid(input.requestId))
  writer.i64(input.schemaRevision)
  writer.i64(input.definitionRevision)
  writer.text(creating ? key(input.machineKey) : '', WireLimits.PropertyKeyBytes)
  writer.text(input.label.length > 0 ? label(input.label) : '', WireLimits.PropertyLabelBytes)
  writer.i32(tag)
  writeOptions(writer, options)
  return writer.finish()
}

export function encodePropertyValueCommand(input: PropertyValueCommand): Uint8Array {
  requireProperty(input.articleId > 0 && input.articleRevision > 0n && input.schemaRevision > 0n &&
    input.valueRevision >= 0n && input.definitionRevision > 0n, 'value command coordinates')
  const writer = new PodWriter()
  writer.i32(input.articleId)
  writer.i64(input.articleRevision)
  writer.i64(input.schemaRevision)
  writer.i64(input.valueRevision)
  writer.uuid(uuid(input.definitionId))
  writer.i64(input.definitionRevision)
  writer.uuid(uuid(input.requestId))
  writeValue(writer, input.value)
  return writer.finish()
}

export function encodePropertyValueBatch(input: PropertyValueBatchCommand): Uint8Array {
  requireProperty(input.articleId > 0 && input.articleRevision > 0n && input.schemaRevision > 0n &&
    input.valueRevision >= 0n && input.valueRevision < 9_223_372_036_854_775_807n &&
    input.changes.length > 0 && input.changes.length <= WireLimits.PropertyBatchMaxChanges, 'batch coordinates')
  const writer = new PodWriter()
  writer.i32(input.articleId)
  writer.i64(input.articleRevision)
  writer.i64(input.schemaRevision)
  writer.i64(input.valueRevision)
  writer.uuid(uuid(input.requestId))
  writer.i32(input.changes.length)
  const fields = new Set<string>()
  for (const change of input.changes) {
    const id = uuid(change.definitionId)
    requireProperty(change.definitionRevision > 0n && !fields.has(id), 'batch field')
    fields.add(id)
    writer.uuid(id)
    writer.i64(change.definitionRevision)
    writeValue(writer, change.value)
  }
  return writer.finish()
}

export function decodePropertyEditor(payload: Uint8Array): PropertyWorkspace {
  const reader = new PodReader(payload)
  const articleId = reader.i32()
  const articleRevision = reader.i64()
  const schemaRevision = reader.i64()
  const valueRevision = reader.i64()
  const nextKey = reader.text(WireLimits.PropertyKeyBytes)
  const size = limitCount(reader.i32(), WireLimits.PropertyPageSize)
  requireProperty(articleId > 0 && articleRevision > 0n && schemaRevision >= 0n && valueRevision >= 0n, 'workspace coordinates')
  const fields: EditableProperty[] = []
  const identities = new Set<string>()
  let previous = ''
  for (let index = 0; index < size; index++) {
    const definitionId = uuid(reader.uuid())
    const definitionRevision = reader.i64()
    const machineKey = key(reader.text(WireLimits.PropertyKeyBytes))
    const title = label(reader.text(WireLimits.PropertyLabelBytes))
    const deprecated = reader.bool()
    const kind = decodeKind(reader.i32())
    const options = readOptions(reader, kind)
    const value = readValue(reader, kind)
    requireProperty(definitionRevision > 0n && definitionRevision <= schemaRevision &&
      machineKey > previous && !identities.has(definitionId), 'field coordinates')
    checkValueOptions(value, options)
    fields.push({ definitionId, definitionRevision, machineKey, label: title, deprecated, kind, options, value })
    identities.add(definitionId)
    previous = machineKey
  }
  requireProperty(!nextKey || (size === WireLimits.PropertyPageSize && nextKey === previous), 'cursor')
  reader.finish()
  return { articleId, articleRevision, schemaRevision, valueRevision, nextKey, fields }
}

function readReceipt(payload: Uint8Array) {
  const receipt = decodePropertyCommandReceipt(payload)
  uuid(receipt.definitionId)
  requireProperty(receipt.schemaRevision > 0n && receipt.revision > 0n, 'receipt coordinates')
  return receipt
}

export const propertyApi = {
  history(input: { articleId: number; articleRevision: bigint; sourceRevision: bigint; offset?: number },
    credential: string, signal?: AbortSignal): Promise<PropertyWorkspace> {
    const offset = input.offset ?? 0
    requireProperty(input.articleId > 0 && input.sourceRevision > 0n && input.sourceRevision <= input.articleRevision &&
      Number.isInteger(offset) && offset >= 0,
      'saved revision coordinates')
    const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(input.articleId))
      .replace('{sourceRevision:long}', String(input.sourceRevision))
    const cursor = offset === 0 ? '' : `&offset=${offset}`
    return request(`${path}?revision=${input.articleRevision}&map=properties${cursor}`, FrameType.PropertyEditor, payload => {
      const page = decodePropertyEditor(payload)
      requireProperty(page.articleId === input.articleId && page.articleRevision === input.sourceRevision, 'saved property response')
      return page
    }, signal, 'GET', undefined, siteSessionHeader(credential))
  },
  textHit(input: PropertyTextHitRequest, credential: string, signal?: AbortSignal): Promise<PropertyWorkspace> {
    return request(WireRoutes.PropertyEditor, FrameType.PropertyEditor, payload => {
      const response = decodePropertyEditor(payload)
      const [field] = response.fields
      requireProperty(response.articleId === input.articleId && response.articleRevision === input.articleRevision &&
        response.schemaRevision === input.schemaRevision && response.valueRevision > 0n &&
        (input.valueRevision === 0n || response.valueRevision === input.valueRevision) && response.nextKey === '' &&
        response.fields.length === 1 && field.definitionId === input.definitionId && field.definitionRevision === input.definitionRevision &&
        field.kind === 'text' && !field.deprecated && field.value.kind === 'text', 'saved Text hit response')
      return response
    }, signal, 'POST', encodePropertyTextHitRequest(input), siteSessionHeader(credential))
  },
  workspace(input: PropertyWorkspaceRequest, signal?: AbortSignal) {
    requireProperty(input.articleId > 0 && input.articleRevision > 0n && input.schemaRevision >= 0n && input.valueRevision >= 0n &&
      (input.afterKey ? machineKey.test(input.afterKey) : input.schemaRevision === 0n && input.valueRevision === 0n), 'workspace request')
    const body = encodeFrame(FrameType.PropertyWorkspaceRequest, encodePropertyWorkspaceRequest(input))
    return request(WireRoutes.PropertyEditor, FrameType.PropertyEditor, payload => {
      const response = decodePropertyEditor(payload)
      requireProperty(response.articleId === input.articleId && response.articleRevision === input.articleRevision,
        'workspace response article')
      if (input.afterKey) {
        requireProperty(response.schemaRevision === input.schemaRevision && response.valueRevision === input.valueRevision &&
          response.fields.every(field => field.machineKey > input.afterKey), 'workspace response continuation')
      }
      return response
    }, signal, 'POST', body)
  },
  definition(input: PropertySchemaCommand, signal?: AbortSignal) {
    const body = encodeFrame(FrameType.PropertySchemaCommand, encodePropertySchemaCommand(input))
    return request(WireRoutes.PropertySchemaCommand, FrameType.PropertyCommandReceipt, payload => {
      const receipt = readReceipt(payload)
      requireProperty(receipt.definitionId === uuid(input.definitionId) &&
        receipt.schemaRevision === input.schemaRevision + 1n && receipt.revision === input.definitionRevision + 1n, 'definition receipt')
      return receipt
    }, signal, 'POST', body)
  },
  value(input: PropertyValueCommand, signal?: AbortSignal) {
    const body = encodeFrame(FrameType.PropertyValueCommand, encodePropertyValueCommand(input))
    return request(WireRoutes.PropertyValueCommand, FrameType.PropertyCommandReceipt, payload => {
      const receipt = readReceipt(payload)
      requireProperty(receipt.definitionId === uuid(input.definitionId) &&
        receipt.schemaRevision === input.schemaRevision && receipt.revision === input.valueRevision + 1n, 'value receipt')
      return receipt
    }, signal, 'POST', body)
  },
  values(input: PropertyValueBatchCommand, signal?: AbortSignal, credential?: string) {
    const body = encodeFrame(FrameType.PropertyValueBatchCommand, encodePropertyValueBatch(input))
    return request(WireRoutes.PropertyValueCommand, FrameType.PropertyValueBatchReceipt, payload => {
      const receipt = decodePropertyValueBatchReceipt(payload)
      requireProperty(receipt.articleId === input.articleId && receipt.schemaRevision === input.schemaRevision &&
        receipt.valueRevision === input.valueRevision + 1n && receipt.requestId === uuid(input.requestId), 'batch receipt')
      return receipt
    }, signal, 'POST', body, credential === undefined ? undefined : siteSessionHeader(credential))
  },
}
