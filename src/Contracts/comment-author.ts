import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError, decodeUtf8 } from './binary.ts';
import { ApiError, request, validSiteSessionId } from './client.ts';
import { post } from './internal/http-methods.ts';
import { decodeCommentAuthorEditDetail, FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

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
  return post(path, FrameType.CommentAuthorEligibility, (payload, responseHeaders) => {
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
    return { ids: result, editEnabled: responseHeaders.get(WireHeaders.CommentAuthorEditEnabled) === '1' };
  }, signal, frame, headers(handle));
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

function authorPath(route: string, id: string): string {
  if (!positiveId.test(id) || BigInt(id) >= (1n << 63n)) throw new ProtocolError('Invalid comment identifier');
  return route.replace('{id:long}', id);
}

export async function requestCommentAuthorChallenge(id: string, handle: string, purpose: 'delete' | 'appeal' | 'edit', signal: AbortSignal) {
  const path = authorPath(WireRoutes.CommentAuthorChallenge, id);
  return post(path, FrameType.CommentManagementChallengeResponse, payload => {
    const value = parse(payload);
    if (value.issued !== true || value.failureCode !== null || !version(value.currentVersion) ||
        typeof value.challenge !== 'string' || !proofFormat.test(value.challenge) ||
        typeof value.expiresAtUtc !== 'string' || !Number.isFinite(Date.parse(value.expiresAtUtc)))
      throw new ProtocolError('Invalid comment author challenge');
    return { challenge: value.challenge, currentVersion: value.currentVersion };
  }, signal, encodeFrame(FrameType.CommentManagementChallengeRequest,
    encoder.encode(JSON.stringify({ purpose, capabilitySecret: null }))), headers(handle));
}

export async function deleteOwnComment(id: string, handle: string, signal: AbortSignal) {
  const proof = await requestCommentAuthorChallenge(id, handle, 'delete', signal);
  signal.throwIfAborted();
  return post(WireRoutes.CommentAuthorDelete.replace('{id:long}', id), FrameType.CommentAuthorMutationResult, payload => {
    const value = parse(payload);
    if (value.success !== true || value.code !== 'ok' || value.currentVersion !== proof.currentVersion + 1 ||
        ![0, 1, 2, 3].includes(value.moderationStatus as number) ||
        (value.editedAtUtc !== null && (typeof value.editedAtUtc !== 'string' || !Number.isFinite(Date.parse(value.editedAtUtc)))))
      throw new ProtocolError('Invalid comment deletion result');
  }, signal, encodeFrame(FrameType.CommentAuthorStatusRequest,
    encoder.encode(JSON.stringify({ challenge: proof.challenge, capabilitySecret: '' }))), headers(handle));
}

export function commentAuthorEditDetail(id: string, handle: string, signal: AbortSignal, pendingOnly = false) {
  const path = authorPath(WireRoutes.CommentAuthorEditDetail, id) + (pendingOnly ? '?state=pending' : '');
  return request(path, FrameType.CommentAuthorEditDetail, payload => {
    const { articleId, publication, currentVersion, body } = decodeCommentAuthorEditDetail(payload);
    if (articleId <= 0 || publication <= 0n || currentVersion <= 0n || currentVersion >= BigInt(Number.MAX_SAFE_INTEGER) ||
        body.length === 0 || body.length > 1000)
      throw new ProtocolError('Invalid comment edit detail');
    return { articleId, publication, currentVersion: Number(currentVersion), body };
  }, signal, 'GET', undefined, headers(handle));
}

export async function editOwnComment(id: string, expectedVersion: number, content: string, handle: string, signal: AbortSignal) {
  const path = authorPath(WireRoutes.CommentAuthorEdit, id);
  if (!version(expectedVersion) || expectedVersion === Number.MAX_SAFE_INTEGER ||
      !content.trim() || content.length > 1000 || encoder.encode(content).length > WireLimits.PublicCommentBodyBytes)
    throw new ProtocolError('Invalid comment edit request');
  const { challenge, currentVersion } = await requestCommentAuthorChallenge(id, handle, 'edit', signal);
  signal.throwIfAborted();
  if (currentVersion !== expectedVersion) throw new ApiError('The comment changed.', 409);
  const frame = encodeFrame(FrameType.CommentAuthorEditRequest, encoder.encode(JSON.stringify({ expectedVersion, content, challenge })));
  if (frame.length > WireLimits.CommentAuthorEditFrameBytes) throw new ProtocolError('Comment edit request exceeds its byte limit');

  return post(path, FrameType.CommentAuthorMutationResult, payload => {
    const value = parse(payload);
    if (value.success !== true || value.code !== 'ok' || value.currentVersion !== expectedVersion + 1 ||
        value.moderationStatus !== 0 || typeof value.editedAtUtc !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/.test(value.editedAtUtc) ||
        !Number.isFinite(Date.parse(value.editedAtUtc)))
      throw new ProtocolError('Invalid comment edit result');
    return { currentVersion: value.currentVersion, editedAtUtc: value.editedAtUtc };
  }, signal, frame, headers(handle));
}
