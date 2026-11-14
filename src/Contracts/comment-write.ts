import { ProtocolError, encodeFrame } from './aeds.ts';
import { request } from './client.ts';
import {
  decodePublicCommentEligibility, decodePublicCommentSubmissionResult, encodePublicCommentSubmission,
  FrameType, WireHeaders, WireRoutes,
} from './wire.generated.ts';

export async function commentEligibility(articleId: number, publication: bigint, signal: AbortSignal) {
  const route = WireRoutes.PublicCommentEligibility.replace('{articleId:int}', String(articleId));
  return request(`${route}?publication=${publication}`, FrameType.PublicCommentEligibility, payload => {
    const value = decodePublicCommentEligibility(payload);
    if (value.articleId !== articleId || value.publication !== publication || !value.displayName.trim())
      throw new ProtocolError('AEDS comment eligibility publication mismatch');
    return value;
  }, signal);
}

export function submitPublicComment(articleId: number, publication: bigint, displayName: string, body: string, key: string, signal: AbortSignal) {
  const payload = encodePublicCommentSubmission({ articleId, publication, displayName, body, idempotencyKey: key, explicitPublic: true });
  const frame = encodeFrame(FrameType.PublicCommentSubmission, payload);
  return request(WireRoutes.SubmitPublicComment, FrameType.PublicCommentSubmissionResult, payload => {
    const result = decodePublicCommentSubmissionResult(payload);
    if (result.articleId !== articleId || result.commentId <= 0n ||
        result.moderationStatus < 0 || result.moderationStatus > 3)
      throw new ProtocolError('Invalid AEDS public comment confirmation');
    return result;
  }, signal, 'POST', frame, { [WireHeaders.ClientMutationId]: key });
}
