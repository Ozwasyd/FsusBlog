import assert from 'node:assert/strict';
import { hexFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeClusterObservation } from '../../src/Contracts/admin-cluster.ts';
import { encodeAdminClusterStatus, FrameType } from '../../src/Contracts/wire.generated.ts';

const fixture = hexFixture('admin-cluster-status-v2.hex');
const payload = decodeFrame(fixture, FrameType.AdminClusterStatus).payload;
const status = {
  mode: 1, nodeId: 'lab-a', instanceId: 'bd978cbd-7565-44ed-876d-d734cbe45c79', buildVersion: '2.0.0+ca32',
  startedAt: 1794680000000n, observedAt: 1794680040012n, leaseAgeMs: 349, snapshotReady: true,
};

test('standalone deployment observation matches the independent AEDS vector', () => {
  assert.deepEqual(Buffer.from(encodeAdminClusterStatus(status)), Buffer.from(payload));
  assert.deepEqual(decodeClusterObservation(payload), { ...status, startedAt: Number(status.startedAt), observedAt: Number(status.observedAt) });
});

test('standalone decoder rejects unknown mode, invalid lease age, times and identity', () => {
  for (const invalid of [{ mode: 0 }, { leaseAgeMs: 1000 }, { leaseAgeMs: -1 }, { startedAt: 0n }, { observedAt: 253_402_300_800_000n },
    { instanceId: '00000000-0000-0000-0000-000000000000' }, { nodeId: 'invalid\n' }, { buildVersion: '1.0.0\n' }]) {
    assert.throws(() => decodeClusterObservation(encodeAdminClusterStatus({ ...status, ...invalid })), ProtocolError);
  }
});
