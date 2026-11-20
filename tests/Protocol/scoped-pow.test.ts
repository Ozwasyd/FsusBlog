import { deepEqual, equal, match, notEqual, rejects, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
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
import { hexFixture } from './fixture-source.ts';

const aedsHeaders = { 'Content-Type': 'application/octet-stream' };
const encoder = new TextEncoder();
const validSalt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const validSignature = 'S'.repeat(43);
const validProof = 'P'.repeat(43);
const validSiteSession = 'a'.repeat(64);
const altSiteSession = 'b'.repeat(64);

function emptySuccessFrame(): Uint8Array<ArrayBuffer> {
  return encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0));
}

function powChallengeFrame({
  salt = validSalt,
  signature = validSignature,
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

function apiErrorResponse(status: number, details: string, message = 'Request failed'): Response {
  const payload = new Uint8Array(WireLayouts.ErrorBytes);
  const view = new DataView(payload.buffer);
  payload[0] = 1;
  payload[1] = 1;
  view.setInt32(WireLayouts.ErrorStatusOffset, status, true);
  payload.set(encoder.encode(message).subarray(0, 255), WireLayouts.ErrorMessageOffset);
  payload.set(encoder.encode(details).subarray(0, 255), WireLayouts.ErrorDetailsOffset);
  return new Response(encodeFrame(FrameType.ApiError, payload), { status, headers: aedsHeaders });
}

function loginBeginFrame(): Uint8Array<ArrayBuffer> {
  const token = 'T'.repeat(43);
  const rp = encoder.encode('localhost');
  const challenge = new Uint8Array(WireLimits.PasskeyChallengeBytes).fill(7);
  const credId = Uint8Array.of(1, 2, 3, 4);
  const descriptorBytes = WireLayouts.PasskeyCredentialDescriptorSize;
  const blobStart = WireLayouts.PasskeyLoginBeginSize + descriptorBytes + 4;
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
  const credRef = WireLayouts.PasskeyLoginBeginSize;
  view.setInt32(credRef + 8, rp.length + challenge.length, true);
  view.setInt32(credRef + 12, credId.length, true);
  payload.set(credId, blobStart + rp.length + challenge.length);
  view.setInt32(blobStart - 4, rp.length + challenge.length + credId.length, true);
  payload.set(rp, blobStart);
  payload.set(challenge, blobStart + rp.length);
  return encodeFrame(FrameType.PasskeyLoginBegin, payload);
}

function mfaChallengeResultFrame(): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(WireLayouts.MfaChallengeResultBytes);
  const view = new DataView(payload.buffer);
  view.setInt32(0, 0, true);
  payload[4] = 1;
  payload[5] = 1;
  payload.set(encoder.encode('admin-sensitive'), WireLayouts.MfaChallengeActionOffset);
  payload.set(encoder.encode(validProof), WireLayouts.MfaChallengeProofOffset);
  return encodeFrame(FrameType.MfaChallengeResult, payload);
}

function installPasskeyEnvironment(t: TestContext) {
  class FakeAssertionResponse {}
  class FakeAttestationResponse {
    clientDataJSON = Uint8Array.of(10, 11).buffer;
    attestationObject = Uint8Array.of(12, 13, 14).buffer;
    getTransports() { return ['internal']; }
  }
  class FakeCredential {
    id = 'cred-id';
    rawId = Uint8Array.of(9, 8, 7).buffer;
    response: FakeAssertionResponse | FakeAttestationResponse;
    constructor(response: FakeAssertionResponse | FakeAttestationResponse) {
      this.response = response;
    }
  }
  const prevSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  const prevCredential = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
  const prevAssertion = Object.getOwnPropertyDescriptor(globalThis, 'AuthenticatorAssertionResponse');
  const prevAttestation = Object.getOwnPropertyDescriptor(globalThis, 'AuthenticatorAttestationResponse');
  const prevCredentials = Object.getOwnPropertyDescriptor(globalThis.navigator, 'credentials');

  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: FakeCredential });
  Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', { configurable: true, value: FakeAssertionResponse });
  Object.defineProperty(globalThis, 'AuthenticatorAttestationResponse', { configurable: true, value: FakeAttestationResponse });
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: {
      async get() {
        return new FakeCredential(Object.assign(new FakeAssertionResponse(), {
          clientDataJSON: Uint8Array.of(1, 2).buffer,
          authenticatorData: Uint8Array.of(3, 4).buffer,
          signature: Uint8Array.of(5, 6).buffer,
          userHandle: null,
        }));
      },
      async create() {
        return new FakeCredential(new FakeAttestationResponse());
      },
    },
  });

  t.after(() => {
    if (prevSecure) Object.defineProperty(globalThis, 'isSecureContext', prevSecure);
    else delete (globalThis as Record<string, unknown>).isSecureContext;
    if (prevCredential) Object.defineProperty(globalThis, 'PublicKeyCredential', prevCredential);
    else delete (globalThis as Record<string, unknown>).PublicKeyCredential;
    if (prevAssertion) Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', prevAssertion);
    else delete (globalThis as Record<string, unknown>).AuthenticatorAssertionResponse;
    if (prevAttestation) Object.defineProperty(globalThis, 'AuthenticatorAttestationResponse', prevAttestation);
    else delete (globalThis as Record<string, unknown>).AuthenticatorAttestationResponse;
    if (prevCredentials) Object.defineProperty(globalThis.navigator, 'credentials', prevCredentials);
    else delete (globalThis.navigator as unknown as Record<string, unknown>).credentials;
  });
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
  const prevWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const control: WorkerControl = { spawns: 0, terminated: 0, posted: [], last: null };
  class BoundWorker extends FakeControllableWorker {
    constructor() {
      super(control, onPost);
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BoundWorker });
  t.after(() => {
    if (prevWorker) Object.defineProperty(globalThis, 'Worker', prevWorker);
    else delete (globalThis as Record<string, unknown>).Worker;
  });
  return control;
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
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();
    requests.push({ url, method: init?.method ?? 'GET', headers, body });
    if (url === '/pow') return new Response(powChallengeFrame(), { headers: aedsHeaders });
    if (url === '/submit') return new Response(emptySuccessFrame(), { headers: aedsHeaders });
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
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/submit') {
      submitCalled = true;
      return new Response(emptySuccessFrame(), { headers: aedsHeaders });
    }
    return new Response(nextFrame, { headers: aedsHeaders });
  });

  const badFrames = [
    powChallengeFrame({ salt: 'not-hex!'.padEnd(32, '0') }),
    powChallengeFrame({ signature: 'invalid!'.padEnd(43, '!') }),
    powChallengeFrame({ difficulty: WireLimits.PowChallengeDifficulty + 1 }),
    powChallengeFrame({ timestamp: 0n }),
  ];

  for (const frame of badFrames) {
    nextFrame = frame;
    await rejects(() => requestWithScopedPow({
      challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
      decode: () => {}, body: emptySuccessFrame(), signal: new AbortController().signal,
    }), ProtocolError);
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
  let resolvedSync = false;
  const pendingPromise = solveScopedPow(challenge, createPowClientNonce(), new AbortController().signal)
    .then(value => { resolvedSync = true; return value; });
  equal(resolvedSync, false);
  equal(workerCtrl.spawns, 1);
  equal(workerCtrl.terminated, 0);
  pendingWorker!.onmessage?.({ data: '777' } as MessageEvent<unknown>);
  equal(await pendingPromise, '777');
  equal(workerCtrl.terminated, 1);

  // 2. Worker onerror rejects & terminates
  installControlledWorker(t, w => queueMicrotask(() => w.onerror?.()));
  await rejects(() => solveScopedPow(challenge, createPowClientNonce(), new AbortController().signal),
    { message: 'The security challenge could not be solved' });

  // 3. Invalid nonces (non-digit, empty, >10 digits) reject & terminate
  for (const badNonce of ['', 'abc', '12345678901', 42]) {
    installControlledWorker(t, w => queueMicrotask(() => w.onmessage?.({ data: badNonce } as MessageEvent<unknown>)));
    await rejects(() => solveScopedPow(challenge, createPowClientNonce(), new AbortController().signal),
      { message: 'The security challenge could not be solved' });
  }

  // 4. Synchronous postMessage throw cleans up and propagates
  const boomCtrl = installControlledWorker(t, () => { throw new Error('postMessage failed'); });
  await rejects(() => solveScopedPow(challenge, createPowClientNonce(), new AbortController().signal),
    { message: 'postMessage failed' });
  equal(boomCtrl.terminated, 1);

  // 5. Timeout rejects, terminates Worker, and ignores late message after timeout
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let hungWorker: FakeControllableWorker | null = null;
  const timeoutCtrl = installControlledWorker(t, w => { hungWorker = w; });
  const timedOut = rejects(() => solveScopedPow(challenge, createPowClientNonce(), new AbortController().signal),
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
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/submit') {
      submitCalls++;
      return new Response(emptySuccessFrame(), { headers: aedsHeaders });
    }
    return await new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      releaseChallenge = () => resolve(new Response(powChallengeFrame(), { headers: aedsHeaders }));
    });
  });

  const abortedAtChallenge = requestWithScopedPow({
    challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
    decode: () => {}, body: emptySuccessFrame(), signal: challengeAbort.signal,
  });
  challengeAbort.abort(new DOMException('stopped at challenge', 'AbortError'));
  await rejects(() => abortedAtChallenge, { name: 'AbortError' });
  equal(workerCtrl.spawns, 0);
  equal(submitCalls, 0);
  equal(typeof releaseChallenge, 'function');

  // Stage B: Abort while Worker is solving -> Worker terminated, onmessage cleared, late reply ignored, submit never called
  let solvingWorker: FakeControllableWorker | null = null;
  const stageBCtrl = installControlledWorker(t, w => { solvingWorker = w; });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/submit') {
      submitCalls++;
      return new Response(emptySuccessFrame(), { headers: aedsHeaders });
    }
    return new Response(powChallengeFrame(), { headers: aedsHeaders });
  });

  const workerAbort = new AbortController();
  const abortedInWorker = requestWithScopedPow({
    challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
    decode: () => {}, body: emptySuccessFrame(), signal: workerAbort.signal,
  });
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
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      return apiErrorResponse(status, `pow_fail_${status}`);
    });
    await rejects(() => requestWithScopedPow({
      challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
      decode: () => {}, body: emptySuccessFrame(), signal: new AbortController().signal,
    }), (err: unknown) => err instanceof ApiError && err.status === status && err.details === `pow_fail_${status}`);
    deepEqual(calls, ['/pow']);

    calls = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === '/pow') return new Response(powChallengeFrame(), { headers: aedsHeaders });
      return apiErrorResponse(status, `submit_fail_${status}`);
    });
    await rejects(() => requestWithScopedPow({
      challengePath: '/pow', submitPath: '/submit', expected: FrameType.EmptySuccess,
      decode: () => {}, body: emptySuccessFrame(), signal: new AbortController().signal,
    }), (err: unknown) => err instanceof ApiError && err.status === status && err.details === `submit_fail_${status}`);
    deepEqual(calls, ['/pow', '/submit']);
  }
});

test('all 9 migrated Scoped PoW business modules (10 call sites) preserve exact routes, bytes, headers, and counts', async t => {
  installPasskeyEnvironment(t);
  installControlledWorker(t);

  type CallRecord = { url: string; method: string; headers: Headers; body: Uint8Array };
  let calls: CallRecord[] = [];

  const installFetch = (responder: (url: string, init?: RequestInit) => Response) => {
    calls = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
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

  // 1a. admin-tag-metadata (tag create -> POST)
  installFetch(url => url === WireRoutes.AdminTagCreatePow
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(metadataReceiptFrame('tag', 15, 1n, 'Rust', 'Systems', true), { headers: aedsHeaders }));
  const createdTag = await changeTaxonomyMetadata('tag', {
    id: 0, expectedRevision: 0n, requestId: '11111111-1111-4111-8111-111111111111', name: 'Rust', description: 'Systems',
  }, new AbortController().signal);
  equal(createdTag.id, 15);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.AdminTagCreatePow);
  equal(calls[1].url, WireRoutes.AdminTagCreate);
  assertPowPair(calls[0], calls[1], 'POST');

  // 1b. admin-tag-metadata (category update -> PUT)
  installFetch(url => url === WireRoutes.AdminCategoryMetadataPow.replace('{id:int}', '7')
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(metadataReceiptFrame('category', 7, 3n, 'Notes', 'Updated', true), { headers: aedsHeaders }));
  const updatedCategory = await changeTaxonomyMetadata('category', {
    id: 7, expectedRevision: 2n, requestId: '22222222-2222-4222-8222-222222222222', name: 'Notes', description: 'Updated',
  }, new AbortController().signal);
  equal(updatedCategory.revision, 3n);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.AdminCategoryMetadataPow.replace('{id:int}', '7'));
  equal(calls[1].url, WireRoutes.AdminCategoryMetadata.replace('{id:int}', '7'));
  assertPowPair(calls[0], calls[1], 'PUT');

  // 2. admin-inbox: adminReply
  installFetch(url => url === WireRoutes.AdminInboxReplyPow.replace('{id:long}', '42')
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(inboxMessageFrame(501n, 42n, 1, 'Admin response body'), { headers: aedsHeaders }));
  const replied = await adminReply(42n, 'Admin response body', 'reply-key-1', new AbortController().signal);
  equal(replied.id, 501n);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.AdminInboxReplyPow.replace('{id:long}', '42'));
  equal(calls[1].url, WireRoutes.AdminInboxReply.replace('{id:long}', '42'));
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.ClientMutationId, 'reply-key-1']);

  // 3. admin-inbox: adminChangeStatus
  installFetch(url => url === WireRoutes.AdminInboxStatusPow.replace('{id:long}', '42')
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(statusMutationFrame(0, 2), { headers: aedsHeaders }));
  const statusRes = await adminChangeStatus(42n, '19', 2, 'Resolved issue', new AbortController().signal);
  deepEqual(statusRes, { previous: 0, current: 2, changed: true });
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.AdminInboxStatusPow.replace('{id:long}', '42'));
  equal(calls[1].url, WireRoutes.AdminInboxStatus.replace('{id:long}', '42'));
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.AdminInboxVersion, '19']);

  // 4. admin-inbox-notice: adminSendNotice
  const recipient = '33333333-3333-4333-8333-333333333333';
  installFetch(url => url === WireRoutes.AdminInboxSendNoticePow
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(systemNoticeFrame(88n, 'Security alert', 901n, 'Notice content'), { headers: aedsHeaders }));
  const noticeThread = await adminSendNotice(recipient, 'Security alert', 'Notice content', 777n, new AbortController().signal);
  equal(noticeThread.id, 88n);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.AdminInboxSendNoticePow);
  equal(calls[1].url, WireRoutes.AdminInboxSendNotice);
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.SourceEventId, '777']);

  // 5. admin-appearance: Step-Up -> PoW (no MfaProof) -> Apply (MfaProof + PowProof)
  const appearanceCmd = {
    expectedRevision: 4n, currentTheme: 'e'.repeat(64), currentFont: 'f'.repeat(64),
    theme: '1'.repeat(64), font: '2'.repeat(64), rollback: false,
  };
  installFetch(url => {
    if (url === WireRoutes.AdminAppearanceStepUpBegin) return new Response(loginBeginFrame(), { headers: aedsHeaders });
    if (url === WireRoutes.AdminAppearanceStepUpComplete) return new Response(mfaChallengeResultFrame(), { headers: aedsHeaders });
    if (url === WireRoutes.AdminAppearancePow) return new Response(powChallengeFrame(), { headers: aedsHeaders });
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
  });
  await applyAppearance(appearanceCmd, new AbortController().signal);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminAppearanceStepUpBegin,
    WireRoutes.AdminAppearanceStepUpComplete,
    WireRoutes.AdminAppearancePow,
    WireRoutes.AdminAppearanceApply,
  ]);
  assertPowPair(calls[2], calls[3]);
  equal(calls[2].headers.get(WireHeaders.MfaProof), null);
  equal(calls[3].headers.get(WireHeaders.MfaProof), validProof);
  deepEqual(decodeAdminAppearanceCommand(decodeFrame(calls[3].body, FrameType.AdminAppearanceCommand).payload), appearanceCmd);

  // 6. admin-site-pages: Step-Up -> PoW (no MfaProof) -> Publish (MfaProof + PowProof)
  const pageIntent = { slug: 'about', expectedRevision: 2n, expectedDigest: 'd'.repeat(64), markdown: '# Hello\n' };
  installFetch(url => {
    if (url === WireRoutes.AdminSitePageStepUpBegin) return new Response(loginBeginFrame(), { headers: aedsHeaders });
    if (url === WireRoutes.AdminSitePageStepUpComplete) return new Response(mfaChallengeResultFrame(), { headers: aedsHeaders });
    if (url === WireRoutes.AdminSitePagePow) return new Response(powChallengeFrame(), { headers: aedsHeaders });
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
  });
  await publishAdminSitePage(pageIntent, new AbortController().signal);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminSitePageStepUpBegin,
    WireRoutes.AdminSitePageStepUpComplete,
    WireRoutes.AdminSitePagePow,
    WireRoutes.AdminSitePagePublish,
  ]);
  assertPowPair(calls[2], calls[3]);
  equal(calls[2].headers.get(WireHeaders.MfaProof), null);
  equal(calls[3].headers.get(WireHeaders.MfaProof), validProof);
  deepEqual(decodeAdminSitePagePublish(decodeFrame(calls[3].body, FrameType.AdminSitePagePublish).payload), pageIntent);

  // 7a. comment-write: anonymous root comment
  const rootCommentKey = '44444444-4444-4444-8444-444444444444';
  installFetch(url => url === WireRoutes.PublicCommentPowChallenge
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(encodeFrame(FrameType.PublicCommentSubmissionResult, encodePublicCommentSubmissionResult({
        articleId: 5, commentId: 101n, moderationStatus: 0, replayed: false,
      })), { headers: aedsHeaders }));
  const rootRes = await submitPublicComment(5, 3n, 'Reader', 'Comment text', rootCommentKey, new AbortController().signal);
  equal(rootRes.commentId, 101n);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.PublicCommentPowChallenge);
  equal(calls[1].url, WireRoutes.SubmitPublicComment);
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.ClientMutationId, rootCommentKey]);
  equal(calls[0].headers.get(WireHeaders.CurrentSession), null);
  equal(decodePublicCommentSubmission(decodeFrame(calls[1].body, FrameType.PublicCommentSubmission).payload).articleId, 5);

  // 7b. comment-write: signed-in reply
  const replyCommentKey = '55555555-5555-4555-8555-555555555555';
  installFetch(url => url === WireRoutes.PublicCommentReplyPow
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(encodeFrame(FrameType.PublicCommentSubmissionResult, encodePublicCommentSubmissionResult({
        articleId: 5, commentId: 102n, moderationStatus: 0, replayed: false,
      })), { headers: aedsHeaders }));
  const replyRes = await submitPublicComment(5, 3n, 'Reader', 'Reply text', replyCommentKey, new AbortController().signal, {
    parent: '101', session: validSiteSession,
  });
  equal(replyRes.commentId, 102n);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.PublicCommentReplyPow);
  equal(calls[1].url, WireRoutes.SubmitPublicCommentReply);
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), replyCommentKey);
  equal(decodePublicCommentReply(decodeFrame(calls[1].body, FrameType.PublicCommentReply).payload).parentId, 101n);

  // 8a. inbox-write: createInboxConversation
  const createdConversation = Uint8Array.from(hexFixture('conversation-detail-v2.hex', 'strip'));
  installFetch(url => url === WireRoutes.InboxCreatePowChallenge
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(createdConversation, { headers: aedsHeaders }));
  const createdId = await createInboxConversation('Appeal', 'Body', 'inbox-create-key', new AbortController().signal, validSiteSession);
  equal(createdId > 0n, true);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.InboxCreatePowChallenge);
  equal(calls[1].url, WireRoutes.InboxList);
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.CurrentSession, validSiteSession]);
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), 'inbox-create-key');

  // 8b. inbox-write: replyInboxConversation
  const repliedMessage = Uint8Array.from(hexFixture('conversation-message-frame.hex', 'strip'));
  const replyPayload = decodeFrame(repliedMessage, FrameType.ConversationMessage).payload;
  const replyConvId = new DataView(replyPayload.buffer, replyPayload.byteOffset).getBigInt64(8, true);
  installFetch(url => url === WireRoutes.InboxReplyPowChallenge.replace('{id:long}', String(replyConvId))
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(repliedMessage, { headers: aedsHeaders }));
  const replyMsgId = await replyInboxConversation(replyConvId, 1n, 'Follow-up', 'inbox-reply-key', new AbortController().signal, validSiteSession);
  equal(replyMsgId > 0n, true);
  equal(calls.length, 2);
  equal(calls[0].url, WireRoutes.InboxReplyPowChallenge.replace('{id:long}', String(replyConvId)));
  equal(calls[1].url, WireRoutes.InboxReply.replace('{id:long}', String(replyConvId)));
  assertPowPair(calls[0], calls[1], 'POST', [WireHeaders.CurrentSession, validSiteSession]);

  // 9. reader-registration: Pow -> Begin (PowProof only, no PowClientNonce) -> Complete (no PowProof)
  const provisionBegin = Uint8Array.from(hexFixture('site-passkey-bootstrap.hex', 'strip'));
  installFetch(url => {
    if (url === '/api/v2/identity/reader-registration/pow.aeds') return new Response(powChallengeFrame(), { headers: aedsHeaders });
    if (url === '/api/v2/identity/reader-registration/begin.aeds') return new Response(provisionBegin, { headers: aedsHeaders });
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
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
  installFetch(url => url === WireRoutes.RecoveryKeyPow
    ? new Response(powChallengeFrame(), { headers: aedsHeaders })
    : new Response(emptySuccessFrame(), { headers: aedsHeaders }));
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
    const url = typeof input === 'string' ? input : input.toString();
    if (url === WireRoutes.RecoveryKeyPow) {
      // Keep direct reference (not copied) to verify body.fill(0) ran in finally
      heldBody = init?.body as Uint8Array;
      return new Response(powChallengeFrame(), { headers: aedsHeaders });
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
    const url = typeof input === 'string' ? input : input.toString();
    if (url === WireRoutes.InboxCreatePowChallenge) return new Response(powChallengeFrame(), { headers: aedsHeaders });
    inboxSubmitCalled = true;
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
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
