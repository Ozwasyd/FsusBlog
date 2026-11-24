import { deepEqual, equal, match, notEqual, rejects, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  altPermissionSession as altSiteSession, apiErrorResponse, emptySuccessFrame, installPasskeyEnvironment,
  installPowWorker, loginBeginFrame, mfaChallengeResultFrame, powChallengeFrame,
  validPermissionSession as validSiteSession, validProof, type FakePowWorker,
} from './step-up-fixture.ts';
import { ApiError, decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { applyAppearance } from '../../src/Contracts/admin-appearance.ts';
import { adminChangeStatus, adminReply } from '../../src/Contracts/admin-inbox.ts';
import { adminSendNotice } from '../../src/Contracts/admin-inbox-notice.ts';
import { publishAdminSitePage } from '../../src/Contracts/admin-site-pages.ts';
import { changeTaxonomyMetadata } from '../../src/Contracts/admin-tag-metadata.ts';
import { submitPublicComment } from '../../src/Contracts/comment-write.ts';
import { createInboxConversation, replyInboxConversation } from '../../src/Contracts/inbox-write.ts';
import {
  createPowClientNonce, powProofHeaders, proveScopedPow, requestWithScopedPow, solveScopedPow, type PowChallenge,
} from '../../src/Contracts/pow.ts';
import { registerReaderPasskey } from '../../src/Contracts/reader-registration.ts';
import { verifySiteRecoveryKey } from '../../src/Contracts/recovery-key.ts';
import {
  decodeAdminAppearanceCommand, decodeAdminSitePagePublish, decodePublicCommentReply,
  decodePublicCommentSubmission, decodeRecoveryKeyVerify, encodePublicCommentSubmissionResult,
  FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';
import { captureFetch, frameResponse, hexFixture, podFrame, type RecordedCall } from './fixture-source.ts';

const encoder = new TextEncoder();
const validSalt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const validSignature = 'S'.repeat(43);
const noncePattern = /^[a-f0-9]{32}$/;
const signal = new AbortController().signal;

function decodePowHeader(encoded: string) {
  const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  equal(String.fromCharCode(...bytes.subarray(0, 5)), 'FPOW\u0001');
  const difficulty = view.getInt32(5, true);
  const timestamp = Number(view.getBigInt64(9, true));
  let offset = WireLayouts.PowProofHeaderBytes;
  const parts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const length = view.getUint16(offset, true);
    offset += 2;
    parts.push(new TextDecoder().decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  equal(offset, bytes.length);
  return { difficulty, timestamp, salt: parts[0], nonce: parts[1], signature: parts[2], clientNonce: parts[3] };
}

function requestEmpty(abortSignal = signal) {
  return requestWithScopedPow({
    challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
    decode: () => {}, body: emptySuccessFrame(), signal: abortSignal,
  });
}

function assertPowPair(powCall: RecordedCall, submitCall: RecordedCall, method = 'POST', requiredHeader?: [string, string]) {
  equal(powCall.method, 'POST');
  equal(submitCall.method, method);
  deepEqual(powCall.body, submitCall.body);
  const nonce = powCall.headers.get(WireHeaders.PowClientNonce) ?? '';
  match(nonce, noncePattern);
  equal(powCall.headers.get(WireHeaders.PowProof), null);
  equal(submitCall.headers.get(WireHeaders.PowClientNonce), null);
  const proof = decodePowHeader(submitCall.headers.get(WireHeaders.PowProof) ?? '');
  equal(proof.clientNonce, nonce);
  equal(proof.salt, validSalt);
  equal(proof.signature, validSignature);
  equal(proof.nonce, '12345');
  if (requiredHeader) {
    equal(powCall.headers.get(requiredHeader[0]), requiredHeader[1]);
    equal(submitCall.headers.get(requiredHeader[0]), requiredHeader[1]);
  }
}

const metadataReceiptFrame = (kind: 'tag' | 'category', id: number, revision: bigint, name: string, description: string, changed: boolean) =>
  podFrame(kind === 'tag' ? FrameType.AdminTagMetadata : FrameType.AdminCategoryMetadata, w => {
    w.i32(id); w.i64(revision); w.text(name, WireLimits.TaxonomyNameBytes); w.text(description, WireLimits.TaxonomyDescriptionBytes); w.bool(changed);
  });

const statusMutationFrame = (previous: number, current: number) =>
  podFrame(FrameType.ConversationStatusMutationResult, w => { w.i32(previous); w.i32(current); w.i32(previous === current ? 1 : 0); });

const writeMessage = (w: { i64(v: bigint): void; i32(v: number): void }, id: bigint, convId: bigint, sender: number, offset: number, len: number) => {
  w.i64(id); w.i64(convId); w.i32(sender); w.i64(1_794_680_000_000n); w.i64(0n); w.i32(0); w.i32(offset); w.i32(len);
};

const inboxMessageFrame = (id: bigint, conversationId: bigint, sender: number, body: string) =>
  podFrame(FrameType.ConversationMessage, w => {
    const bodyBytes = encoder.encode(body);
    writeMessage(w, id, conversationId, sender, 0, bodyBytes.length);
    w.bytes(bodyBytes);
  });

const systemNoticeFrame = (conversationId: bigint, subject: string, messageId: bigint, body: string) =>
  podFrame(FrameType.ConversationDetailV2, w => {
    const subjectBytes = encoder.encode(subject);
    const bodyBytes = encoder.encode(body);
    w.i64(conversationId); w.i64(0n); w.i64(1_794_680_000_000n); w.i64(messageId);
    w.fixedBytes(Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0)); w.i32(subjectBytes.length); w.i32(1);
    writeMessage(w, messageId, conversationId, 2, subjectBytes.length, bodyBytes.length);
    w.bytes(Buffer.concat([subjectBytes, bodyBytes]));
  });

test('createPowClientNonce and powProofHeaders enforce formatting and non-empty proof bounds', () => {
  const first = createPowClientNonce();
  const second = createPowClientNonce();
  match(first, noncePattern);
  match(second, noncePattern);
  notEqual(first, second);
  deepEqual(powProofHeaders('F'.repeat(100)), { [WireHeaders.PowProof]: 'F'.repeat(100) });
  throws(() => powProofHeaders(''), ProtocolError);
  throws(() => powProofHeaders('F'.repeat(WireLimits.PowProofHeaderChars + 1)), ProtocolError);
});

test('proveScopedPow and requestWithScopedPow handle success, header isolation, malformed challenges, and Worker cleanup', async t => {
  const worker = installPowWorker(t);
  const sampleBody = emptySuccessFrame();
  const requests = captureFetch(t, ({ url }) => {
    if (url === '/pow') return frameResponse(powChallengeFrame());
    if (url === '/submit') return frameResponse(emptySuccessFrame());
    throw new Error(`Unexpected URL ${url}`);
  });

  const callerHeaders = new Headers({ 'X-Custom': 'yes', [WireHeaders.PowProof]: 'stale-proof' });
  const proof = await proveScopedPow('/pow', sampleBody, signal, callerHeaders);
  equal(callerHeaders.get(WireHeaders.PowProof), 'stale-proof');
  equal(callerHeaders.has(WireHeaders.PowClientNonce), false);
  equal(requests.length, 1);
  equal(requests[0].headers.get(WireHeaders.PowProof), null);
  const nonceSent = requests[0].headers.get(WireHeaders.PowClientNonce) ?? '';
  match(nonceSent, noncePattern);
  const decoded = decodePowHeader(proof);
  equal(decoded.salt, validSalt);
  equal(decoded.signature, validSignature);
  equal(decoded.nonce, '12345');
  equal(decoded.clientNonce, nonceSent);
  equal(worker.spawns, 1);
  equal(worker.terminated, 1);

  requests.length = 0;
  let capturedDecodeHeaders: Headers | null = null;
  await requestWithScopedPow({
    challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
    decode: (_, h) => { capturedDecodeHeaders = h; }, body: sampleBody, signal, method: 'PUT',
    headers: { 'X-Caller': 'base' }, submitHeaders: { [WireHeaders.MfaProof]: validProof },
  });
  equal(requests.length, 2);
  assertPowPair(requests[0], requests[1], 'PUT', ['X-Caller', 'base']);
  deepEqual(requests[0].body, sampleBody);
  equal(requests[0].headers.get(WireHeaders.MfaProof), null);
  equal(requests[1].headers.get(WireHeaders.MfaProof), validProof);
  equal(capturedDecodeHeaders !== null, true);

  const controller = new AbortController();
  controller.abort(new DOMException('pre-aborted', 'AbortError'));
  await rejects(() => proveScopedPow('/pow', sampleBody, controller.signal), { name: 'AbortError' });
  await rejects(() => proveScopedPow('   ', sampleBody, signal), ProtocolError);
  await rejects(() => requestWithScopedPow({
    challengePath: '/pow', submitPath: ' ', expected: FrameType.EmptySuccess, decode: () => {}, body: sampleBody, signal,
  }), ProtocolError);
  equal(requests.length, 2);
  equal(worker.spawns, 2);
});

test('malformed or unsupported challenges reject before spawning a Worker or submitting', async t => {
  const worker = installPowWorker(t);
  let submitCalled = false;
  let nextFrame = powChallengeFrame();
  captureFetch(t, ({ url }) => {
    if (url === '/submit') { submitCalled = true; return frameResponse(emptySuccessFrame()); }
    return frameResponse(nextFrame);
  });
  for (const frame of [
    powChallengeFrame({ salt: 'not-hex!'.padEnd(32, '0') }),
    powChallengeFrame({ signature: 'invalid!'.padEnd(43, '!') }),
    powChallengeFrame({ difficulty: WireLimits.PowChallengeDifficulty + 1 }),
    powChallengeFrame({ timestamp: 0n }),
  ]) {
    nextFrame = frame;
    await rejects(() => requestEmpty(), ProtocolError);
  }
  equal(worker.spawns, 0);
  equal(submitCalled, false);
});

test('solveScopedPow runs asynchronously via Worker and handles Worker failure, invalid nonces, timeout, and postMessage error', async t => {
  let pendingWorker: FakePowWorker | null = null;
  const workerCtrl = installPowWorker(t, w => { pendingWorker = w; });
  const challenge: PowChallenge = {
    salt: validSalt, signature: validSignature, difficulty: WireLimits.PowChallengeDifficulty, timestamp: 1_794_680_000,
  };
  const solve = () => solveScopedPow(challenge, createPowClientNonce(), signal);
  let resolvedSync = false;
  const pendingPromise = solve().then(value => { resolvedSync = true; return value; });
  equal(resolvedSync, false);
  equal(workerCtrl.spawns, 1);
  equal(workerCtrl.terminated, 0);
  pendingWorker!.reply('777');
  equal(await pendingPromise, '777');
  equal(workerCtrl.terminated, 1);

  installPowWorker(t, w => queueMicrotask(() => w.onerror?.()));
  await rejects(solve, { message: 'The security challenge could not be solved' });

  for (const badNonce of ['', 'abc', '12345678901', 42]) {
    installPowWorker(t, w => queueMicrotask(() => w.reply(badNonce)));
    await rejects(solve, { message: 'The security challenge could not be solved' });
  }

  const boomCtrl = installPowWorker(t, () => { throw new Error('postMessage failed'); });
  await rejects(solve, { message: 'postMessage failed' });
  equal(boomCtrl.terminated, 1);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let hungWorker: FakePowWorker | null = null;
  const timeoutCtrl = installPowWorker(t, w => { hungWorker = w; });
  const timedOut = rejects(solve, { message: 'The security challenge timed out' });
  t.mock.timers.tick(WireLimits.PowWorkerMilliseconds);
  await timedOut;
  equal(timeoutCtrl.terminated, 1);
  hungWorker!.reply('999');
  equal(hungWorker!.onmessage, null);
});

test('abort during challenge or Worker solving terminates Worker, ignores late results, and never submits', async t => {
  const workerCtrl = installPowWorker(t);
  let submitCalls = 0;
  let releaseChallenge: (() => void) | null = null;
  const challengeAbort = new AbortController();

  captureFetch(t, ({ url }, init) => {
    if (url === '/submit') { submitCalls++; return frameResponse(emptySuccessFrame()); }
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      releaseChallenge = () => resolve(frameResponse(powChallengeFrame()));
    });
  });

  const abortedAtChallenge = requestEmpty(challengeAbort.signal);
  challengeAbort.abort(new DOMException('stopped at challenge', 'AbortError'));
  await rejects(() => abortedAtChallenge, { name: 'AbortError' });
  equal(workerCtrl.spawns, 0);
  equal(submitCalls, 0);
  equal(typeof releaseChallenge, 'function');

  let solvingWorker: FakePowWorker | null = null;
  const stageBCtrl = installPowWorker(t, w => { solvingWorker = w; });
  captureFetch(t, ({ url }) => {
    if (url === '/submit') { submitCalls++; return frameResponse(emptySuccessFrame()); }
    return frameResponse(powChallengeFrame());
  });

  const workerAbort = new AbortController();
  const abortedInWorker = requestEmpty(workerAbort.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  equal(stageBCtrl.spawns, 1);
  equal(stageBCtrl.terminated, 0);
  workerAbort.abort(new DOMException('session changed mid-solve', 'AbortError'));
  await rejects(() => abortedInWorker, { name: 'AbortError' });
  equal(stageBCtrl.terminated, 1);
  equal(solvingWorker!.onmessage, null);
  solvingWorker!.reply('55');
  await new Promise(resolve => setTimeout(resolve, 10));
  equal(submitCalls, 0);
});

test('HTTP errors (401/403/409/429) on challenge or submit propagate verbatim without automatic retries', async t => {
  installPowWorker(t);
  for (const status of [401, 403, 409, 429]) {
    const powCalls = captureFetch(t, () => apiErrorResponse(status, `pow_fail_${status}`));
    await rejects(() => requestEmpty(), (err: unknown) => err instanceof ApiError && err.status === status && err.details === `pow_fail_${status}`);
    deepEqual(powCalls.map(c => c.url), ['/pow']);

    const submitCalls = captureFetch(t, ({ url }) =>
      url === '/pow' ? frameResponse(powChallengeFrame()) : apiErrorResponse(status, `submit_fail_${status}`));
    await rejects(() => requestEmpty(), (err: unknown) => err instanceof ApiError && err.status === status && err.details === `submit_fail_${status}`);
    deepEqual(submitCalls.map(c => c.url), ['/pow', '/submit']);
  }
});

test('all 9 migrated Scoped PoW business modules (10 call sites) preserve exact routes, bytes, headers, and counts', async t => {
  installPasskeyEnvironment(t, { registration: true });
  installPowWorker(t);

  let calls: RecordedCall[] = [];
  const installFetch = (responder: (url: string) => Response) => {
    calls = captureFetch(t, ({ url }) => responder(url));
  };
  async function checkPow<T>(
    challenge: string, submit: string, receipt: Uint8Array<ArrayBuffer>, run: () => Promise<T>,
    method = 'POST', header?: [string, string],
  ) {
    installFetch(url => frameResponse(url === challenge ? powChallengeFrame() : receipt));
    const result = await run();
    deepEqual(calls.map(c => c.url), [challenge, submit]);
    assertPowPair(calls[0], calls[1], method, header);
    return result;
  }
  async function checkStepUp(routes: string[], run: () => Promise<void>) {
    const [begin, complete, challenge] = routes;
    installFetch(url => frameResponse(url === begin ? loginBeginFrame() : url === complete ? mfaChallengeResultFrame()
      : url === challenge ? powChallengeFrame() : emptySuccessFrame()));
    await run();
    deepEqual(calls.map(c => c.url), routes);
    assertPowPair(calls[2], calls[3]);
    equal(calls[2].headers.get(WireHeaders.MfaProof), null);
    equal(calls[3].headers.get(WireHeaders.MfaProof), validProof);
  }
  const commentReceipt = (commentId: bigint) => encodeFrame(FrameType.PublicCommentSubmissionResult,
    encodePublicCommentSubmissionResult({ articleId: 5, commentId, moderationStatus: 0, replayed: false }));

  // 1a & 1b. admin-tag-metadata
  const tag = await checkPow(WireRoutes.AdminTagCreatePow, WireRoutes.AdminTagCreate,
    metadataReceiptFrame('tag', 15, 1n, 'Rust', 'Systems', true),
    () => changeTaxonomyMetadata('tag', {
      id: 0, expectedRevision: 0n, requestId: '11111111-1111-4111-8111-111111111111', name: 'Rust', description: 'Systems',
    }, signal));
  equal(tag.id, 15);

  const cat = await checkPow(
    WireRoutes.AdminCategoryMetadataPow.replace('{id:int}', '7'), WireRoutes.AdminCategoryMetadata.replace('{id:int}', '7'),
    metadataReceiptFrame('category', 7, 3n, 'Notes', 'Updated', true),
    () => changeTaxonomyMetadata('category', {
      id: 7, expectedRevision: 2n, requestId: '22222222-2222-4222-8222-222222222222', name: 'Notes', description: 'Updated',
    }, signal), 'PUT');
  equal(cat.revision, 3n);

  // 2 & 3. admin-inbox
  const replied = await checkPow(
    WireRoutes.AdminInboxReplyPow.replace('{id:long}', '42'), WireRoutes.AdminInboxReply.replace('{id:long}', '42'),
    inboxMessageFrame(501n, 42n, 1, 'Admin response body'),
    () => adminReply(42n, 'Admin response body', 'reply-key-1', signal), 'POST', [WireHeaders.ClientMutationId, 'reply-key-1']);
  equal(replied.id, 501n);

  const statusRes = await checkPow(
    WireRoutes.AdminInboxStatusPow.replace('{id:long}', '42'), WireRoutes.AdminInboxStatus.replace('{id:long}', '42'),
    statusMutationFrame(0, 2),
    () => adminChangeStatus(42n, '19', 2, 'Resolved issue', signal), 'POST', [WireHeaders.AdminInboxVersion, '19']);
  deepEqual(statusRes, { previous: 0, current: 2, changed: true });

  // 4. admin-inbox-notice
  const notice = await checkPow(WireRoutes.AdminInboxSendNoticePow, WireRoutes.AdminInboxSendNotice,
    systemNoticeFrame(88n, 'Security alert', 901n, 'Notice content'),
    () => adminSendNotice('33333333-3333-4333-8333-333333333333', 'Security alert', 'Notice content', 777n, signal),
    'POST', [WireHeaders.SourceEventId, '777']);
  equal(notice.id, 88n);

  // 5. admin-appearance
  const appearanceCmd = {
    expectedRevision: 4n, currentTheme: 'e'.repeat(64), currentFont: 'f'.repeat(64),
    theme: '1'.repeat(64), font: '2'.repeat(64), rollback: false,
  };
  await checkStepUp([
    WireRoutes.AdminAppearanceStepUpBegin, WireRoutes.AdminAppearanceStepUpComplete,
    WireRoutes.AdminAppearancePow, WireRoutes.AdminAppearanceApply,
  ], () => applyAppearance(appearanceCmd, signal));
  deepEqual(decodeAdminAppearanceCommand(decodeFrame(calls[3].body, FrameType.AdminAppearanceCommand).payload), appearanceCmd);

  // 6. admin-site-pages
  const pageIntent = { slug: 'about', expectedRevision: 2n, expectedDigest: 'd'.repeat(64), markdown: '# Hello\n' };
  await checkStepUp([
    WireRoutes.AdminSitePageStepUpBegin, WireRoutes.AdminSitePageStepUpComplete,
    WireRoutes.AdminSitePagePow, WireRoutes.AdminSitePagePublish,
  ], () => publishAdminSitePage(pageIntent, signal));
  deepEqual(decodeAdminSitePagePublish(decodeFrame(calls[3].body, FrameType.AdminSitePagePublish).payload), pageIntent);

  // 7a & 7b. comment-write
  const rootKey = '44444444-4444-4444-8444-444444444444';
  const rootRes = await checkPow(WireRoutes.PublicCommentPowChallenge, WireRoutes.SubmitPublicComment, commentReceipt(101n),
    () => submitPublicComment(5, 3n, 'Reader', 'Comment text', rootKey, signal), 'POST', [WireHeaders.ClientMutationId, rootKey]);
  equal(rootRes.commentId, 101n);
  equal(calls[0].headers.get(WireHeaders.CurrentSession), null);
  equal(decodePublicCommentSubmission(decodeFrame(calls[1].body, FrameType.PublicCommentSubmission).payload).articleId, 5);

  const replyKey = '55555555-5555-4555-8555-555555555555';
  const replyRes = await checkPow(WireRoutes.PublicCommentReplyPow, WireRoutes.SubmitPublicCommentReply, commentReceipt(102n),
    () => submitPublicComment(5, 3n, 'Reader', 'Reply text', replyKey, signal, { parent: '101', session: validSiteSession }),
    'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(replyRes.commentId, 102n);
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), replyKey);
  equal(decodePublicCommentReply(decodeFrame(calls[1].body, FrameType.PublicCommentReply).payload).parentId, 101n);

  // 8a & 8b. inbox-write
  const createdConv = Uint8Array.from(hexFixture('conversation-detail-v2.hex', 'strip'));
  const createdId = await checkPow(WireRoutes.InboxCreatePowChallenge, WireRoutes.InboxList, createdConv,
    () => createInboxConversation('Appeal', 'Body', 'inbox-create-key', signal, validSiteSession),
    'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(createdId > 0n, true);
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), 'inbox-create-key');

  const repliedMsg = Uint8Array.from(hexFixture('conversation-message-frame.hex', 'strip'));
  const replyPayload = decodeFrame(repliedMsg, FrameType.ConversationMessage).payload;
  const replyConvId = new DataView(replyPayload.buffer, replyPayload.byteOffset).getBigInt64(8, true);
  const replyMsgId = await checkPow(
    WireRoutes.InboxReplyPowChallenge.replace('{id:long}', String(replyConvId)),
    WireRoutes.InboxReply.replace('{id:long}', String(replyConvId)), repliedMsg,
    () => replyInboxConversation(replyConvId, 1n, 'Follow-up', 'inbox-reply-key', signal, validSiteSession),
    'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(replyMsgId > 0n, true);

  // 9. reader-registration
  const provisionBegin = Uint8Array.from(hexFixture('site-passkey-bootstrap.hex', 'strip'));
  installFetch(url => frameResponse(
    url === '/api/v2/identity/reader-registration/pow.aeds' ? powChallengeFrame()
      : url === '/api/v2/identity/reader-registration/begin.aeds' ? provisionBegin : emptySuccessFrame()));
  await registerReaderPasskey(signal);
  deepEqual(calls.map(c => c.url), [
    '/api/v2/identity/reader-registration/pow.aeds',
    '/api/v2/identity/reader-registration/begin.aeds',
    '/api/v2/identity/reader-registration/complete.aeds',
  ]);
  assertPowPair(calls[0], calls[1], 'POST');
  equal(calls[2].headers.get(WireHeaders.PowProof), null);
  equal(calls[2].headers.get(WireHeaders.PowClientNonce), null);

  // 10. recovery-key
  const recoveryKey = `frk_${'a'.repeat(32)}_${'B'.repeat(43)}`;
  await checkPow(WireRoutes.RecoveryKeyPow, WireRoutes.RecoveryKeyVerify, emptySuccessFrame(),
    () => verifySiteRecoveryKey(recoveryKey, signal));
  equal(decodeRecoveryKeyVerify(decodeFrame(calls[1].body, FrameType.RecoveryKeyVerify).payload).key, recoveryKey);
});

test('recovery-key zeros its sensitive frame buffer on abort and session-change abort prevents inbox/comment submission', async t => {
  let heldBody: Uint8Array | null = null;
  let workerInstance: FakePowWorker | null = null;
  installPowWorker(t, w => { workerInstance = w; });

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === WireRoutes.RecoveryKeyPow) {
      heldBody = init?.body as Uint8Array;
      return frameResponse(powChallengeFrame());
    }
    throw new Error(`Unexpected submit call to ${url}`);
  });

  const controller = new AbortController();
  const verifyPromise = verifySiteRecoveryKey(`frk_${'9'.repeat(32)}_${'Z'.repeat(43)}`, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new DOMException('user canceled', 'AbortError'));
  await rejects(() => verifyPromise, { name: 'AbortError' });
  equal(workerInstance!.terminated, true);
  equal(heldBody?.every(byte => byte === 0), true, 'verifySiteRecoveryKey must zero the frame buffer on abort');

  let inboxSubmitCalled = false;
  captureFetch(t, ({ url }) => {
    if (url === WireRoutes.InboxCreatePowChallenge) return frameResponse(powChallengeFrame());
    inboxSubmitCalled = true;
    return frameResponse(emptySuccessFrame());
  });
  let currentSession = validSiteSession;
  const sessionAbort = new AbortController();
  const pendingInbox = createInboxConversation('Subject', 'Message body', 'session-change-key', sessionAbort.signal, currentSession);
  await new Promise(resolve => setTimeout(resolve, 10));
  currentSession = altSiteSession;
  sessionAbort.abort(new DOMException(`Session changed to ${currentSession}`, 'AbortError'));
  await rejects(() => pendingInbox, { name: 'AbortError' });
  equal(inboxSubmitCalled, false);
});

test('PoW and reader contract modules never depend on admin modules', () => {
  for (const rel of ['pow.ts', 'pow.worker.ts', 'comment-write.ts', 'inbox-write.ts', 'reader-registration.ts', 'recovery-key.ts']) {
    const source = readFileSync(new URL(`../../src/Contracts/${rel}`, import.meta.url), 'utf8');
    equal(/from\s+['"]\.\/admin-[^'"]+['"]/.test(source), false, `${rel} must not import any admin module`);
  }
});
