import { encodeFrame, ProtocolError } from './aeds.ts';
import { request, siteSessionHeader, type Draft } from './client.ts';
import {
  decodeDraft, decodeDraftRevisionBodyInsertion, encodeArticleBodyInsertionCommand,
  FrameType, WireRoutes, type ArticleBodyInsertionCommand, type DraftRevisionBodyInsertion,
} from './wire.generated.ts';

export type BodyInsertion = Readonly<{offset: number; length: number}>;

export function saveWithBodyInsertion(input: ArticleBodyInsertionCommand, session: string,
  signal: AbortSignal): Promise<Draft> {
  const frame = encodeFrame(FrameType.ArticleBodyInsertionCommand, encodeArticleBodyInsertionCommand(input));
  return request(WireRoutes.Save, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n)
      throw new ProtocolError('Invalid saved body insertion coordinates');
    return draft;
  }, signal, 'POST', frame, siteSessionHeader(session));
}

export function readBodyInsertion(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyInsertion> {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id))
    .replace('{sourceRevision:long}', String(sourceRevision));
  return request(`${path}?revision=${revision}&map=body-insertion`, FrameType.DraftRevisionBodyInsertion, payload => {
    const map = decodeDraftRevisionBodyInsertion(payload);
    if (map.id !== id || map.revision !== revision || map.sourceRevision !== sourceRevision)
      throw new ProtocolError('Invalid revision body map coordinates');
    if (!map.available && (map.offset !== 0 || map.length !== 0 || map.body || map.sourceBody || map.digest || map.sourceDigest))
      throw new ProtocolError('Invalid missing revision body map');
    return map;
  }, signal, 'GET', undefined, siteSessionHeader(session));
}
