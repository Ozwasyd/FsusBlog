import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureFetch, encodedResponse, fixtureBytes, framedFixture, frameResponse, hexBytes, rejectInputs, rejectPatches, rejectWrongLength, withI32, withI64 } from './fixture-source.ts';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodePropertyEditor, encodePropertySchemaCommand, encodePropertyValueBatch, encodePropertyValueCommand,
  normalizePropertyDecimal, propertyApi, type PropertySchemaCommand, type PropertyValueBatchCommand, type PropertyValueCommand,
} from '../../src/Contracts/property-values.ts';
import { encodePropertyCommandReceipt, FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { encodePropertyQuery, queryPropertyArticles, type FilterField, type PropertyFilterCondition } from '../../src/Contracts/property-query.ts';
import { decodePropertyTextHitRequest, encodePropertyTextHitRequest, type PropertyTextHitRequest } from '../../src/Contracts/property-text-hit.ts';
import { savedViewLink } from '../../src/Web/src/authoring/savedViewLink.ts';

const fixture = (name: string) => fixtureBytes(`${name}.hex`);
const definitionId = '00000000-0000-4000-8000-000000000006';
const requestId = '0a0b0c0d-1111-4000-8000-010203040506';
const red = { id: 'af970001-2222-4000-8000-112233445566', label: 'Red' };
const blue = { id: 'af970002-2222-4000-8000-112233445566', label: '蓝色' };
const filterField = (kind: FilterField['kind'], machineKey: string, label: string, options: FilterField['options'] = []): FilterField =>
  ({ id: definitionId, revision: 2n, kind, machineKey, label, enabled: true, deprecated: false, options });
const firstValueTag = 36 + 16 + 8 + 4 + 'article'.length + 4 + 'Reference'.length + 1 + 4 + 4;
const typedEditorPayload = () => framedFixture('property-editor-typed.hex', FrameType.PropertyEditor);
const baseQuery = { schema: 10n, cursor: '' };

const valueCommand = {
  articleId: 17, articleRevision: 9007199254740993n, schemaRevision: 10n, valueRevision: 8n,
  definitionId, definitionRevision: 1n, requestId, value: { kind: 'number', value: '-9007199254740993.000000000001' },
} satisfies PropertyValueCommand;
const schemaCommand = {
  operation: 1, definitionId: '00000000-0000-4000-8000-000000000004', requestId, schemaRevision: 10n,
  definitionRevision: 0n, machineKey: 'multi', label: 'Multiple', kind: 'multi-select', options: [red, blue],
} satisfies PropertySchemaCommand;

test('typed editor decodes eight exact variants and preserves null and missing', () => {
  const workspace = decodePropertyEditor(typedEditorPayload());
  assert.deepEqual([workspace.articleId, workspace.articleRevision, workspace.schemaRevision, workspace.valueRevision],
    [17, 9007199254740993n, 10n, 8n]);
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
  ]);
  assert.deepEqual(workspace.fields[3]?.options, [red, blue]);
  assert.equal(workspace.fields[6]?.deprecated, true);
});

test('typed editor rejects payload truncation, trailing bytes, and mismatched kinds', () => {
  const payload = typedEditorPayload();
  rejectWrongLength(decodePropertyEditor, payload);
  assert.throws(() => decodePropertyEditor(withI32(payload, firstValueTag, 5)), /definition\/value kind mismatch/);
  assert.throws(() => decodePropertyEditor(withI32(payload, firstValueTag, 99)), /kind/);
});

test('unavailable references reveal no IDs and cannot be encoded as an edit', () => {
  const published = typedEditorPayload();
  const unavailable = Uint8Array.of(...published.subarray(0, firstValueTag), 0xfd, 0xff, 0xff, 0xff, ...published.subarray(firstValueTag + 16));
  assert.deepEqual(decodePropertyEditor(unavailable).fields[0]?.value, { kind: 'unavailable' });
  assert.throws(() => decodePropertyEditor(withI32(unavailable, firstValueTag - 8, 0)), /unavailable reference/);
  // @ts-expect-error Availability belongs to reads, never to edits.
  assert.throws(() => encodePropertyValueCommand({ ...valueCommand, value: { kind: 'unavailable' } }), ProtocolError);
});

test('property commands match independently framed bytes', () => {
  assert.deepEqual(encodeFrame(FrameType.PropertySchemaCommand, encodePropertySchemaCommand(schemaCommand)), fixture('property-definition-options'));
  assert.deepEqual(encodeFrame(FrameType.PropertyValueCommand, encodePropertyValueCommand(valueCommand)), fixture('property-value-exact-decimal'));
});

test('property batch uses fixed mixed-value bytes and binds the receipt to the command', async t => {
  const batch = {
    articleId: valueCommand.articleId, articleRevision: valueCommand.articleRevision,
    schemaRevision: valueCommand.schemaRevision, valueRevision: valueCommand.valueRevision, requestId,
    changes: [
      { definitionId, definitionRevision: 1n, value: valueCommand.value },
      { definitionId: schemaCommand.definitionId, definitionRevision: 3n, value: { kind: 'missing' } },
    ],
  } satisfies PropertyValueBatchCommand;
  assert.throws(() => encodePropertyValueBatch({ ...batch, changes: [] }), /batch coordinates/);
  assert.throws(() => encodePropertyValueBatch({ ...batch, changes: [...batch.changes, batch.changes[0]] }), /batch field/);

  const credential = 'a'.repeat(64);
  let returned = fixture('property-value-batch-receipt');
  const calls = captureFetch(t, ({ url, method, headers, body }) => {
    assert.equal(url, WireRoutes.PropertyValueCommand);
    assert.equal(method, 'POST');
    assert.equal(headers.get(WireHeaders.CurrentSession), credential);
    assert.deepEqual(body, fixture('property-value-batch'));
    return frameResponse(returned);
  });
  assert.deepEqual(await propertyApi.values(batch, undefined, credential), { articleId: 17, schemaRevision: 10n, valueRevision: 9n, requestId });
  returned = encodeFrame(FrameType.PropertyValueBatchReceipt,
    withI64(decodeFrame(returned, FrameType.PropertyValueBatchReceipt).payload, 12, 10n));
  await assert.rejects(propertyApi.values(batch, undefined, credential), /batch receipt/);
  assert.equal(calls.length, 2);
});

test('the AND request preserves independent decimal and UTC comparison bytes', async t => {
  const base = filterField('number', 'score', 'Score');
  const calls = captureFetch(t, ({ url, method, body }) => {
    assert.equal(url, WireRoutes.PropertyArticleQuery);
    assert.equal(method, 'POST');
    assert.deepEqual(body, fixture('property-query-group'));
    return encodedResponse(FrameType.PropertyArticlePage, new Uint8Array(8));
  });
  assert.deepEqual(await queryPropertyArticles({ ...baseQuery, conditions: [
    { field: base, comparison: 'at-least', value: valueCommand.value },
    { field: { ...base, id: '12345678-1234-4000-9000-123456789abc', revision: 3n, kind: 'date' },
      comparison: 'at-most', value: { kind: 'date', value: '2024-02-29T14:12:06.015Z' } },
  ] }), { nextCursor: '', rows: [] });
  assert.equal(calls.length, 1);
});

function checkSingleConditionQuery(
  fixtureName: string, condition: PropertyFilterCondition, invalidConditions: PropertyFilterCondition[],
  extraValid?: PropertyFilterCondition,
) {
  assert.deepEqual(encodePropertyQuery({ ...baseQuery, conditions: [condition] }), fixture(fixtureName));
  if (extraValid) assert.doesNotThrow(() => encodePropertyQuery({ ...baseQuery, conditions: [extraValid] }));
  for (const invalid of invalidConditions)
    assert.throws(() => encodePropertyQuery({ ...baseQuery, conditions: [invalid] }), ProtocolError);
}

test('single-condition filters preserve presence, multi-select, single-select, and reference alternatives', () => {
  const num = filterField('number', 'score', 'Score');
  const multi = filterField('multi-select', 'tag', 'Tag', [red, blue]);
  const single = filterField('single-select', 'tag', 'Tag', [red, blue]);
  const ref = filterField('article-reference', 'reference', 'Reference');
  const multiCond = { field: multi, comparison: 'multi-select-any-of', value: { kind: 'multi-select', value: [blue.id, red.id] } } as const;
  const singleCond = { field: single, comparison: 'single-select-any-of', value: { kind: 'multi-select', value: [blue.id, red.id] } } as const;
  const refCond = { field: ref, comparison: 'reference-any-of', value: { kind: 'article-reference', value: [42, 17] } } as const;

  checkSingleConditionQuery('property-query-presence',
    { field: num, comparison: 'is-present', value: { kind: 'missing' } },
    [{ field: num, comparison: 'is-present', value: { kind: 'null' } }]);
  checkSingleConditionQuery('property-query-multi-select-any-of', multiCond, [
    { ...multiCond, field: { ...multi, kind: 'single-select' } }, { ...multiCond, value: { kind: 'null' } },
  ]);
  checkSingleConditionQuery('property-query-single-select-any-of', singleCond, [
    { ...singleCond, value: { kind: 'multi-select', value: [] } }, { ...singleCond, field: { ...single, kind: 'multi-select' } },
  ]);
  checkSingleConditionQuery('property-query-reference-any-of', refCond,
    [{ ...refCond, value: { kind: 'article-reference', value: [17, 17] } }],
    { ...refCond, value: { kind: 'article-reference', value: [] } });

  const zero = { field: num, comparison: 'equal', value: { kind: 'number', value: '0' }, anyOf: true } as const;
  const higher = { ...zero, value: { kind: 'number', value: '19.75' } } as const;
  assert.deepEqual(encodePropertyQuery({ ...baseQuery, conditions: [zero, higher] }), fixture('property-query-alternatives'));
  rejectInputs(conditions => encodePropertyQuery({ ...baseQuery, conditions }), [
    [zero], [zero, zero], [zero, { ...higher, anyOf: false }], [zero, { ...higher, field: { ...num, revision: 3n } }],
  ]);
});

test('title or summary keyword has its own exact frame and current-session witness', async t => {
  const field = filterField('number', 'score', 'Score');
  const query = { ...baseQuery, keyword: '%_雪', conditions: [{ field, comparison: 'is-present', value: { kind: 'missing' } }] } as const;
  const bytes = fixture('property-query-keyword');
  assert.deepEqual(encodePropertyQuery(query), bytes);
  assert.deepEqual(encodePropertyQuery({ ...query, keyword: '' }), fixture('property-query-presence'));
  rejectInputs(keyword => encodePropertyQuery({ ...query, keyword }), ['\u00a0a', 'a\u0085b', '\ud800', '雪'.repeat(129)]);
  assert.doesNotThrow(() => encodePropertyQuery({ ...query, keyword: '🐈'.repeat(64) }));
  const session = 'a'.repeat(WireLimits.SiteSessionIdBytes);
  const calls = captureFetch(t, ({ headers, body }) => {
    assert.equal(headers.get(WireHeaders.CurrentSession), session);
    assert.deepEqual(body, bytes);
    return encodedResponse(FrameType.PropertyArticlePage, new Uint8Array(8));
  });
  assert.deepEqual(await queryPropertyArticles(query, undefined, session), { nextCursor: '', rows: [] });
  assert.equal(calls.length, 1);
});

test('typed writers reject unsupported identity, dates, and exact decimal overflow', () => {
  for (const [input, expected] of [
    ['-000.000', '0'], ['09007199254740993.0020000', '9007199254740993.002'],
    ['79228162514264337593543950335', '79228162514264337593543950335'],
    ['0.0000000000000000000000000001', '0.0000000000000000000000000001'],
  ]) assert.equal(normalizePropertyDecimal(input), expected);
  rejectInputs(normalizePropertyDecimal, ['1e4', '1\n', '1,000', '79228162514264337593543950336', '0.00000000000000000000000000001']);
  rejectInputs(value => encodePropertyValueCommand({ ...valueCommand, value }), [
    { kind: 'number', value: '1.0' }, { kind: 'date', value: '2023-02-29T14:12:06.015Z' },
    { kind: 'article-reference', value: [2, 2] }, { kind: 'article-reference', value: [2147483648] },
  ] satisfies PropertyValueCommand['value'][]);
  assert.throws(() => encodePropertySchemaCommand({ ...schemaCommand, options: [red, { ...red, id: red.id.toUpperCase() }] }), ProtocolError);
});

test('typed client only accepts workspace and receipts bound to the submitted revision and identity', async t => {
  let body: Uint8Array = fixture('property-editor-typed');
  const calls = captureFetch(t, () => frameResponse(Uint8Array.from(body)));
  const wsReq = { articleId: 17, articleRevision: 9007199254740993n, schemaRevision: 0n, valueRevision: 0n, afterKey: '' };
  await propertyApi.workspace(wsReq);
  await assert.rejects(propertyApi.workspace({ ...wsReq, articleId: 18 }), /workspace response article/);
  body = encodeFrame(FrameType.PropertyCommandReceipt, encodePropertyCommandReceipt({ definitionId, schemaRevision: 10n, revision: 9n }));
  await propertyApi.value(valueCommand);
  await assert.rejects(propertyApi.value({ ...valueCommand, valueRevision: 9n }), /value receipt/);
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    [WireRoutes.PropertyEditor, 'POST'], [WireRoutes.PropertyEditor, 'POST'],
    [WireRoutes.PropertyValueCommand, 'POST'], [WireRoutes.PropertyValueCommand, 'POST'],
  ]);
});

test('exact property hit request binds saved revisions and carries one fixed-width digest', () => {
  const digestHex = '6483f3cdcb9d29881ca70c82853ba6959b38994c5ac381120dfebaafe6ce567a';
  const expected = hexBytes('1100000001000000000020000a000000000000000900000000000000111111111111411181111111111111110300000000000000' + digestHex);
  const request: PropertyTextHitRequest = {
    articleId: 17, articleRevision: 9007199254740993n, schemaRevision: 10n, valueRevision: 9n,
    definitionId: '11111111-1111-4111-8111-111111111111', definitionRevision: 3n,
    sourceDigest: Uint8Array.from(hexBytes(digestHex)),
  };
  const frame = encodePropertyTextHitRequest(request);
  assert.equal(FrameType.PropertyTextHitRequest, 33034);
  assert.equal(frame.byteLength, 100);
  assert.equal(frame.byteLength, WireLimits.PropertyTextHitRequestFrameBytes);
  assert.deepEqual(Buffer.from(decodeFrame(frame, FrameType.PropertyTextHitRequest).payload), expected);
  const decoded = decodePropertyTextHitRequest(expected);
  assert.deepEqual({ ...decoded, sourceDigest: Uint8Array.from(decoded.sourceDigest) }, request);
  assert.throws(() => decodeFrame(frame, FrameType.PropertyWorkspaceRequest), ProtocolError);
  assert.equal(decodePropertyTextHitRequest(decodeFrame(encodePropertyTextHitRequest({ ...request, valueRevision: 0n })).payload).valueRevision, 0n);

  rejectPatches(encodePropertyTextHitRequest, request, [
    { sourceDigest: new Uint8Array(31) }, { sourceDigest: new Uint8Array(33) }, { articleId: 0 }, { articleRevision: 1n << 63n },
  ]);
  rejectWrongLength(decodePropertyTextHitRequest, expected);
  for (const [offset, value] of [[4, 0n], [12, 0n], [20, -1n], [44, 0n], [44, 11n]] as const)
    assert.throws(() => decodePropertyTextHitRequest(withI64(expected, offset, value)), ProtocolError);
  const zeroDefinition = Buffer.from(expected);
  zeroDefinition.fill(0, 28, 44);
  assert.throws(() => decodePropertyTextHitRequest(zeroDefinition), ProtocolError);
});

test('the author saved-view route resolves only a stable UUID and the current query schema', () => {
  const id = 'e50f00d1-519c-4c62-9a3d-1b513b60ee27';
  assert.equal(savedViewLink({}), undefined);
  assert.deepEqual(savedViewLink({ view: id.toUpperCase(), viewSchema: '1' }), { id });
  for (const bad of [{ view: id }, { viewSchema: '1' }, { view: id, viewSchema: '01' },
    { view: id, viewSchema: '2' }, { view: id, viewSchema: ['1', '1'] }, { view: [id, id], viewSchema: '1' },
    { view: id, viewSchema: '1', q: 'private' }, { view: '00000000-0000-0000-0000-000000000000', viewSchema: '1' }])
    assert.equal(savedViewLink(bad), 'invalid');
});
