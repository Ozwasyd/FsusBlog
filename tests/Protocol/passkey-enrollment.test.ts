import { deepEqual, equal, throws } from 'node:assert/strict';
import { hexFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeEnrollmentBegin, decodeProvisionBegin } from '../../src/Contracts/passkey.ts';
import { FrameType, WireLayouts, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const fixture = (name: string) => decodeFrame(hexFixture(`site-passkey-${name}.hex`), FrameType.PasskeyRegisterBegin).payload;

const enrollment = fixture('enrollment');
const bootstrap = fixture('bootstrap');

test('enrollment reuses frame 63 with exact credential exclusions and leaves bootstrap unchanged', () => {
  equal(WireRoutes.SitePasskeyEnrollBegin, '/api/v2/identity/passkeys/enroll/begin.aeds');
  equal(WireRoutes.SitePasskeyEnrollApprove, '/api/v2/identity/passkeys/enroll/approve.aeds');
  equal(WireRoutes.SitePasskeyEnrollComplete, '/api/v2/identity/passkeys/enroll/complete.aeds');
  const { token, options } = decodeEnrollmentBegin(enrollment);
  equal(token, 'Q'.repeat(43));
  deepEqual(options.excludeCredentials, [
    { type: 'public-key', id: Uint8Array.of(0, 255, 123) },
    { type: 'public-key', id: Uint8Array.of(12, 11, 10) },
  ]);
  deepEqual(decodeProvisionBegin(bootstrap).options, { ...options, excludeCredentials: [] });
  throws(() => decodeProvisionBegin(enrollment), ProtocolError);
  throws(() => decodeEnrollmentBegin(bootstrap), ProtocolError);
});

test('enrollment excludes only a bounded, unique, canonical contiguous descriptor list', () => {
  const first = WireLayouts.PasskeyRegisterBeginSize + 16;
  const tail = first + 2 * WireLayouts.PasskeyCredentialDescriptorSize + 4;
  const change = (offset: number, value: number) => {
    const bytes = Buffer.from(enrollment);
    bytes.writeInt32LE(value, offset);
    throws(() => decodeEnrollmentBegin(bytes), ProtocolError);
  };
  change(12, WireLimits.SitePasskeyListSize);
  change(first, 1);
  change(first + 4, 1);
  change(first + 8, 0);
  change(first + 12, WireLimits.PasskeyCredentialIdBytes + 1);
  change(first + 16, 1);
  const duplicate = Buffer.from(enrollment);
  const existingId = duplicate.readInt32LE(first + 8) + tail;
  duplicate.copy(duplicate, existingId + 3, existingId, existingId + 3);
  throws(() => decodeEnrollmentBegin(duplicate), ProtocolError);
  throws(() => decodeEnrollmentBegin(enrollment.subarray(0, enrollment.length - 1)), ProtocolError);
  throws(() => decodeEnrollmentBegin(Buffer.concat([enrollment, Uint8Array.of(0)])), ProtocolError);
});
