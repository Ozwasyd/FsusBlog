import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  executeReaderStatusChange, readAdminReaderAccounts, requestReaderStatusProof, validReaderGovernanceReason,
  type AdminReaderAccount, type AdminReaderAccountPage, type AdminReaderQuery, type AdminReaderStatusCommand, type AdminReaderStatusReceipt,
} from '../../src/Contracts/admin-readers.ts';
import { decodeAdminSessionHistory } from '../../src/Contracts/admin-session-history.ts';
import { readAuthorAppeals, validAuthorCommentQuery } from '../../src/Contracts/comment-appeals.ts';
import {
  AdminSignInState, decodeAdminReaderStatusCommand, decodeAdminSignInHistorySnapshot, encodeAdminReaderAccountPage,
  encodeAdminReaderStatusReceipt, encodeAdminSignInHistorySnapshot, FrameType, WireHeaders, WireLimits, WireRoutes,
  type AdminSignIn,
} from '../../src/Contracts/wire.generated.ts';
import { captureFetch, encodedResponse, fixtureText, framedFixture, frameResponse, hexBytes, hexFixture, podFrame } from './fixture-source.ts';
import {
  adminSessionFixture, altPermissionSession, installPasskeyEnvironment, loginBeginFrame, mfaChallengeResultFrame,
  permissionHeader, validPermissionSession, validProof,
} from './step-up-fixture.ts';

const signal = new AbortController().signal;

test('admin reader governance validates reasons, queries, Step-Up proofs, and receipt invariants', async t => {
  const zeroUuid = '00000000-0000-0000-0000-000000000000';
  const userId = '11111111-2222-4333-8444-555555555555';
  const commandId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const activeSession = adminSessionFixture('admin-fixture', 3n);
  const sampleAccount = (overrides: Partial<AdminReaderAccount> = {}): AdminReaderAccount => ({
    userId, accountId: 42, name: 'alice', displayName: 'Alice Reader', enabled: true, generation: 2n,
    passkeyCount: 2, activeSessionCount: 1, hasRecoveryKey: true, hasTotp: false, commentCount: 5,
    registeredAtUnixMs: 1_794_680_000_000n, lastUsedAtUnixMs: 1_794_685_000_000n, lastGovernanceAtUnixMs: 1_794_684_000_000n,
    lastGovernanceActor: 'admin-fixture', lastGovernanceReason: 'Restored after appeal', ...overrides,
  });
  const samplePage = (overrides: Partial<AdminReaderAccountPage> = {}): AdminReaderAccountPage => ({
    total: 2, enabledTotal: 1, disabledTotal: 1, hasMore: false,
    nextCursorAccountId: 0, nextCursorUserId: zeroUuid, items: [sampleAccount()], ...overrides,
  });
  const sampleCommand = (overrides: Partial<AdminReaderStatusCommand> = {}): AdminReaderStatusCommand => ({
    userId, targetEnabled: false, expectedGeneration: 2n, idempotencyKey: commandId, reason: '  Spam automation detected  ', ...overrides,
  });
  const sampleReceipt = (overrides: Partial<AdminReaderStatusReceipt> = {}): AdminReaderStatusReceipt => ({
    userId, enabled: false, generation: 3n, revokedSessionCount: 2, happenedAtUnixMs: 1_794_686_000_000n, replayed: false, ...overrides,
  });
  const pageResponse = (page: AdminReaderAccountPage, binding = validPermissionSession) =>
    encodedResponse(FrameType.AdminReaderAccountPage, encodeAdminReaderAccountPage(page), permissionHeader(binding));

  for (const [value, valid] of [
    ['', false], ['   ', false], ['Line 1\nLine 2', false], ['Bad\u007fchar', false],
    ['A'.repeat(WireLimits.AdminReaderReasonChars), true], ['A'.repeat(WireLimits.AdminReaderReasonChars + 1), false],
    ['汉'.repeat(500), true], ['违规垃圾评论刷屏，按规则临时封禁', true],
  ] as const) equal(validReaderGovernanceReason(value), valid);

  const read = (query: AdminReaderQuery = {}) => readAdminReaderAccounts(activeSession(), query, signal);
  const expected = samplePage({ hasMore: true, nextCursorAccountId: 42, nextCursorUserId: userId });
  let nextResponse = () => pageResponse(expected);
  const readCalls = captureFetch(t, () => nextResponse());
  deepEqual(await read({ status: 'disabled', keyword: '  alice  ', after: { accountId: 99, userId } }), expected);
  equal(readCalls[0].url, `${WireRoutes.AdminReaderAccounts}?status=disabled&keyword=alice&afterAccountId=99&afterUserId=${userId}`);
  await read({ status: 'all', keyword: '   ' });
  equal(readCalls[1].url, WireRoutes.AdminReaderAccounts);
  for (const response of [
    () => pageResponse(samplePage(), altPermissionSession),
    () => pageResponse(samplePage({ total: 5, enabledTotal: 1, disabledTotal: 1 })),
    () => pageResponse(samplePage({ hasMore: true, nextCursorUserId: zeroUuid })),
    () => pageResponse(samplePage({ hasMore: false, nextCursorAccountId: 7 })),
    () => pageResponse(samplePage({ items: [sampleAccount({ lastGovernanceAtUnixMs: 0n, lastGovernanceActor: 'admin' })] })),
    () => pageResponse(samplePage({ items: [sampleAccount({ lastGovernanceAtUnixMs: 1_794_684_000_000n, lastGovernanceReason: '' })] })),
  ]) { nextResponse = response; await rejects(read(), ProtocolError); }

  installPasskeyEnvironment(t);
  const proofCalls = captureFetch(t, ({ url }) =>
    frameResponse(url === WireRoutes.AdminReaderStatusStepUpBegin ? loginBeginFrame() : mfaChallengeResultFrame({ proof: validProof })));
  equal(await requestReaderStatusProof(sampleCommand(), signal), validProof);
  deepEqual(proofCalls.map(c => c.url), [WireRoutes.AdminReaderStatusStepUpBegin, WireRoutes.AdminReaderStatusStepUpComplete]);
  equal(proofCalls[0].headers.get(WireHeaders.ClientMutationId), commandId);
  equal(decodeAdminReaderStatusCommand(decodeFrame(proofCalls[0].body, FrameType.AdminReaderStatusCommand).payload).reason, 'Spam automation detected');
  const blocked = captureFetch(t, () => { throw new Error('should not fetch'); });
  await rejects(requestReaderStatusProof(sampleCommand({ userId: zeroUuid }), signal), ProtocolError);
  await rejects(requestReaderStatusProof(sampleCommand({ reason: '   ' }), signal), ProtocolError);
  equal(blocked.length, 0);

  const execute = (proof?: string) => executeReaderStatusChange(activeSession(), sampleCommand(), proof, signal);
  const receipt = sampleReceipt();
  let currentReceipt = receipt;
  const execCalls = captureFetch(t, ({ url }) => {
    equal(url, WireRoutes.AdminReaderStatusExecute);
    return encodedResponse(FrameType.AdminReaderStatusReceipt, encodeAdminReaderStatusReceipt(currentReceipt), permissionHeader(validPermissionSession));
  });
  deepEqual(await execute(validProof), receipt);
  equal(execCalls[0].headers.get(WireHeaders.MfaProof), validProof);
  equal(execCalls[0].headers.get(WireHeaders.ClientMutationId), commandId);
  deepEqual(await execute(undefined), receipt);
  equal(execCalls[1].headers.get(WireHeaders.MfaProof), null);
  equal(execCalls[1].headers.get(WireHeaders.ClientMutationId), commandId);
  for (const overrides of [{ generation: 99n }, { enabled: true }, { revokedSessionCount: -1 }, { userId: commandId }]) {
    currentReceipt = sampleReceipt(overrides);
    await rejects(execute(validProof), ProtocolError);
  }
});

test('administrator sign-in history matches C# vectors and rejects malformed snapshots', () => {
  const hours2 = 7_200_000n;
  const maxDate = 8_640_000_000_000_000n;
  const generation = 9_007_199_254_740_993n;
  const typical = framedFixture('admin-sign-in-history.hex', FrameType.AdminSignInHistory);
  const stateLabel = { [AdminSignInState.Current]: 'current', [AdminSignInState.Ended]: 'ended', [AdminSignInState.Expired]: 'expired' } as const;
  const fullWireRows = (count: number): AdminSignIn[] => [
    { startedAt: 1_800_000_000_000n, expiresAt: 1_800_000_000_000n + hours2, endedAt: 0n, state: AdminSignInState.Current },
    ...Array.from({ length: count - 1 }, (_, offset) => {
      const index = BigInt(offset + 1);
      const startedAt = 1_700_000_000_000n + index * 10_000_000n;
      return index % 2n === 1n
        ? { startedAt, expiresAt: startedAt + hours2, endedAt: startedAt + index * 1000n, state: AdminSignInState.Ended }
        : { startedAt, expiresAt: startedAt + hours2, endedAt: startedAt + hours2, state: AdminSignInState.Expired };
    }),
  ];
  const typicalWireRows: readonly AdminSignIn[] = [
    { startedAt: 1_800_000_000_000n, expiresAt: 1_800_000_000_000n + hours2, endedAt: 0n, state: AdminSignInState.Current },
    { startedAt: 1_799_990_000_000n, expiresAt: 1_799_990_000_000n + hours2, endedAt: 1_799_990_000_000n, state: AdminSignInState.Ended },
    { startedAt: maxDate - hours2, expiresAt: maxDate, endedAt: maxDate, state: AdminSignInState.Expired },
    { startedAt: 1_799_980_000_000n, expiresAt: 1_799_980_000_000n + hours2, endedAt: 1_799_981_234_567n, state: AdminSignInState.Ended },
  ];
  for (const [name, snapshot] of [
    ['admin-sign-in-history.hex', { generation, signIns: typicalWireRows }],
    ['admin-sign-in-history-empty.hex', { generation: 1n, signIns: [] }],
    ['admin-sign-in-history-full.hex', { generation: 2n, signIns: fullWireRows(50) }],
  ] as const) {
    const payload = framedFixture(name, FrameType.AdminSignInHistory);
    deepEqual(decodeAdminSessionHistory(payload, snapshot.generation), snapshot.signIns.map(row => ({
      startedAt: Number(row.startedAt), expiresAt: Number(row.expiresAt),
      endedAt: row.endedAt === 0n ? null : Number(row.endedAt), state: stateLabel[row.state],
    })));
    deepEqual(encodeFrame(FrameType.AdminSignInHistory, encodeAdminSignInHistorySnapshot(snapshot)), Uint8Array.from(hexFixture(name)), name);
    deepEqual(decodeAdminSignInHistorySnapshot(payload), snapshot);
  }

  const wireRejectNames = new Set([
    'trailing-byte', 'negative-count', 'count-over-limit', 'count-past-rows',
    'count-short-of-rows', 'state-zero', 'state-four', 'state-max',
  ]);
  const rejectVectors = fixtureText('admin-sign-in-history-reject.txt').trim().split('\n').map(line => {
    const [name, hex] = line.split(' ');
    return [name, hexBytes(hex)] as const;
  });
  equal(rejectVectors.length, 23);
  for (const [name, payload] of rejectVectors) {
    throws(() => decodeAdminSessionHistory(payload, generation), ProtocolError, name);
    if (wireRejectNames.has(name)) throws(() => decodeAdminSignInHistorySnapshot(payload), ProtocolError, name);
  }
  for (let length = 0; length < typical.length; length++) {
    throws(() => decodeAdminSessionHistory(typical.subarray(0, length), generation), ProtocolError);
    throws(() => decodeAdminSignInHistorySnapshot(typical.subarray(0, length)), ProtocolError);
  }
  throws(() => decodeAdminSessionHistory(typical, generation + 1n), ProtocolError);
  throws(() => decodeAdminSessionHistory(encodeAdminSignInHistorySnapshot({ generation: 0n, signIns: [] }), 0n), ProtocolError);
  throws(() => encodeAdminSignInHistorySnapshot({ generation: 2n, signIns: fullWireRows(51) }), ProtocolError);
  for (const state of [0, 4, 255] as unknown as AdminSignInState[])
    throws(() => encodeAdminSignInHistorySnapshot({ generation, signIns: [{ ...typicalWireRows[1], state }] }), ProtocolError);
});

test('author comment appeals validate search filters, query params, and row editability', async t => {
  type AppealRow = { article: number; comment: bigint; body: string; status: number; appeal: number; reason: string; editable: boolean };
  const appealsResponse = (rows: AppealRow[] = []) => frameResponse(podFrame(FrameType.CommentAuthorAppeals, w => {
    w.bool(false); w.i32(rows.length);
    for (const r of rows) { w.i32(r.article); w.i64(r.comment); w.text(r.body); w.i32(r.status); w.i32(r.appeal); w.text(r.reason); w.bool(r.editable); }
  }), { [WireHeaders.CommentAuthorEditEnabled]: '1' });

  for (const [value, valid] of [
    ['', true], ['  PostgreSQL 18  ', true], ['a'.repeat(100), true], ['a'.repeat(101), false],
    ['中'.repeat(100), true], ['hello\nworld', false], ['bad\u0000text', false],
  ] as const) equal(validAuthorCommentQuery(value), valid);

  let rows: AppealRow[] = [];
  const calls = captureFetch(t, () => appealsResponse(rows));
  const session = 'a'.repeat(64);
  equal((await readAuthorAppeals(null, session, signal)).editEnabled, true);
  equal(calls.at(-1)?.url, WireRoutes.CommentAuthorAppeals);
  await readAuthorAppeals(null, session, signal, { q: '  ', status: 'all' });
  equal(calls.at(-1)?.url, WireRoutes.CommentAuthorAppeals);
  await readAuthorAppeals('42', session, signal, { q: '  AEDS v2  ', status: 'rejected' });
  equal(calls.at(-1)?.url, `${WireRoutes.CommentAuthorAppeals}?before=42&q=AEDS+v2&status=rejected`);
  throws(() => readAuthorAppeals(null, session, signal, { q: 'bad\u0007' }), ProtocolError);
  throws(() => readAuthorAppeals(null, session, signal, { status: 'bogus' as never }), ProtocolError);

  rows = [
    { article: 1, comment: 10n, body: 'Fresh pending', status: 0, appeal: 0, reason: '', editable: true },
    { article: 1, comment: 9n, body: 'Expired pending', status: 0, appeal: 0, reason: '', editable: false },
    { article: 1, comment: 8n, body: 'Approved', status: 1, appeal: 0, reason: '', editable: false },
  ];
  const page = await readAuthorAppeals(null, 'b'.repeat(64), signal);
  deepEqual(page.rows.map(r => [r.comment, r.editable]), [['10', true], ['9', false], ['8', false]]);
  for (const invalid of [
    [{ article: 1, comment: 8n, body: 'Approved', status: 1, appeal: 0, reason: '', editable: true }],
    [{ article: 1, comment: 7n, body: '', status: 0, appeal: 0, reason: '', editable: true }],
  ]) { rows = invalid; await rejects(() => readAuthorAppeals(null, 'b'.repeat(64), signal), ProtocolError); }
});
