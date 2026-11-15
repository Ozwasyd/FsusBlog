import { ApiError, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import {
  decodeAdminArticleDraftRollbackReceipt, encodeAdminArticleDraftRollbackIntent,
  decodeAdminArticleRollbackPreview, decodeAdminArticleRollbackReceipt, encodeAdminArticleRollbackIntent,
  FrameType, WireHeaders, WireLimits, WireRoutes,
  type AdminArticleDraftRollbackIntent, type AdminArticleDraftRollbackReceipt,
  type AdminArticleRollbackIntent, type AdminArticleRollbackPreview as WireRollbackPreview, type AdminArticleRollbackReceipt,
} from './wire.generated.ts';

export type {
  AdminArticleDraftRollbackIntent, AdminArticleDraftRollbackReceipt, AdminArticleRollbackIntent, AdminArticleRollbackReceipt,
} from './wire.generated.ts';

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

export function readAdminArticleRollbackAvailability(signal: AbortSignal): Promise<boolean> {
  return readRollbackAvailability(WireRoutes.AdminArticleRollbackAvailability, signal);
}

export function readAdminArticleDraftRollbackAvailability(signal: AbortSignal): Promise<boolean> {
  return readRollbackAvailability(WireRoutes.AdminArticleDraftRollbackAvailability, signal);
}

export async function readRollbackAvailability(path: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(path, {
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
  return requestRollbackProof(WireRoutes.AdminArticleRollbackStepUpBegin, WireRoutes.AdminArticleRollbackStepUpComplete,
    intentFrame(intent), signal);
}

export async function requestAdminArticleDraftRollbackProof(intent: AdminArticleDraftRollbackIntent, signal: AbortSignal): Promise<string> {
  return requestRollbackProof(WireRoutes.AdminArticleDraftRollbackStepUpBegin, WireRoutes.AdminArticleDraftRollbackStepUpComplete,
    draftIntentFrame(intent), signal);
}

export async function requestRollbackProof(begin: string, complete: string, frame: Uint8Array<ArrayBuffer>,
  signal: AbortSignal, headers?: HeadersInit): Promise<string> {
  const assertion = await requestPasskeyAssertion(begin, signal, frame, true, false, headers);
  return request(complete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, 'POST', assertion);
}

export function executeAdminArticleRollback(intent: AdminArticleRollbackIntent, proof: string | undefined,
  signal: AbortSignal): Promise<AdminArticleRollbackReceipt> {
  const headers = proofHeaders(proof);
  return request(WireRoutes.AdminArticleRollbackExecute, FrameType.AdminArticleRollbackReceipt, payload => {
    const receipt = decodeAdminArticleRollbackReceipt(payload);
    if (!matchesReceipt(receipt, intent, receipt.publicationId, receipt.publishedUnixMs))
      throw new ProtocolError('Invalid administrator article rollback receipt');
    return receipt;
  }, signal, 'POST', intentFrame(intent), headers);
}

export function executeAdminArticleDraftRollback(intent: AdminArticleDraftRollbackIntent, proof: string | undefined,
  signal: AbortSignal): Promise<AdminArticleDraftRollbackReceipt> {
  const headers = proofHeaders(proof);
  return request(WireRoutes.AdminArticleDraftRollbackExecute, FrameType.AdminArticleDraftRollbackReceipt, payload => {
    const receipt = decodeAdminArticleDraftRollbackReceipt(payload);
    if (receipt.targetStatus !== 0 || !matchesReceipt(receipt, intent, receipt.privateReleaseId, receipt.transitionedUnixMs))
      throw new ProtocolError('Invalid administrator article draft rollback receipt');
    return receipt;
  }, signal, 'POST', draftIntentFrame(intent), headers);
}

export async function rollbackAdminArticle(intent: AdminArticleRollbackIntent, signal: AbortSignal): Promise<AdminArticleRollbackReceipt> {
  const proof = await requestAdminArticleRollbackProof(intent, signal);
  return executeAdminArticleRollback(intent, proof, signal);
}

function intentFrame(intent: AdminArticleRollbackIntent): Uint8Array<ArrayBuffer> {
  validateIntent(intent);
  return encodeFrame(FrameType.AdminArticleRollbackIntent, encodeAdminArticleRollbackIntent(intent));
}

function draftIntentFrame(intent: AdminArticleDraftRollbackIntent): Uint8Array<ArrayBuffer> {
  validateIntent(intent);
  if (intent.targetStatus !== 0) throw new ProtocolError('Invalid administrator article draft rollback target');
  return encodeFrame(FrameType.AdminArticleDraftRollbackIntent, encodeAdminArticleDraftRollbackIntent(intent));
}

function validateIntent(intent: AdminArticleRollbackIntent): void {
  if (!validArticleId(intent.articleId) || !validRevision(intent.expectedRevision) || !validRevision(intent.expectedPublicationId) ||
      !validRevision(intent.sourceRevision) || intent.sourceRevision >= intent.expectedRevision || intent.idempotencyKey === emptyUuid ||
      !isValidAdminArticleRollbackReason(intent.reason))
    throw new ProtocolError('Invalid administrator article rollback intent');
}

export function proofHeaders(proof: string | undefined): Record<string, string> | undefined {
  if (proof === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof))
    throw new ProtocolError('Invalid administrator article rollback proof');
  return { [WireHeaders.MfaProof]: proof };
}

function matchesReceipt(receipt: AdminArticleRollbackReceipt | AdminArticleDraftRollbackReceipt, intent: AdminArticleRollbackIntent,
  release: bigint, when: bigint): boolean {
  return receipt.articleId === intent.articleId && receipt.sourceRevision === intent.sourceRevision &&
    receipt.revision === intent.expectedRevision + 1n && receipt.previousPublicationId === intent.expectedPublicationId &&
    release > 0n && release !== receipt.previousPublicationId && receipt.publicationNo >= 2 &&
    when > 0n && when <= 253402300799999n && receipt.rightsSnapshotId > 0n && receipt.responsibilitySnapshotId > 0n;
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
