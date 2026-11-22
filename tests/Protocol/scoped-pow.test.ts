import { deepEqual, equal, match, notEqual, rejects, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import {
  apiErrorResponse, emptySuccessFrame, installPasskeyEnvironment, loginBeginFrame, mfaChallengeResultFrame, powChallengeFrame, replaceProperty,
} from './step-up-fixture.ts';
import { ApiError, decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { applyAppearance } from '../../src/Contracts/admin-appearance.ts';
import { adminChangeStatus, adminReply } from '../../src/Contracts/admin-inbox.ts';
import { adminSendNotice } from '../../src/Contracts/admin-inbox-notice.ts';
import { publishAdminSitePage } from '../../src/Contracts/admin-site-pages.ts';
import { changeTaxonomyMetadata } from '../../src/Contracts/admin-tag-metadata.ts';
import { PodWriter } from '../../src/Contracts/binary.ts';
import { submitPublicComment } from '../../src/Contracts/comment-write.ts';
import { createInboxConversation, replyInboxConversation } from '../../src/Contracts/inbox-write.ts';
import {
  createPowClientNonce, powProofHeaders, proveScopedPow, requestWithScopedPow, solveScopedPow,
  type PowChallenge,
} from '../../src/Contracts/pow.ts';
import { registerReaderPasskey } from '../../src/Contracts/reader-registration.ts';
import { verifySiteRecoveryKey } from '../../src/Contracts/recovery-key.ts';
import {
  decodeAdminAppearanceCommand, decodeAdminSitePagePublish, decodePublicCommentReply,
  decodePublicCommentSubmission, decodeRecoveryKeyVerify, encodePublicCommentSubmissionResult,
  FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';
import { frameResponse, hexFixture } from './fixture-source.ts';

const encoder = new TextEncoder();
const validSalt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const validSignature = 'S'.repeat(43);
const validProof = 'P'.repeat(43);
const validSiteSession = 'a'.repeat(64);
const altSiteSession = 'b'.repeat(64);

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

type WorkerControl = {
  spawns: number;
  terminated: number;
  posted: unknown[];
  last: FakeControllableWorker | null;
};

class FakeControllableWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  readonly control: WorkerControl;
  readonly onPost: (worker: FakeControllableWorker, payload: unknown) => void;
  constructor(control: WorkerControl, onPost: (worker: FakeControllableWorker, payload: unknown) => void) {
    this.control = control;
    this.onPost = onPost;
    control.spawns++;
    control.last = this;
  }
  postMessage(payload: unknown) {
    this.control.posted.push(payload);
    this.onPost(this, payload);
  }
  terminate() {
    if (!this.terminated) {
      this.terminated = true;
      this.control.terminated++;
    }
  }
}

function installControlledWorker(
  t: TestContext,
  onPost: (worker: FakeControllableWorker, payload: unknown) => void = worker => {
    queueMicrotask(() => worker.onmessage?.({ data: '12345' } as MessageEvent<unknown>));
  },
): WorkerControl {
  const control: WorkerControl = { spawns: 0, terminated: 0, posted: [], last: null };
  class BoundWorker extends FakeControllableWorker {
    constructor() {
      super(control, onPost);
    }
  }
  replaceProperty(t, globalThis, 'Worker', BoundWorker);
  return control;
}

function requestUrl(input: string | URL | Request) {
  return typeof input === 'string' ? input : input.toString();
}

function requestEmpty(signal?: AbortSignal) {
  return requestWithScopedPow({
    challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
    decode: () => {}, body: emptySuccessFrame(), signal: signal ?? new AbortController().signal,
  });
}

function metadataReceiptFrame(kind: 'tag' | 'category', id: number, revision: bigint, name: string, description: string, changed: boolean): Uint8Array<ArrayBuffer> {
  const w = new PodWriter();
  w.i32(id);
  w.i64(revision);
  w.text(name, WireLimits.TaxonomyNameBytes);
  w.text(description, WireLimits.TaxonomyDescriptionBytes);
  w.bool(changed);
  return encodeFrame(kind === 'tag' ? FrameType.AdminTagMetadata : FrameType.AdminCategoryMetadata, w.finish());
}

function statusMutationFrame(previous: number, current: number): Uint8Array<ArrayBuffer> {
  const w = new PodWriter();
  w.i32(previous);
  w.i32(current);
  w.i32(previous === current ? 1 : 0);
  return encodeFrame(FrameType.ConversationStatusMutationResult, w.finish());
}

function inboxMessageFrame(id: bigint, conversationId: bigint, sender: number, body: string): Uint8Array<ArrayBuffer> {
  const bodyBytes = encoder.encode(body);
  const fieldsEnd = 48;
  const arenaStart = fieldsEnd + 4;
  const payload = new Uint8Array(arenaStart + bodyBytes.length);
  const view = new DataView(payload.buffer);
  view.setBigInt64(0, id, true);
  view.setBigInt64(8, conversationId, true);
  view.setInt32(16, sender, true);
  view.setBigInt64(20, 1_794_680_000_000n, true);
  payload[28] = 0; // hasName = false
  payload[29] = 0;
  view.setInt32(32, 0, true);
  view.setInt32(36, 0, true);
  view.setInt32(40, 0, true);
  view.setInt32(44, bodyBytes.length, true);
  view.setInt32(fieldsEnd, bodyBytes.length, true);
  payload.set(bodyBytes, arenaStart);
  return encodeFrame(FrameType.ConversationMessage, payload);
}

function systemNoticeFrame(conversationId: bigint, subject: string, messageId: bigint, body: string): Uint8Array<ArrayBuffer> {
  const subjectBytes = encoder.encode(subject);
  const bodyBytes = encoder.encode(body);
  const header = 44; // created ? threadHeaderBytes - 8 : threadHeaderBytes
  const msgStart = header + 4;
  const fieldsEnd = msgStart + 48;
  const arenaStart = fieldsEnd + 4;
  const arenaBytes = subjectBytes.length + bodyBytes.length;
  const payload = new Uint8Array(arenaStart + arenaBytes);
  const view = new DataView(payload.buffer);
  view.setBigInt64(0, conversationId, true);
  view.setInt32(8, 0, true); // open
  view.setInt32(12, 0, true); // unread
  view.setBigInt64(16, 1_794_680_000_000n, true);
  view.setBigInt64(24, messageId, true);
  payload[32] = 1; // isSystem
  payload[33] = 1; // canReply
  payload[34] = 0; // not replayed
  payload[35] = 0;
  view.setInt32(36, 0, true);
  view.setInt32(40, subjectBytes.length, true);
  view.setInt32(header, 1, true); // count = 1
  view.setBigInt64(msgStart, messageId, true);
  view.setBigInt64(msgStart + 8, conversationId, true);
  view.setInt32(msgStart + 16, 2, true); // system sender
  view.setBigInt64(msgStart + 20, 1_794_680_000_000n, true);
  payload[msgStart + 28] = 0;
  payload[msgStart + 29] = 0;
  view.setInt32(msgStart + 32, 0, true);
  view.setInt32(msgStart + 36, 0, true);
  view.setInt32(msgStart + 40, subjectBytes.length, true);
  view.setInt32(msgStart + 44, bodyBytes.length, true);
  view.setInt32(fieldsEnd, arenaBytes, true);
  payload.set(subjectBytes, arenaStart);
  payload.set(bodyBytes, arenaStart + subjectBytes.length);
  return encodeFrame(FrameType.ConversationDetailV2, payload);
}

test('createPowClientNonce and powProofHeaders enforce formatting and non-empty proof bounds', () => {
  const first = createPowClientNonce();
  const second = createPowClientNonce();
  match(first, /^[a-f0-9]{32}$/);
  match(second, /^[a-f0-9]{32}$/);
  notEqual(first, second);

  deepEqual(powProofHeaders('F'.repeat(100)), { [WireHeaders.PowProof]: 'F'.repeat(100) });
  throws(() => powProofHeaders(''), ProtocolError);
  throws(() => powProofHeaders('F'.repeat(WireLimits.PowProofHeaderChars + 1)), ProtocolError);
});

test('proveScopedPow and requestWithScopedPow handle success, header isolation, malformed challenges, and Worker cleanup', async t => {
  const worker = installControlledWorker(t);
  const requests: { url: string; method: string; headers: Headers; body: Uint8Array }[] = [];
  const sampleBody = emptySuccessFrame();

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();
    requests.push({ url, method: init?.method ?? 'GET', headers, body });
    if (url === '/pow') return frameResponse(powChallengeFrame());
    if (url === '/submit') return frameResponse(emptySuccessFrame());
    throw new Error(`Unexpected URL ${url}`);
  });

  // Ensure proveScopedPow strips any caller-supplied PowProof and never mutates the caller's Headers instance
  const callerHeaders = new Headers({ 'X-Custom': 'yes', [WireHeaders.PowProof]: 'stale-proof' });
  const proof = await proveScopedPow('/pow', sampleBody, new AbortController().signal, callerHeaders);
  equal(callerHeaders.get(WireHeaders.PowProof), 'stale-proof');
  equal(callerHeaders.has(WireHeaders.PowClientNonce), false);
  equal(requests.length, 1);
  equal(requests[0].headers.get(WireHeaders.PowProof), null);
  const nonceSent = requests[0].headers.get(WireHeaders.PowClientNonce) ?? '';
  match(nonceSent, /^[a-f0-9]{32}$/);
  const decoded = decodePowHeader(proof);
  equal(decoded.salt, validSalt);
  equal(decoded.signature, validSignature);
  equal(decoded.nonce, '12345');
  equal(decoded.clientNonce, nonceSent);
  equal(worker.spawns, 1);
  equal(worker.terminated, 1);

  // Full requestWithScopedPow keeps challenge and submit bytes identical, strips PowClientNonce on submit, and isolates submitHeaders
  requests.length = 0;
  let capturedDecodeHeaders: Headers | null = null;
  await requestWithScopedPow({
    challengePath: '/pow',
    submitPath: '/submit',
    expected: FrameType.EmptySuccess,
    decode: (_, h) => { capturedDecodeHeaders = h; },
    body: sampleBody,
    signal: new AbortController().signal,
    method: 'PUT',
    headers: { 'X-Caller': 'base' },
    submitHeaders: { [WireHeaders.MfaProof]: validProof },
  });
  equal(requests.length, 2);
  equal(requests[0].method, 'POST');
  equal(requests[1].method, 'PUT');
  deepEqual(requests[0].body, sampleBody);
  deepEqual(requests[1].body, sampleBody);
  equal(requests[0].headers.get('X-Caller'), 'base');
  equal(requests[0].headers.get(WireHeaders.MfaProof), null);
  equal(requests[0].headers.get(WireHeaders.PowProof), null);
  match(requests[0].headers.get(WireHeaders.PowClientNonce) ?? '', /^[a-f0-9]{32}$/);
  equal(requests[1].headers.get('X-Caller'), 'base');
  equal(requests[1].headers.get(WireHeaders.MfaProof), validProof);
  equal(requests[1].headers.get(WireHeaders.PowClientNonce), null);
  const submitPow = decodePowHeader(requests[1].headers.get(WireHeaders.PowProof) ?? '');
  equal(submitPow.clientNonce, requests[0].headers.get(WireHeaders.PowClientNonce));
  equal(capturedDecodeHeaders !== null, true);

  // Route guard & pre-aborted signal make zero fetches/Workers
  const controller = new AbortController();
  controller.abort(new DOMException('pre-aborted', 'AbortError'));
  await rejects(() => proveScopedPow('/pow', sampleBody, controller.signal), { name: 'AbortError' });
  await rejects(() => proveScopedPow('   ', sampleBody, new AbortController().signal), ProtocolError);
  await rejects(() => requestWithScopedPow({
    challengePath: '/pow', submitPath: ' ', expected: FrameType.EmptySuccess,
    decode: () => {}, body: sampleBody, signal: new AbortController().signal,
  }), ProtocolError);
  equal(requests.length, 2);
  equal(worker.spawns, 2);
});

test('malformed or unsupported challenges reject before spawning a Worker or submitting', async t => {
  const worker = installControlledWorker(t);
  let submitCalled = false;
  let nextFrame = powChallengeFrame();

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url === '/submit') {
      submitCalled = true;
      return frameResponse(emptySuccessFrame());
    }
    return frameResponse(nextFrame);
  });

  const badFrames = [
    powChallengeFrame({ salt: 'not-hex!'.padEnd(32, '0') }),
    powChallengeFrame({ signature: 'invalid!'.padEnd(43, '!') }),
    powChallengeFrame({ difficulty: WireLimits.PowChallengeDifficulty + 1 }),
    powChallengeFrame({ timestamp: 0n }),
  ];

  for (const frame of badFrames) {
    nextFrame = frame;
    await rejects(() => requestEmpty(), ProtocolError);
  }
  equal(worker.spawns, 0);
  equal(submitCalled, false);
});

test('solveScopedPow runs asynchronously via Worker and handles Worker failure, invalid nonces, timeout, and postMessage error', async t => {
  // 1. Non-blocking check: promise remains pending until Worker posts back asynchronously
  let pendingWorker: FakeControllableWorker | null = null;
  const workerCtrl = installControlledWorker(t, w => { pendingWorker = w; });
  const challenge: PowChallenge = {
    salt: validSalt, signature: validSignature, difficulty: WireLimits.PowChallengeDifficulty, timestamp: 1_794_680_000,
  };
  const solve = () => solveScopedPow(challenge, createPowClientNonce(), new AbortController().signal);
  let resolvedSync = false;
  const pendingPromise = solve()
    .then(value => { resolvedSync = true; return value; });
  equal(resolvedSync, false);
  equal(workerCtrl.spawns, 1);
  equal(workerCtrl.terminated, 0);
  pendingWorker!.onmessage?.({ data: '777' } as MessageEvent<unknown>);
  equal(await pendingPromise, '777');
  equal(workerCtrl.terminated, 1);

  // 2. Worker onerror rejects & terminates
  installControlledWorker(t, w => queueMicrotask(() => w.onerror?.()));
  await rejects(solve,
    { message: 'The security challenge could not be solved' });

  // 3. Invalid nonces (non-digit, empty, >10 digits) reject & terminate
  for (const badNonce of ['', 'abc', '12345678901', 42]) {
    installControlledWorker(t, w => queueMicrotask(() => w.onmessage?.({ data: badNonce } as MessageEvent<unknown>)));
    await rejects(solve,
      { message: 'The security challenge could not be solved' });
  }

  // 4. Synchronous postMessage throw cleans up and propagates
  const boomCtrl = installControlledWorker(t, () => { throw new Error('postMessage failed'); });
  await rejects(solve,
    { message: 'postMessage failed' });
  equal(boomCtrl.terminated, 1);

  // 5. Timeout rejects, terminates Worker, and ignores late message after timeout
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let hungWorker: FakeControllableWorker | null = null;
  const timeoutCtrl = installControlledWorker(t, w => { hungWorker = w; });
  const timedOut = rejects(solve,
    { message: 'The security challenge timed out' });
  t.mock.timers.tick(WireLimits.PowWorkerMilliseconds);
  await timedOut;
  equal(timeoutCtrl.terminated, 1);
  hungWorker!.onmessage?.({ data: '999' } as MessageEvent<unknown>);
  equal(hungWorker!.onmessage, null);
});

test('abort during challenge or Worker solving terminates Worker, ignores late results, and never submits', async t => {
  // Stage A: Abort while challenge fetch is in flight -> never spawns Worker or calls submit
  const workerCtrl = installControlledWorker(t);
  let submitCalls = 0;
  let releaseChallenge: (() => void) | null = null;
  const challengeAbort = new AbortController();

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url === '/submit') {
      submitCalls++;
      return frameResponse(emptySuccessFrame());
    }
    return await new Promise<Response>((resolve, reject) => {
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

  // Stage B: Abort while Worker is solving -> Worker terminated, onmessage cleared, late reply ignored, submit never called
  let solvingWorker: FakeControllableWorker | null = null;
  const stageBCtrl = installControlledWorker(t, w => { solvingWorker = w; });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url === '/submit') {
      submitCalls++;
      return frameResponse(emptySuccessFrame());
    }
    return frameResponse(powChallengeFrame());
  });

  const workerAbort = new AbortController();
  const abortedInWorker = requestEmpty(workerAbort.signal);
  // Flush microtask so challenge resolves and Worker receives postMessage
  await new Promise(resolve => setTimeout(resolve, 10));
  equal(stageBCtrl.spawns, 1);
  equal(stageBCtrl.terminated, 0);
  workerAbort.abort(new DOMException('session changed mid-solve', 'AbortError'));
  await rejects(() => abortedInWorker, { name: 'AbortError' });
  equal(stageBCtrl.terminated, 1);
  equal(solvingWorker!.onmessage, null);
  solvingWorker!.onmessage?.({ data: '55' } as MessageEvent<unknown>);
  await new Promise(resolve => setTimeout(resolve, 10));
  equal(submitCalls, 0);
});

test('HTTP errors (401/403/409/429) on challenge or submit propagate verbatim without automatic retries', async t => {
  installControlledWorker(t);
  let calls: string[] = [];

  for (const status of [401, 403, 409, 429]) {
    calls = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = requestUrl(input);
      calls.push(url);
      return apiErrorResponse(status, `pow_fail_${status}`);
    });
    await rejects(() => requestEmpty(), (err: unknown) => err instanceof ApiError && err.status === status && err.details === `pow_fail_${status}`);
    deepEqual(calls, ['/pow']);

    calls = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === '/pow') return frameResponse(powChallengeFrame());
      return apiErrorResponse(status, `submit_fail_${status}`);
    });
    await rejects(() => requestEmpty(), (err: unknown) => err instanceof ApiError && err.status === status && err.details === `submit_fail_${status}`);
    deepEqual(calls, ['/pow', '/submit']);
  }
});

test('all 9 migrated Scoped PoW business modules (10 call sites) preserve exact routes, bytes, headers, and counts', async t => {
  installPasskeyEnvironment(t, { registration: true });
  installControlledWorker(t);

  type CallRecord = { url: string; method: string; headers: Headers; body: Uint8Array };
  let calls: CallRecord[] = [];

  const installFetch = (responder: (url: string, init?: RequestInit) => Response) => {
    calls = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();
      calls.push({ url, method: init?.method ?? 'GET', headers, body });
      return responder(url, init);
    });
  };

  const assertPowPair = (powCall: CallRecord, submitCall: CallRecord, expectedMethod = 'POST', requiredHeader?: [string, string]) => {
    equal(powCall.method, 'POST');
    equal(submitCall.method, expectedMethod);
    deepEqual(powCall.body, submitCall.body);
    const nonce = powCall.headers.get(WireHeaders.PowClientNonce) ?? '';
    match(nonce, /^[a-f0-9]{32}$/);
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
  };

  function mockPow(challenge: string, receipt: () => Uint8Array<ArrayBuffer>) {
    installFetch(url => frameResponse(url === challenge ? powChallengeFrame() : receipt()));
  }
  function checkExchange(challenge: string, submit: string, method: string, header?: [string, string]) {
    equal(calls.length, 2);
    equal(calls[0].url, challenge);
    equal(calls[1].url, submit);
    assertPowPair(calls[0], calls[1], method, header);
  }
  function mockStepUp(begin: string, complete: string, challenge: string) {
    installFetch(url => {
      if (url === begin) return frameResponse(loginBeginFrame());
      if (url === complete) return frameResponse(mfaChallengeResultFrame());
      if (url === challenge) return frameResponse(powChallengeFrame());
      return frameResponse(emptySuccessFrame());
    });
  }
  function checkStepUp(routes: string[]) {
    deepEqual(calls.map(c => c.url), routes);
    assertPowPair(calls[2], calls[3]);
    equal(calls[2].headers.get(WireHeaders.MfaProof), null);
    equal(calls[3].headers.get(WireHeaders.MfaProof), validProof);
  }
  function commentReceipt(commentId: bigint) {
    return encodeFrame(FrameType.PublicCommentSubmissionResult,
      encodePublicCommentSubmissionResult({ articleId: 5, commentId, moderationStatus: 0, replayed: false }));
  }

  // 1a. admin-tag-metadata (tag create -> POST)
  mockPow(WireRoutes.AdminTagCreatePow, () => metadataReceiptFrame('tag', 15, 1n, 'Rust', 'Systems', true));
  const createdTag = await changeTaxonomyMetadata('tag', {
    id: 0, expectedRevision: 0n, requestId: '11111111-1111-4111-8111-111111111111', name: 'Rust', description: 'Systems',
  }, new AbortController().signal);
  equal(createdTag.id, 15);
  checkExchange(WireRoutes.AdminTagCreatePow, WireRoutes.AdminTagCreate, 'POST');

  // 1b. admin-tag-metadata (category update -> PUT)
  mockPow(WireRoutes.AdminCategoryMetadataPow.replace('{id:int}', '7'),
    () => metadataReceiptFrame('category', 7, 3n, 'Notes', 'Updated', true));
  const updatedCategory = await changeTaxonomyMetadata('category', {
    id: 7, expectedRevision: 2n, requestId: '22222222-2222-4222-8222-222222222222', name: 'Notes', description: 'Updated',
  }, new AbortController().signal);
  equal(updatedCategory.revision, 3n);
  checkExchange(WireRoutes.AdminCategoryMetadataPow.replace('{id:int}', '7'),
    WireRoutes.AdminCategoryMetadata.replace('{id:int}', '7'), 'PUT');

  // 2. admin-inbox: adminReply
  mockPow(WireRoutes.AdminInboxReplyPow.replace('{id:long}', '42'),
    () => inboxMessageFrame(501n, 42n, 1, 'Admin response body'));
  const replied = await adminReply(42n, 'Admin response body', 'reply-key-1', new AbortController().signal);
  equal(replied.id, 501n);
  checkExchange(WireRoutes.AdminInboxReplyPow.replace('{id:long}', '42'),
    WireRoutes.AdminInboxReply.replace('{id:long}', '42'), 'POST',
    [WireHeaders.ClientMutationId, 'reply-key-1']);

  // 3. admin-inbox: adminChangeStatus
  mockPow(WireRoutes.AdminInboxStatusPow.replace('{id:long}', '42'), () => statusMutationFrame(0, 2));
  const statusRes = await adminChangeStatus(42n, '19', 2, 'Resolved issue', new AbortController().signal);
  deepEqual(statusRes, { previous: 0, current: 2, changed: true });
  checkExchange(WireRoutes.AdminInboxStatusPow.replace('{id:long}', '42'),
    WireRoutes.AdminInboxStatus.replace('{id:long}', '42'), 'POST', [WireHeaders.AdminInboxVersion, '19']);

  // 4. admin-inbox-notice: adminSendNotice
  const recipient = '33333333-3333-4333-8333-333333333333';
  mockPow(WireRoutes.AdminInboxSendNoticePow,
    () => systemNoticeFrame(88n, 'Security alert', 901n, 'Notice content'));
  const noticeThread = await adminSendNotice(recipient, 'Security alert', 'Notice content', 777n, new AbortController().signal);
  equal(noticeThread.id, 88n);
  checkExchange(WireRoutes.AdminInboxSendNoticePow, WireRoutes.AdminInboxSendNotice, 'POST', [WireHeaders.SourceEventId, '777']);

  // 5. admin-appearance: Step-Up -> PoW (no MfaProof) -> Apply (MfaProof + PowProof)
  const appearanceCmd = {
    expectedRevision: 4n, currentTheme: 'e'.repeat(64), currentFont: 'f'.repeat(64),
    theme: '1'.repeat(64), font: '2'.repeat(64), rollback: false,
  };
  mockStepUp(WireRoutes.AdminAppearanceStepUpBegin, WireRoutes.AdminAppearanceStepUpComplete, WireRoutes.AdminAppearancePow);
  await applyAppearance(appearanceCmd, new AbortController().signal);
  checkStepUp([WireRoutes.AdminAppearanceStepUpBegin, WireRoutes.AdminAppearanceStepUpComplete,
    WireRoutes.AdminAppearancePow, WireRoutes.AdminAppearanceApply]);
  deepEqual(decodeAdminAppearanceCommand(decodeFrame(calls[3].body, FrameType.AdminAppearanceCommand).payload), appearanceCmd);

  // 6. admin-site-pages: Step-Up -> PoW (no MfaProof) -> Publish (MfaProof + PowProof)
  const pageIntent = { slug: 'about', expectedRevision: 2n, expectedDigest: 'd'.repeat(64), markdown: '# Hello\n' };
  mockStepUp(WireRoutes.AdminSitePageStepUpBegin, WireRoutes.AdminSitePageStepUpComplete, WireRoutes.AdminSitePagePow);
  await publishAdminSitePage(pageIntent, new AbortController().signal);
  checkStepUp([WireRoutes.AdminSitePageStepUpBegin, WireRoutes.AdminSitePageStepUpComplete,
    WireRoutes.AdminSitePagePow, WireRoutes.AdminSitePagePublish]);
  deepEqual(decodeAdminSitePagePublish(decodeFrame(calls[3].body, FrameType.AdminSitePagePublish).payload), pageIntent);

  // 7a. comment-write: anonymous root comment
  const rootCommentKey = '44444444-4444-4444-8444-444444444444';
  mockPow(WireRoutes.PublicCommentPowChallenge, () => commentReceipt(101n));
  const rootRes = await submitPublicComment(5, 3n, 'Reader', 'Comment text', rootCommentKey, new AbortController().signal);
  equal(rootRes.commentId, 101n);
  checkExchange(WireRoutes.PublicCommentPowChallenge,
    WireRoutes.SubmitPublicComment, 'POST', [WireHeaders.ClientMutationId, rootCommentKey]);
  equal(calls[0].headers.get(WireHeaders.CurrentSession), null);
  equal(decodePublicCommentSubmission(decodeFrame(calls[1].body, FrameType.PublicCommentSubmission).payload).articleId, 5);

  // 7b. comment-write: signed-in reply
  const replyCommentKey = '55555555-5555-4555-8555-555555555555';
  mockPow(WireRoutes.PublicCommentReplyPow, () => commentReceipt(102n));
  const replyRes = await submitPublicComment(5, 3n, 'Reader', 'Reply text', replyCommentKey, new AbortController().signal, {
    parent: '101', session: validSiteSession,
  });
  equal(replyRes.commentId, 102n);
  checkExchange(WireRoutes.PublicCommentReplyPow,
    WireRoutes.SubmitPublicCommentReply, 'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), replyCommentKey);
  equal(decodePublicCommentReply(decodeFrame(calls[1].body, FrameType.PublicCommentReply).payload).parentId, 101n);

  // 8a. inbox-write: createInboxConversation
  const createdConversation = Uint8Array.from(hexFixture('conversation-detail-v2.hex', 'strip'));
  mockPow(WireRoutes.InboxCreatePowChallenge, () => createdConversation);
  const createdId = await createInboxConversation('Appeal', 'Body', 'inbox-create-key', new AbortController().signal, validSiteSession);
  equal(createdId > 0n, true);
  checkExchange(WireRoutes.InboxCreatePowChallenge, WireRoutes.InboxList, 'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), 'inbox-create-key');

  // 8b. inbox-write: replyInboxConversation
  const repliedMessage = Uint8Array.from(hexFixture('conversation-message-frame.hex', 'strip'));
  const replyPayload = decodeFrame(repliedMessage, FrameType.ConversationMessage).payload;
  const replyConvId = new DataView(replyPayload.buffer, replyPayload.byteOffset).getBigInt64(8, true);
  mockPow(WireRoutes.InboxReplyPowChallenge.replace('{id:long}', String(replyConvId)), () => repliedMessage);
  const replyMsgId = await replyInboxConversation(replyConvId, 1n, 'Follow-up', 'inbox-reply-key', new AbortController().signal, validSiteSession);
  equal(replyMsgId > 0n, true);
  checkExchange(WireRoutes.InboxReplyPowChallenge.replace('{id:long}', String(replyConvId)),
    WireRoutes.InboxReply.replace('{id:long}', String(replyConvId)), 'POST',
    [WireHeaders.CurrentSession, validSiteSession]);

  // 9. reader-registration: Pow -> Begin (PowProof only, no PowClientNonce) -> Complete (no PowProof)
  const provisionBegin = Uint8Array.from(hexFixture('site-passkey-bootstrap.hex', 'strip'));
  installFetch(url => {
    if (url === '/api/v2/identity/reader-registration/pow.aeds') return frameResponse(powChallengeFrame());
    if (url === '/api/v2/identity/reader-registration/begin.aeds') return frameResponse(provisionBegin);
    return frameResponse(emptySuccessFrame());
  });
  await registerReaderPasskey(new AbortController().signal);
  deepEqual(calls.map(c => c.url), [
    '/api/v2/identity/reader-registration/pow.aeds',
    '/api/v2/identity/reader-registration/begin.aeds',
    '/api/v2/identity/reader-registration/complete.aeds',
  ]);
  assertPowPair(calls[0], calls[1], 'POST');
  equal(calls[2].headers.get(WireHeaders.PowProof), null);
  equal(calls[2].headers.get(WireHeaders.PowClientNonce), null);

  // 10. recovery-key: verifySiteRecoveryKey zeroes key buffer on completion and on failure
  const recoveryKey = `frk_${'a'.repeat(32)}_${'B'.repeat(43)}`;
  mockPow(WireRoutes.RecoveryKeyPow, () => emptySuccessFrame());
  await verifySiteRecoveryKey(recoveryKey, new AbortController().signal);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.RecoveryKeyPow);
  equal(calls[1].url, WireRoutes.RecoveryKeyVerify);
  const submitSnapshot = decodeRecoveryKeyVerify(decodeFrame(calls[1].body, FrameType.RecoveryKeyVerify).payload);
  equal(submitSnapshot.key, recoveryKey);
  assertPowPair(calls[0], calls[1], 'POST');
});

test('recovery-key zeros its sensitive frame buffer on abort and session-change abort prevents inbox/comment submission', async t => {
  let heldBody: Uint8Array | null = null;
  let workerInstance: FakeControllableWorker | null = null;
  installControlledWorker(t, w => { workerInstance = w; });

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url === WireRoutes.RecoveryKeyPow) {
      // Keep direct reference (not copied) to verify body.fill(0) ran in finally
      heldBody = init?.body as Uint8Array;
      return frameResponse(powChallengeFrame());
    }
    throw new Error(`Unexpected submit call to ${url}`);
  });

  const controller = new AbortController();
  const recoveryKey = `frk_${'9'.repeat(32)}_${'Z'.repeat(43)}`;
  const verifyPromise = verifySiteRecoveryKey(recoveryKey, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new DOMException('user canceled', 'AbortError'));
  await rejects(() => verifyPromise, { name: 'AbortError' });
  equal(workerInstance!.terminated, true);
  equal(heldBody?.every(byte => byte === 0), true, 'verifySiteRecoveryKey must zero the frame buffer on abort');

  // Session-change abort blocks inbox write mid-Worker before final POST
  let inboxSubmitCalled = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = requestUrl(input);
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
  const readerAndPowModules = [
    '../../src/Contracts/pow.ts',
    '../../src/Contracts/pow.worker.ts',
    '../../src/Contracts/comment-write.ts',
    '../../src/Contracts/inbox-write.ts',
    '../../src/Contracts/reader-registration.ts',
    '../../src/Contracts/recovery-key.ts',
  ];
  for (const rel of readerAndPowModules) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    equal(/from\s+['"]\.\/admin-[^'"]+['"]/.test(source), false, `${rel} must not import any admin module`);
  }
});
