import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import type { AdminCommentCursor } from './admin-identity.ts';
import { adminProofHeaders } from './admin-step-up.ts';
import { request } from './client.ts';
import {
  decodeAdminModerationClaim,
  encodeAdminModerationClaim,
  encodeAdminModerationClaimRequest,
  encodeAdminModerationDecision,
  FrameType,
  WireLimits,
  WireRoutes,
  type AdminModerationClaim,
  type AdminModerationDecision,
} from './wire.generated.ts';

const encoder = new TextEncoder();
const maxDate = 8_640_000_000_000_000n;

export type { AdminModerationClaim, AdminModerationDecision };

export function validModerationReason(reason: string): boolean {
  return reason.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(reason) &&
    encoder.encode(reason).length <= WireLimits.AdminModerationReasonBytes;
}

export function claimComment(target: AdminCommentCursor, signal: AbortSignal): Promise<AdminModerationClaim> {
  const body = encodeFrame(FrameType.AdminModerationClaimRequest, encodeAdminModerationClaimRequest(target));
  return request(WireRoutes.AdminModerationClaim, FrameType.AdminModerationClaim,
    payload => readClaim(payload, target), signal, 'POST', body);
}

export function renewCommentClaim(claim: AdminModerationClaim, signal: AbortSignal): Promise<AdminModerationClaim> {
  const body = encodeFrame(FrameType.AdminModerationClaim, encodeAdminModerationClaim(claim));
  return request(WireRoutes.AdminModerationRenew, FrameType.AdminModerationClaim,
    payload => readClaim(payload, claim), signal, 'POST', body);
}

export function releaseCommentClaim(claim: AdminModerationClaim, signal: AbortSignal): Promise<void> {
  const body = encodeFrame(FrameType.AdminModerationClaim, encodeAdminModerationClaim(claim));
  return request(WireRoutes.AdminModerationRelease, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', body);
}

export function decideComment(decision: AdminModerationDecision, proof: string, signal: AbortSignal): Promise<void> {
  const body = encodeFrame(FrameType.AdminModerationDecision, encodeAdminModerationDecision(decision));
  return request(WireRoutes.AdminModerationDecision, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', body,
    adminProofHeaders(proof));
}

function readClaim(payload: Uint8Array, target: AdminCommentCursor): AdminModerationClaim {
  const claim = decodeAdminModerationClaim(payload);
  if (claim.articleId !== target.articleId || claim.commentId !== target.commentId ||
      claim.commentVersion <= 0n || claim.claimGeneration <= 0n || claim.claimVersion <= 0n ||
      claim.expiresAt <= 0n || claim.expiresAt > maxDate || !/^[A-Za-z0-9_-]{43}$/.test(claim.claimToken))
    throw new ProtocolError('Invalid administrator moderation claim.');
  return claim;
}
