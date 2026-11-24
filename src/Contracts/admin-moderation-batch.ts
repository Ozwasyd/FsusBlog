import { ApiError, encodePod, ProtocolError } from './aeds.ts';
import type { AdminCommentCursor } from './admin-identity.ts';
import { validModerationReason } from './admin-moderation.ts';
import { adminProofHeaders, proveAdminStepUp } from './admin-step-up.ts';
import { decodePod, PodWriter } from './binary.ts';
import { post } from './internal/http.ts';
import { FrameType, WireLimits, WireRoutes, type AdminModerationClaim } from './wire.generated.ts';

export type AdminModerationBatchItem = Readonly<Omit<AdminModerationClaim, 'expiresAt'> & { expectedStatus: 0 }>;
export type AdminModerationBatchDecision = Readonly<{
  decision: 1 | 2;
  reason: string;
  rows: readonly AdminModerationBatchItem[];
}>;
export type AdminModerationBatchReceipt = Readonly<{ batchId: bigint; count: number }>;

const maxDate = 8_640_000_000_000_000n;
const conflictPrefix = 'moderation_batch_conflicts:';

export function claimModerationBatch(items: readonly AdminCommentCursor[], signal: AbortSignal): Promise<readonly AdminModerationClaim[]> {
  // Callers can change their visible selection while a request is in flight.
  // Compare the response to a value snapshot of what this request actually sent.
  const targets = items.map(({ articleId, commentId }) => ({ articleId, commentId }));
  const frame = encodePod(FrameType.AdminModerationBatchTargets, writer => writeTargets(writer, targets));
  return post(WireRoutes.AdminModerationBatchClaim, FrameType.AdminModerationBatchClaims,
    payload => decodeClaims(payload, targets), signal, frame);
}

export async function proveAndDecideModerationBatch(decision: AdminModerationBatchDecision, signal: AbortSignal): Promise<AdminModerationBatchReceipt> {
  const count = decision.rows.length;
  const frame = encodeModerationBatchDecision(decision);
  const proof = await proveAdminStepUp({
    begin: WireRoutes.AdminModerationBatchStepUpBegin,
    complete: WireRoutes.AdminModerationBatchStepUpComplete,
  }, frame, signal);
  return post(WireRoutes.AdminModerationBatchDecision, FrameType.AdminModerationBatchReceipt,
    payload => decodeModerationBatchReceipt(payload, count), signal, frame, adminProofHeaders(proof));
}

export function encodeModerationBatchDecision(value: AdminModerationBatchDecision): Uint8Array<ArrayBuffer> {
  if ((value.decision !== 1 && value.decision !== 2) || value.reason.trim() !== value.reason || !validModerationReason(value.reason))
    throw invalid();
  checkTargets(value.rows);
  return encodePod(FrameType.AdminModerationBatchDecision, writer => {
    writer.i32(value.decision).text(value.reason, WireLimits.AdminModerationReasonBytes).i32(value.rows.length);
    for (const row of value.rows) {
      checkClaim(row);
      if (row.expectedStatus !== 0) throw invalid();
      writeTarget(writer, row).i64(row.commentVersion).text(row.claimToken, WireLimits.AdminModerationClaimTokenBytes)
        .i64(row.claimGeneration).i64(row.claimVersion).i32(row.expectedStatus);
    }
  });
}

export function decodeModerationBatchReceipt(payload: Uint8Array, expectedCount: number): AdminModerationBatchReceipt {
  return decodePod(payload, reader => {
    const batchId = reader.i64(), count = reader.i32();
    if (batchId <= 0n || !validCount(count) || count !== expectedCount) throw invalid();
    return { batchId, count };
  });
}

export function readModerationBatchConflicts(failure: unknown, items: readonly AdminCommentCursor[]): readonly AdminCommentCursor[] | null {
  if (!(failure instanceof ApiError) || failure.status !== 409 || !validCount(items.length)) return null;
  if (!failure.details.startsWith(conflictPrefix)) return null;
  const encoded = failure.details.slice(conflictPrefix.length);
  if (encoded.length !== 5 || !/^[0-9a-f]+$/.test(encoded)) return null;
  const mask = Number.parseInt(encoded, 16);
  if (mask === 0 || mask >>> items.length !== 0) return null;
  return items.filter((_, index) => (mask & (1 << index)) !== 0);
}

function decodeClaims(payload: Uint8Array, targets: readonly AdminCommentCursor[]): AdminModerationClaim[] {
  return decodePod(payload, reader => {
    const count = reader.i32();
    if (!validCount(count) || count !== targets.length) throw invalid();
    return targets.map(target => {
      const claim = {
        articleId: reader.i32(), commentId: reader.i64(), commentVersion: reader.i64(),
        claimToken: reader.text(WireLimits.AdminModerationClaimTokenBytes),
        claimGeneration: reader.i64(), claimVersion: reader.i64(), expiresAt: reader.i64(),
      };
      if (claim.articleId !== target.articleId || claim.commentId !== target.commentId || claim.expiresAt <= 0n || claim.expiresAt > maxDate)
        throw invalid();
      checkClaim(claim);
      return claim;
    });
  });
}

function writeTargets(writer: PodWriter, targets: readonly AdminCommentCursor[]): void {
  checkTargets(targets);
  writer.i32(targets.length);
  for (const target of targets) writeTarget(writer, target);
}

const writeTarget = (writer: PodWriter, target: AdminCommentCursor): PodWriter => writer.i32(target.articleId).i64(target.commentId);

function checkTargets(targets: readonly AdminCommentCursor[]): void {
  if (!validCount(targets.length)) throw invalid();
  const seen = new Set<string>();
  for (const { articleId, commentId } of targets) {
    const coordinate = `${articleId}/${commentId}`;
    if (!Number.isInteger(articleId) || articleId < 1 || articleId > 0x7fffffff || commentId <= 0n ||
        BigInt.asIntN(64, commentId) !== commentId || seen.has(coordinate)) throw invalid();
    seen.add(coordinate);
  }
}

function checkClaim(claim: Pick<AdminModerationClaim, 'commentVersion' | 'claimGeneration' | 'claimVersion' | 'claimToken'>): void {
  if (claim.commentVersion <= 0n || claim.claimGeneration <= 0n || claim.claimVersion <= 0n ||
      claim.claimToken.length !== WireLimits.AdminModerationClaimTokenBytes || !/^[A-Za-z0-9_-]+$/.test(claim.claimToken)) throw invalid();
}

function validCount(count: number): boolean {
  return count >= WireLimits.AdminModerationBatchMinimum && count <= WireLimits.AdminModerationBatchCount;
}

function invalid(): ProtocolError {
  return new ProtocolError('Invalid administrator moderation batch.');
}
