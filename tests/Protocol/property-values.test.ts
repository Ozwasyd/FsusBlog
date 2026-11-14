import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import {
  decodePropertyEditor, encodePropertySchemaCommand, encodePropertyValueCommand, normalizePropertyDecimal, propertyApi,
  type PropertySchemaCommand, type PropertyValueCommand,
} from '../../src/Contracts/property-values.ts'
import { encodePropertyCommandReceipt, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

// Independently assembled with Python struct/UUID and bitwise CRC, without the production codec.
function fixture(name: string): Uint8Array {
  const hex = readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8').trim()
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

const definitionId = '00000000-0000-4000-8000-000000000006'
const requestId = '0a0b0c0d-1111-4000-8000-010203040506'
const red = { id: 'af970001-2222-4000-8000-112233445566', label: 'Red' }
const blue = { id: 'af970002-2222-4000-8000-112233445566', label: '蓝色' }
const valueCommand = {
  articleId: 17, articleRevision: 9007199254740993n, schemaRevision: 10n, valueRevision: 8n,
  definitionId, definitionRevision: 1n, requestId, value: { kind: 'number', value: '-9007199254740993.000000000001' },
} satisfies PropertyValueCommand
const schemaCommand = {
  operation: 1, definitionId: '00000000-0000-4000-8000-000000000004', requestId, schemaRevision: 10n,
  definitionRevision: 0n, machineKey: 'multi', label: 'Multiple', kind: 'multi-select', options: [red, blue],
} satisfies PropertySchemaCommand

test('typed editor decodes eight exact variants and preserves null and missing', () => {
  const workspace = decodePropertyEditor(decodeFrame(fixture('property-editor-typed'), FrameType.PropertyEditor).payload)
  assert.equal(workspace.articleId, 17)
  assert.equal(workspace.articleRevision, 9007199254740993n)
  assert.equal(workspace.schemaRevision, 10n)
  assert.equal(workspace.valueRevision, 8n)
  assert.deepEqual(workspace.fields.map(field => field.value), [
    { kind: 'article-reference', value: [5, 40] },
    { kind: 'boolean', value: false },
    { kind: 'date', value: '2024-02-29T14:12:06.015Z' },
    { kind: 'multi-select', value: [blue.id, red.id] },
    { kind: 'null' },
    { kind: 'number', value: '-9007199254740993.000000000001' },
    { kind: 'single-select', value: blue.id },
    { kind: 'text', value: '空值不同于未设置 🐈' },
    { kind: 'missing' },
    { kind: 'url', value: 'https://example.org/a?q=x%20y' },
  ])
  assert.deepEqual(workspace.fields[3]?.options, [red, blue])
  assert.equal(workspace.fields[6]?.deprecated, true)
})

test('typed editor rejects payload truncation, trailing bytes, and mismatched kinds', () => {
  const payload = decodeFrame(fixture('property-editor-typed'), FrameType.PropertyEditor).payload
  assert.throws(() => decodePropertyEditor(payload.subarray(0, -1)), ProtocolError)
  assert.throws(() => decodePropertyEditor(Uint8Array.of(...payload, 0)), ProtocolError)

  // First value tag follows the workspace header, two bounded strings and empty options collection.
  const tag = 36 + 16 + 8 + 4 + 'article'.length + 4 + 'Reference'.length + 1 + 4 + 4
  const changed = Uint8Array.from(payload)
  new DataView(changed.buffer).setInt32(tag, 5, true)
  assert.throws(() => decodePropertyEditor(changed), /definition\/value kind mismatch/)
  new DataView(changed.buffer).setInt32(tag, 99, true)
  assert.throws(() => decodePropertyEditor(changed), /kind/)
})

test('unavailable references reveal no IDs and cannot be encoded as an edit', () => {
  const published = decodeFrame(fixture('property-editor-typed'), FrameType.PropertyEditor).payload
  const tag = 36 + 16 + 8 + 4 + 'article'.length + 4 + 'Reference'.length + 1 + 4 + 4
  // Replace the reference tag and its count + two IDs with the read-only availability marker.
  const unavailable = Uint8Array.of(...published.subarray(0, tag), 0xfd, 0xff, 0xff, 0xff, ...published.subarray(tag + 16))
  assert.deepEqual(decodePropertyEditor(unavailable).fields[0]?.value, { kind: 'unavailable' })

  const incompatibleKind = Uint8Array.from(unavailable)
  new DataView(incompatibleKind.buffer).setInt32(tag - 8, 0, true)
  assert.throws(() => decodePropertyEditor(incompatibleKind), /unavailable reference/)
  assert.throws(() => encodePropertyValueCommand({
    ...valueCommand,
    // @ts-expect-error Availability belongs to reads, never to edits.
    value: { kind: 'unavailable' },
  }), ProtocolError)
})

test('property commands match independently framed bytes', () => {
  assert.deepEqual(encodeFrame(FrameType.PropertySchemaCommand, encodePropertySchemaCommand(schemaCommand)),
    fixture('property-definition-options'))
  assert.deepEqual(encodeFrame(FrameType.PropertyValueCommand, encodePropertyValueCommand(valueCommand)),
    fixture('property-value-exact-decimal'))
})

test('typed writers reject unsupported identity, dates, and exact decimal overflow', () => {
  assert.equal(normalizePropertyDecimal('-000.000'), '0')
  assert.equal(normalizePropertyDecimal('09007199254740993.0020000'), '9007199254740993.002')
  assert.equal(normalizePropertyDecimal('79228162514264337593543950335'), '79228162514264337593543950335')
  assert.equal(normalizePropertyDecimal('0.0000000000000000000000000001'), '0.0000000000000000000000000001')
  for (const invalid of ['1e4', '1\n', '1,000', '79228162514264337593543950336', '0.00000000000000000000000000001']) {
    assert.throws(() => normalizePropertyDecimal(invalid), ProtocolError)
  }
  assert.throws(() => encodePropertyValueCommand({ ...valueCommand, value: { kind: 'number', value: '1.0' } }), ProtocolError)
  assert.throws(() => encodePropertyValueCommand({ ...valueCommand, value: { kind: 'date', value: '2023-02-29T14:12:06.015Z' } }), ProtocolError)
  assert.throws(() => encodePropertyValueCommand({ ...valueCommand, value: { kind: 'article-reference', value: [2, 2] } }), ProtocolError)
  assert.throws(() => encodePropertyValueCommand({ ...valueCommand, value: { kind: 'article-reference', value: [2147483648] } }), ProtocolError)
  assert.throws(() => encodePropertySchemaCommand({ ...schemaCommand, options: [red, { ...red, id: red.id.toUpperCase() }] }),
    ProtocolError)
})

test('typed client only accepts workspace and receipts bound to the submitted revision and identity', async t => {
  const calls: { path: string; method?: string }[] = []
  let body: Uint8Array = fixture('property-editor-typed')
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, method: init.method })
    return new Response(Uint8Array.from(body), { headers: { 'content-type': 'application/octet-stream' } })
  })
  await propertyApi.workspace({ articleId: 17, articleRevision: 9007199254740993n, schemaRevision: 0n, valueRevision: 0n, afterKey: '' })
  await assert.rejects(propertyApi.workspace({
    articleId: 18, articleRevision: 9007199254740993n, schemaRevision: 0n, valueRevision: 0n, afterKey: '',
  }), /workspace response article/)
  body = encodeFrame(FrameType.PropertyCommandReceipt, encodePropertyCommandReceipt({
    definitionId, schemaRevision: 10n, revision: 9n,
  }))
  await propertyApi.value(valueCommand)
  await assert.rejects(propertyApi.value({ ...valueCommand, valueRevision: 9n }), /value receipt/)
  assert.deepEqual(calls, [
    { path: WireRoutes.PropertyEditor, method: 'POST' },
    { path: WireRoutes.PropertyEditor, method: 'POST' },
    { path: WireRoutes.PropertyValueCommand, method: 'POST' },
    { path: WireRoutes.PropertyValueCommand, method: 'POST' },
  ])
})
