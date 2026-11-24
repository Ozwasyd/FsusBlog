import { deepStrictEqual, equal, ok, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeApiError, decodeFrame, decodeSuccess, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { definePodRecord, podField } from '../../src/Contracts/pod-record.ts';
import { decodeArticleCommand, encodeArticleCommand, FrameType } from '../../src/Contracts/wire.generated.ts';
import { compileSchema } from '../../tools/protocol-generate.mjs';
import { fixtureBytes, withByte } from './fixture-source.ts';

test('reads the pinned v1 ApiError, matches C#/TS command vectors, and rejects bit flips and malformed payloads', () => {
  const frame = decodeFrame(fixtureBytes('api-error-v1.hex'), FrameType.ApiError);
  const error = decodeApiError(frame.payload, 403);
  equal(error.message, '权限不足');
  equal(error.details, 'role_required');
  equal(error.traceId, 'trace-123');
  deepStrictEqual([error.status, error.code, error.category], [403, 5, 3]);
  throws(() => decodeApiError(frame.payload, 200), ProtocolError);

  const expected = fixtureBytes('article-command.hex');
  const command = {
    id: 0, expectedRevision: 0n, idempotencyKey: '00446688-2244-6688-99aa-bbccddeeff00',
    title: '独立向量', body: 'first draft 🐈\n',
  };
  deepStrictEqual(encodeFrame(FrameType.ArticleCommand, encodeArticleCommand(command)), expected);
  deepStrictEqual(decodeArticleCommand(decodeFrame(expected).payload), command);

  const bytes = Uint8Array.from(expected);
  for (let offset = 0; offset < bytes.length; offset++) {
    throws(() => decodeFrame(bytes.subarray(0, offset), FrameType.ArticleCommand), ProtocolError);
    for (let bit = 0; bit < 8; bit++) {
      bytes[offset] ^= 1 << bit;
      throws(() => decodeFrame(bytes, FrameType.ArticleCommand), ProtocolError);
      bytes[offset] ^= 1 << bit;
    }
  }

  const badPayload = withByte(decodeFrame(expected, FrameType.ArticleCommand).payload, 32, 255);
  throws(() => decodeArticleCommand(decodeFrame(encodeFrame(FrameType.ArticleCommand, badPayload)).payload), ProtocolError);
  throws(() => decodeSuccess(Uint8Array.of(1, 0, 1, 0)), ProtocolError);
});

test('podField supports explicit-width u8 enums, embedded records, and bounded lists', () => {
  const Kind = { First: 1, Second: 2 } as const;
  const itemFields = { id: podField.i32, kind: podField.enumU8(Kind) };
  const [encode, decode] = definePodRecord({ primary: podField.record(itemFields), items: podField.list(podField.record(itemFields), 2, 5) });
  const value = { primary: { id: 7, kind: Kind.First }, items: [{ id: 8, kind: Kind.Second }, { id: 9, kind: Kind.First }] };
  const payload = encode(value);
  deepStrictEqual(Array.from(payload), [7, 0, 0, 0, 1, 2, 0, 0, 0, 8, 0, 0, 0, 2, 9, 0, 0, 0, 1]);
  deepStrictEqual(decode(payload), value);
  throws(() => decode(payload.subarray(0, -1)), ProtocolError);
  throws(() => encode({ ...value, items: [...value.items, { id: 10, kind: Kind.First }] }), ProtocolError);
  throws(() => encode({ ...value, primary: { id: 7, kind: 99 as unknown as typeof Kind.First } }), ProtocolError);
  throws(() => decode(withByte(payload, 4, 99)), ProtocolError);
});

test('protocol generator compiles single embedded records in dependency order and rejects invalid schemas', () => {
  const baseSchema = JSON.parse(readFileSync(new URL('../../src/Contracts/wire.schema.json', import.meta.url), 'utf8'));
  const extended = structuredClone(baseSchema);
  extended.embeddedRecords.OuterRow = { fields: [['Inner', 'record', 'AdminSignIn'], ['Tag', 'i32']] };
  extended.records.AdminSignInHistorySnapshot.fields.push(['Latest', 'record', 'OuterRow']);
  const outputs = compileSchema(extended);
  const ts = outputs['src/Contracts/wire.generated.ts'];
  const cs = outputs['src/Contracts/Wire.Generated.cs'];
  ok(ts.indexOf('const adminSignInFields') < ts.indexOf('const outerRowFields'));
  ok(cs.includes('WriteOuterRow(writer, record.Latest);'));
  ok(cs.includes('ReadOuterRow(ref reader)'));

  const reject = (mutate: (s: any) => void, message: RegExp) => {
    const candidate = structuredClone(baseSchema);
    mutate(candidate);
    throws(() => compileSchema(candidate), message);
  };
  reject(s => { delete s.enums.AdminSignInState.type; }, /Invalid enum definition/);
  reject(s => { s.enums.AdminSignInState.type = 'i32'; }, /Invalid enum definition/);
  reject(s => { s.enums.AdminSignInState.values.Overflow = 256; }, /Invalid enum member/);
  reject(s => { s.enums.AdminSignInState.values.Duplicate = 1; }, /Invalid enum member/);
  reject(s => { s.embeddedRecords.Self = { fields: [['Child', 'record', 'Self']] }; }, /Cyclic embedded record/);
  reject(s => { s.embeddedRecords.SelfList = { fields: [['Children', 'list', 'SelfList', 'AdminSignInHistoryMaxItems']] }; }, /Cyclic embedded record/);
  reject(s => { s.embeddedRecords.AdminSignIn.frame = 'AdminSignInHistory'; }, /Invalid embedded record definition/);
  reject(s => { s.records.AdminSignIn = { fields: [['X', 'i32']] }; }, /Duplicate type name/);
  reject(s => { s.records.AdminSignInHistorySnapshot.fields[1] = ['SignIns', 'list', 'Missing', 'AdminSignInHistoryMaxItems']; }, /Invalid list field/);
});
