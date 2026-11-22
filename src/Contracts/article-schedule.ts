import { encodeFrame, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { post } from './internal/http-methods.ts';
import {
  decodeArticleSchedule, encodeArticleScheduleCommand, FrameType, WireHeaders, WireRoutes,
  type ArticleSchedule, type ArticleScheduleCommand,
} from './wire.generated.ts';

export type { ArticleSchedule } from './wire.generated.ts';

export function readArticleSchedule(id: number, revision: bigint, signal?: AbortSignal): Promise<ArticleSchedule> {
  const path = WireRoutes.DraftSchedule.replace('{id:int}', String(id));
  return request(`${path}?revision=${revision}`, FrameType.ArticleSchedule, revisionResponse(id, revision), signal);
}

export function setArticleSchedule(input: ArticleScheduleCommand, signal?: AbortSignal): Promise<ArticleSchedule> {
  return post(WireRoutes.DraftScheduleCommand, FrameType.ArticleSchedule,
    revisionResponse(input.id, input.expectedRevision + 1n), signal,
    encodeFrame(FrameType.ArticleScheduleCommand, encodeArticleScheduleCommand(input)),
    { [WireHeaders.ClientMutationId]: input.idempotencyKey });
}

function revisionResponse(id: number, revision: bigint) {
  return (data: Uint8Array): ArticleSchedule => {
    const value = decodeArticleSchedule(data);
    if (value.id !== id || value.revision !== revision || value.revision <= 0n ||
        value.dueUnixMs < 0n || value.dueUnixMs > 253402300799999n ||
        value.publishedRevision < 0n || value.publishedRevision > revision)
      throw new ProtocolError('Invalid article schedule receipt');
    return value;
  };
}
