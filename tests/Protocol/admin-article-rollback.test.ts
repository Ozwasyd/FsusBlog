import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  AdminArticleRollbackBlock, executeAdminArticleRollback, isValidAdminArticleRollbackReason,
  readAdminArticleRollbackAvailability, readAdminArticleRollbackPreview,
} from '../../src/Contracts/admin-article-rollback.ts';
import {
  decodeAdminArticleRollbackIntent, encodeAdminArticleRollbackPreview, encodeAdminArticleRollbackReceipt,
  FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const intent = {
  articleId: 42,
  expectedRevision: 9007199254740993n,
  expectedPublicationId: 67n,
  sourceRevision: 9007199254740991n,
  idempotencyKey: '00000000-0011-4222-8333-445566778899',
  reason: '恢复已核验的历史内容',
};
const receipt = {
  articleId: intent.articleId,
  revision: intent.expectedRevision + 1n,
  sourceRevision: intent.sourceRevision,
  previousPublicationId: intent.expectedPublicationId,
  publicationId: 78n,
  publicationNo: 4,
  publishedUnixMs: 1794659381000n,
  rightsSnapshotId: 88n,
  responsibilitySnapshotId: 93n,
};
const signal = new AbortController().signal;
const headers = { 'Content-Type': 'application/octet-stream' };

test('rollback submit binds the exact bigint intent and permits receipt replay without sending a proof', async t => {
  let sentProof: string | null = null;
  const fake = t.mock.method(globalThis, 'fetch', async (path, init) => {
    equal(path, WireRoutes.AdminArticleRollbackExecute);
    equal(init.method, 'POST');
    equal(init.credentials, 'same-origin');
    sentProof = init.headers.get(WireHeaders.MfaProof);
    deepEqual(decodeAdminArticleRollbackIntent(decodeFrame(init.body, FrameType.AdminArticleRollbackIntent).payload), intent);
    return new Response(encodeFrame(FrameType.AdminArticleRollbackReceipt, encodeAdminArticleRollbackReceipt(receipt)), { headers });
  });
  const proof = 'a'.repeat(43);
  deepEqual(await executeAdminArticleRollback(intent, proof, signal), receipt);
  equal(sentProof, proof);
  deepEqual(await executeAdminArticleRollback(intent, undefined, signal), receipt);
  equal(sentProof, null);

  fake.mock.mockImplementation(async () => new Response(encodeFrame(FrameType.AdminArticleRollbackReceipt,
    encodeAdminArticleRollbackReceipt({ ...receipt, previousPublicationId: 69n })), { headers }));
  await rejects(() => executeAdminArticleRollback(intent, undefined, signal), ProtocolError);
  throws(() => executeAdminArticleRollback({ ...intent, sourceRevision: intent.expectedRevision }, proof, signal), ProtocolError);
  throws(() => executeAdminArticleRollback(intent, 'not-a-proof', signal), ProtocolError);
});

test('rollback preview treats partial history as a typed blocker and checks request coordinates', async t => {
  const preview = {
    articleId: intent.articleId, currentRevision: intent.expectedRevision,
    currentPublicationId: intent.expectedPublicationId, sourceRevision: intent.sourceRevision,
    sourcePublicationId: 54n, sourceTitle: '旧标题',
    packageComplete: false, blockingReason: AdminArticleRollbackBlock.MissingResponsibility,
  };
  const response = (value: typeof preview) => new Response(encodeFrame(FrameType.AdminArticleRollbackPreview,
    encodeAdminArticleRollbackPreview(value)), { headers });
  const fake = t.mock.method(globalThis, 'fetch', async path => {
    equal(path, `${WireRoutes.AdminArticleRollbackPreview}?articleId=42&sourceRevision=9007199254740991`);
    return response(preview);
  });
  deepEqual(await readAdminArticleRollbackPreview(intent.articleId, intent.sourceRevision, signal), preview);
  fake.mock.mockImplementation(async () => response({ ...preview, packageComplete: true }));
  await rejects(() => readAdminArticleRollbackPreview(intent.articleId, intent.sourceRevision, signal), ProtocolError);
});

test('rollback availability distinguishes a disabled route from an authorization failure', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  equal(await readAdminArticleRollbackAvailability(signal), true);
  fake.mock.mockImplementation(async () => new Response(null, { status: 404 }));
  equal(await readAdminArticleRollbackAvailability(signal), false);
  fake.mock.mockImplementation(async () => new Response(null, { status: 403 }));
  await rejects(() => readAdminArticleRollbackAvailability(signal), { status: 403 });
});

test('rollback reason has exact whitespace, character, and encoding limits', () => {
  equal(isValidAdminArticleRollbackReason('历史内容已经重新核对'), true);
  equal(isValidAdminArticleRollbackReason('回'.repeat(500)), true);
  for (const reason of ['short', ` ${intent.reason}`, `${intent.reason}\u0000`,
    `${intent.reason}\ud800`, '回'.repeat(501)]) {
    equal(isValidAdminArticleRollbackReason(reason), false);
  }
});
