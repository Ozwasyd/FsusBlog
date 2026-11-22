import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { frameResponse } from './fixture-source.ts';
import { emptySuccessFrame, installPowWorker, loginBeginFrame, mfaChallengeResultFrame, powChallengeFrame, replaceProperty } from './step-up-fixture.ts';
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
  WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

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
  globalThis.fetch = async () => frameResponse(encodeFrame(FrameType.AdminSiteConfigState, encodeAdminSiteConfigState(state)));
  deepEqual(await readAdminSiteConfig(new AbortController().signal), state);

  globalThis.fetch = async () => frameResponse(encodeFrame(FrameType.AdminSiteConfigState, encodeAdminSiteConfigState({ ...state, digest: 'BAD' })));
  await rejects(() => readAdminSiteConfig(new AbortController().signal), ProtocolError);
});

test('saveAdminSiteConfig runs Step-Up then scoped PoW before submitting', async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const proof = 'P'.repeat(43);
  const calls: string[] = [];

  class FakeAssertionResponse {}
  class FakeCredential {
    readonly id = 'AQIDBA';
    readonly rawId = Uint8Array.of(1, 2, 3, 4).buffer;
    readonly response: FakeAssertionResponse;
    constructor(response: FakeAssertionResponse) { this.response = response; }
  }
  const challenge = powChallengeFrame({ salt: 'a'.repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) });

  replaceProperty(t, globalThis, 'PublicKeyCredential', FakeCredential);
  replaceProperty(t, globalThis, 'AuthenticatorAssertionResponse', FakeAssertionResponse);
  installPowWorker(t);
  replaceProperty(t, globalThis.navigator, 'credentials', {
    get: async () => new FakeCredential(Object.assign(new FakeAssertionResponse(), {
      clientDataJSON: encoder.encode('{}').buffer,
      authenticatorData: new Uint8Array(37).fill(1).buffer,
      signature: new Uint8Array(64).fill(2).buffer,
      userHandle: null,
    })),
  });

  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    calls.push(path);
    if (path === WireRoutes.AdminSiteConfigStepUpBegin) {
      return frameResponse(loginBeginFrame());
    }
    if (path === WireRoutes.AdminSiteConfigStepUpComplete) {
      return frameResponse(mfaChallengeResultFrame({ proof }));
    }
    if (path === WireRoutes.AdminSiteConfigPow) {
      return frameResponse(challenge);
    }
    if (path === WireRoutes.AdminSiteConfigSave) {
      equal(headers.get(WireHeaders.MfaProof), proof);
      equal(typeof headers.get(WireHeaders.PowProof), 'string');
      return frameResponse(emptySuccessFrame());
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
