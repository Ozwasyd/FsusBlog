import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import { getWithSession, postWithSession } from './internal/http-methods.ts';
import { FrameType, WireLimits, WireRoutes } from './wire.generated.ts';

export const commentReportReasons = ['spam', 'harassment', 'hate', 'privacy', 'illegal', 'misinformation', 'other'] as const;
export type CommentReportReason = typeof commentReportReasons[number];

export function commentReportingAvailable(session: string, signal: AbortSignal) {
  return getWithSession(WireRoutes.CommentReportAvailability, FrameType.EmptySuccess, decodeSuccess,
    signal, session);
}

export function reportComment(article: number, comment: string, reasonCode: CommentReportReason, detail: string, session: string,
  signal: AbortSignal) {
  if (!Number.isInteger(article) || article <= 0 || article > 2_147_483_647 ||
      !/^[1-9][0-9]{0,18}$/.test(comment) || BigInt(comment) >= (1n << 63n) || !commentReportReasons.includes(reasonCode))
    throw new ProtocolError('Invalid comment report coordinates.');
  const explanation = detail.trim();
  if (explanation.length > WireLimits.CommentReportDetailChars) throw new ProtocolError('Comment report detail is too long.');
  const payload = new TextEncoder().encode(JSON.stringify({ reasonCode, detail: explanation || null }));
  const frame = encodeFrame(FrameType.CommentReportRequest, payload);
  if (frame.length > WireLimits.CommentReportFrameBytes) throw new ProtocolError('Comment report exceeds its frame limit.');
  const path = WireRoutes.CommentReport.replace('{articleId:int}', String(article)).replace('{id:long}', comment);
  return postWithSession(path, FrameType.CommentReportResult, bytes => {
    let result: unknown;
    try { result = JSON.parse(decodeUtf8(bytes)); }
    catch { throw new ProtocolError('Invalid comment report receipt.'); }
    if (!result || typeof result !== 'object' || !('reportId' in result) || !('duplicate' in result) ||
        !('success' in result) || !('code' in result) || Object.keys(result).length !== 4 ||
        result.success !== true || typeof result.reportId !== 'number' || !Number.isSafeInteger(result.reportId) || result.reportId <= 0 ||
        typeof result.duplicate !== 'boolean' || result.code !== (result.duplicate ? 'comment_report_duplicate' : 'ok'))
      throw new ProtocolError('Invalid comment report receipt.');
    return { id: result.reportId, duplicate: result.duplicate };
  }, signal, frame, session);
}
