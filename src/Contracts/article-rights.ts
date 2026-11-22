import { encodeFrame, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { post } from './internal/http-methods.ts';
import {
  decodeArticleRightsPolicy, encodeArticleRightsCommand, FrameType, WireHeaders, WireRoutes,
  type ArticleRightsCommand, type ArticleRightsPolicy,
} from './wire.generated.ts';

export type RightsEdit = Omit<ArticleRightsCommand, 'id' | 'expectedRevision' | 'idempotencyKey'>;

export function draftRights(id: number, revision: bigint, signal?: AbortSignal): Promise<ArticleRightsPolicy> {
  const path = WireRoutes.DraftRights.replace('{id:int}', String(id));
  return request(`${path}?revision=${revision}`, FrameType.ArticleRightsPolicy, receipt(id, revision), signal);
}

export function setDraftRights(input: ArticleRightsCommand, signal?: AbortSignal): Promise<ArticleRightsPolicy> {
  return post(WireRoutes.DraftRightsCommand, FrameType.ArticleRightsPolicy, receipt(input.id, input.expectedRevision + 1n),
    signal, encodeFrame(FrameType.ArticleRightsCommand, encodeArticleRightsCommand(input)),
    { [WireHeaders.ClientMutationId]: input.idempotencyKey });
}

function receipt(id: number, revision: bigint) {
  return (payload: Uint8Array): ArticleRightsPolicy => {
    const result = decodeArticleRightsPolicy(payload);
    if (id <= 0 || revision <= 0n || result.id !== id || result.revision !== revision)
      throw new ProtocolError('Invalid article rights receipt');
    return result;
  };
}
