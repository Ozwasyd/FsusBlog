import { deepEqual, equal, throws } from 'node:assert/strict';
import { hexFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeSitePasskeyManagement, encodeSitePasskeyRemove, encodeSitePasskeyRename } from '../../src/Contracts/site-passkey-names.ts';
import { FrameType, WireLimits } from '../../src/Contracts/wire.generated.ts';

const currentReference = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const otherReference = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf';
const revision = 9_007_199_254_740_999n;
const fixture = (name: string) => hexFixture(`${name}.hex`);

test('managed passkeys decode fixed opaque references without losing metadata or large revisions', () => {
  equal(FrameType.SitePasskeys, 32980);
  equal(FrameType.SitePasskeyManagement, 33055);
  const { payload } = decodeFrame(fixture('site-passkey-management'), FrameType.SitePasskeyManagement);
  deepEqual(decodeSitePasskeyManagement(payload), [{
    reference: currentReference, revision: 0n, name: '', createdAt: new Date(1800000000123),
    lastUsedAt: new Date(1800000000987), backupEligible: true, backedUp: true, current: true,
  }, {
    reference: otherReference, revision, name: '工作钥匙 🐈', createdAt: new Date(1800000001122),
    lastUsedAt: null, backupEligible: false, backedUp: false, current: false,
  }]);
  const duplicate = Buffer.from(payload);
  duplicate.copy(duplicate, 67, 4, 36);
  throws(() => decodeSitePasskeyManagement(duplicate), ProtocolError);
  const noCurrent = Buffer.from(payload);
  noCurrent[66] = 0;
  throws(() => decodeSitePasskeyManagement(noCurrent), ProtocolError);
  const unexpectedName = Buffer.from(payload);
  unexpectedName.writeBigInt64LE(0n, 99);
  throws(() => decodeSitePasskeyManagement(unexpectedName), ProtocolError);
  throws(() => decodeSitePasskeyManagement(Buffer.concat([payload, Uint8Array.of(0)])), ProtocolError);
});

test('rename intent carries one opaque reference, exact expected revision and raw bounded text', () => {
  equal(FrameType.SitePasskeyRename, 33056);
  deepEqual(Buffer.from(encodeSitePasskeyRename(otherReference, revision, ' 工位 🔑 ')), fixture('site-passkey-rename'));
  for (const name of ['', '　', ' ' + '鍵'.repeat(64), '\ud800']) {
    throws(() => encodeSitePasskeyRename(otherReference, revision, name), ProtocolError);
  }
  throws(() => encodeSitePasskeyRename(otherReference.toUpperCase(), revision, 'Name'), ProtocolError);
  throws(() => encodeSitePasskeyRename(otherReference, -1n, 'Name'), ProtocolError);
});

test('removal intent uses a separate exact frame for the opaque target and expected revision', () => {
  equal(FrameType.SitePasskeyRemove, 33057);
  const frame = encodeSitePasskeyRemove(otherReference, revision);
  equal(frame.byteLength, WireLimits.MaxSitePasskeyRemoveFrameBytes);
  deepEqual(Buffer.from(frame), fixture('site-passkey-remove'));
  throws(() => decodeFrame(frame, FrameType.SitePasskeyRename), ProtocolError);
  for (const reference of [otherReference.toUpperCase(), otherReference.slice(1), otherReference.slice(0, -1) + '\n']) {
    throws(() => encodeSitePasskeyRemove(reference, revision), ProtocolError);
  }
  for (const revision of [-1n, 1n << 63n]) {
    throws(() => encodeSitePasskeyRemove(otherReference, revision), ProtocolError);
  }
});
