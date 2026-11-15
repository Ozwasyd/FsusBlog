import { ProtocolError, decodeUtf8 } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export type ModerationTimelineEvent = {
  eventType: string;
  nextStatus: number;
  actorType: string;
  reasonCode: string | null;
  occurredAtUtc: string;
};

export type ModerationTimeline = {
  currentStatus: number;
  deleted: boolean;
  consistent: boolean;
  events: ModerationTimelineEvent[];
};

type CommentRevision = { version: number; content: string; contentSha256: string; operation: string; createdAtUtc: string };
export type CommentRevisionPage = { rows: CommentRevision[]; next: number | null };

export function validModerationCoordinates(article: string, comment: string): boolean {
  return /^[1-9]\d{0,9}$/.test(article) && Number(article) <= 2_147_483_647 &&
    /^[1-9]\d{0,18}$/.test(comment) && BigInt(comment) <= 9_223_372_036_854_775_807n;
}

export function readModerationTimeline(article: string, comment: string, signal: AbortSignal) {
  const invalid = () => new ProtocolError('Invalid comment moderation timeline.');
  if (!validModerationCoordinates(article, comment)) throw invalid();
  const path = WireRoutes.AdminCommentTimeline.replace('{id:long}', comment);
  return request(`${path}?articleId=${article}`, FrameType.CommentModerationTimeline, payload => {
    const result = JSON.parse(decodeUtf8(payload)) as (ModerationTimeline & { articleId: number }) | null;
    if (!result || result.articleId !== Number(article) || typeof result.deleted !== 'boolean' ||
        typeof result.consistent !== 'boolean' || !isStatus(result.currentStatus) ||
        !Array.isArray(result.events) || result.events.length > 128 || result.events.some(event =>
          !event || typeof event.eventType !== 'string' || typeof event.actorType !== 'string' ||
          !isStatus(event.nextStatus) || event.reasonCode !== null && typeof event.reasonCode !== 'string' ||
          typeof event.occurredAtUtc !== 'string' || !Number.isFinite(Date.parse(event.occurredAtUtc)))) throw invalid();
    return result;
  }, signal);
}

export function readCommentRevisions(article: string, comment: string, before: number | null, signal: AbortSignal) {
  const invalid = () => new ProtocolError('Invalid comment revision history.');
  if (!validModerationCoordinates(article, comment) || before !== null && (!Number.isSafeInteger(before) || before <= 1)) throw invalid();
  const path = WireRoutes.AdminCommentRevisions.replace('{id:long}', comment);
  return request(`${path}?articleId=${article}${before === null ? '' : `&before=${before}`}`, FrameType.CommentRevisionList, (payload, headers) => {
    const rows = JSON.parse(decodeUtf8(payload)) as CommentRevision[];
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64 || rows.some((row, index) =>
      !row || !Number.isSafeInteger(row.version) || row.version < 1 || index > 0 && rows[index - 1].version !== row.version + 1 ||
      typeof row.content !== 'string' || typeof row.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentSha256) ||
      !['created', 'edited', 'deleted'].includes(row.operation) || typeof row.createdAtUtc !== 'string' ||
      !Number.isFinite(Date.parse(row.createdAtUtc))) || before !== null && rows[0].version !== before - 1) throw invalid();
    const last = rows[rows.length - 1].version;
    const next = last > 1 ? last : null;
    if (headers.get('Link') !== (next === null ? null : `<${path}?before=${next}&articleId=${article}>; rel="next"`) ||
        next !== null && rows.length !== 64) throw invalid();
    return { rows, next } satisfies CommentRevisionPage;
  }, signal);
}

function isStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 0 && status <= 3;
}
