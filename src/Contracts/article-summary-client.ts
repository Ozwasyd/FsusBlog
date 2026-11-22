import { ProtocolError } from './aeds.ts';
import { decodeArticleSummary, encodeArticleSummaryCommand, type ArticleSummary, type ArticleSummaryCommand } from './article-summary.ts';
import { type Draft } from './client.ts';
import { sessionGet, post, siteSessionHeader } from './internal/http.ts';
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export type DraftSummaryEdit = Readonly<{ articleId: number; revision: bigint; credential: string; text: string }>;

export function draftSummary(id: number, revision: bigint, session: string, signal: AbortSignal,
  sourceRevision?: bigint): Promise<ArticleSummary> {
  if (sourceRevision !== undefined && (sourceRevision <= 0n || sourceRevision >= revision))
    throw new ProtocolError('Invalid historical summary coordinates');
  const path = WireRoutes.ArticleSummary.replace('{id:int}', String(id));
  const query = new URLSearchParams({ revision: String(revision) });
  if (sourceRevision !== undefined) query.set('sourceRevision', String(sourceRevision));
  return sessionGet(`${path}?${query}`, FrameType.ArticleSummary, payload => {
    const summary = decodeArticleSummary(payload);
    if (summary.id !== id || summary.revision !== (sourceRevision ?? revision)) throw new ProtocolError('Invalid article summary coordinates');
    return summary;
  }, signal, session);
}

export function saveDraftSummary(input: ArticleSummaryCommand, session: string, signal: AbortSignal): Promise<Draft> {
  const headers = new Headers(siteSessionHeader(session));
  headers.set(WireHeaders.ClientMutationId, input.idempotencyKey);
  return post(WireRoutes.ArticleSummarySave, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n)
      throw new ProtocolError('Invalid article summary save receipt');
    return draft;
  }, signal, encodeArticleSummaryCommand(input), headers);
}
