import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import {
  decodePropertyEditor, encodePropertySchemaCommand, encodePropertyValueBatch, encodePropertyValueCommand,
  normalizePropertyDecimal, propertyApi, type PropertySchemaCommand, type PropertyValueBatchCommand, type PropertyValueCommand,
} from '../../src/Contracts/property-values.ts'
import { encodePropertyCommandReceipt, FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { encodePropertyQuery, queryPropertyArticles, type FilterField } from '../../src/Contracts/property-query.ts'
import {
  decodePropertyTextHitRequest, encodePropertyTextHitRequest, type PropertyTextHitRequest,
} from '../../src/Contracts/property-text-hit.ts'

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

test('property batch uses fixed mixed-value bytes and binds the receipt to the command', async t => {
  const batch = {
    articleId: valueCommand.articleId, articleRevision: valueCommand.articleRevision,
    schemaRevision: valueCommand.schemaRevision, valueRevision: valueCommand.valueRevision, requestId,
    changes: [
      { definitionId, definitionRevision: 1n, value: valueCommand.value },
      { definitionId: schemaCommand.definitionId, definitionRevision: 3n, value: { kind: 'missing' } },
    ],
  } satisfies PropertyValueBatchCommand
  assert.throws(() => encodePropertyValueBatch({ ...batch, changes: [] }), /batch coordinates/)
  assert.throws(() => encodePropertyValueBatch({ ...batch, changes: [...batch.changes, batch.changes[0]] }), /batch field/)

  const credential = 'a'.repeat(64)
  let returned = fixture('property-value-batch-receipt')
  const fetch = t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, WireRoutes.PropertyValueCommand)
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get(WireHeaders.CurrentSession), credential)
    assert.deepEqual(init.body, fixture('property-value-batch'))
    return new Response(returned, { headers: { 'content-type': 'application/octet-stream' } })
  })
  assert.deepEqual(await propertyApi.values(batch, undefined, credential), {
    articleId: 17, schemaRevision: 10n, valueRevision: 9n, requestId,
  })
  const payload = Uint8Array.from(decodeFrame(returned, FrameType.PropertyValueBatchReceipt).payload)
  new DataView(payload.buffer).setBigInt64(12, 10n, true)
  returned = encodeFrame(FrameType.PropertyValueBatchReceipt, payload)
  await assert.rejects(propertyApi.values(batch, undefined, credential), /batch receipt/)
  assert.equal(fetch.mock.callCount(), 2)
})

test('the AND request preserves independent decimal and UTC comparison bytes', async t => {
  const base: FilterField = { id: definitionId, revision: 2n, kind: 'number', machineKey: 'score', label: 'Score',
    enabled: true, deprecated: false, options: [] }
  const fetch = t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, WireRoutes.PropertyArticleQuery)
    assert.equal(init.method, 'POST')
    assert.deepEqual(init.body, fixture('property-query-group'))
    return new Response(encodeFrame(FrameType.PropertyArticlePage, new Uint8Array(8)),
      { headers: { 'content-type': 'application/octet-stream' } })
  })
  assert.deepEqual(await queryPropertyArticles({ schema: 10n, cursor: '', conditions: [
    { field: base, comparison: 'at-least', value: valueCommand.value },
    { field: { ...base, id: '12345678-1234-4000-9000-123456789abc', revision: 3n, kind: 'date' },
      comparison: 'at-most', value: { kind: 'date', value: '2024-02-29T14:12:06.015Z' } },
  ] }), { nextCursor: '', rows: [] })
  assert.equal(fetch.mock.callCount(), 1)
})

test('property presence uses the operand-free comparison bytes', () => {
  const field: FilterField = { id: definitionId, revision: 2n, kind: 'number', machineKey: 'score', label: 'Score',
    enabled: true, deprecated: false, options: [] }
  const query = { schema: 10n, cursor: '' }
  assert.deepEqual(encodePropertyQuery({ ...query, conditions: [{ field, comparison: 'is-present', value: { kind: 'missing' } }] }),
    fixture('property-query-presence'))
  assert.throws(() => encodePropertyQuery({ ...query, conditions: [{ field, comparison: 'is-present', value: { kind: 'null' } }] }),
    ProtocolError)
})

test('title or summary keyword has its own exact frame and current-session witness', async t => {
  const field: FilterField = { id: definitionId, revision: 2n, kind: 'number', machineKey: 'score', label: 'Score',
    enabled: true, deprecated: false, options: [] }
  const query = { schema: 10n, cursor: '', keyword: '%_雪',
    conditions: [{ field, comparison: 'is-present', value: { kind: 'missing' } }] } as const
  const bytes = fixture('property-query-keyword')
  assert.deepEqual(encodePropertyQuery(query), bytes)
  assert.deepEqual(encodePropertyQuery({ ...query, keyword: '' }), fixture('property-query-presence'))
  for (const keyword of ['\u00a0a', 'a\u0085b', '\ud800', '雪'.repeat(129)])
    assert.throws(() => encodePropertyQuery({ ...query, keyword }), ProtocolError)
  assert.doesNotThrow(() => encodePropertyQuery({ ...query, keyword: '🐈'.repeat(64) }))
  const session = 'a'.repeat(WireLimits.SiteSessionIdBytes)
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(new Headers(init?.headers).get(WireHeaders.CurrentSession), session)
    assert.deepEqual(new Uint8Array(await new Response(init?.body).arrayBuffer()), bytes)
    return new Response(encodeFrame(FrameType.PropertyArticlePage, new Uint8Array(8)),
      { headers: { 'content-type': 'application/octet-stream' } })
  })
  assert.deepEqual(await queryPropertyArticles(query, undefined, session), { nextCursor: '', rows: [] })
  assert.equal(fetch.mock.callCount(), 1)
})

test('multi-select alternatives preserve independent query bytes', () => {
  const field: FilterField = { id: definitionId, revision: 2n, kind: 'multi-select', machineKey: 'tag', label: 'Tag',
    enabled: true, deprecated: false, options: [red, blue] }
  const condition = { field, comparison: 'multi-select-any-of', value: { kind: 'multi-select', value: [blue.id, red.id] } } as const
  const query = { schema: 10n, cursor: '', conditions: [condition] }
  assert.deepEqual(encodePropertyQuery(query), fixture('property-query-multi-select-any-of'))
  assert.throws(() => encodePropertyQuery({ ...query, conditions: [{ ...condition, field: { ...field, kind: 'single-select' } }] }),
    ProtocolError)
  assert.throws(() => encodePropertyQuery({ ...query, conditions: [{ ...condition, value: { kind: 'null' } }] }), ProtocolError)
})

test('single-select filters encode nonempty UUID alternatives without changing stored values', () => {
  const field: FilterField = { id: definitionId, revision: 2n, kind: 'single-select', machineKey: 'tag', label: 'Tag',
    enabled: true, deprecated: false, options: [red, blue] }
  const condition = { field, comparison: 'single-select-any-of', value: { kind: 'multi-select', value: [blue.id, red.id] } } as const
  const query = { schema: 10n, cursor: '', conditions: [condition] }
  assert.deepEqual(encodePropertyQuery(query), fixture('property-query-single-select-any-of'))
  assert.throws(() => encodePropertyQuery({ ...query, conditions: [{ ...condition, value: { kind: 'multi-select', value: [] } }] }),
    ProtocolError)
  assert.throws(() => encodePropertyQuery({ ...query, conditions: [{ ...condition, field: { ...field, kind: 'multi-select' } }] }),
    ProtocolError)
})

test('reference alternatives encode the bounded existing article reference carrier', () => {
  const field: FilterField = { id: definitionId, revision: 2n, kind: 'article-reference', machineKey: 'reference',
    label: 'Reference', enabled: true, deprecated: false, options: [] }
  const condition = { field, comparison: 'reference-any-of', value: { kind: 'article-reference', value: [42, 17] } } as const
  const query = { schema: 10n, cursor: '', conditions: [condition] }
  assert.deepEqual(encodePropertyQuery(query), fixture('property-query-reference-any-of'))
  assert.doesNotThrow(() => encodePropertyQuery({ ...query, conditions: [{ ...condition, value: { kind: 'article-reference', value: [] } }] }))
  assert.throws(() => encodePropertyQuery({ ...query, conditions: [{ ...condition, value: { kind: 'article-reference', value: [17, 17] } }] }),
    ProtocolError)
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


test('exact property hit request binds saved revisions and carries one fixed-width digest', () => {
  // Packed independently with Python struct, network-order UUID and SHA-256 of "Raw 北 house".
  const expected = Buffer.from(
    '1100000001000000000020000a000000000000000900000000000000111111111111411181111111111111110300000000000000' +
    '6483f3cdcb9d29881ca70c82853ba6959b38994c5ac381120dfebaafe6ce567a',
    'hex',
  )
  const request: PropertyTextHitRequest = {
    articleId: 17, articleRevision: 9007199254740993n, schemaRevision: 10n, valueRevision: 9n,
    definitionId: '11111111-1111-4111-8111-111111111111', definitionRevision: 3n,
    sourceDigest: Uint8Array.from(Buffer.from('6483f3cdcb9d29881ca70c82853ba6959b38994c5ac381120dfebaafe6ce567a', 'hex')),
  }
  const frame = encodePropertyTextHitRequest(request)
  assert.equal(FrameType.PropertyTextHitRequest, 33034)
  assert.equal(frame.byteLength, 100)
  assert.equal(frame.byteLength, WireLimits.PropertyTextHitRequestFrameBytes)
  assert.deepEqual(Buffer.from(decodeFrame(frame, FrameType.PropertyTextHitRequest).payload), expected)
  const decoded = decodePropertyTextHitRequest(expected)
  assert.deepEqual({ ...decoded, sourceDigest: Uint8Array.from(decoded.sourceDigest) }, request)
  assert.throws(() => decodeFrame(frame, FrameType.PropertyWorkspaceRequest), ProtocolError)
  const firstRead = { ...request, valueRevision: 0n }
  assert.equal(decodePropertyTextHitRequest(decodeFrame(encodePropertyTextHitRequest(firstRead)).payload).valueRevision, 0n)

  for (const length of [31, 33])
    assert.throws(() => encodePropertyTextHitRequest({ ...request, sourceDigest: new Uint8Array(length) }), ProtocolError)
  for (const payload of [expected.subarray(0, -1), Buffer.concat([expected, Uint8Array.of(0)])])
    assert.throws(() => decodePropertyTextHitRequest(payload), ProtocolError)
  for (const [offset, value] of [[4, 0n], [12, 0n], [20, -1n], [44, 0n], [44, 11n]] as const) {
    const invalid = Buffer.from(expected)
    invalid.writeBigInt64LE(value, offset)
    assert.throws(() => decodePropertyTextHitRequest(invalid), ProtocolError)
  }
  const zeroDefinition = Buffer.from(expected)
  zeroDefinition.fill(0, 28, 44)
  assert.throws(() => decodePropertyTextHitRequest(zeroDefinition), ProtocolError)
  assert.throws(() => encodePropertyTextHitRequest({ ...request, articleId: 0 }), ProtocolError)
  assert.throws(() => encodePropertyTextHitRequest({ ...request, articleRevision: 1n << 63n }), ProtocolError)
})
