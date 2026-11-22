import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  readAdminSiteConfig,
  saveAdminSiteConfig,
  validCopyrightStartYear,
  validSiteColor,
  validSiteEmail,
  validSiteText,
  validSiteUrl,
  type AdminSiteConfigCommand,
  type AdminSiteConfigState,
} from '../../src/Contracts/admin-site-config.ts';
import {
  decodeAdminSiteConfigCommand,
  decodeAdminSiteConfigState,
  encodeAdminSiteConfigCommand,
  encodeAdminSiteConfigState,
  FrameType,
  WireHeaders,
  WireLayouts,
  WireLimits,
  WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const aedsHeaders = { 'Content-Type': 'application/octet-stream' };
const encoder = new TextEncoder();

function sampleState(): AdminSiteConfigState {
  return {
    revision: 2n,
    digest: 'a'.repeat(64),
    origin: 'https://blog.example.test',
    title: 'North Journal',
    description: 'Notes on fieldwork',
    author: 'Editors',
    ogImage: '/assets/og.png',
    faviconSvgUrl: '/assets/favicon.svg',
    faviconIcoUrl: '/assets/favicon.ico',
    faviconPngUrl: '/assets/favicon.png',
    appleTouchIconUrl: '/assets/apple-touch.png',
    manifestName: 'North Journal App',
    manifestShortName: 'North',
    pwaIcon192Url: '/assets/icon-192.png',
    pwaIcon512Url: '/assets/icon-512.png',
    pwaMaskableIconUrl: '/assets/icon-maskable.png',
    themeColor: '#123456',
    backgroundColor: '#fafafa',
    siteLogoUrl: '/assets/logo.svg',
    siteLogoDarkUrl: '/assets/logo-dark.svg',
    siteWordmarkUrl: '/assets/wordmark.svg',
    complianceEnabled: true,
    regionMode: 'mainland-cn',
    copyrightStartYear: 2024,
    copyrightOwner: 'North Studio',
    copyrightText: 'All rights reserved.',
    contentLicenseName: 'CC BY 4.0',
    contentLicenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    icpRecordNumber: '京ICP备2026000000号-1',
    icpRecordUrl: 'https://beian.miit.gov.cn/',
    policeRecordNumber: '京公网安备11000002000000号',
    policeRecordUrl: 'https://beian.mps.gov.cn/',
    policeBadgeIconUrl: '/assets/police.png',
    operatorName: 'North Studio',
    contactEmail: 'hello@example.test',
  };
}

function sampleCommand(): AdminSiteConfigCommand {
  const { revision, digest, origin: _origin, ...fields } = sampleState();
  return { expectedRevision: revision, expectedDigest: digest, ...fields };
}

test('AdminSiteConfigState and AdminSiteConfigCommand roundtrip cleanly', () => {
  const state = sampleState();
  const decodedState = decodeAdminSiteConfigState(decodeFrame(encodeFrame(FrameType.AdminSiteConfigState, encodeAdminSiteConfigState(state)), FrameType.AdminSiteConfigState).payload);
  deepEqual(decodedState, state);

  const command = sampleCommand();
  const decodedCommand = decodeAdminSiteConfigCommand(decodeFrame(encodeFrame(FrameType.AdminSiteConfigCommand, encodeAdminSiteConfigCommand(command)), FrameType.AdminSiteConfigCommand).payload);
  deepEqual(decodedCommand, command);
});

test('Site configuration client validators match server safety boundaries', () => {
  equal(validSiteText('  ', 256, true), 'required');
  equal(validSiteText('North Journal', 256, true), null);
  equal(validSiteText('bad\u0007text', 256), 'invalidChars');
  equal(validSiteText('line1\nline2', 256, false, true), null);
  equal(validSiteText('x'.repeat(257), 256), 'tooLong');

  equal(validSiteUrl('', { asset: true }), null);
  equal(validSiteUrl('/assets/brand/logo.svg', { asset: true }), null);
  equal(validSiteUrl('https://cdn.example.test/logo.png', { asset: true }), null);
  equal(validSiteUrl('/assets/../secret.png', { asset: true }), 'invalidAssetUrl');
  equal(validSiteUrl('/assets/logo.png', { asset: false }), 'invalidUrl');
  equal(validSiteUrl('https://example.test/x?q=1', { asset: true }), 'invalidAssetUrl');
  equal(validSiteUrl('https://user@example.test/x.png', { asset: true }), 'invalidAssetUrl');
  equal(validSiteUrl('http://example.test/x.png', { asset: true }), 'invalidAssetUrl');
  equal(validSiteUrl('https://beian.miit.gov.cn/', { label: '' }), 'requiresLabel');
  equal(validSiteUrl('https://beian.miit.gov.cn/', { label: 'ICP-1' }), null);

  equal(validSiteColor(''), null);
  equal(validSiteColor('#1234af'), null);
  equal(validSiteColor('#1234'), 'invalidColor');
  equal(validSiteColor('red'), 'invalidColor');

  equal(validSiteEmail(''), null);
  equal(validSiteEmail('hello@example.test'), null);
  equal(validSiteEmail('Name <hello@example.test>'), 'invalidEmail');

  equal(validCopyrightStartYear(null, 2026), null);
  equal(validCopyrightStartYear(0, 2026), null);
  equal(validCopyrightStartYear(2024, 2026), null);
  equal(validCopyrightStartYear(1989, 2026), 'invalidYear');
  equal(validCopyrightStartYear(2027, 2026), 'invalidYear');
});

test('readAdminSiteConfig decodes valid state and rejects invalid digest or region', async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const state = sampleState();
  globalThis.fetch = async () => new Response(encodeFrame(FrameType.AdminSiteConfigState, encodeAdminSiteConfigState(state)), {
    status: 200,
    headers: aedsHeaders,
  });
  deepEqual(await readAdminSiteConfig(new AbortController().signal), state);

  globalThis.fetch = async () => new Response(encodeFrame(FrameType.AdminSiteConfigState, encodeAdminSiteConfigState({ ...state, digest: 'BAD' })), {
    status: 200,
    headers: aedsHeaders,
  });
  await rejects(() => readAdminSiteConfig(new AbortController().signal), ProtocolError);
});

test('saveAdminSiteConfig runs Step-Up then scoped PoW before submitting', async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  const prevCredential = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
  const prevAssertion = Object.getOwnPropertyDescriptor(globalThis, 'AuthenticatorAssertionResponse');
  const prevCredentials = Object.getOwnPropertyDescriptor(globalThis.navigator, 'credentials');
  const prevWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (prevCredential) Object.defineProperty(globalThis, 'PublicKeyCredential', prevCredential);
    else delete (globalThis as Record<string, unknown>).PublicKeyCredential;
    if (prevAssertion) Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', prevAssertion);
    else delete (globalThis as Record<string, unknown>).AuthenticatorAssertionResponse;
    if (prevCredentials) Object.defineProperty(globalThis.navigator, 'credentials', prevCredentials);
    else delete (globalThis.navigator as unknown as Record<string, unknown>).credentials;
    if (prevWorker) Object.defineProperty(globalThis, 'Worker', prevWorker);
    else delete (globalThis as Record<string, unknown>).Worker;
  });

  const proof = 'P'.repeat(43);
  const calls: string[] = [];

  class FakeAssertionResponse {}
  class FakeCredential {
    readonly id = 'AQIDBA';
    readonly rawId = Uint8Array.of(1, 2, 3, 4).buffer;
    readonly response: FakeAssertionResponse;
    constructor(response: FakeAssertionResponse) { this.response = response; }
  }
  class FakeWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: '42' } as MessageEvent<unknown>));
    }
    terminate() {}
  }

  const loginBeginPayload = (() => {
    const token = 'T'.repeat(43);
    const rp = encoder.encode('localhost');
    const challenge = new Uint8Array(WireLimits.PasskeyChallengeBytes).fill(7);
    const credId = Uint8Array.of(1, 2, 3, 4);
    const blobStart = WireLayouts.PasskeyLoginBeginSize + WireLayouts.PasskeyCredentialDescriptorSize + 4;
    const payload = new Uint8Array(blobStart + rp.length + challenge.length + credId.length);
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, 60_000n, true);
    view.setInt32(8, 1, true);
    payload.set(encoder.encode(token), WireLayouts.PasskeyLoginBeginTokenOffset);
    const rpRef = WireLayouts.PasskeyLoginBeginTokenOffset + WireLayouts.PasskeyTokenSize;
    view.setInt32(rpRef, 0, true);
    view.setInt32(rpRef + 4, rp.length, true);
    view.setInt32(rpRef + WireLayouts.PasskeySliceSize, rp.length, true);
    view.setInt32(rpRef + WireLayouts.PasskeySliceSize + 4, challenge.length, true);
    view.setInt32(WireLayouts.PasskeyLoginBeginSize + 8, rp.length + challenge.length, true);
    view.setInt32(WireLayouts.PasskeyLoginBeginSize + 12, credId.length, true);
    view.setInt32(blobStart - 4, rp.length + challenge.length + credId.length, true);
    payload.set(rp, blobStart);
    payload.set(challenge, blobStart + rp.length);
    payload.set(credId, blobStart + rp.length + challenge.length);
    return payload;
  })();

  const mfaResultPayload = (() => {
    const payload = new Uint8Array(WireLayouts.MfaChallengeResultBytes);
    payload[4] = 1;
    payload[5] = 1;
    payload.set(encoder.encode('admin-sensitive'), WireLayouts.MfaChallengeActionOffset);
    payload.set(encoder.encode(proof), WireLayouts.MfaChallengeProofOffset);
    return payload;
  })();

  const powPayload = (() => {
    const payload = new Uint8Array(WireLayouts.PowChallengeBytes);
    const view = new DataView(payload.buffer);
    payload.set(encoder.encode('a'.repeat(32)), 0);
    view.setInt32(WireLayouts.PowChallengeSaltBytes, WireLimits.PowChallengeDifficulty, true);
    view.setBigInt64(WireLayouts.PowChallengeTimestampOffset, BigInt(Math.floor(Date.now() / 1000)), true);
    payload.set(encoder.encode('S'.repeat(43)), WireLayouts.PowChallengeSignatureOffset);
    return payload;
  })();

  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: FakeCredential });
  Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', { configurable: true, value: FakeAssertionResponse });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: {
      get: async () => new FakeCredential(Object.assign(new FakeAssertionResponse(), {
        clientDataJSON: encoder.encode('{}').buffer,
        authenticatorData: new Uint8Array(37).fill(1).buffer,
        signature: new Uint8Array(64).fill(2).buffer,
        userHandle: null,
      })),
    },
  });

  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    calls.push(path);
    if (path === WireRoutes.AdminSiteConfigStepUpBegin) {
      return new Response(encodeFrame(FrameType.PasskeyLoginBegin, loginBeginPayload), { status: 200, headers: aedsHeaders });
    }
    if (path === WireRoutes.AdminSiteConfigStepUpComplete) {
      return new Response(encodeFrame(FrameType.MfaChallengeResult, mfaResultPayload), { status: 200, headers: aedsHeaders });
    }
    if (path === WireRoutes.AdminSiteConfigPow) {
      return new Response(encodeFrame(FrameType.PowChallenge, powPayload), { status: 200, headers: aedsHeaders });
    }
    if (path === WireRoutes.AdminSiteConfigSave) {
      equal(headers.get(WireHeaders.MfaProof), proof);
      equal(typeof headers.get(WireHeaders.PowProof), 'string');
      return new Response(encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0)), { status: 200, headers: aedsHeaders });
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  await saveAdminSiteConfig(sampleCommand(), new AbortController().signal);
  deepEqual(calls, [
    WireRoutes.AdminSiteConfigStepUpBegin,
    WireRoutes.AdminSiteConfigStepUpComplete,
    WireRoutes.AdminSiteConfigPow,
    WireRoutes.AdminSiteConfigSave,
  ]);
});
