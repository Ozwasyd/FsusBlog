import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureText, framedFixture, hexFixture } from './fixture-source.ts';
import { encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeAdminSessionHistory } from '../../src/Contracts/admin-session-history.ts';
import {
  AdminSignInState, decodeAdminSignInHistorySnapshot, encodeAdminSignInHistorySnapshot, FrameType,
  type AdminSignIn,
} from '../../src/Contracts/wire.generated.ts';

const hours2 = 7_200_000;
const hours2Big = 7_200_000n;
const maxDate = 8_640_000_000_000_000;
const maxDateBig = 8_640_000_000_000_000n;
const generation = 9_007_199_254_740_993n;
const typical = framedFixture('admin-sign-in-history.hex', FrameType.AdminSignInHistory);
const rejectVectors = fixtureText('admin-sign-in-history-reject.txt').trim().split('\n').map(line => {
  const [name, hex] = line.split(' ');
  return [name, Buffer.from(hex, 'hex')] as const;
});
const wireRejectNames = new Set([
  'trailing-byte',
  'negative-count',
  'count-over-limit',
  'count-past-rows',
  'count-short-of-rows',
  'state-zero',
  'state-four',
  'state-max',
]);

function fullRows(count: number) {
  return [
    { startedAt: 1_800_000_000_000, expiresAt: 1_800_000_000_000 + hours2, endedAt: null, state: 'current' },
    ...Array.from({ length: count - 1 }, (_, offset) => {
      const index = offset + 1;
      const startedAt = 1_700_000_000_000 + index * 10_000_000;
      return index % 2 === 1
        ? { startedAt, expiresAt: startedAt + hours2, endedAt: startedAt + index * 1000, state: 'ended' }
        : { startedAt, expiresAt: startedAt + hours2, endedAt: startedAt + hours2, state: 'expired' };
    }),
  ];
}

function fullWireRows(count: number): AdminSignIn[] {
  return [
    { startedAt: 1_800_000_000_000n, expiresAt: 1_800_000_000_000n + hours2Big, endedAt: 0n, state: AdminSignInState.Current },
    ...Array.from({ length: count - 1 }, (_, offset) => {
      const index = BigInt(offset + 1);
      const startedAt = 1_700_000_000_000n + index * 10_000_000n;
      return index % 2n === 1n
        ? { startedAt, expiresAt: startedAt + hours2Big, endedAt: startedAt + index * 1000n, state: AdminSignInState.Ended }
        : { startedAt, expiresAt: startedAt + hours2Big, endedAt: startedAt + hours2Big, state: AdminSignInState.Expired };
    }),
  ];
}

const typicalWireRows: readonly AdminSignIn[] = [
  { startedAt: 1_800_000_000_000n, expiresAt: 1_800_000_000_000n + hours2Big, endedAt: 0n, state: AdminSignInState.Current },
  { startedAt: 1_799_990_000_000n, expiresAt: 1_799_990_000_000n + hours2Big, endedAt: 1_799_990_000_000n, state: AdminSignInState.Ended },
  { startedAt: maxDateBig - hours2Big, expiresAt: maxDateBig, endedAt: maxDateBig, state: AdminSignInState.Expired },
  { startedAt: 1_799_980_000_000n, expiresAt: 1_799_980_000_000n + hours2Big, endedAt: 1_799_981_234_567n, state: AdminSignInState.Ended },
];

test('administrator sign-in history decodes the independent typical, empty and full vectors', () => {
  assert.deepEqual(decodeAdminSessionHistory(typical, generation), [
    { startedAt: 1_800_000_000_000, expiresAt: 1_800_000_000_000 + hours2, endedAt: null, state: 'current' },
    { startedAt: 1_799_990_000_000, expiresAt: 1_799_990_000_000 + hours2, endedAt: 1_799_990_000_000, state: 'ended' },
    { startedAt: maxDate - hours2, expiresAt: maxDate, endedAt: maxDate, state: 'expired' },
    { startedAt: 1_799_980_000_000, expiresAt: 1_799_980_000_000 + hours2, endedAt: 1_799_981_234_567, state: 'ended' },
  ]);
  assert.deepEqual(decodeAdminSessionHistory(framedFixture('admin-sign-in-history-empty.hex', FrameType.AdminSignInHistory), 1n), []);
  assert.deepEqual(decodeAdminSessionHistory(framedFixture('admin-sign-in-history-full.hex', FrameType.AdminSignInHistory), 2n), fullRows(50));
});

test('generated codec encodes and decodes identical bytes to C# for typical, empty and full vectors', () => {
  const cases = [
    ['admin-sign-in-history.hex', { generation, signIns: typicalWireRows }],
    ['admin-sign-in-history-empty.hex', { generation: 1n, signIns: [] }],
    ['admin-sign-in-history-full.hex', { generation: 2n, signIns: fullWireRows(50) }],
  ] as const;

  for (const [name, snapshot] of cases) {
    const expectedFrame = Uint8Array.from(hexFixture(name));
    const encodedFrame = encodeFrame(FrameType.AdminSignInHistory, encodeAdminSignInHistorySnapshot(snapshot));
    assert.deepEqual(encodedFrame, expectedFrame, name);
    assert.deepEqual(decodeAdminSignInHistorySnapshot(framedFixture(name, FrameType.AdminSignInHistory)), snapshot);
  }
});

test('administrator sign-in history rejects truncation, bounds, states and cross-field combinations', () => {
  assert.equal(rejectVectors.length, 23);
  for (const [name, payload] of rejectVectors) {
    assert.throws(() => decodeAdminSessionHistory(payload, generation), ProtocolError, name);
    if (wireRejectNames.has(name))
      assert.throws(() => decodeAdminSignInHistorySnapshot(payload), ProtocolError, name);
  }
  for (let length = 0; length < typical.length; length++) {
    assert.throws(() => decodeAdminSessionHistory(typical.subarray(0, length), generation), ProtocolError);
    assert.throws(() => decodeAdminSignInHistorySnapshot(typical.subarray(0, length)), ProtocolError);
  }
  assert.throws(() => decodeAdminSessionHistory(typical, generation + 1n), ProtocolError);
  assert.throws(() => decodeAdminSessionHistory(encodeAdminSignInHistorySnapshot({ generation: 0n, signIns: [] }), 0n), ProtocolError);
  assert.throws(() => encodeAdminSignInHistorySnapshot({ generation: 2n, signIns: fullWireRows(51) }), ProtocolError);
  for (const invalidState of [0, 4, 255] as unknown as AdminSignInState[]) {
    assert.throws(() => encodeAdminSignInHistorySnapshot({
      generation,
      signIns: [{ ...typicalWireRows[1], state: invalidState }],
    }), ProtocolError);
  }
});
