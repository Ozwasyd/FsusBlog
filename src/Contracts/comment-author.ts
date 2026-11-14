import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError, decodeUtf8 } from './binary.ts';
import { request, validSiteSessionId } from './client.ts';
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

const positiveId = /^[1-9][0-9]{0,18}$/;
const proofFormat = /^[a-zA-Z0-9_-]{43}$/;
const encoder = new TextEncoder();

function headers(handle: string): HeadersInit {
  if (!validSiteSessionId(handle)) throw new ProtocolError('Invalid comment author session');
  return { [WireHeaders.CurrentSession]: handle };
}

export async function commentAuthorEligibility(article: number, candidates: readonly string[], handle: string, signal: AbortSignal) {
  if (!Number.isInteger(article) || article <= 0 || article > 2_147_483_647 ||
      candidates.length === 0 || candidates.length > WireLimits.CommentAuthorBatchSize || candidates.some(id => !positiveId.test(id)))
    throw new ProtocolError('Invalid comment eligibility coordinates');
  const supplied = new Set(candidates);
  if (supplied.size !== candidates.length) throw new ProtocolError('Repeated comment eligibility coordinate');
  const writer = new PodWriter();
  writer.i32(candidates.length);
  for (const id of candidates) {
    const numeric = BigInt(id);
    if (numeric >= (1n << 63n)) throw new ProtocolError('Invalid comment identifier');
    writer.i64(numeric);
  }
  const path = WireRoutes.CommentAuthorEligibility.replace('{articleId:int}', String(article));
  const frame = encodeFrame(FrameType.CommentAuthorEligibilityRequest, writer.finish());
  return request(path, FrameType.CommentAuthorEligibility, payload => {
    const reader = new PodReader(payload);
    const count = reader.i32();
    if (count < 0 || count > supplied.size) throw new ProtocolError('Invalid comment eligibility count');
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = String(reader.i64());
      if (!supplied.delete(id)) throw new ProtocolError('Unexpected comment eligibility coordinate');
      result.push(id);
    }
    reader.finish();
    return result;
  }, signal, 'POST', frame, headers(handle));
}

function parse(payload: Uint8Array): Record<string, unknown> {
  let result: unknown;
  try { result = JSON.parse(decodeUtf8(payload)); }
  catch { throw new ProtocolError('Invalid comment author response'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ProtocolError('Invalid comment author response');
  return result as Record<string, unknown>;
}

function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export async function deleteOwnComment(id: string, handle: string, signal: AbortSignal) {
  if (!positiveId.test(id) || BigInt(id) >= (1n << 63n)) throw new ProtocolError('Invalid comment identifier');
  const path = WireRoutes.CommentAuthorChallenge.replace('{id:long}', id);
  const proof = await request(path, FrameType.CommentManagementChallengeResponse, payload => {
    const value = parse(payload);
    if (value.issued !== true || value.failureCode !== null || !version(value.currentVersion) ||
        typeof value.challenge !== 'string' || !proofFormat.test(value.challenge) ||
        typeof value.expiresAtUtc !== 'string' || !Number.isFinite(Date.parse(value.expiresAtUtc)))
      throw new ProtocolError('Invalid comment deletion challenge');
    return { challenge: value.challenge, currentVersion: value.currentVersion };
  }, signal, 'POST', encodeFrame(FrameType.CommentManagementChallengeRequest,
    encoder.encode(JSON.stringify({ purpose: 'delete', capabilitySecret: null }))), headers(handle));
  signal.throwIfAborted();
  return request(WireRoutes.CommentAuthorDelete.replace('{id:long}', id), FrameType.CommentAuthorMutationResult, payload => {
    const value = parse(payload);
    if (value.success !== true || value.code !== 'ok' || value.currentVersion !== proof.currentVersion + 1 ||
        ![0, 1, 2, 3].includes(value.moderationStatus as number) ||
        (value.editedAtUtc !== null && (typeof value.editedAtUtc !== 'string' || !Number.isFinite(Date.parse(value.editedAtUtc)))))
      throw new ProtocolError('Invalid comment deletion result');
  }, signal, 'POST', encodeFrame(FrameType.CommentAuthorStatusRequest,
    encoder.encode(JSON.stringify({ challenge: proof.challenge, capabilitySecret: '' }))), headers(handle));
}
