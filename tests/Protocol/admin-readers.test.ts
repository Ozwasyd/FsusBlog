import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import type { AdminSession } from '../../src/Contracts/admin-identity.ts';
import {
  executeReaderStatusChange,
  readAdminReaderAccounts,
  requestReaderStatusProof,
  validReaderGovernanceReason,
  type AdminReaderAccount,
  type AdminReaderAccountPage,
  type AdminReaderStatusCommand,
  type AdminReaderStatusReceipt,
} from '../../src/Contracts/admin-readers.ts';
import {
  decodeAdminReaderStatusCommand,
  encodeAdminReaderAccountPage,
  encodeAdminReaderStatusReceipt,
  FrameType,
  WireHeaders,
  WireLayouts,
  WireLimits,
  WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const aedsHeaders = { 'Content-Type': 'application/octet-stream' };
const validProof = 'P'.repeat(43);
const validPermissionSession = 'a'.repeat(64);
const altPermissionSession = 'b'.repeat(64);
const zeroUuid = '00000000-0000-0000-0000-000000000000';
const userId = '11111111-2222-4333-8444-555555555555';
const commandId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const encoder = new TextEncoder();

function activeSession(permissionSession = validPermissionSession): AdminSession {
  return {
    handle: 'admin-fixture',
    generation: 3n,
    expiresAt: Date.now() + 60_000,
    appearanceEnabled: true,
    siteConfigEnabled: true,
    permissionSession,
  };
}

function sampleAccount(overrides: Partial<AdminReaderAccount> = {}): AdminReaderAccount {
  return {
    userId,
    accountId: 42,
    name: 'alice',
    displayName: 'Alice Reader',
    enabled: true,
    generation: 2n,
    passkeyCount: 2,
    activeSessionCount: 1,
    hasRecoveryKey: true,
    hasTotp: false,
    commentCount: 5,
    registeredAtUnixMs: 1_794_680_000_000n,
    lastUsedAtUnixMs: 1_794_685_000_000n,
    lastGovernanceAtUnixMs: 1_794_684_000_000n,
    lastGovernanceActor: 'admin-fixture',
    lastGovernanceReason: 'Restored after appeal',
    ...overrides,
  };
}

function samplePage(overrides: Partial<AdminReaderAccountPage> = {}): AdminReaderAccountPage {
  return {
    total: 2,
    enabledTotal: 1,
    disabledTotal: 1,
    hasMore: false,
    nextCursorAccountId: 0,
    nextCursorUserId: zeroUuid,
    items: [sampleAccount()],
    ...overrides,
  };
}

function sampleCommand(overrides: Partial<AdminReaderStatusCommand> = {}): AdminReaderStatusCommand {
  return {
    userId,
    targetEnabled: false,
    expectedGeneration: 2n,
    idempotencyKey: commandId,
    reason: '  Spam automation detected  ',
    ...overrides,
  };
}

function sampleReceipt(overrides: Partial<AdminReaderStatusReceipt> = {}): AdminReaderStatusReceipt {
  return {
    userId,
    enabled: false,
    generation: 3n,
    revokedSessionCount: 2,
    happenedAtUnixMs: 1_794_686_000_000n,
    replayed: false,
    ...overrides,
  };
}

function loginBeginFrame(): Uint8Array<ArrayBuffer> {
  const token = 'T'.repeat(43);
  const rp = encoder.encode('localhost');
  const challenge = new Uint8Array(WireLimits.PasskeyChallengeBytes).fill(7);
  const credId = Uint8Array.of(1, 2, 3, 4);
  const blobStart = WireLayouts.PasskeyLoginBeginSize + WireLayouts.PasskeyCredentialDescriptorSize + 4;
  const blobSize = rp.length + challenge.length + credId.length;
  const payload = new Uint8Array(blobStart + blobSize);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, 60_000n, true);
  view.setInt32(8, 1, true);
  payload.set(encoder.encode(token), WireLayouts.PasskeyLoginBeginTokenOffset);
  const rpRef = WireLayouts.PasskeyLoginBeginTokenOffset + WireLayouts.PasskeyTokenSize;
  view.setInt32(rpRef, 0, true);
  view.setInt32(rpRef + 4, rp.length, true);
  view.setInt32(rpRef + WireLayouts.PasskeySliceSize, rp.length, true);
  view.setInt32(rpRef + WireLayouts.PasskeySliceSize + 4, challenge.length, true);
  const ref = WireLayouts.PasskeyLoginBeginSize;
  view.setInt32(ref + 8, rp.length + challenge.length, true);
  view.setInt32(ref + 12, credId.length, true);
  view.setInt32(blobStart - 4, blobSize, true);
  payload.set(rp, blobStart);
  payload.set(challenge, blobStart + rp.length);
  payload.set(credId, blobStart + rp.length + challenge.length);
  return encodeFrame(FrameType.PasskeyLoginBegin, payload);
}

function mfaChallengeResultFrame(proof = validProof): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(WireLayouts.MfaChallengeResultBytes);
  payload[4] = 1;
  payload[5] = 1;
  payload.set(encoder.encode('admin-sensitive'), WireLayouts.MfaChallengeActionOffset);
  payload.set(encoder.encode(proof), WireLayouts.MfaChallengeProofOffset);
  return encodeFrame(FrameType.MfaChallengeResult, payload);
}

function installPasskeyEnvironment(t: TestContext) {
  class FakeAssertionResponse {}
  class FakeCredential {
    id = 'cred-id';
    rawId = Uint8Array.of(9, 8, 7).buffer;
    response: FakeAssertionResponse;
    constructor(response: FakeAssertionResponse) {
      this.response = response;
    }
  }
  const prevCredential = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
  const prevAssertion = Object.getOwnPropertyDescriptor(globalThis, 'AuthenticatorAssertionResponse');
  const prevCredentials = Object.getOwnPropertyDescriptor(globalThis.navigator, 'credentials');

  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: FakeCredential });
  Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', { configurable: true, value: FakeAssertionResponse });
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: {
      async get() {
        const response = Object.assign(new FakeAssertionResponse(), {
          clientDataJSON: Uint8Array.of(1, 2).buffer,
          authenticatorData: Uint8Array.of(3, 4).buffer,
          signature: Uint8Array.of(5, 6).buffer,
          userHandle: null,
        });
        return new FakeCredential(response);
      },
    },
  });

  t.after(() => {
    if (prevCredential) Object.defineProperty(globalThis, 'PublicKeyCredential', prevCredential);
    else delete (globalThis as Record<string, unknown>).PublicKeyCredential;
    if (prevAssertion) Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', prevAssertion);
    else delete (globalThis as Record<string, unknown>).AuthenticatorAssertionResponse;
    if (prevCredentials) Object.defineProperty(globalThis.navigator, 'credentials', prevCredentials);
    else delete (globalThis.navigator as unknown as Record<string, unknown>).credentials;
  });
}

function mockFetch(t: TestContext, handler: typeof fetch) {
  const prev = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = prev;
  });
}

test('validReaderGovernanceReason enforces length, UTF-8 byte budget, and control character rules', () => {
  equal(validReaderGovernanceReason(''), false);
  equal(validReaderGovernanceReason('   '), false);
  equal(validReaderGovernanceReason('Line 1\nLine 2'), false);
  equal(validReaderGovernanceReason('Bad\u007fchar'), false);
  equal(validReaderGovernanceReason('A'.repeat(WireLimits.AdminReaderReasonChars)), true);
  equal(validReaderGovernanceReason('A'.repeat(WireLimits.AdminReaderReasonChars + 1)), false);
  equal(validReaderGovernanceReason('汉'.repeat(500)), true);
  equal(validReaderGovernanceReason('违规垃圾评论刷屏，按规则临时封禁'), true);
});

test('readAdminReaderAccounts encodes query params, enforces permission session, and validates response invariants', async t => {
  const seenUrls: string[] = [];
  const expected = samplePage({
    hasMore: true,
    nextCursorAccountId: 42,
    nextCursorUserId: userId,
  });

  mockFetch(t, async input => {
    seenUrls.push(String(input));
    return new Response(encodeFrame(FrameType.AdminReaderAccountPage, encodeAdminReaderAccountPage(expected)), {
      status: 200,
      headers: {
        ...aedsHeaders,
        [WireHeaders.AdminPermissionSession]: validPermissionSession,
      },
    });
  });

  const page = await readAdminReaderAccounts(activeSession(), {
    status: 'disabled',
    keyword: '  alice  ',
    after: { accountId: 99, userId },
  }, new AbortController().signal);
  deepEqual(page, expected);
  equal(
    seenUrls[0],
    `${WireRoutes.AdminReaderAccounts}?status=disabled&keyword=alice&afterAccountId=99&afterUserId=${userId}`,
  );

  await readAdminReaderAccounts(activeSession(), { status: 'all', keyword: '   ' }, new AbortController().signal);
  equal(seenUrls[1], WireRoutes.AdminReaderAccounts);

  mockFetch(t, async () => new Response(
    encodeFrame(FrameType.AdminReaderAccountPage, encodeAdminReaderAccountPage(samplePage())),
    {
      status: 200,
      headers: {
        ...aedsHeaders,
        [WireHeaders.AdminPermissionSession]: altPermissionSession,
      },
    },
  ));
  await rejects(
    readAdminReaderAccounts(activeSession(), {}, new AbortController().signal),
    ProtocolError,
  );

  const malformedPages: AdminReaderAccountPage[] = [
    samplePage({ total: 5, enabledTotal: 1, disabledTotal: 1 }),
    samplePage({ hasMore: true, nextCursorUserId: zeroUuid }),
    samplePage({ hasMore: false, nextCursorAccountId: 7 }),
    samplePage({ items: [sampleAccount({ lastGovernanceAtUnixMs: 0n, lastGovernanceActor: 'admin' })] }),
    samplePage({ items: [sampleAccount({ lastGovernanceAtUnixMs: 1_794_684_000_000n, lastGovernanceReason: '' })] }),
  ];
  for (const invalid of malformedPages) {
    mockFetch(t, async () => new Response(
      encodeFrame(FrameType.AdminReaderAccountPage, encodeAdminReaderAccountPage(invalid)),
      {
        status: 200,
        headers: {
          ...aedsHeaders,
          [WireHeaders.AdminPermissionSession]: validPermissionSession,
        },
      },
    ));
    await rejects(
      readAdminReaderAccounts(activeSession(), {}, new AbortController().signal),
      ProtocolError,
    );
  }
});

test('requestReaderStatusProof binds trimmed command and idempotency key to Step-Up routes', async t => {
  installPasskeyEnvironment(t);
  const calls: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];

  mockFetch(t, async (input, init) => {
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    if (String(input) === WireRoutes.AdminReaderStatusStepUpBegin) {
      return new Response(loginBeginFrame(), { status: 200, headers: aedsHeaders });
    }
    return new Response(mfaChallengeResultFrame(validProof), { status: 200, headers: aedsHeaders });
  });

  const proof = await requestReaderStatusProof(sampleCommand(), new AbortController().signal);
  equal(proof, validProof);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.AdminReaderStatusStepUpBegin);
  equal(calls[0].headers.get(WireHeaders.ClientMutationId), commandId);
  const decodedBegin = decodeAdminReaderStatusCommand(decodeFrame(calls[0].body, FrameType.AdminReaderStatusCommand).payload);
  equal(decodedBegin.reason, 'Spam automation detected');
  equal(calls[1].url, WireRoutes.AdminReaderStatusStepUpComplete);

  let networkCalled = false;
  mockFetch(t, async () => {
    networkCalled = true;
    throw new Error('should not fetch');
  });
  await rejects(
    requestReaderStatusProof(sampleCommand({ userId: zeroUuid }), new AbortController().signal),
    ProtocolError,
  );
  await rejects(
    requestReaderStatusProof(sampleCommand({ reason: '   ' }), new AbortController().signal),
    ProtocolError,
  );
  equal(networkCalled, false);
});

test('executeReaderStatusChange sends proof and idempotency headers, supports proof-less replay, and validates receipts', async t => {
  const seenHeaders: Headers[] = [];
  const receipt = sampleReceipt();
  mockFetch(t, async (input, init) => {
    equal(String(input), WireRoutes.AdminReaderStatusExecute);
    seenHeaders.push(new Headers(init?.headers));
    return new Response(encodeFrame(FrameType.AdminReaderStatusReceipt, encodeAdminReaderStatusReceipt(receipt)), {
      status: 200,
      headers: {
        ...aedsHeaders,
        [WireHeaders.AdminPermissionSession]: validPermissionSession,
      },
    });
  });

  const first = await executeReaderStatusChange(activeSession(), sampleCommand(), validProof, new AbortController().signal);
  deepEqual(first, receipt);
  equal(seenHeaders[0].get(WireHeaders.MfaProof), validProof);
  equal(seenHeaders[0].get(WireHeaders.ClientMutationId), commandId);

  const replayed = await executeReaderStatusChange(activeSession(), sampleCommand(), undefined, new AbortController().signal);
  deepEqual(replayed, receipt);
  equal(seenHeaders[1].get(WireHeaders.MfaProof), null);
  equal(seenHeaders[1].get(WireHeaders.ClientMutationId), commandId);

  for (const badReceipt of [
    sampleReceipt({ generation: 99n }),
    sampleReceipt({ enabled: true }),
    sampleReceipt({ revokedSessionCount: -1 }),
    sampleReceipt({ userId: commandId }),
  ]) {
    mockFetch(t, async () => new Response(
      encodeFrame(FrameType.AdminReaderStatusReceipt, encodeAdminReaderStatusReceipt(badReceipt)),
      {
        status: 200,
        headers: {
          ...aedsHeaders,
          [WireHeaders.AdminPermissionSession]: validPermissionSession,
        },
      },
    ));
    await rejects(
      executeReaderStatusChange(activeSession(), sampleCommand(), validProof, new AbortController().signal),
      ProtocolError,
    );
  }
});
