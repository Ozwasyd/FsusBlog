import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
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
  assertAdminPermissionSession, readAdminAvailability, readAdminCommentQueue, readAdminOperations, type AdminSession,
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
  encodeAdminAppearanceCommand, encodeAdminArticleArchiveIntent, encodeAdminArticleArchiveReceipt,
  encodeAdminArticleDraftRollbackIntent, encodeAdminArticleRollbackIntent, encodeAdminArticleTrashPublicationIntent,
  encodeAdminArticleTrashPublicationReceipt, encodeAdminArticleTrashRestoreIntent, encodeAdminArticleTrashRestoreReceipt,
  encodeAdminClusterStatus, encodeAdminModerationDecision, encodeAdminModerationIntent, encodeAdminOperationsStatus,
  encodeAdminRiskReadiness, encodeAdminRootCommentPowCommand, encodeAdminRootCommentPowPolicy, encodeAdminSitePagePublish,
  encodeAdminSitePages, FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const aedsHeaders = { 'Content-Type': 'application/octet-stream' };
const validProof = 'P'.repeat(43);
const altProof = 'Q'.repeat(43);
const validPermissionSession = 'a'.repeat(64);
const altPermissionSession = 'b'.repeat(64);
const encoder = new TextEncoder();

function activeSession(permissionSession: string | null = validPermissionSession): AdminSession {
  return {
    handle: 'admin-fixture',
    generation: 5n,
    expiresAt: Date.now() + 60_000,
    appearanceEnabled: true,
    ...(permissionSession !== null ? { permissionSession } : {}),
  };
}

function emptySuccessFrame(): Uint8Array<ArrayBuffer> {
  return encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0));
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

function loginBeginFrame(allowCredentialsCount = 1): Uint8Array<ArrayBuffer> {
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

function mfaChallengeResultFrame({
  action = 'admin-sensitive',
  verified = true,
  withUser = false,
  proof = validProof,
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

function sessionHistoryFrame(generation: bigint): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(12 + 25);
  const view = new DataView(payload.buffer);
  view.setBigInt64(0, generation, true);
  view.setInt32(8, 1, true);
  view.setBigInt64(12, 1_794_680_000_000n, true);
  view.setBigInt64(20, 1_794_687_200_000n, true);
  view.setBigInt64(28, 0n, true);
  payload[36] = 1;
  return encodeFrame(FrameType.AdminSignInHistory, payload);
}

function powChallengeFrame(): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(WireLayouts.PowChallengeBytes);
  const view = new DataView(payload.buffer);
  payload.set(encoder.encode('f'.repeat(32)), 0);
  view.setInt32(WireLayouts.PowChallengeSaltBytes, WireLimits.PowChallengeDifficulty, true);
  view.setBigInt64(WireLayouts.PowChallengeTimestampOffset, 1_794_680_000n, true);
  payload.set(encoder.encode('S'.repeat(43)), WireLayouts.PowChallengeSignatureOffset);
  return encodeFrame(FrameType.PowChallenge, payload);
}

function installPasskeyEnvironment(t: TestContext, onGet?: (options: CredentialRequestOptions | undefined) => void) {
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
      async get(options?: CredentialRequestOptions) {
        onGet?.(options);
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

function installPowWorker(t: TestContext) {
  const prevWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class FakeWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: '42' } as MessageEvent<unknown>));
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  t.after(() => {
    if (prevWorker) Object.defineProperty(globalThis, 'Worker', prevWorker);
    else delete (globalThis as Record<string, unknown>).Worker;
  });
}

test('assertAdminPermissionSession enforces binding across all six bound admin routes without adding it to unbound routes', async t => {
  const session = activeSession();
  const rootPolicyDigest = 'c'.repeat(64);
  const clusterStatus = {
    mode: 1, nodeId: 'node-1', instanceId: 'bd978cbd-7565-44ed-876d-d734cbe45c79', buildVersion: '2.0.0',
    startedAt: 1_794_680_000_000n, observedAt: 1_794_680_010_000n, leaseAgeMs: 100, snapshotReady: true,
  };
  const operationsStatus = {
    snapshotReady: true, publicationWatermark: 1n, pendingPublicationEvents: 0n, oldestPendingAt: 0n,
  };
  const riskStatus = {
    publicReadMode: 1, rootWriteMode: 1, replyWriteMode: 2, forwardingMode: 1, dynamicRisk: 0, strongAnonymous: 0,
  };
  const trafficPayload = (() => {
    const w = new PodWriter();
    w.bool(false);
    w.bool(false);
    w.i32(0);
    w.i32(0);
    return w.finish();
  })();
  const rootPolicy = {
    generation: 1n, digest: rootPolicyDigest, proofSeconds: WireLimits.PowChallengeSeconds, previousSeconds: 0,
  };

  const boundCases = [
    {
      name: 'readAdminOperations',
      frame: encodeFrame(FrameType.AdminOperationsStatus, encodeAdminOperationsStatus(operationsStatus)),
      run: (target: AdminSession, signal: AbortSignal) => readAdminOperations(target, signal),
    },
    {
      name: 'readAdminCluster',
      frame: encodeFrame(FrameType.AdminClusterStatus, encodeAdminClusterStatus(clusterStatus)),
      run: (target: AdminSession, signal: AbortSignal) => readAdminCluster(target, signal),
    },
    {
      name: 'readAdminRiskReadiness',
      frame: encodeFrame(FrameType.AdminRiskReadiness, encodeAdminRiskReadiness(riskStatus)),
      run: (target: AdminSession, signal: AbortSignal) => readAdminRiskReadiness(target, signal),
    },
    {
      name: 'readAdminSiteTraffic',
      frame: encodeFrame(FrameType.AdminSiteTraffic, trafficPayload),
      run: (target: AdminSession, signal: AbortSignal) => readAdminSiteTraffic(target, signal),
    },
    {
      name: 'readAdminSessionHistory',
      frame: sessionHistoryFrame(session.generation),
      run: (target: AdminSession, signal: AbortSignal) => readAdminSessionHistory(target, signal),
      message: 'Administrator history session changed.',
    },
    {
      name: 'readRootCommentPowPolicy',
      frame: encodeFrame(FrameType.AdminRootCommentPowPolicy, encodeAdminRootCommentPowPolicy(rootPolicy)),
      run: (target: AdminSession, signal: AbortSignal) => readRootCommentPowPolicy(target, signal),
    },
  ];

  let responseHeaders: Record<string, string> = {};
  let responseBody: Uint8Array<ArrayBuffer> = new Uint8Array();
  t.mock.method(globalThis, 'fetch', async () => new Response(responseBody, { headers: { ...aedsHeaders, ...responseHeaders } }));

  for (const item of boundCases) {
    responseBody = item.frame;
    responseHeaders = { [WireHeaders.AdminPermissionSession]: validPermissionSession };
    await item.run(session, new AbortController().signal);

    // Missing header
    responseHeaders = {};
    await rejects(() => item.run(session, new AbortController().signal), ProtocolError);

    // Cross-session / late response header mismatch
    responseHeaders = { [WireHeaders.AdminPermissionSession]: altPermissionSession };
    await rejects(() => item.run(session, new AbortController().signal),
      error => error instanceof ProtocolError && (!item.message || error.message === item.message));

    // Malformed response header
    for (const malformed of ['', 'not-hex', 'A'.repeat(64), '0'.repeat(63)]) {
      responseHeaders = { [WireHeaders.AdminPermissionSession]: malformed };
      await rejects(() => item.run(session, new AbortController().signal), ProtocolError);
    }

    // Empty / missing / malformed session permissionSession
    for (const badSession of [activeSession(null), activeSession(''), activeSession('not-hex')]) {
      responseHeaders = badSession.permissionSession ? { [WireHeaders.AdminPermissionSession]: badSession.permissionSession } : {};
      await rejects(() => item.run(badSession, new AbortController().signal), ProtocolError);
    }
  }

  throws(() => assertAdminPermissionSession(activeSession(''), new Headers()), ProtocolError);
  throws(() => assertAdminPermissionSession(activeSession('0'.repeat(63)), new Headers({ [WireHeaders.AdminPermissionSession]: '0'.repeat(63) })), ProtocolError);

  // Unbound admin routes must not require X-Fsus-Admin-Permission-Session.
  responseHeaders = {};
  const queueWriter = new PodWriter();
  queueWriter.bool(false);
  queueWriter.i32(0);
  responseBody = encodeFrame(FrameType.AdminCommentQueue, queueWriter.finish());
  deepEqual(await readAdminCommentQueue(null, new AbortController().signal), { comments: [], next: null, batchEnabled: false });

  const taxWriter = new PodWriter();
  taxWriter.i32(0);
  taxWriter.i32(0);
  responseBody = encodeFrame(FrameType.AdminTaxonomyPage, taxWriter.finish());
  deepEqual(await readAdminTaxonomy('categories', null, new AbortController().signal), { nextId: null, items: [] });

  responseBody = encodeFrame(FrameType.AdminCommentAppeals, queueWriter.finish());
  deepEqual(await readAdminAppeals(null, new AbortController().signal), { rows: [], more: false });

  responseBody = encodeFrame(FrameType.AdminSitePages, encodeAdminSitePages({ configuredMask: 0 }));
  equal((await readAdminSitePages(new AbortController().signal)).pages.length, 4);
});

test('proveAdminStepUp enforces route order, restricted assertion, begin-only headers, and proof validation', async t => {
  const calls: { url: string; method: string; headers: Headers; body: Uint8Array }[] = [];
  let assertionCount = 0;
  installPasskeyEnvironment(t, options => {
    assertionCount++;
    equal(options?.publicKey?.allowCredentials?.length, 1);
  });

  const intent = encodeFrame(FrameType.AdminModerationIntent, encodeAdminModerationIntent({
    articleId: 3, commentId: 9n, expectedStatus: 0, decision: 1, reason: 'Approve step-up fixture',
  }));
  const routes = { begin: '/begin.aeds', complete: '/complete.aeds' };

  const fake = t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const body = new Uint8Array(init?.body as Uint8Array);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    if (url === routes.begin) return new Response(loginBeginFrame(1), { headers: aedsHeaders });
    if (url === routes.complete) {
      const completePayload = decodeFrame(body, FrameType.PasskeyLoginCompleteRequest).payload;
      equal(completePayload[0], 0, 'rememberMe must remain false for administrator Step-Up');
      return new Response(mfaChallengeResultFrame({ proof: validProof }), { headers: aedsHeaders });
    }
    throw new Error(`Unexpected route ${url}`);
  });

  const proof = await proveAdminStepUp(routes, intent, new AbortController().signal, {
    [WireHeaders.ClientMutationId]: 'mutation-1',
  });
  equal(proof, validProof);
  equal(assertionCount, 1);
  equal(calls.length, 2);
  equal(calls[0].url, routes.begin);
  equal(calls[0].method, 'POST');
  deepEqual(calls[0].body, intent);
  equal(calls[0].headers.get(WireHeaders.ClientMutationId), 'mutation-1');
  equal(calls[1].url, routes.complete);
  equal(calls[1].method, 'POST');
  equal(calls[1].headers.get(WireHeaders.ClientMutationId), null);

  // Proof header helpers
  deepEqual(adminProofHeaders(validProof), { [WireHeaders.MfaProof]: validProof });
  deepEqual(optionalAdminProofHeaders(validProof), { [WireHeaders.MfaProof]: validProof });
  equal(optionalAdminProofHeaders(undefined), undefined);
  for (const invalidProof of ['', 'short', 'P'.repeat(44), 'P'.repeat(42) + '!', undefined as unknown as string]) {
    throws(() => adminProofHeaders(invalidProof), ProtocolError);
  }
  throws(() => optionalAdminProofHeaders('bad-proof'), ProtocolError);
  await rejects(() => proveAdminStepUp({ begin: '', complete: '/c' }, intent), ProtocolError);

  // Reject unrestricted begin (0 allowCredentials)
  fake.mock.mockImplementation(async () => new Response(loginBeginFrame(0), { headers: aedsHeaders }));
  await rejects(() => proveAdminStepUp(routes, intent), ProtocolError);
  equal(assertionCount, 1);

  // Reject mismatched action / unverified / withUser MFA result
  for (const badResult of [
    mfaChallengeResultFrame({ action: 'recovery-key.create' }),
    mfaChallengeResultFrame({ verified: false }),
    mfaChallengeResultFrame({ withUser: true }),
    mfaChallengeResultFrame({ proof: 'bad!' }),
  ]) {
    fake.mock.mockImplementation(async (path: string | URL | Request) => String(path) === routes.begin
      ? new Response(loginBeginFrame(1), { headers: aedsHeaders })
      : new Response(badResult, { headers: aedsHeaders }));
    await rejects(() => proveAdminStepUp(routes, intent), ProtocolError);
  }
});

test('proveAdminStepUp propagates abort, Passkey cancellation, and HTTP errors without retrying', async t => {
  let getBehavior: 'ok' | 'cancel' | 'abort-during' = 'ok';
  let abortController = new AbortController();
  let getCalls = 0;
  installPasskeyEnvironment(t, () => {
    getCalls++;
    if (getBehavior === 'cancel') throw new DOMException('User canceled', 'NotAllowedError');
    if (getBehavior === 'abort-during') abortController.abort(new DOMException('Aborted', 'AbortError'));
  });

  const intent = emptySuccessFrame();
  const routes = { begin: '/begin.aeds', complete: '/complete.aeds' };
  let fetchCalls: string[] = [];
  let beginResponse: () => Response = () => new Response(loginBeginFrame(1), { headers: aedsHeaders });
  let completeResponse: () => Response = () => new Response(mfaChallengeResultFrame(), { headers: aedsHeaders });
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request) => {
    const url = String(path);
    fetchCalls.push(url);
    return url === routes.begin ? beginResponse() : completeResponse();
  });

  // Pre-aborted signal makes zero network or WebAuthn calls.
  abortController = new AbortController();
  abortController.abort(new DOMException('Already aborted', 'AbortError'));
  await rejects(() => proveAdminStepUp(routes, intent, abortController.signal), { name: 'AbortError' });
  deepEqual(fetchCalls, []);
  equal(getCalls, 0);

  // Begin failure (403) propagates unchanged with no retry.
  fetchCalls = [];
  beginResponse = () => apiErrorResponse(403, 'FORBIDDEN');
  await rejects(() => proveAdminStepUp(routes, intent, new AbortController().signal),
    error => error instanceof ApiError && error.status === 403 && error.details === 'FORBIDDEN');
  deepEqual(fetchCalls, [routes.begin]);
  equal(getCalls, 0);

  // Passkey cancellation propagates NotAllowedError without calling complete or retrying.
  fetchCalls = [];
  getBehavior = 'cancel';
  beginResponse = () => new Response(loginBeginFrame(1), { headers: aedsHeaders });
  await rejects(() => proveAdminStepUp(routes, intent, new AbortController().signal), { name: 'NotAllowedError' });
  deepEqual(fetchCalls, [routes.begin]);
  equal(getCalls, 1);

  // Abort during credentials.get never calls complete.
  fetchCalls = [];
  getBehavior = 'abort-during';
  abortController = new AbortController();
  await rejects(() => proveAdminStepUp(routes, intent, abortController.signal), { name: 'AbortError' });
  deepEqual(fetchCalls, [routes.begin]);
  equal(getCalls, 2);

  // Complete failure (401) propagates unchanged with no retry.
  fetchCalls = [];
  getBehavior = 'ok';
  completeResponse = () => apiErrorResponse(401, 'ADMIN_SESSION_EXPIRED');
  await rejects(() => proveAdminStepUp(routes, intent, new AbortController().signal),
    error => error instanceof ApiError && error.status === 401 && error.details === 'ADMIN_SESSION_EXPIRED');
  deepEqual(fetchCalls, [routes.begin, routes.complete]);
});

test('all migrated administrator Step-Up actions preserve exact routes, bytes, headers, and receipt binding', async t => {
  installPasskeyEnvironment(t);
  installPowWorker(t);

  const calls: { url: string; method: string; headers: Headers; body: Uint8Array }[] = [];
  const signal = new AbortController().signal;
  const session = activeSession();

  const handlers = new Map<string, (headers: Headers, body: Uint8Array) => Response>();
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    const handler = handlers.get(url);
    if (!handler) throw new Error(`Unexpected fetch: ${url}`);
    return handler(headers, body);
  });

  const stepUpPair = (begin: string, complete: string, expectedFrame: FrameType, proof = validProof, expectMutation?: string) => {
    handlers.set(begin, (headers, body) => {
      decodeFrame(body, expectedFrame);
      equal(headers.get(WireHeaders.ClientMutationId), expectMutation ?? null);
      return new Response(loginBeginFrame(1), { headers: aedsHeaders });
    });
    handlers.set(complete, headers => {
      equal(headers.get(WireHeaders.ClientMutationId), null);
      return new Response(mfaChallengeResultFrame({ proof }), { headers: aedsHeaders });
    });
  };

  // 1. Moderation intent & decision
  calls.length = 0;
  handlers.clear();
  stepUpPair(WireRoutes.AdminStepUpBegin, WireRoutes.AdminStepUpComplete, FrameType.AdminModerationIntent);
  equal(await proveAdminModeration({ articleId: 1, commentId: 2n, expectedStatus: 0, decision: 1, reason: 'Valid reason' }, signal), validProof);
  deepEqual(calls.map(c => c.url), [WireRoutes.AdminStepUpBegin, WireRoutes.AdminStepUpComplete]);

  calls.length = 0;
  handlers.clear();
  stepUpPair(WireRoutes.AdminModerationStepUpBegin, WireRoutes.AdminStepUpComplete, FrameType.AdminModerationDecision, altProof);
  handlers.set(WireRoutes.AdminModerationDecision, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), altProof);
    decodeFrame(body, FrameType.AdminModerationDecision);
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
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
  calls.length = 0;
  handlers.clear();
  const rollbackIntent = {
    articleId: 7, expectedRevision: 3n, expectedPublicationId: 8n, sourceRevision: 1n,
    idempotencyKey: '00000000-0011-4222-8333-445566778899', reason: 'Restore approved article content',
  };
  stepUpPair(WireRoutes.AdminArticleRollbackStepUpBegin, WireRoutes.AdminArticleRollbackStepUpComplete, FrameType.AdminArticleRollbackIntent);
  stepUpPair(WireRoutes.AdminArticleDraftRollbackStepUpBegin, WireRoutes.AdminArticleDraftRollbackStepUpComplete, FrameType.AdminArticleDraftRollbackIntent, altProof);
  equal(await requestAdminArticleRollbackProof(rollbackIntent, signal), validProof);
  equal(await requestAdminArticleDraftRollbackProof({ ...rollbackIntent, targetStatus: 0 }, signal), altProof);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminArticleRollbackStepUpBegin, WireRoutes.AdminArticleRollbackStepUpComplete,
    WireRoutes.AdminArticleDraftRollbackStepUpBegin, WireRoutes.AdminArticleDraftRollbackStepUpComplete,
  ]);
  // Execute rollback rejects invalid proofs before fetch
  throws(() => executeAdminArticleRollback(rollbackIntent, 'bad', signal), ProtocolError);
  throws(() => executeAdminArticleDraftRollback({ ...rollbackIntent, targetStatus: 0 }, 'bad', signal), ProtocolError);

  // 3. Archive proof + execute + replay + availability
  calls.length = 0;
  handlers.clear();
  const archiveIntent = {
    articleId: 7, expectedRevision: 3n, expectedReleaseId: 8n, sourceRevision: 1n,
    idempotencyKey: '00000000-0011-4222-8333-445566778899', reason: 'Archive article cleanly', targetStatus: 3,
  };
  const archiveReceipt = {
    articleId: 7, revision: 4n, sourceRevision: 1n, previousReleaseId: 8n, releaseId: 9n, publicationNo: 3,
    transitionedUnixMs: 1_794_680_000_000n, rightsSnapshotId: 1n, responsibilitySnapshotId: 2n, targetStatus: 3,
  };
  stepUpPair(WireRoutes.AdminArticleArchiveStepUpBegin, WireRoutes.AdminArticleArchiveStepUpComplete, FrameType.AdminArticleArchiveIntent);
  handlers.set(WireRoutes.AdminArticleArchiveExecute, headers => {
    const sent = calls.length === 3 ? validProof : null;
    equal(headers.get(WireHeaders.MfaProof), sent);
    return new Response(encodeFrame(FrameType.AdminArticleArchiveReceipt, encodeAdminArticleArchiveReceipt(archiveReceipt)), { headers: aedsHeaders });
  });
  const archiveProof = await requestAdminArticleArchiveProof(archiveIntent, signal);
  deepEqual(await executeAdminArticleArchive(archiveIntent, archiveProof, signal), archiveReceipt);
  deepEqual(await executeAdminArticleArchive(archiveIntent, undefined, signal), archiveReceipt);
  handlers.set(WireRoutes.AdminArticleArchiveExecute, () =>
    new Response(encodeFrame(FrameType.AdminArticleArchiveReceipt, encodeAdminArticleArchiveReceipt({ ...archiveReceipt, targetStatus: 2 })), { headers: aedsHeaders }));
  await rejects(() => executeAdminArticleArchive(archiveIntent, undefined, signal), ProtocolError);

  // 4. Trash publication & trash restore (beginHeaders sent to begin ONLY)
  calls.length = 0;
  handlers.clear();
  const trashKey = '11111111-1111-4111-8111-111111111111';
  const trashPubIntent = {
    articleId: 9, expectedRevision: 5n, sourceRevision: 2n, sourcePublicationId: 4n,
    idempotencyKey: trashKey, reason: 'Republish trashed article cleanly',
  };
  const trashPubReceipt = {
    articleId: 9, revision: 6n, sourceRevision: 2n, sourcePublicationId: 4n, publicationId: 12n,
  };
  stepUpPair(WireRoutes.AdminArticleTrashPublicationBegin, WireRoutes.AdminArticleTrashPublicationComplete,
    FrameType.AdminArticleTrashPublicationIntent, validProof, trashKey);
  handlers.set(WireRoutes.AdminArticleTrashPublicationExecute, headers => {
    equal(headers.get(WireHeaders.ClientMutationId), trashKey);
    equal(headers.get(WireHeaders.MfaProof), calls.length === 3 ? validProof : null);
    return new Response(encodeFrame(FrameType.AdminArticleTrashPublicationReceipt,
      encodeAdminArticleTrashPublicationReceipt(trashPubReceipt)), { headers: aedsHeaders });
  });
  const trashPubProof = await requestTrashPublicationProof(trashPubIntent, signal);
  deepEqual(await executeTrashPublication(trashPubIntent, trashPubProof, signal), trashPubReceipt);
  deepEqual(await executeTrashPublication(trashPubIntent, undefined, signal), trashPubReceipt);

  calls.length = 0;
  handlers.clear();
  const trashRestoreIntent = { articleId: 9, expectedRevision: 5n, idempotencyKey: trashKey };
  const trashRestoreReceipt = { articleId: 9, revision: 6n };
  stepUpPair(WireRoutes.AdminArticleTrashRestoreBegin, WireRoutes.AdminArticleTrashRestoreComplete,
    FrameType.AdminArticleTrashRestoreIntent, altProof, trashKey);
  handlers.set(WireRoutes.AdminArticleTrashRestoreExecute, headers => {
    equal(headers.get(WireHeaders.ClientMutationId), trashKey);
    equal(headers.get(WireHeaders.MfaProof), calls.length === 3 ? altProof : null);
    return new Response(encodeFrame(FrameType.AdminArticleTrashRestoreReceipt,
      encodeAdminArticleTrashRestoreReceipt(trashRestoreReceipt)), { headers: aedsHeaders });
  });
  const trashRestoreProof = await requestTrashRestoreProof(trashRestoreIntent, signal);
  deepEqual(await executeTrashRestore(trashRestoreIntent, trashRestoreProof, signal), trashRestoreReceipt);
  deepEqual(await executeTrashRestore(trashRestoreIntent, undefined, signal), trashRestoreReceipt);

  // Availability helpers
  handlers.set(WireRoutes.AdminArticleArchiveAvailability, () => new Response(null, { status: 204 }));
  handlers.set(WireRoutes.AdminArticleTrashRestoreAvailability, () => new Response(null, { status: 404 }));
  handlers.set(WireRoutes.AdminArticleTrashPublicationAvailability, () => new Response(null, { status: 403 }));
  equal(await readAdminArticleArchiveAvailability(signal), true);
  equal(await readTrashRestoreAvailability(signal), false);
  await rejects(() => readTrashPublicationAvailability(signal), { status: 403 });
  handlers.set('/bad-availability', () => new Response(null, { status: 200 }));
  await rejects(() => readAdminAvailability('/bad-availability', signal), ProtocolError);

  // 5. Moderation batch
  calls.length = 0;
  handlers.clear();
  const batchDecision = {
    decision: 1 as const,
    reason: 'Batch approval fixture',
    rows: [
      { articleId: 1, commentId: 10n, commentVersion: 1n, claimToken: 'A'.repeat(43), claimGeneration: 1n, claimVersion: 1n, expectedStatus: 0 as const },
      { articleId: 1, commentId: 11n, commentVersion: 1n, claimToken: 'B'.repeat(43), claimGeneration: 1n, claimVersion: 1n, expectedStatus: 0 as const },
    ],
  };
  const expectedBatchFrame = encodeModerationBatchDecision(batchDecision);
  stepUpPair(WireRoutes.AdminModerationBatchStepUpBegin, WireRoutes.AdminModerationBatchStepUpComplete,
    FrameType.AdminModerationBatchDecision);
  handlers.set(WireRoutes.AdminModerationBatchDecision, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    deepEqual(body, expectedBatchFrame);
    const w = new PodWriter();
    w.i64(55n);
    w.i32(2);
    return new Response(encodeFrame(FrameType.AdminModerationBatchReceipt, w.finish()), { headers: aedsHeaders });
  });
  deepEqual(await proveAndDecideModerationBatch(batchDecision, signal), { batchId: 55n, count: 2 });
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminModerationBatchStepUpBegin,
    WireRoutes.AdminModerationBatchStepUpComplete,
    WireRoutes.AdminModerationBatchDecision,
  ]);

  // 6. Appearance (Step-Up -> PoW challenge without MfaProof -> Apply with both)
  calls.length = 0;
  handlers.clear();
  const appearanceCmd = {
    expectedRevision: 1n, currentTheme: '', currentFont: '', theme: 'd'.repeat(64), font: '', rollback: false,
  };
  const appearanceFrame = encodeFrame(FrameType.AdminAppearanceCommand, encodeAdminAppearanceCommand(appearanceCmd));
  stepUpPair(WireRoutes.AdminAppearanceStepUpBegin, WireRoutes.AdminAppearanceStepUpComplete, FrameType.AdminAppearanceCommand);
  handlers.set(WireRoutes.AdminAppearancePow, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), null);
    match(headers.get(WireHeaders.PowClientNonce) ?? '', /^[a-f0-9]{32}$/);
    deepEqual(body, appearanceFrame);
    return new Response(powChallengeFrame(), { headers: aedsHeaders });
  });
  handlers.set(WireRoutes.AdminAppearanceApply, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    equal(typeof headers.get(WireHeaders.PowProof), 'string');
    deepEqual(body, appearanceFrame);
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
  });
  await applyAppearance(appearanceCmd, signal);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminAppearanceStepUpBegin,
    WireRoutes.AdminAppearanceStepUpComplete,
    WireRoutes.AdminAppearancePow,
    WireRoutes.AdminAppearanceApply,
  ]);

  // 7. Site pages (Step-Up -> PoW challenge without MfaProof -> Publish with both)
  calls.length = 0;
  handlers.clear();
  const pageIntent = { slug: 'about', expectedRevision: 1n, expectedDigest: 'e'.repeat(64), markdown: '# Updated about\n' };
  const pageFrame = encodeFrame(FrameType.AdminSitePagePublish, encodeAdminSitePagePublish(pageIntent));
  stepUpPair(WireRoutes.AdminSitePageStepUpBegin, WireRoutes.AdminSitePageStepUpComplete, FrameType.AdminSitePagePublish, altProof);
  handlers.set(WireRoutes.AdminSitePagePow, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), null);
    match(headers.get(WireHeaders.PowClientNonce) ?? '', /^[a-f0-9]{32}$/);
    deepEqual(body, pageFrame);
    return new Response(powChallengeFrame(), { headers: aedsHeaders });
  });
  handlers.set(WireRoutes.AdminSitePagePublish, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), altProof);
    equal(typeof headers.get(WireHeaders.PowProof), 'string');
    deepEqual(body, pageFrame);
    return new Response(emptySuccessFrame(), { headers: aedsHeaders });
  });
  await publishAdminSitePage(pageIntent, signal);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminSitePageStepUpBegin,
    WireRoutes.AdminSitePageStepUpComplete,
    WireRoutes.AdminSitePagePow,
    WireRoutes.AdminSitePagePublish,
  ]);

  // 8. Root comment PoW policy (Step-Up + AdminPermissionSession + receipt check)
  calls.length = 0;
  handlers.clear();
  const powCmd = { expectedGeneration: 1n, expectedDigest: 'c'.repeat(64), proofSeconds: 90, rollback: false };
  const powFrame = encodeFrame(FrameType.AdminRootCommentPowCommand, encodeAdminRootCommentPowCommand(powCmd));
  stepUpPair(WireRoutes.AdminRootCommentPowBegin, WireRoutes.AdminRootCommentPowComplete, FrameType.AdminRootCommentPowCommand);
  let applyPermissionHeader: string | null = validPermissionSession;
  handlers.set(WireRoutes.AdminRootCommentPowApply, (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    deepEqual(body, powFrame);
    return new Response(encodeFrame(FrameType.AdminRootCommentPowPolicy, encodeAdminRootCommentPowPolicy({
      generation: 2n, digest: 'd'.repeat(64), proofSeconds: 90, previousSeconds: 120,
    })), {
      headers: {
        ...aedsHeaders,
        ...(applyPermissionHeader !== null ? { [WireHeaders.AdminPermissionSession]: applyPermissionHeader } : {}),
      },
    });
  });
  const savedPolicy = await applyRootCommentPowPolicy(session, powCmd, signal);
  equal(savedPolicy.generation, 2n);
  applyPermissionHeader = altPermissionSession;
  await rejects(() => applyRootCommentPowPolicy(session, powCmd, signal), ProtocolError);

  // 9. Comment appeals (parameterized route + Step-Up + appealId receipt binding)
  calls.length = 0;
  handlers.clear();
  const appealId = '77';
  stepUpPair(WireRoutes.AdminAppealStepUpBegin.replace('{id:long}', appealId),
    WireRoutes.AdminAppealStepUpComplete, FrameType.CommentAppealDecisionRequest);
  handlers.set(WireRoutes.AdminAppealDecision.replace('{id:long}', appealId), (headers, body) => {
    equal(headers.get(WireHeaders.MfaProof), validProof);
    decodeFrame(body, FrameType.CommentAppealDecisionRequest);
    return new Response(encodeFrame(FrameType.CommentAppealDecisionResult,
      encoder.encode(JSON.stringify({ success: true, code: 'ok', appealId: 77 }))), { headers: aedsHeaders });
  });
  await decideAdminAppeal(appealId, 'granted', 'Valid appeal explanation', signal);
  deepEqual(calls.map(c => c.url), [
    WireRoutes.AdminAppealStepUpBegin.replace('{id:long}', appealId),
    WireRoutes.AdminAppealStepUpComplete,
    WireRoutes.AdminAppealDecision.replace('{id:long}', appealId),
  ]);
  handlers.set(WireRoutes.AdminAppealDecision.replace('{id:long}', appealId), () =>
    new Response(encodeFrame(FrameType.CommentAppealDecisionResult,
      encoder.encode(JSON.stringify({ success: true, code: 'ok', appealId: 78 }))), { headers: aedsHeaders }));
  await rejects(() => decideAdminAppeal(appealId, 'denied', 'Valid appeal explanation', signal), ProtocolError);
});
