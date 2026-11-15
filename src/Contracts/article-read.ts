import { encodeFrame, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { FrameType, WireLayouts, WireRoutes } from './wire.generated.ts';

const dwellSize = 4;
const ticketSize = WireLayouts.ArticleReadTicketSize;
const emptyChallengeRequest = encodeFrame(FrameType.ArticleReadChallengeRequest, new Uint8Array());

export function requestArticleReadChallenge(id: number, publication: bigint, signal: AbortSignal):
  Promise<{ minDwellMs: number; ticket: Uint8Array }> {
  return request(articleReadPath(WireRoutes.ArticleReadChallenge, id, publication), FrameType.ArticleReadChallenge, payload => {
    if (payload.length !== dwellSize + ticketSize) throw invalid();
    const minDwellMs = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(0, true);
    if (minDwellMs !== WireLayouts.ArticleReadDwellMs) throw invalid();
    return { minDwellMs, ticket: payload.slice(dwellSize) };
  }, signal, 'POST', emptyChallengeRequest, undefined, 'omit');
}

export function submitArticleReadProof(id: number, publication: bigint, ticket: Uint8Array, dwellMs: number,
  signal: AbortSignal): Promise<boolean> {
  if (ticket.length !== ticketSize || !Number.isInteger(dwellMs) || dwellMs < 0 || dwellMs > 0x7fffffff) throw invalid();
  const payload = new Uint8Array(dwellSize + ticketSize);
  new DataView(payload.buffer).setInt32(0, dwellMs, true);
  payload.set(ticket, dwellSize);
  const frame = encodeFrame(FrameType.ArticleReadSubmit, payload);
  return request(articleReadPath(WireRoutes.ArticleReadSubmit, id, publication), FrameType.ArticleReadReceipt, receipt => {
    if (receipt.length !== 1 || (receipt[0] !== 0 && receipt[0] !== 1)) throw invalid();
    return receipt[0] === 1;
  }, signal, 'POST', frame, undefined, 'omit');
}

function articleReadPath(route: string, id: number, publication: bigint): string {
  if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff || publication <= 0n || BigInt.asIntN(64, publication) !== publication)
    throw invalid();
  return route.replace('{id:int}', String(id)).replace('{publication:long}', String(publication));
}

const invalid = () => new ProtocolError('Invalid article read proof data.');
