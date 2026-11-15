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

function isStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 0 && status <= 3;
}
