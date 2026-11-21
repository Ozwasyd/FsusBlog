import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProtocolError } from '../../src/Contracts/aeds.ts';
import { definePodRecord, podField } from '../../src/Contracts/pod-record.ts';
import { compileSchema } from '../../tools/protocol-generate.mjs';

const baseSchema = JSON.parse(
  readFileSync(new URL('../../src/Contracts/wire.schema.json', import.meta.url), 'utf8'),
);

test('podField supports explicit-width u8 enums, embedded records, and bounded lists', () => {
  const Kind = { First: 1, Second: 2 } as const;
  const itemFields = {
    id: podField.i32,
    kind: podField.enumU8(Kind),
  };
  const envelopeFields = {
    primary: podField.record(itemFields),
    items: podField.list(podField.record(itemFields), 2, 5),
  };
  const [encode, decode] = definePodRecord(envelopeFields);
  const value = {
    primary: { id: 7, kind: Kind.First },
    items: [{ id: 8, kind: Kind.Second }, { id: 9, kind: Kind.First }],
  };
  const payload = encode(value);
  assert.deepEqual(Array.from(payload), [
    7, 0, 0, 0, 1,
    2, 0, 0, 0,
    8, 0, 0, 0, 2,
    9, 0, 0, 0, 1,
  ]);
  assert.deepEqual(decode(payload), value);
  assert.throws(() => decode(payload.subarray(0, payload.length - 1)), ProtocolError);
  assert.throws(() => encode({
    ...value,
    items: [...value.items, { id: 10, kind: Kind.First }],
  }), ProtocolError);
  assert.throws(() => encode({
    ...value,
    primary: { id: 7, kind: 99 as unknown as typeof Kind.First },
  }), ProtocolError);
  const badEnum = Uint8Array.from(payload);
  badEnum[4] = 99;
  assert.throws(() => decode(badEnum), ProtocolError);
});

test('protocol generator compiles single embedded records in dependency order and rejects invalid schemas', () => {
  const extended = structuredClone(baseSchema);
  extended.embeddedRecords.OuterRow = {
    fields: [['Inner', 'record', 'AdminSignIn'], ['Tag', 'i32']],
  };
  extended.records.AdminSignInHistorySnapshot.fields.push(['Latest', 'record', 'OuterRow']);
  const outputs = compileSchema(extended);
  const ts = outputs['src/Contracts/wire.generated.ts'];
  const cs = outputs['src/Contracts/Wire.Generated.cs'];
  assert.ok(ts.indexOf('const adminSignInFields') < ts.indexOf('const outerRowFields'));
  assert.ok(cs.includes('WriteOuterRow(writer, record.Latest);'));
  assert.ok(cs.includes('ReadOuterRow(ref reader)'));

  const reject = (mutate: (schema: any) => void, message: RegExp) => {
    const candidate = structuredClone(baseSchema);
    mutate(candidate);
    assert.throws(() => compileSchema(candidate), message);
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
