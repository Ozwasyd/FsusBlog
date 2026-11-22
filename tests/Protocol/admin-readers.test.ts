import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { adminSessionFixture, altPermissionSession, permissionHeader, validPermissionSession, validProof } from './admin-permission-fixture.ts';
import { frameResponse } from './fixture-source.ts';
import {
  installPasskeyEnvironment, loginBeginFrame, mfaChallengeResultFrame,
} from './step-up-fixture.ts';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  executeReaderStatusChange,
  readAdminReaderAccounts,
  requestReaderStatusProof,
  validReaderGovernanceReason,
  type AdminReaderAccount,
  type AdminReaderAccountPage,
  type AdminReaderQuery,
  type AdminReaderStatusCommand,
  type AdminReaderStatusReceipt,
} from '../../src/Contracts/admin-readers.ts';
import {
  decodeAdminReaderStatusCommand,
  encodeAdminReaderAccountPage,
  encodeAdminReaderStatusReceipt,
  FrameType,
  WireHeaders,
  WireLimits,
  WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const zeroUuid = '00000000-0000-0000-0000-000000000000';
const userId = '11111111-2222-4333-8444-555555555555';
const commandId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const activeSession = adminSessionFixture('admin-fixture', 3n);

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

function readerPageResponse(page: AdminReaderAccountPage, binding = validPermissionSession) {
  return frameResponse(encodeFrame(FrameType.AdminReaderAccountPage, encodeAdminReaderAccountPage(page)), permissionHeader(binding));
}

function readerReceiptResponse(receipt: AdminReaderStatusReceipt) {
  return frameResponse(encodeFrame(FrameType.AdminReaderStatusReceipt, encodeAdminReaderStatusReceipt(receipt)), permissionHeader(validPermissionSession));
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
  const read = (query: AdminReaderQuery = {}) => readAdminReaderAccounts(activeSession(), query, new AbortController().signal);
  const seenUrls: string[] = [];
  const expected = samplePage({
    hasMore: true,
    nextCursorAccountId: 42,
    nextCursorUserId: userId,
  });

  mockFetch(t, async input => {
    seenUrls.push(String(input));
    return readerPageResponse(expected);
  });

  const page = await read({
    status: 'disabled',
    keyword: '  alice  ',
    after: { accountId: 99, userId },
  });
  deepEqual(page, expected);
  equal(
    seenUrls[0],
    `${WireRoutes.AdminReaderAccounts}?status=disabled&keyword=alice&afterAccountId=99&afterUserId=${userId}`,
  );

  await read({ status: 'all', keyword: '   ' });
  equal(seenUrls[1], WireRoutes.AdminReaderAccounts);

  mockFetch(t, async () => readerPageResponse(samplePage(), altPermissionSession));
  await rejects(read(), ProtocolError);

  const malformedPages: AdminReaderAccountPage[] = [
    samplePage({ total: 5, enabledTotal: 1, disabledTotal: 1 }),
    samplePage({ hasMore: true, nextCursorUserId: zeroUuid }),
    samplePage({ hasMore: false, nextCursorAccountId: 7 }),
    samplePage({ items: [sampleAccount({ lastGovernanceAtUnixMs: 0n, lastGovernanceActor: 'admin' })] }),
    samplePage({ items: [sampleAccount({ lastGovernanceAtUnixMs: 1_794_684_000_000n, lastGovernanceReason: '' })] }),
  ];
  for (const invalid of malformedPages) {
    mockFetch(t, async () => readerPageResponse(invalid));
    await rejects(read(), ProtocolError);
  }
});

test('requestReaderStatusProof binds trimmed command and idempotency key to Step-Up routes', async t => {
  installPasskeyEnvironment(t);
  const calls: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];

  mockFetch(t, async (input, init) => {
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    if (String(input) === WireRoutes.AdminReaderStatusStepUpBegin) {
      return frameResponse(loginBeginFrame());
    }
    return frameResponse(mfaChallengeResultFrame({ proof: validProof }));
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
  const execute = (proof?: string) => executeReaderStatusChange(activeSession(), sampleCommand(), proof, new AbortController().signal);
  const seenHeaders: Headers[] = [];
  const receipt = sampleReceipt();
  mockFetch(t, async (input, init) => {
    equal(String(input), WireRoutes.AdminReaderStatusExecute);
    seenHeaders.push(new Headers(init?.headers));
    return readerReceiptResponse(receipt);
  });

  const first = await execute(validProof);
  deepEqual(first, receipt);
  equal(seenHeaders[0].get(WireHeaders.MfaProof), validProof);
  equal(seenHeaders[0].get(WireHeaders.ClientMutationId), commandId);

  const replayed = await execute(undefined);
  deepEqual(replayed, receipt);
  equal(seenHeaders[1].get(WireHeaders.MfaProof), null);
  equal(seenHeaders[1].get(WireHeaders.ClientMutationId), commandId);

  for (const badReceipt of [
    sampleReceipt({ generation: 99n }),
    sampleReceipt({ enabled: true }),
    sampleReceipt({ revokedSessionCount: -1 }),
    sampleReceipt({ userId: commandId }),
  ]) {
    mockFetch(t, async () => readerReceiptResponse(badReceipt));
    await rejects(execute(validProof), ProtocolError);
  }
});
