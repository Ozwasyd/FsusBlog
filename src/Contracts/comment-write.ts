import { ProtocolError, encodeFrame } from './aeds.ts';
import { request, siteSessionHeader } from './client.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import {
  decodePublicCommentEligibility, decodePublicCommentSubmissionResult, encodePublicCommentSubmission, encodePublicCommentReply,
  FrameType, WireHeaders, WireRoutes,
} from './wire.generated.ts';

export async function commentEligibility(articleId: number, publication: bigint, signal: AbortSignal) {
  const route = WireRoutes.PublicCommentEligibility.replace('{articleId:int}', String(articleId));
  return request(`${route}?publication=${publication}`, FrameType.PublicCommentEligibility, (payload, headers) => {
    const value = decodePublicCommentEligibility(payload);
    if (value.articleId !== articleId || value.publication !== publication || !value.displayName.trim())
      throw new ProtocolError('AEDS comment eligibility publication mismatch');
    const reply = headers.get(WireHeaders.CommentReplyEnabled);
    if (reply !== null && reply !== '1') throw new ProtocolError('Invalid AEDS comment reply availability');
    return { ...value, canReply: reply === '1' };
  }, signal);
}

export async function submitPublicComment(articleId: number, publication: bigint, displayName: string, body: string, key: string,
  signal: AbortSignal, reply?: { parent: string; session: string }) {
  const command = { articleId, publication, displayName, body, idempotencyKey: key, explicitPublic: true };
  if (reply && (!/^[1-9][0-9]{0,18}$/.test(reply.parent) || BigInt.asIntN(64, BigInt(reply.parent)) !== BigInt(reply.parent)))
    throw new ProtocolError('Invalid AEDS comment reply target');
  const frame = reply ? encodeFrame(FrameType.PublicCommentReply, encodePublicCommentReply({ ...command, parentId: BigInt(reply.parent) }))
    : encodeFrame(FrameType.PublicCommentSubmission, encodePublicCommentSubmission(command));
  const headers = new Headers(siteSessionHeader(reply?.session));
  headers.set(WireHeaders.ClientMutationId, key);
  const clientNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  headers.set(WireHeaders.PowClientNonce, clientNonce);
  const challenge = await request(reply ? WireRoutes.PublicCommentReplyPow : WireRoutes.PublicCommentPowChallenge,
    FrameType.PowChallenge, decodePowChallenge, signal, 'POST', frame, headers);
  const nonce = await solveScopedPow(challenge, clientNonce, signal);
  signal.throwIfAborted();
  headers.delete(WireHeaders.PowClientNonce);
  headers.set(WireHeaders.PowProof, encodePowProof(challenge, nonce, clientNonce));
  return request(reply ? WireRoutes.SubmitPublicCommentReply : WireRoutes.SubmitPublicComment, FrameType.PublicCommentSubmissionResult, payload => {
    const result = decodePublicCommentSubmissionResult(payload);
    if (result.articleId !== articleId || result.commentId <= 0n ||
        result.moderationStatus < 0 || result.moderationStatus > 3)
      throw new ProtocolError('Invalid AEDS public comment confirmation');
    return result;
  }, signal, 'POST', frame, headers);
}
