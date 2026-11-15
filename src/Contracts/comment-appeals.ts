import { encodeFrame } from './aeds.ts';
import { PodReader, ProtocolError, decodeUtf8 } from './binary.ts';
import { request, siteSessionHeader } from './client.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { readMfaProof } from './mfa.ts';
import { requestCommentAuthorChallenge } from './comment-author.ts';
import { FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export type AuthorAppeal = { article: number; comment: string; body: string; status: number; appeal: number; decisionReason: string };
export type PendingAppeal = { id: string; article: number; comment: string; body: string; reason: string };
const invalid = () => new ProtocolError('Invalid comment appeal contract');

export function appealReason(value: string) {
  return value.trim().length >= 10 && value.trim().length <= 1000 && !value.includes('\0');
}

export function readAuthorAppeals(before: string | null, session: string, signal: AbortSignal) {
  return request(appealPage(WireRoutes.CommentAuthorAppeals, before), FrameType.CommentAuthorAppeals, (payload, headers) => {
    const result = page(payload, reader => {
      const article = reader.i32();
      const comment = id(reader.i64());
      const body = reader.text(4096);
      const status = reader.i32();
      const appeal = reader.i32();
      const decisionReason = reader.text(4000);
      if (article <= 0 || status < 0 || status > 3 || appeal < 0 || appeal > 5 ||
          (appeal === 3 || appeal === 4) !== Boolean(decisionReason)) throw invalid();
      return { article, comment, body, status, appeal, decisionReason } as AuthorAppeal;
    });
    return { ...result, editEnabled: headers.get(WireHeaders.CommentAuthorEditEnabled) === '1' };
  }, signal, 'GET', undefined, siteSessionHeader(session));
}

export async function submitAuthorAppeal(comment: string, reason: string, session: string, signal: AbortSignal) {
  if (!appealReason(reason)) throw invalid();
  const { challenge } = await requestCommentAuthorChallenge(comment, session, 'appeal', signal);
  signal.throwIfAborted();
  const frame = encodeFrame(FrameType.CommentAuthorAppealRequest,
    new TextEncoder().encode(JSON.stringify({ reason: reason.trim(), challenge })));
  return request(WireRoutes.CommentAuthorAppeal.replace('{id:long}', comment), FrameType.CommentAuthorMutationResult, payload => {
    const value = json(payload);
    if (value.success !== true || value.code !== 'ok' || value.moderationStatus !== 0 ||
        value.currentVersion !== 0 || value.editedAtUtc !== null) throw invalid();
  }, signal, 'POST', frame, siteSessionHeader(session));
}

export function readAdminAppeals(before: string | null, signal: AbortSignal) {
  return request(appealPage(WireRoutes.AdminCommentAppeals, before), FrameType.AdminCommentAppeals, payload =>
    page(payload, reader => {
      const appeal = id(reader.i64());
      const article = reader.i32();
      const comment = id(reader.i64());
      const body = reader.text(4096);
      const reason = reader.text(4000);
      if (article <= 0 || !body || !appealReason(reason)) throw invalid();
      return { id: appeal, article, comment, body, reason } as PendingAppeal;
    }), signal);
}

export async function decideAdminAppeal(appeal: string, decision: 'granted' | 'denied', reason: string, signal: AbortSignal) {
  if (!/^[1-9]\d{0,18}$/.test(appeal) || id(BigInt(appeal)) !== appeal || !appealReason(reason)) throw invalid();
  const frame = encodeFrame(FrameType.CommentAppealDecisionRequest,
    new TextEncoder().encode(JSON.stringify({ decision, reason: reason.trim() })));
  const assertion = await requestPasskeyAssertion(WireRoutes.AdminAppealStepUpBegin.replace('{id:long}', appeal), signal, frame, true);
  const proof = await request(WireRoutes.AdminAppealStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, 'POST', assertion);
  signal.throwIfAborted();
  return request(WireRoutes.AdminAppealDecision.replace('{id:long}', appeal), FrameType.CommentAppealDecisionResult, payload => {
    const value = json(payload);
    if (value.success !== true || value.code !== 'ok' || !Number.isSafeInteger(value.appealId) || String(value.appealId) !== appeal)
      throw invalid();
  }, signal, 'POST', frame, { [WireHeaders.MfaProof]: proof });
}

function appealPage(path: string, before: string | null) {
  if (!before) return path;
  if (!/^[1-9]\d{0,18}$/.test(before) || id(BigInt(before)) !== before) throw invalid();
  return `${path}?before=${before}`;
}

function id(value: bigint) {
  if (value <= 0n || BigInt.asIntN(64, value) !== value) throw invalid();
  return String(value);
}

function page<T>(payload: Uint8Array, row: (reader: PodReader) => T) {
  const reader = new PodReader(payload);
  const more = reader.bool();
  const count = reader.i32();
  if (count < 0 || count > 24 || more && count !== 24) throw invalid();
  const rows = Array.from({ length: count }, () => row(reader));
  reader.finish();
  return { rows, more };
}

function json(payload: Uint8Array): Record<string, unknown> {
  const object: unknown = JSON.parse(decodeUtf8(payload));
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw invalid();
  return object as Record<string, unknown>;
}
