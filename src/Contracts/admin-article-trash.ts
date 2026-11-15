import { encodeFrame, ProtocolError } from './aeds.ts';
import { proofHeaders, readRollbackAvailability, requestRollbackProof } from './admin-article-rollback.ts';
import { request } from './client.ts';
import { decodeAdminArticleTrashRestoreReceipt, encodeAdminArticleTrashRestoreIntent,
  FrameType, WireHeaders, WireRoutes, type AdminArticleTrashRestoreIntent } from './wire.generated.ts';

export function readTrashRestoreAvailability(signal: AbortSignal) {
  return readRollbackAvailability(WireRoutes.AdminArticleTrashRestoreAvailability, signal);
}

export function requestTrashRestoreProof(intent: AdminArticleTrashRestoreIntent, signal: AbortSignal) {
  return requestRollbackProof(WireRoutes.AdminArticleTrashRestoreBegin, WireRoutes.AdminArticleTrashRestoreComplete,
    frame(intent), signal, { [WireHeaders.ClientMutationId]: intent.idempotencyKey });
}

export function executeTrashRestore(intent: AdminArticleTrashRestoreIntent, proof: string | undefined, signal: AbortSignal) {
  return request(WireRoutes.AdminArticleTrashRestoreExecute, FrameType.AdminArticleTrashRestoreReceipt, payload => {
    const receipt = decodeAdminArticleTrashRestoreReceipt(payload);
    if (receipt.articleId !== intent.articleId || receipt.revision !== intent.expectedRevision + 1n)
      throw new ProtocolError('Invalid administrator trash restore receipt.');
    return receipt;
  }, signal, 'POST', frame(intent), { ...proofHeaders(proof), [WireHeaders.ClientMutationId]: intent.idempotencyKey });
}

function frame(intent: AdminArticleTrashRestoreIntent) {
  return encodeFrame(FrameType.AdminArticleTrashRestoreIntent, encodeAdminArticleTrashRestoreIntent(intent));
}
