import type { TestContext } from 'node:test';
import type { AdminSession } from '../../src/Contracts/admin-identity.ts';
import { encodeFrame } from '../../src/Contracts/aeds.ts';
import { FrameType, WireHeaders, WireLayouts, WireLimits } from '../../src/Contracts/wire.generated.ts';
import { replaceProperty } from './fixture-source.ts';

const encoder = new TextEncoder();
export const validProof = 'P'.repeat(43);
export const validPermissionSession = 'a'.repeat(64);
export const altPermissionSession = 'b'.repeat(64);

export function adminSessionFixture(handle: string, generation: bigint) {
  return (permissionSession: string | null = validPermissionSession): AdminSession => ({
    handle, generation, expiresAt: Date.now() + 60_000,
    appearanceEnabled: true, siteConfigEnabled: true,
    ...(permissionSession === null ? {} : { permissionSession }),
  });
}

export const permissionHeader = (session: string) => ({ [WireHeaders.AdminPermissionSession]: session });

export function emptySuccessFrame(): Uint8Array<ArrayBuffer> {
  return encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0));
}

export function loginBeginFrame(allowCredentialsCount = 1): Uint8Array<ArrayBuffer> {
  const token = 'T'.repeat(43);
  const rp = encoder.encode('localhost');
  const challenge = new Uint8Array(WireLimits.PasskeyChallengeBytes).fill(7);
  const credId = Uint8Array.of(1, 2, 3, 4);
  const descriptorBytes = allowCredentialsCount * WireLayouts.PasskeyCredentialDescriptorSize;
  const blobStart = WireLayouts.PasskeyLoginBeginSize + descriptorBytes + 4;
  const blobSize = rp.length + challenge.length + allowCredentialsCount * credId.length;
  const payload = new Uint8Array(blobStart + blobSize);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, 60_000n, true);
  view.setInt32(8, allowCredentialsCount, true);
  payload.set(encoder.encode(token), WireLayouts.PasskeyLoginBeginTokenOffset);
  const rpRef = WireLayouts.PasskeyLoginBeginTokenOffset + WireLayouts.PasskeyTokenSize;
  view.setInt32(rpRef, 0, true);
  view.setInt32(rpRef + 4, rp.length, true);
  view.setInt32(rpRef + WireLayouts.PasskeySliceSize, rp.length, true);
  view.setInt32(rpRef + WireLayouts.PasskeySliceSize + 4, challenge.length, true);
  let pos = rp.length + challenge.length;
  for (let i = 0; i < allowCredentialsCount; i++) {
    const ref = WireLayouts.PasskeyLoginBeginSize + i * WireLayouts.PasskeyCredentialDescriptorSize;
    view.setInt32(ref + 8, pos, true);
    view.setInt32(ref + 12, credId.length, true);
    payload.set(credId, blobStart + pos);
    pos += credId.length;
  }
  view.setInt32(blobStart - 4, blobSize, true);
  payload.set(rp, blobStart);
  payload.set(challenge, blobStart + rp.length);
  return encodeFrame(FrameType.PasskeyLoginBegin, payload);
}

export function mfaChallengeResultFrame({
  action = 'admin-sensitive',
  verified = true,
  withUser = false,
  proof = 'P'.repeat(43),
} = {}): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(WireLayouts.MfaChallengeResultBytes);
  const view = new DataView(payload.buffer);
  view.setInt32(0, withUser ? 1 : 0, true);
  payload[4] = Number(verified);
  payload[5] = Number(!withUser);
  payload[6] = Number(withUser);
  payload[7] = Number(withUser);
  if (withUser) payload.set(encoder.encode('anonymous_account'), 8);
  payload.set(encoder.encode(action), WireLayouts.MfaChallengeActionOffset);
  if (!withUser) payload.set(encoder.encode(proof), WireLayouts.MfaChallengeProofOffset);
  return encodeFrame(FrameType.MfaChallengeResult, payload);
}

export function powChallengeFrame({
  salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  signature = 'S'.repeat(43),
  difficulty = WireLimits.PowChallengeDifficulty,
  timestamp = 1_794_680_000n,
}: {
  salt?: string;
  signature?: string;
  difficulty?: number;
  timestamp?: bigint;
} = {}): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(WireLayouts.PowChallengeBytes);
  const view = new DataView(payload.buffer);
  payload.set(encoder.encode(salt).subarray(0, WireLayouts.PowChallengeSaltBytes), 0);
  view.setInt32(WireLayouts.PowChallengeSaltBytes, difficulty, true);
  view.setBigInt64(WireLayouts.PowChallengeTimestampOffset, timestamp, true);
  payload.set(encoder.encode(signature).subarray(0, 64), WireLayouts.PowChallengeSignatureOffset);
  return encodeFrame(FrameType.PowChallenge, payload);
}

export function installPasskeyEnvironment(
  t: TestContext, options: { onGet?: (request: CredentialRequestOptions | undefined) => void; registration?: boolean } = {},
) {
  class FakeAssertionResponse {}
  class FakeCredential {
    id = 'cred-id';
    rawId = Uint8Array.of(9, 8, 7).buffer;
    response: object;
    constructor(response: object) { this.response = response; }
  }
  const credentials = {
    async get(request?: CredentialRequestOptions) {
      options.onGet?.(request);
      return new FakeCredential(Object.assign(new FakeAssertionResponse(), {
        clientDataJSON: Uint8Array.of(1, 2).buffer,
        authenticatorData: Uint8Array.of(3, 4).buffer,
        signature: Uint8Array.of(5, 6).buffer,
        userHandle: null,
      }));
    },
  };
  replaceProperty(t, globalThis, 'PublicKeyCredential', FakeCredential);
  replaceProperty(t, globalThis, 'AuthenticatorAssertionResponse', FakeAssertionResponse);
  if (options.registration) {
    class FakeAttestationResponse {
      clientDataJSON = Uint8Array.of(10, 11).buffer;
      attestationObject = Uint8Array.of(12, 13, 14).buffer;
      getTransports() { return ['internal']; }
    }
    replaceProperty(t, globalThis, 'isSecureContext', true);
    replaceProperty(t, globalThis, 'AuthenticatorAttestationResponse', FakeAttestationResponse);
    Object.assign(credentials, { async create() { return new FakeCredential(new FakeAttestationResponse()); } });
  }
  replaceProperty(t, globalThis.navigator, 'credentials', credentials);
}

export interface FakePowWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: (() => void) | null;
  terminated: boolean;
  postMessage(payload: unknown): void;
  reply(data: unknown): void;
  terminate(): void;
}

export function installPowWorker(
  t: TestContext,
  onPost: (worker: FakePowWorker, payload: unknown) => void = worker => {
    queueMicrotask(() => worker.reply('12345'));
  },
) {
  const control = { spawns: 0, terminated: 0, posted: [] as unknown[], last: null as FakePowWorker | null };
  replaceProperty(t, globalThis, 'Worker', class implements FakePowWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() { control.spawns++; control.last = this; }
    postMessage(payload: unknown) { control.posted.push(payload); onPost(this, payload); }
    reply(data: unknown) { this.onmessage?.({ data } as MessageEvent<unknown>); }
    terminate() { if (!this.terminated) { this.terminated = true; control.terminated++; } }
  });
  return control;
}
