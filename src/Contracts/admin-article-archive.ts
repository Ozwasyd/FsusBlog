import { encodeFrame, ProtocolError } from './aeds.ts';
import { isValidAdminArticleRollbackReason, proofHeaders, readRollbackAvailability, requestRollbackProof } from './admin-article-rollback.ts';
import { PodReader } from './binary.ts';
import { request } from './client.ts';
import {
  decodeAdminArticleArchivePreview, decodeAdminArticleArchiveReceipt, encodeAdminArticleArchiveIntent,
  FrameType, WireLimits, WireRoutes, type AdminArticleArchiveIntent, type AdminArticleArchivePreview, type AdminArticleArchiveReceipt,
} from './wire.generated.ts';

export type { AdminArticleArchiveIntent, AdminArticleArchivePreview, AdminArticleArchiveReceipt } from './wire.generated.ts';
export const AdminArchiveTarget = { Published: 2, Archived: 3 } as const;
export type AdminArchivedArticle = Readonly<{
  articleId: number;
  revision: bigint;
  privateReleaseId: bigint;
  publicationNo: number;
  archivedUnixMs: bigint;
  title: string;
}>;
export type AdminArchivedArticles = Readonly<{
  nextId: number | null;
  items: readonly AdminArchivedArticle[];
}>;

export function readAdminArticleArchiveAvailability(signal: AbortSignal): Promise<boolean> {
  return readRollbackAvailability(WireRoutes.AdminArticleArchiveAvailability, signal);
}

export function readAdminArticleArchivePage(before: number | undefined, signal: AbortSignal): Promise<AdminArchivedArticles> {
  if (before !== undefined && !positiveArticleId(before)) throw new ProtocolError('Invalid archive position');
  const path = WireRoutes.AdminArticleArchivePage + (before === undefined ? '' : `?${new URLSearchParams({ before: String(before) })}`);
  return request(path, FrameType.AdminArticleArchivePage, payload => decodeArchivePage(payload, before), signal);
}

export function readAdminArticleArchivePreview(archive: AdminArchivedArticle, signal: AbortSignal): Promise<AdminArticleArchivePreview> {
  const { articleId, revision, privateReleaseId } = archive;
  if (!positiveArticleId(articleId) || revision <= 0n || privateReleaseId <= 0n)
    throw new ProtocolError('Invalid administrator article archive coordinates');
  const query = new URLSearchParams({ articleId: String(articleId), revision: String(revision), privateReleaseId: String(privateReleaseId) });
  return request(`${WireRoutes.AdminArticleArchivePreview}?${query}`, FrameType.AdminArticleArchivePreview, payload => {
    const result = decodeAdminArticleArchivePreview(payload);
    if (result.articleId !== articleId || result.revision !== revision || result.privateReleaseId !== privateReleaseId ||
        !/\P{White_Space}/u.test(result.title))
      throw new ProtocolError('Invalid administrator article archive preview');
    return result;
  }, signal);
}

export async function requestAdminArticleArchiveProof(intent: AdminArticleArchiveIntent, signal: AbortSignal): Promise<string> {
  return requestRollbackProof(WireRoutes.AdminArticleArchiveStepUpBegin, WireRoutes.AdminArticleArchiveStepUpComplete,
    intentFrame(intent), signal);
}

export function executeAdminArticleArchive(intent: AdminArticleArchiveIntent, proof: string | undefined,
  signal: AbortSignal): Promise<AdminArticleArchiveReceipt> {
  return request(WireRoutes.AdminArticleArchiveExecute, FrameType.AdminArticleArchiveReceipt, payload => {
    const result = decodeAdminArticleArchiveReceipt(payload);
    if (result.articleId !== intent.articleId || result.revision !== intent.expectedRevision + 1n ||
        result.sourceRevision !== intent.sourceRevision || result.previousReleaseId !== intent.expectedReleaseId ||
        result.targetStatus !== intent.targetStatus || result.releaseId <= 0n || result.releaseId === result.previousReleaseId ||
        result.publicationNo < 2 || !validTimestamp(result.transitionedUnixMs) ||
        result.rightsSnapshotId <= 0n || result.responsibilitySnapshotId <= 0n) {
      throw new ProtocolError('Invalid administrator article archive receipt');
    }
    return result;
  }, signal, 'POST', intentFrame(intent), proofHeaders(proof));
}

function decodeArchivePage(payload: Uint8Array, before: number | undefined): AdminArchivedArticles {
  const reader = new PodReader(payload);
  const nextId = reader.i32(), count = reader.i32();
  if (count < 0 || count > WireLimits.AdminArticleArchivePageSize ||
      nextId < 0 || nextId !== 0 && count !== WireLimits.AdminArticleArchivePageSize)
    throw new ProtocolError('Invalid administrator article archive page');
  const items: AdminArchivedArticle[] = [];
  let previous = before;
  for (let index = 0; index < count; index++) {
    const item = {
      articleId: reader.i32(), revision: reader.i64(), privateReleaseId: reader.i64(),
      publicationNo: reader.i32(), archivedUnixMs: reader.i64(), title: reader.text(WireLimits.TitleBytes),
    };
    if (!positiveArticleId(item.articleId) || previous !== undefined && item.articleId >= previous ||
        item.revision <= 0n || item.privateReleaseId <= 0n || item.publicationNo < 2 ||
        !validTimestamp(item.archivedUnixMs) || !/\P{White_Space}/u.test(item.title))
      throw new ProtocolError('Invalid archived article');
    items.push(item);
    previous = item.articleId;
  }
  reader.finish();
  if (nextId !== 0 && nextId !== previous) throw new ProtocolError('Invalid next archive position');
  return { nextId: nextId || null, items };
}

function intentFrame(intent: AdminArticleArchiveIntent): Uint8Array<ArrayBuffer> {
  const validSource = intent.targetStatus === AdminArchiveTarget.Archived
    ? intent.sourceRevision < intent.expectedRevision
    : intent.targetStatus === AdminArchiveTarget.Published && intent.sourceRevision === intent.expectedRevision;
  if (!positiveArticleId(intent.articleId) || intent.expectedRevision <= 0n || intent.expectedReleaseId <= 0n ||
      intent.sourceRevision <= 0n || !validSource || intent.idempotencyKey === '00000000-0000-0000-0000-000000000000' ||
      !isValidAdminArticleRollbackReason(intent.reason))
    throw new ProtocolError('Invalid administrator article archive intent');
  return encodeFrame(FrameType.AdminArticleArchiveIntent, encodeAdminArticleArchiveIntent(intent));
}

function positiveArticleId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validTimestamp(value: bigint): boolean {
  return value > 0n && value <= 253402300799999n;
}
