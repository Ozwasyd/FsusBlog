import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { apiErrorResponse, captureFetch, encodedResponse, frameResponse, podFrame, rejectInputs } from './fixture-source.ts';
import {
  adminSessionFixture, altPermissionSession, emptySuccessFrame, installPasskeyEnvironment,
  installPowWorker, loginBeginFrame, mfaChallengeResultFrame, permissionHeader, powChallengeFrame,
  validPermissionSession, validProof,
} from './step-up-fixture.ts';
import { ApiError, decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { applyAppearance } from '../../src/Contracts/admin-appearance.ts';
import { executeAdminArticleArchive, readAdminArticleArchiveAvailability, requestAdminArticleArchiveProof } from '../../src/Contracts/admin-article-archive.ts';
import {
  executeAdminArticleDraftRollback, executeAdminArticleRollback,
  requestAdminArticleDraftRollbackProof, requestAdminArticleRollbackProof,
} from '../../src/Contracts/admin-article-rollback.ts';
import {
  executeTrashPublication, executeTrashRestore, readTrashPublicationAvailability, readTrashRestoreAvailability,
  requestTrashPublicationProof, requestTrashRestoreProof,
} from '../../src/Contracts/admin-article-trash.ts';
import { readAdminCluster } from '../../src/Contracts/admin-cluster.ts';
import {
  assertAdminPermissionSession, readAdminAvailability, readAdminCommentQueue, readAdminOperations,
} from '../../src/Contracts/admin-identity.ts';
import { decideComment } from '../../src/Contracts/admin-moderation.ts';
import { encodeModerationBatchDecision, proveAndDecideModerationBatch } from '../../src/Contracts/admin-moderation-batch.ts';
import { readAdminRiskReadiness } from '../../src/Contracts/admin-risk-readiness.ts';
import { applyRootCommentPowPolicy, readRootCommentPowPolicy } from '../../src/Contracts/admin-root-comment-pow.ts';
import { readAdminSessionHistory } from '../../src/Contracts/admin-session-history.ts';
import { publishAdminSitePage, readAdminSitePages } from '../../src/Contracts/admin-site-pages.ts';
import { readAdminSiteTraffic } from '../../src/Contracts/admin-site-traffic.ts';
import {
  adminProofHeaders, optionalAdminProofHeaders, proveAdminModeration, proveAdminModerationDecision, proveAdminStepUp,
} from '../../src/Contracts/admin-step-up.ts';
import { readAdminTaxonomy } from '../../src/Contracts/admin-taxonomy.ts';
import { PodWriter } from '../../src/Contracts/binary.ts';
import { decideAdminAppeal, readAdminAppeals } from '../../src/Contracts/comment-appeals.ts';
import {
  encodeAdminAppearanceCommand, encodeAdminArticleArchiveReceipt,
  encodeAdminArticleTrashPublicationReceipt, encodeAdminArticleTrashRestoreReceipt,
  encodeAdminClusterStatus, encodeAdminModerationIntent, encodeAdminOperationsStatus,
  encodeAdminRiskReadiness, encodeAdminRootCommentPowCommand, encodeAdminRootCommentPowPolicy, encodeAdminSitePagePublish,
  encodeAdminSitePages, FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const altProof = 'Q'.repeat(43);
const encoder = new TextEncoder();
const activeSession = adminSessionFixture('admin-fixture', 5n);
const signal = new AbortController().signal;

test('assertAdminPermissionSession enforces binding across all six bound admin routes without adding it to unbound routes', async t => {
  const session = activeSession();
  const boundCases = [
    [encodeFrame(FrameType.AdminOperationsStatus, encodeAdminOperationsStatus({
      snapshotReady: true, publicationWatermark: 1n, pendingPublicationEvents: 0n, oldestPendingAt: 0n,
    })), readAdminOperations],
    [encodeFrame(FrameType.AdminClusterStatus, encodeAdminClusterStatus({
      mode: 1, nodeId: 'node-1', instanceId: 'bd978cbd-7565-44ed-876d-d734cbe45c79', buildVersion: '2.0.0',
      startedAt: 1_794_680_000_000n, observedAt: 1_794_680_010_000n, leaseAgeMs: 100, snapshotReady: true,
    })), readAdminCluster],
    [encodeFrame(FrameType.AdminRiskReadiness, encodeAdminRiskReadiness({
      publicReadMode: 1, rootWriteMode: 1, replyWriteMode: 2, forwardingMode: 1, dynamicRisk: 0, strongAnonymous: 0,
    })), readAdminRiskReadiness],
    [podFrame(FrameType.AdminSiteTraffic, w => { w.bool(false); w.bool(false); w.i32(0); w.i32(0); }), readAdminSiteTraffic],
    [podFrame(FrameType.AdminSignInHistory, w => {
      w.i64(session.generation); w.i32(1); w.i64(1_794_680_000_000n); w.i64(1_794_687_200_000n); w.i64(0n); w.bool(true);
    }), readAdminSessionHistory, 'Administrator history session changed.'],
    [encodeFrame(FrameType.AdminRootCommentPowPolicy, encodeAdminRootCommentPowPolicy({
      generation: 1n, digest: 'c'.repeat(64), proofSeconds: WireLimits.PowChallengeSeconds, previousSeconds: 0,
    })), readRootCommentPowPolicy],
  ] as const;

  let responseHeaders: Record<string, string> = {};
  let responseBody: Uint8Array<ArrayBuffer> = new Uint8Array();
  t.mock.method(globalThis, 'fetch', async () => frameResponse(responseBody, responseHeaders));

  for (const [frame, run, message] of boundCases) {
    const read = (target = session) => run(target, signal);
    responseBody = frame;
    responseHeaders = permissionHeader(validPermissionSession);
    await read();
    responseHeaders = {};
    await rejects(() => read(), ProtocolError);
    responseHeaders = permissionHeader(altPermissionSession);
    await rejects(() => read(), error => error instanceof ProtocolError && (!message || error.message === message));
    for (const malformed of ['', 'not-hex', 'A'.repeat(64), '0'.repeat(63)]) {
      responseHeaders = permissionHeader(malformed);
      await rejects(() => read(), ProtocolError);
    }
    for (const badSession of [activeSession(null), activeSession(''), activeSession('not-hex')]) {
      responseHeaders = badSession.permissionSession ? permissionHeader(badSession.permissionSession) : {};
      await rejects(() => read(badSession), ProtocolError);
    }
  }

  throws(() => assertAdminPermissionSession(activeSession(''), new Headers()), ProtocolError);
  throws(() => assertAdminPermissionSession(activeSession('0'.repeat(63)), new Headers(permissionHeader('0'.repeat(63)))), ProtocolError);

  responseHeaders = {};
  const queueBytes = (() => { const w = new PodWriter(); w.bool(false); w.i32(0); return w.finish(); })();
  responseBody = encodeFrame(FrameType.AdminCommentQueue, queueBytes);
  deepEqual(await readAdminCommentQueue(null, signal), { comments: [], next: null, batchEnabled: false });
  responseBody = podFrame(FrameType.AdminTaxonomyPage, w => { w.i32(0); w.i32(0); });
  deepEqual(await readAdminTaxonomy('categories', null, signal), { nextId: null, items: [] });
  responseBody = encodeFrame(FrameType.AdminCommentAppeals, queueBytes);
  deepEqual(await readAdminAppeals(null, signal), { rows: [], more: false });
  responseBody = encodeFrame(FrameType.AdminSitePages, encodeAdminSitePages({ configuredMask: 0 }));
  equal((await readAdminSitePages(signal)).pages.length, 4);
});

test('proveAdminStepUp enforces route order, restricted assertion, begin-only headers, and proof validation', async t => {
  let assertionCount = 0;
  installPasskeyEnvironment(t, { onGet: options => { assertionCount++; equal(options?.publicKey?.allowCredentials?.length, 1); } });

  const intent = encodeFrame(FrameType.AdminModerationIntent, encodeAdminModerationIntent({
    articleId: 3, commentId: 9n, expectedStatus: 0, decision: 1, reason: 'Approve step-up fixture',
  }));
  const routes = { begin: '/begin.aeds', complete: '/complete.aeds' };
  const calls = captureFetch(t, ({ url, body }) => {
    if (url === routes.begin) return frameResponse(loginBeginFrame(1));
    if (url === routes.complete) {
      equal(decodeFrame(body, FrameType.PasskeyLoginCompleteRequest).payload[0], 0);
      return frameResponse(mfaChallengeResultFrame({ proof: validProof }));
    }
    throw new Error(`Unexpected route ${url}`);
  });

  equal(await proveAdminStepUp(routes, intent, signal, { [WireHeaders.ClientMutationId]: 'mutation-1' }), validProof);
  equal(assertionCount, 1);
  deepEqual(calls.map(c => [c.url, c.method, c.headers.get(WireHeaders.ClientMutationId)]), [
    [routes.begin, 'POST', 'mutation-1'], [routes.complete, 'POST', null],
  ]);
  deepEqual(calls[0].body, intent);

  deepEqual(adminProofHeaders(validProof), { [WireHeaders.MfaProof]: validProof });
  deepEqual(optionalAdminProofHeaders(validProof), { [WireHeaders.MfaProof]: validProof });
  equal(optionalAdminProofHeaders(undefined), undefined);
  rejectInputs(adminProofHeaders, ['', 'short', 'P'.repeat(44), 'P'.repeat(42) + '!', undefined as unknown as string]);
  throws(() => optionalAdminProofHeaders('bad-proof'), ProtocolError);
  await rejects(() => proveAdminStepUp({ begin: '', complete: '/c' }, intent), ProtocolError);

  captureFetch(t, () => frameResponse(loginBeginFrame(0)));
  await rejects(() => proveAdminStepUp(routes, intent), ProtocolError);
  equal(assertionCount, 1);

  for (const badResult of [
    mfaChallengeResultFrame({ action: 'recovery-key.create' }), mfaChallengeResultFrame({ verified: false }),
    mfaChallengeResultFrame({ withUser: true }), mfaChallengeResultFrame({ proof: 'bad!' }),
  ]) {
    captureFetch(t, ({ url }) => frameResponse(url === routes.begin ? loginBeginFrame(1) : badResult));
    await rejects(() => proveAdminStepUp(routes, intent), ProtocolError);
  }
});

test('proveAdminStepUp propagates abort, Passkey cancellation, and HTTP errors without retrying', async t => {
  let getBehavior: 'ok' | 'cancel' | 'abort-during' = 'ok';
  let abortController = new AbortController();
  let getCalls = 0;
  installPasskeyEnvironment(t, { onGet: () => {
    getCalls++;
    if (getBehavior === 'cancel') throw new DOMException('User canceled', 'NotAllowedError');
    if (getBehavior === 'abort-during') abortController.abort(new DOMException('Aborted', 'AbortError'));
  } });

  const intent = emptySuccessFrame();
  const routes = { begin: '/begin.aeds', complete: '/complete.aeds' };
  let beginResponse: () => Response = () => frameResponse(loginBeginFrame(1));
  let completeResponse: () => Response = () => frameResponse(mfaChallengeResultFrame());
  const calls = captureFetch(t, ({ url }) => (url === routes.begin ? beginResponse() : completeResponse()));
  const expectStepUpError = async (
    reqSignal: AbortSignal, matcher: Parameters<typeof rejects>[1], urls: string[], expectedGets: number,
  ) => {
    calls.length = 0;
    await rejects(() => proveAdminStepUp(routes, intent, reqSignal), matcher);
    deepEqual(calls.map(c => c.url), urls);
    equal(getCalls, expectedGets);
  };

  const expectApiError = (status: number, details: string) => (err: unknown) =>
    err instanceof ApiError && err.status === status && err.details === details;

  abortController.abort(new DOMException('Already aborted', 'AbortError'));
  await expectStepUpError(abortController.signal, { name: 'AbortError' }, [], 0);

  beginResponse = () => apiErrorResponse(403, 'FORBIDDEN');
  await expectStepUpError(signal, expectApiError(403, 'FORBIDDEN'), [routes.begin], 0);

  getBehavior = 'cancel';
  beginResponse = () => frameResponse(loginBeginFrame(1));
  await expectStepUpError(signal, { name: 'NotAllowedError' }, [routes.begin], 1);

  getBehavior = 'abort-during';
  abortController = new AbortController();
  await expectStepUpError(abortController.signal, { name: 'AbortError' }, [routes.begin], 2);

  getBehavior = 'ok';
  completeResponse = () => apiErrorResponse(401, 'ADMIN_SESSION_EXPIRED');
  await expectStepUpError(signal, expectApiError(401, 'ADMIN_SESSION_EXPIRED'), [routes.begin, routes.complete], 3);
});

test('all migrated administrator Step-Up actions preserve exact routes, bytes, headers, and receipt binding', async t => {
  installPasskeyEnvironment(t);
  installPowWorker(t);

  const session = activeSession();
  const handlers = new Map<string, (headers: Headers, body: Uint8Array) => Response>();
  const calls = captureFetch(t, ({ url, headers, body }) => {
    const handler = handlers.get(url);
    if (!handler) throw new Error(`Unexpected fetch: ${url}`);
    return handler(headers, body);
  });

  const resetRoutes = () => { calls.length = 0; handlers.clear(); };
  const callUrls = () => calls.map(c => c.url);
  const stepUpPair = (begin: string, complete: string, expectedFrame: FrameType, proof = validProof, expectMutation?: string) => {
    handlers.set(begin, (headers, body) => {
      decodeFrame(body, expectedFrame);
      equal(headers.get(WireHeaders.ClientMutationId), expectMutation ?? null);
      return frameResponse(loginBeginFrame(1));
    });
    handlers.set(complete, headers => {
      equal(headers.get(WireHeaders.ClientMutationId), null);
      return frameResponse(mfaChallengeResultFrame({ proof }));
    });
  };
  async function checkReplay<I, R>(spec: {
    routes: readonly [string, string, string]; frame: FrameType; receiptFrame: FrameType;
    intent: I; receipt: R; encodeReceipt: (r: R) => Uint8Array;
    prove: (v: I, s: AbortSignal) => Promise<string>; execute: (v: I, p: string | undefined, s: AbortSignal) => Promise<R>;
    proof?: string; mutation?: string;
  }) {
    const proof = spec.proof ?? validProof;
    resetRoutes();
    stepUpPair(spec.routes[0], spec.routes[1], spec.frame, proof, spec.mutation);
    handlers.set(spec.routes[2], headers => {
      if (spec.mutation) equal(headers.get(WireHeaders.ClientMutationId), spec.mutation);
      equal(headers.get(WireHeaders.MfaProof), calls.length === 3 ? proof : null);
      return encodedResponse(spec.receiptFrame, spec.encodeReceipt(spec.receipt));
    });
    const issued = await spec.prove(spec.intent, signal);
    deepEqual(await spec.execute(spec.intent, issued, signal), spec.receipt);
    deepEqual(await spec.execute(spec.intent, undefined, signal), spec.receipt);
  }
  async function checkPowFlow<C>(routes: string[], type: FrameType, encode: (c: C) => Uint8Array, cmd: C, proof: string, run: (c: C, s: AbortSignal) => Promise<unknown>) {
    const frame = encodeFrame(type, encode(cmd));
    resetRoutes();
    stepUpPair(routes[0], routes[1], type, proof);
    handlers.set(routes[2], (headers, body) => {
      equal(headers.get(WireHeaders.MfaProof), null);
      match(headers.get(WireHeaders.PowClientNonce) ?? '', /^[a-f0-9]{32}$/);
      deepEqual(body, frame);
      return frameResponse(powChallengeFrame({ salt: 'f'.repeat(32) }));
    });
    handlers.set(routes[3], (headers, body) => {
      equal(headers.get(WireHeaders.MfaProof), proof);
      equal(typeof headers.get(WireHeaders.PowProof), 'string');
      deepEqual(body, frame);
      return frameResponse(emptySuccessFrame());
    });
    await run(cmd, signal);
    deepEqual(callUrls(), routes);
  }

  // 1. Moderation intent & decision
  resetRoutes();
  stepUpPair(WireRoutes.AdminStepUpBegin, WireRoutes.AdminStepUpComplete, FrameType.AdminModerationIntent);
  equal(await proveAdminModeration({ articleId: 1, commentId: 2n, expectedStatus: 0, decision: 1, reason: 'Valid reason' }, signal), validProof);
  deepEqual(callUrls(), [WireRoutes.AdminStepUpBegin, WireRoutes.AdminStepUpComplete]);

  resetRoutes();
  stepUpPair(WireRoutes.AdminModerationStepUpBegin, WireRoutes.AdminStepUpComplete, FrameType.AdminModerationDecision, altProof);
  handlers.set(WireRoutes.AdminModerationDecision, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), altProof);
    decodeFrame(body, FrameType.AdminModerationDecision);
    return frameResponse(emptySuccessFrame());
  });
  const modDecision = {
    articleId: 1, commentId: 2n, expectedStatus: 0, decision: 1, reason: 'Moderation reason',
    commentVersion: 1n, claimToken: 'C'.repeat(43), claimGeneration: 1n, claimVersion: 1n,
  };
  const modProof = await proveAdminModerationDecision(modDecision, signal);
  equal(modProof, altProof);
  await decideComment(modDecision, modProof, signal);
  throws(() => decideComment(modDecision, 'invalid-proof', signal), ProtocolError);

  // 2. Rollback proof helpers
  resetRoutes();
  const rollbackIntent = {
    articleId: 7, expectedRevision: 3n, expectedPublicationId: 8n, sourceRevision: 1n,
    idempotencyKey: '00000000-0011-4222-8333-445566778899', reason: 'Restore approved article content',
  };
  stepUpPair(WireRoutes.AdminArticleRollbackStepUpBegin, WireRoutes.AdminArticleRollbackStepUpComplete, FrameType.AdminArticleRollbackIntent);
  stepUpPair(WireRoutes.AdminArticleDraftRollbackStepUpBegin, WireRoutes.AdminArticleDraftRollbackStepUpComplete, FrameType.AdminArticleDraftRollbackIntent, altProof);
  equal(await requestAdminArticleRollbackProof(rollbackIntent, signal), validProof);
  equal(await requestAdminArticleDraftRollbackProof({ ...rollbackIntent, targetStatus: 0 }, signal), altProof);
  deepEqual(callUrls(), [
    WireRoutes.AdminArticleRollbackStepUpBegin, WireRoutes.AdminArticleRollbackStepUpComplete,
    WireRoutes.AdminArticleDraftRollbackStepUpBegin, WireRoutes.AdminArticleDraftRollbackStepUpComplete,
  ]);
  throws(() => executeAdminArticleRollback(rollbackIntent, 'bad', signal), ProtocolError);
  throws(() => executeAdminArticleDraftRollback({ ...rollbackIntent, targetStatus: 0 }, 'bad', signal), ProtocolError);

  // 3 & 4. Archive, trash publication, trash restore
  const archiveIntent = {
    articleId: 7, expectedRevision: 3n, expectedReleaseId: 8n, sourceRevision: 1n,
    idempotencyKey: rollbackIntent.idempotencyKey, reason: 'Archive article cleanly', targetStatus: 3,
  };
  const archiveReceipt = {
    articleId: 7, revision: 4n, sourceRevision: 1n, previousReleaseId: 8n, releaseId: 9n, publicationNo: 3,
    transitionedUnixMs: 1_794_680_000_000n, rightsSnapshotId: 1n, responsibilitySnapshotId: 2n, targetStatus: 3,
  };
  await checkReplay({
    routes: [WireRoutes.AdminArticleArchiveStepUpBegin, WireRoutes.AdminArticleArchiveStepUpComplete, WireRoutes.AdminArticleArchiveExecute],
    frame: FrameType.AdminArticleArchiveIntent, receiptFrame: FrameType.AdminArticleArchiveReceipt,
    intent: archiveIntent, receipt: archiveReceipt, encodeReceipt: encodeAdminArticleArchiveReceipt,
    prove: requestAdminArticleArchiveProof, execute: executeAdminArticleArchive,
  });
  handlers.set(WireRoutes.AdminArticleArchiveExecute, () =>
    encodedResponse(FrameType.AdminArticleArchiveReceipt, encodeAdminArticleArchiveReceipt({ ...archiveReceipt, targetStatus: 2 })));
  await rejects(() => executeAdminArticleArchive(archiveIntent, undefined, signal), ProtocolError);

  const trashKey = '11111111-1111-4111-8111-111111111111';
  await checkReplay({
    routes: [WireRoutes.AdminArticleTrashPublicationBegin, WireRoutes.AdminArticleTrashPublicationComplete, WireRoutes.AdminArticleTrashPublicationExecute],
    frame: FrameType.AdminArticleTrashPublicationIntent, receiptFrame: FrameType.AdminArticleTrashPublicationReceipt,
    intent: { articleId: 9, expectedRevision: 5n, sourceRevision: 2n, sourcePublicationId: 4n, idempotencyKey: trashKey, reason: 'Republish trashed article cleanly' },
    receipt: { articleId: 9, revision: 6n, sourceRevision: 2n, sourcePublicationId: 4n, publicationId: 12n },
    encodeReceipt: encodeAdminArticleTrashPublicationReceipt, prove: requestTrashPublicationProof, execute: executeTrashPublication, mutation: trashKey,
  });
  await checkReplay({
    routes: [WireRoutes.AdminArticleTrashRestoreBegin, WireRoutes.AdminArticleTrashRestoreComplete, WireRoutes.AdminArticleTrashRestoreExecute],
    frame: FrameType.AdminArticleTrashRestoreIntent, receiptFrame: FrameType.AdminArticleTrashRestoreReceipt,
    intent: { articleId: 9, expectedRevision: 5n, idempotencyKey: trashKey }, receipt: { articleId: 9, revision: 6n },
    encodeReceipt: encodeAdminArticleTrashRestoreReceipt, prove: requestTrashRestoreProof, execute: executeTrashRestore, proof: altProof, mutation: trashKey,
  });

  // Availability helpers
  for (const [route, status] of [
    [WireRoutes.AdminArticleArchiveAvailability, 204], [WireRoutes.AdminArticleTrashRestoreAvailability, 404],
    [WireRoutes.AdminArticleTrashPublicationAvailability, 403], ['/bad-availability', 200],
  ] as const) handlers.set(route, () => new Response(null, { status }));
  equal(await readAdminArticleArchiveAvailability(signal), true);
  equal(await readTrashRestoreAvailability(signal), false);
  await rejects(() => readTrashPublicationAvailability(signal), { status: 403 });
  await rejects(() => readAdminAvailability('/bad-availability', signal), ProtocolError);

  // 5. Moderation batch
  resetRoutes();
  const batchRow = (commentId: bigint, ch: string) => ({
    articleId: 1, commentId, commentVersion: 1n, claimToken: ch.repeat(43), claimGeneration: 1n, claimVersion: 1n, expectedStatus: 0 as const,
  });
  const batchDecision = { decision: 1 as const, reason: 'Batch approval fixture', rows: [batchRow(10n, 'A'), batchRow(11n, 'B')] };
  const expectedBatchFrame = encodeModerationBatchDecision(batchDecision);
  stepUpPair(WireRoutes.AdminModerationBatchStepUpBegin, WireRoutes.AdminModerationBatchStepUpComplete, FrameType.AdminModerationBatchDecision);
  handlers.set(WireRoutes.AdminModerationBatchDecision, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    deepEqual(body, expectedBatchFrame);
    return frameResponse(podFrame(FrameType.AdminModerationBatchReceipt, w => { w.i64(55n); w.i32(2); }));
  });
  deepEqual(await proveAndDecideModerationBatch(batchDecision, signal), { batchId: 55n, count: 2 });
  deepEqual(callUrls(), [
    WireRoutes.AdminModerationBatchStepUpBegin, WireRoutes.AdminModerationBatchStepUpComplete, WireRoutes.AdminModerationBatchDecision,
  ]);

  // 6 & 7. Appearance & Site pages
  await checkPowFlow(
    [WireRoutes.AdminAppearanceStepUpBegin, WireRoutes.AdminAppearanceStepUpComplete, WireRoutes.AdminAppearancePow, WireRoutes.AdminAppearanceApply],
    FrameType.AdminAppearanceCommand, encodeAdminAppearanceCommand,
    { expectedRevision: 1n, currentTheme: '', currentFont: '', theme: 'd'.repeat(64), font: '', rollback: false },
    validProof, applyAppearance,
  );
  await checkPowFlow(
    [WireRoutes.AdminSitePageStepUpBegin, WireRoutes.AdminSitePageStepUpComplete, WireRoutes.AdminSitePagePow, WireRoutes.AdminSitePagePublish],
    FrameType.AdminSitePagePublish, encodeAdminSitePagePublish,
    { slug: 'about', expectedRevision: 1n, expectedDigest: 'e'.repeat(64), markdown: '# Updated about\n' },
    altProof, publishAdminSitePage,
  );

  // 8. Root comment PoW policy
  resetRoutes();
  const powCmd = { expectedGeneration: 1n, expectedDigest: 'c'.repeat(64), proofSeconds: 90, rollback: false };
  const powFrame = encodeFrame(FrameType.AdminRootCommentPowCommand, encodeAdminRootCommentPowCommand(powCmd));
  stepUpPair(WireRoutes.AdminRootCommentPowBegin, WireRoutes.AdminRootCommentPowComplete, FrameType.AdminRootCommentPowCommand);
  let applyPermissionHeader: string | null = validPermissionSession;
  handlers.set(WireRoutes.AdminRootCommentPowApply, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    deepEqual(body, powFrame);
    return encodedResponse(FrameType.AdminRootCommentPowPolicy, encodeAdminRootCommentPowPolicy({
      generation: 2n, digest: 'd'.repeat(64), proofSeconds: 90, previousSeconds: 120,
    }), applyPermissionHeader !== null ? permissionHeader(applyPermissionHeader) : {});
  });
  equal((await applyRootCommentPowPolicy(session, powCmd, signal)).generation, 2n);
  applyPermissionHeader = altPermissionSession;
  await rejects(() => applyRootCommentPowPolicy(session, powCmd, signal), ProtocolError);

  // 9. Comment appeals
  resetRoutes();
  const appealBegin = WireRoutes.AdminAppealStepUpBegin.replace('{id:long}', '77');
  const appealDecision = WireRoutes.AdminAppealDecision.replace('{id:long}', '77');
  const appealResult = (id: number) => encodedResponse(FrameType.CommentAppealDecisionResult,
    encoder.encode(JSON.stringify({ success: true, code: 'ok', appealId: id })));
  stepUpPair(appealBegin, WireRoutes.AdminAppealStepUpComplete, FrameType.CommentAppealDecisionRequest);
  handlers.set(appealDecision, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    decodeFrame(body, FrameType.CommentAppealDecisionRequest);
    return appealResult(77);
  });
  await decideAdminAppeal('77', 'granted', 'Valid appeal explanation', signal);
  deepEqual(callUrls(), [appealBegin, WireRoutes.AdminAppealStepUpComplete, appealDecision]);
  handlers.set(appealDecision, () => appealResult(78));
  await rejects(() => decideAdminAppeal('77', 'denied', 'Valid appeal explanation', signal), ProtocolError);
});
