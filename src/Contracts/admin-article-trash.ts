import { encodeFrame, ProtocolError } from './aeds.ts';
import { readAdminAvailability } from './admin-identity.ts';
import { optionalAdminProofHeaders, proveAdminStepUp } from './admin-step-up.ts';
import { request } from './client.ts';
import { post } from './internal/http-methods.ts';
import { decodeAdminArticleTrashRestoreReceipt, encodeAdminArticleTrashRestoreIntent, decodeAdminArticleTrashPublicationPreview,
  decodeAdminArticleTrashPublicationReceipt, encodeAdminArticleTrashPublicationIntent,
  FrameType, WireHeaders, WireRoutes, type AdminArticleTrashRestoreIntent, type AdminArticleTrashPublicationIntent } from './wire.generated.ts';

export function readTrashRestoreAvailability(signal: AbortSignal) {
  return readAdminAvailability(WireRoutes.AdminArticleTrashRestoreAvailability, signal);
}

export function readTrashPublicationAvailability(signal: AbortSignal) {
  return readAdminAvailability(WireRoutes.AdminArticleTrashPublicationAvailability, signal);
}

export function readTrashPublication(articleId: number, revision: bigint, signal: AbortSignal) {
  const parameters = new URLSearchParams({ articleId: String(articleId), revision: String(revision) });
  return request(`${WireRoutes.AdminArticleTrashPublicationPreview}?${parameters}`, FrameType.AdminArticleTrashPublicationPreview,
    payload => {
      const former = decodeAdminArticleTrashPublicationPreview(payload);
      if (former.articleId !== articleId || former.expectedRevision !== revision || former.sourceRevision <= 0n ||
          former.sourceRevision >= revision || former.sourcePublicationId <= 0n || !former.title.trim())
        throw new ProtocolError('Invalid former publication preview.');
      return former;
    }, signal);
}

export function requestTrashPublicationProof(intent: AdminArticleTrashPublicationIntent, signal: AbortSignal) {
  return proveAdminStepUp({
    begin: WireRoutes.AdminArticleTrashPublicationBegin,
    complete: WireRoutes.AdminArticleTrashPublicationComplete,
  }, publicationFrame(intent), signal, { [WireHeaders.ClientMutationId]: intent.idempotencyKey });
}

export function executeTrashPublication(intent: AdminArticleTrashPublicationIntent, proof: string | undefined, signal: AbortSignal) {
  return post(WireRoutes.AdminArticleTrashPublicationExecute, FrameType.AdminArticleTrashPublicationReceipt, payload => {
    const receipt = decodeAdminArticleTrashPublicationReceipt(payload);
    if (receipt.articleId !== intent.articleId || receipt.revision !== intent.expectedRevision + 1n ||
        receipt.sourceRevision !== intent.sourceRevision || receipt.sourcePublicationId !== intent.sourcePublicationId ||
        receipt.publicationId <= 0n || receipt.publicationId === receipt.sourcePublicationId)
      throw new ProtocolError('Invalid administrator publication restore receipt.');
    return receipt;
  }, signal, publicationFrame(intent), { ...optionalAdminProofHeaders(proof), [WireHeaders.ClientMutationId]: intent.idempotencyKey });
}

function publicationFrame(intent: AdminArticleTrashPublicationIntent) {
  return encodeFrame(FrameType.AdminArticleTrashPublicationIntent, encodeAdminArticleTrashPublicationIntent(intent));
}

export function requestTrashRestoreProof(intent: AdminArticleTrashRestoreIntent, signal: AbortSignal) {
  return proveAdminStepUp({
    begin: WireRoutes.AdminArticleTrashRestoreBegin,
    complete: WireRoutes.AdminArticleTrashRestoreComplete,
  }, frame(intent), signal, { [WireHeaders.ClientMutationId]: intent.idempotencyKey });
}

export function executeTrashRestore(intent: AdminArticleTrashRestoreIntent, proof: string | undefined, signal: AbortSignal) {
  return post(WireRoutes.AdminArticleTrashRestoreExecute, FrameType.AdminArticleTrashRestoreReceipt, payload => {
    const receipt = decodeAdminArticleTrashRestoreReceipt(payload);
    if (receipt.articleId !== intent.articleId || receipt.revision !== intent.expectedRevision + 1n)
      throw new ProtocolError('Invalid administrator trash restore receipt.');
    return receipt;
  }, signal, frame(intent), { ...optionalAdminProofHeaders(proof), [WireHeaders.ClientMutationId]: intent.idempotencyKey });
}

function frame(intent: AdminArticleTrashRestoreIntent) {
  return encodeFrame(FrameType.AdminArticleTrashRestoreIntent, encodeAdminArticleTrashRestoreIntent(intent));
}
