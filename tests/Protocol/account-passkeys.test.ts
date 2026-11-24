import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { executeAdminHandleRename, validAdminHandle, type AdminHandleCommand } from '../../src/Contracts/admin-handle.ts';
import { decodeEnrollmentBegin, decodeLoginFlow, decodeProvisionBegin } from '../../src/Contracts/passkey.ts';
import { readSiteDisplayName, updateSiteDisplayName, validSiteDisplayName } from '../../src/Contracts/site-display-name.ts';
import { decodeSitePasskeyManagement, encodeSitePasskeyRemove, encodeSitePasskeyRename } from '../../src/Contracts/site-passkey-names.ts';
import { cancelSubscription, enrollSubscription } from '../../src/Contracts/subscription-preference.ts';
import {
  decodeAdminHandleCommand, decodeSiteDisplayNameCommand, decodeSubscriptionPreferenceRequest,
  encodeAdminHandleReceipt, encodeSiteDisplayNameState, FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';
import {
  appendByte, captureFetch, encodedResponse, framedFixture, frameResponse, hexFixture,
  rejectInputs, rejectWrongLength, withByte, withI32, withI64,
} from './fixture-source.ts';
import {
  adminSessionFixture, altPermissionSession, emptySuccessFrame, permissionHeader, validPermissionSession, validProof,
} from './step-up-fixture.ts';

test('enrollment reuses frame 63 with exact credential exclusions, bootstrap parity, and login flow decoding', () => {
  const enrollment = framedFixture('site-passkey-enrollment.hex', FrameType.PasskeyRegisterBegin);
  const bootstrap = framedFixture('site-passkey-bootstrap.hex', FrameType.PasskeyRegisterBegin);
  equal(WireRoutes.SitePasskeyEnrollBegin, '/api/v2/identity/passkeys/enroll/begin.aeds');
  equal(WireRoutes.SitePasskeyEnrollApprove, '/api/v2/identity/passkeys/enroll/approve.aeds');
  equal(WireRoutes.SitePasskeyEnrollComplete, '/api/v2/identity/passkeys/enroll/complete.aeds');
  const { token, options } = decodeEnrollmentBegin(enrollment);
  equal(token, 'Q'.repeat(43));
  deepEqual(options.excludeCredentials, [
    { type: 'public-key', id: Uint8Array.of(0, 255, 123) }, { type: 'public-key', id: Uint8Array.of(12, 11, 10) },
  ]);
  deepEqual(decodeProvisionBegin(bootstrap).options, { ...options, excludeCredentials: [] });
  throws(() => decodeProvisionBegin(enrollment), ProtocolError);
  throws(() => decodeEnrollmentBegin(bootstrap), ProtocolError);

  const first = WireLayouts.PasskeyRegisterBeginSize + 16;
  const tail = first + 2 * WireLayouts.PasskeyCredentialDescriptorSize + 4;
  for (const [offset, value] of [
    [12, WireLimits.SitePasskeyListSize], [first, 1], [first + 4, 1],
    [first + 8, 0], [first + 12, WireLimits.PasskeyCredentialIdBytes + 1], [first + 16, 1],
  ]) throws(() => decodeEnrollmentBegin(withI32(enrollment, offset, value)), ProtocolError);
  const duplicate = Buffer.from(enrollment);
  const existingId = duplicate.readInt32LE(first + 8) + tail;
  duplicate.copy(duplicate, existingId + 3, existingId, existingId + 3);
  throws(() => decodeEnrollmentBegin(duplicate), ProtocolError);
  rejectWrongLength(decodeEnrollmentBegin, enrollment);

  const flow = (id: number, role: string) => {
    const buf = Buffer.alloc(WireLayouts.PasskeyAuthLoginFlowSize);
    buf.writeInt32LE(id, 0);
    buf[4] = 1;
    buf[7] = 1;
    buf.write(role, 8, 'utf8');
    return buf;
  };
  const reader = flow(7, 'anonymous_account');
  deepEqual(decodeLoginFlow(reader), { kind: 'reader', pending: null });
  const mfa = Buffer.from(reader);
  mfa[4] = 2; mfa[5] = 2; mfa[6] = 1;
  mfa.write('A'.repeat(43), 104, 'ascii');
  deepEqual(decodeLoginFlow(mfa), { kind: 'reader', pending: 'A'.repeat(43) });
  const admin = flow(1, 'administrator');
  deepEqual(decodeLoginFlow(admin), { kind: 'admin' });
  rejectInputs(decodeLoginFlow, [withByte(admin, 4, 2), withByte(admin, 21, 1), flow(1, 'operator')]);
});

test('managed passkeys, rename, and removal intents enforce opaque references and exact revisions', () => {
  const currentReference = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const otherReference = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf';
  const revision = 9_007_199_254_740_999n;
  equal(FrameType.SitePasskeys, 32980);
  equal(FrameType.SitePasskeyManagement, 33055);
  const payload = framedFixture('site-passkey-management.hex', FrameType.SitePasskeyManagement);
  deepEqual(decodeSitePasskeyManagement(payload), [{
    reference: currentReference, revision: 0n, name: '', createdAt: new Date(1800000000123),
    lastUsedAt: new Date(1800000000987), backupEligible: true, backedUp: true, current: true,
  }, {
    reference: otherReference, revision, name: '工作钥匙 🐈', createdAt: new Date(1800000001122),
    lastUsedAt: null, backupEligible: false, backedUp: false, current: false,
  }]);
  const duplicate = Buffer.from(payload);
  duplicate.copy(duplicate, 67, 4, 36);
  rejectInputs(decodeSitePasskeyManagement, [duplicate, withByte(payload, 66, 0), withI64(payload, 99, 0n), appendByte(payload)]);

  equal(FrameType.SitePasskeyRename, 33056);
  deepEqual(Buffer.from(encodeSitePasskeyRename(otherReference, revision, ' 工位 🔑 ')), hexFixture('site-passkey-rename.hex'));
  rejectInputs(name => encodeSitePasskeyRename(otherReference, revision, name), ['', '　', ' ' + '鍵'.repeat(64), '\ud800']);
  throws(() => encodeSitePasskeyRename(otherReference.toUpperCase(), revision, 'Name'), ProtocolError);
  throws(() => encodeSitePasskeyRename(otherReference, -1n, 'Name'), ProtocolError);

  equal(FrameType.SitePasskeyRemove, 33057);
  const frame = encodeSitePasskeyRemove(otherReference, revision);
  equal(frame.byteLength, WireLimits.MaxSitePasskeyRemoveFrameBytes);
  deepEqual(Buffer.from(frame), hexFixture('site-passkey-remove.hex'));
  throws(() => decodeFrame(frame, FrameType.SitePasskeyRename), ProtocolError);
  rejectInputs(ref => encodeSitePasskeyRemove(ref, revision), [otherReference.toUpperCase(), otherReference.slice(1), otherReference.slice(0, -1) + '\n']);
  rejectInputs(rev => encodeSitePasskeyRemove(otherReference, rev), [-1n, 1n << 63n]);
});

test('site display name and admin handle rename validate inputs and bind headers and receipts', async t => {
  for (const [value, valid] of [
    ['林深', true], ['  Alice Reader  ', true], ['', false], ['   ', false], ['hello\nworld', false],
    ['a'.repeat(WireLimits.SiteDisplayNameChars), true], ['a'.repeat(WireLimits.SiteDisplayNameChars + 1), false],
  ] as const) equal(validSiteDisplayName(value), valid);
  for (const [value, valid] of [
    ['dev-admin', true], ['a.b_c-1', true], ['a'.repeat(WireLimits.AdminHandleBytes), true],
    ['a'.repeat(WireLimits.AdminHandleBytes + 1), false], ['Admin', false], ['1admin', false], ['bad handle', false], ['', false],
  ] as const) equal(validAdminHandle(value), valid);

  const sessionId = 'c'.repeat(64);
  const signal = new AbortController().signal;
  let decodedName: string | undefined;
  const displayCalls = captureFetch(t, ({ method, body }) => {
    const displayName = method === 'POST'
      ? (decodedName = decodeSiteDisplayNameCommand(decodeFrame(body, FrameType.SiteDisplayNameCommand).payload).displayName)
      : '';
    return encodedResponse(FrameType.SiteDisplayNameState, encodeSiteDisplayNameState({ displayName }));
  });
  equal(await readSiteDisplayName(sessionId, signal), '');
  equal(displayCalls[0].url, WireRoutes.SiteDisplayName);
  equal(displayCalls[0].headers.get(WireHeaders.CurrentSession), sessionId);
  equal(await updateSiteDisplayName(sessionId, '  林深  ', signal), '林深');
  equal(displayCalls[1].method, 'POST');
  equal(decodedName, '林深');
  await rejects(() => updateSiteDisplayName(sessionId, '   ', signal), ProtocolError);

  const activeSession = adminSessionFixture('dev-admin', 2n);
  const commandId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const command: AdminHandleCommand = { expectedHandle: 'dev-admin', newHandle: 'chief-editor', idempotencyKey: commandId };
  let seenDecoded: AdminHandleCommand | undefined;
  const renameCalls = captureFetch(t, ({ body }) => {
    seenDecoded = decodeAdminHandleCommand(decodeFrame(body, FrameType.AdminHandleCommand).payload);
    return encodedResponse(FrameType.AdminHandleReceipt, encodeAdminHandleReceipt({
      handle: 'chief-editor', happenedAtUnixMs: 1_795_000_000_000n, replayed: false,
    }), permissionHeader(validPermissionSession));
  });
  const receipt = await executeAdminHandleRename(activeSession(), command, validProof, signal);
  equal(receipt.handle, 'chief-editor');
  equal(receipt.replayed, false);
  equal(seenDecoded?.expectedHandle, 'dev-admin');
  equal(seenDecoded?.newHandle, 'chief-editor');
  equal(renameCalls[0].headers.get(WireHeaders.ClientMutationId), commandId);
  equal(renameCalls[0].headers.get(WireHeaders.MfaProof), validProof);
  await rejects(() => executeAdminHandleRename(activeSession(altPermissionSession), command, validProof, signal), ProtocolError);
  await rejects(() => executeAdminHandleRename(activeSession(), { ...command, newHandle: 'dev-admin' }, validProof, signal), ProtocolError);
});

test('subscription preference uses anonymous AEDS, isolates proof headers, and rejects invalid inputs or responses', async t => {
  const email = 'news+brief@example.test';
  const proof = 'ab'.repeat(32);
  const fixture = hexFixture('subscription-preference.hex');
  const calls = captureFetch(t, ({ url, method, headers, body }, init) => {
    equal(method, 'POST');
    equal(init?.credentials, 'omit');
    equal(init?.redirect, 'error');
    equal(headers.get(WireHeaders.SubscriptionProof), url === WireRoutes.SubscriptionCancel ? proof : null);
    equal(headers.get('Content-Type'), 'application/octet-stream');
    equal(headers.get('Accept'), 'application/octet-stream');
    equal(url.includes(email) || url.includes(proof), false);
    deepEqual(Buffer.from(body), fixture);
    deepEqual(decodeSubscriptionPreferenceRequest(decodeFrame(body, FrameType.SubscriptionPreferenceRequest).payload), { email, channel: 2 });
    return frameResponse(emptySuccessFrame());
  });
  equal(await enrollSubscription(email, 'email'), undefined);
  equal(await cancelSubscription(email, 'email', proof), undefined);
  deepEqual(calls.map(c => c.url), [WireRoutes.SubscriptionEnroll, WireRoutes.SubscriptionCancel]);

  const blocked = captureFetch(t, () => frameResponse(emptySuccessFrame()));
  rejectInputs(address => enrollSubscription(address, 'rss'), ['', 'bad\r@example.test', 'bad\n', '国际@example.test', 'x'.repeat(WireLimits.SubscriptionEmailBytes + 1)]);
  rejectInputs(candidate => cancelSubscription(email, 'email', candidate), [proof.toUpperCase(), proof.slice(0, -1), proof.slice(0, -1) + '\n']);
  equal(blocked.length, 0);

  captureFetch(t, () => encodedResponse(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0, 1)));
  await rejects(enrollSubscription(email, 'rss'), ProtocolError);
});
