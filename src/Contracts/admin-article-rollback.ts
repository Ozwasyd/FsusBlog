import { ApiError, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import {
  decodeAdminArticleRollbackPreview, decodeAdminArticleRollbackReceipt, encodeAdminArticleRollbackIntent,
  FrameType, WireHeaders, WireLimits, WireRoutes,
  type AdminArticleRollbackIntent, type AdminArticleRollbackPreview as WireRollbackPreview, type AdminArticleRollbackReceipt,
} from './wire.generated.ts';

export type { AdminArticleRollbackIntent, AdminArticleRollbackReceipt } from './wire.generated.ts';

export const AdminArticleRollbackBlock = {
  Ready: 0,
  MissingRights: 1,
  MissingResponsibility: 2,
  PrivateAttachment: 3,
  PendingSchedule: 4,
  UnpublishedDraft: 5,
} as const;
export type AdminArticleRollbackBlock = typeof AdminArticleRollbackBlock[keyof typeof AdminArticleRollbackBlock];
export type AdminArticleRollbackPreview = Omit<WireRollbackPreview, 'blockingReason'> & {
  blockingReason: AdminArticleRollbackBlock;
};

const textEncoder = new TextEncoder();
const emptyUuid = '00000000-0000-0000-0000-000000000000';
const maximumRevision = 0x7fffffffffffffffn;

export async function readAdminArticleRollbackAvailability(signal: AbortSignal): Promise<boolean> {
  const response = await fetch(WireRoutes.AdminArticleRollbackAvailability, {
    credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  });
  if (response.status === 204) return true;
  if (response.status === 404) return false;
  if (!response.ok) throw new ApiError(response.statusText || 'Request failed', response.status);
  throw new ProtocolError('Invalid administrator article rollback availability response');
}

export function readAdminArticleRollbackPreview(articleId: number, sourceRevision: bigint,
  signal: AbortSignal): Promise<AdminArticleRollbackPreview> {
  if (!validArticleId(articleId) || !validRevision(sourceRevision))
    throw new ProtocolError('Invalid administrator article rollback coordinates');
  const query = new URLSearchParams({ articleId: String(articleId), sourceRevision: String(sourceRevision) });
  return request(`${WireRoutes.AdminArticleRollbackPreview}?${query}`, FrameType.AdminArticleRollbackPreview, payload => {
    const preview = decodeAdminArticleRollbackPreview(payload);
    const reason = preview.blockingReason;
    if (preview.articleId !== articleId || preview.sourceRevision !== sourceRevision || preview.currentRevision <= sourceRevision ||
        preview.currentPublicationId <= 0n || preview.sourcePublicationId <= 0n || !/\P{White_Space}/u.test(preview.sourceTitle) ||
        !validBlockingReason(reason) || preview.packageComplete !== (reason === AdminArticleRollbackBlock.Ready))
      throw new ProtocolError('Invalid administrator article rollback preview');
    return { ...preview, blockingReason: reason };
  }, signal);
}

export function isValidAdminArticleRollbackReason(reason: string): boolean {
  if (reason.length < 8 || reason.length > 500 || /^\p{White_Space}|\p{White_Space}$/u.test(reason) ||
      /\p{Cc}/u.test(reason)) return false;
  const encoded = textEncoder.encode(reason);
  return encoded.length <= WireLimits.RollbackReasonBytes && decodeUtf8(encoded) === reason;
}

export async function requestAdminArticleRollbackProof(intent: AdminArticleRollbackIntent, signal: AbortSignal): Promise<string> {
  const assertion = await requestPasskeyAssertion(WireRoutes.AdminArticleRollbackStepUpBegin, signal, intentFrame(intent), true);
  return request(WireRoutes.AdminArticleRollbackStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, 'POST', assertion);
}

export function executeAdminArticleRollback(intent: AdminArticleRollbackIntent, proof: string | undefined,
  signal: AbortSignal): Promise<AdminArticleRollbackReceipt> {
  if (proof !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(proof))
    throw new ProtocolError('Invalid administrator article rollback proof');
  return request(WireRoutes.AdminArticleRollbackExecute, FrameType.AdminArticleRollbackReceipt, payload => {
    const receipt = decodeAdminArticleRollbackReceipt(payload);
    if (receipt.articleId !== intent.articleId || receipt.sourceRevision !== intent.sourceRevision ||
        receipt.revision !== intent.expectedRevision + 1n || receipt.previousPublicationId !== intent.expectedPublicationId ||
        receipt.publicationId <= 0n || receipt.publicationId === receipt.previousPublicationId || receipt.publicationNo < 2 ||
        receipt.publishedUnixMs <= 0n || receipt.publishedUnixMs > 253402300799999n ||
        receipt.rightsSnapshotId <= 0n || receipt.responsibilitySnapshotId <= 0n)
      throw new ProtocolError('Invalid administrator article rollback receipt');
    return receipt;
  }, signal, 'POST', intentFrame(intent), proof === undefined ? undefined : { [WireHeaders.MfaProof]: proof });
}

export async function rollbackAdminArticle(intent: AdminArticleRollbackIntent, signal: AbortSignal): Promise<AdminArticleRollbackReceipt> {
  const proof = await requestAdminArticleRollbackProof(intent, signal);
  return executeAdminArticleRollback(intent, proof, signal);
}

function intentFrame(intent: AdminArticleRollbackIntent): Uint8Array<ArrayBuffer> {
  if (!validArticleId(intent.articleId) || !validRevision(intent.expectedRevision) || !validRevision(intent.expectedPublicationId) ||
      !validRevision(intent.sourceRevision) || intent.sourceRevision >= intent.expectedRevision || intent.idempotencyKey === emptyUuid ||
      !isValidAdminArticleRollbackReason(intent.reason))
    throw new ProtocolError('Invalid administrator article rollback intent');
  return encodeFrame(FrameType.AdminArticleRollbackIntent, encodeAdminArticleRollbackIntent(intent));
}

function validArticleId(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= 0x7fffffff;
}

function validRevision(value: bigint): boolean {
  return value > 0n && value <= maximumRevision;
}

function validBlockingReason(value: number): value is AdminArticleRollbackBlock {
  return Object.values(AdminArticleRollbackBlock).some(reason => reason === value);
}
