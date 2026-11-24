import { encodeFrame, ProtocolError } from './aeds.ts';
import { decodePod } from './binary.ts';
import { sessionGet, post, request } from './internal/http.ts';
import type { ArticleTaxonomy } from './author-articles.ts';
import { decodeArticleCover } from './article-media.ts';
import {
  decodeDraft, decodeRevisionComparison, encodeDraftRollback, FrameType, WireHeaders, WireLimits, WireRoutes,
  type Draft, type DraftRollback, type RevisionComparison,
} from './wire.generated.ts';

export type RevisionHistoryItem = Readonly<{
  revision: bigint;
  title: string;
  savedAt: number;
  sourceRevision: bigint | null;
  reason: string;
}>;

export type RevisionHistoryPage = Readonly<{
  publishedRevision: bigint | null;
  nextCursor: string | null;
  items: readonly RevisionHistoryItem[];
}>;

type SavedRevisionMetadata = { summary: string; category: ArticleTaxonomy | null; tags: ArticleTaxonomy[]; cover?: string | null };

export function validRollbackReason(value: string): boolean {
  if (value.length < 8 || value.length > 1000 || value !== value.trim() || /\p{Cc}/u.test(value)) return false;
  const length = Array.from(value).length;
  return length >= 8 && length <= 500;
}

export function draftRevisionHistory(id: number, revision: bigint, signal?: AbortSignal, cursor?: string): Promise<RevisionHistoryPage> {
  const path = WireRoutes.DraftRevisionHistory.replace('{id:int}', String(id));
  const query = new URLSearchParams({ revision: String(revision) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return request(`${path}?${query}`, FrameType.RevisionHistory, payload => decodePod(payload, reader => {
    const articleId = reader.i32(), base = reader.i64(), published = reader.i64();
    const next = reader.text(WireLimits.RevisionHistoryCursorChars), count = reader.i32();
    if (id <= 0 || articleId !== id || revision <= 0n || base !== revision || published < 0n || published > base ||
      count < 0 || count > WireLimits.RevisionHistoryPageSize ||
      next !== '' && (next.length !== WireLimits.RevisionHistoryCursorChars || !/^[A-Za-z0-9_-]+$/.test(next) ||
        count !== WireLimits.RevisionHistoryPageSize))
      throw new ProtocolError('Invalid revision history coordinates');
    const items: RevisionHistoryItem[] = [];
    let previous = 0n;
    for (let index = 0; index < count; ++index) {
      const current = reader.i64(), title = reader.text(WireLimits.TitleBytes), savedAt = Number(reader.i64());
      const source = reader.i64(), reason = reader.text(WireLimits.RollbackReasonBytes);
      if (current <= 0n || current > base || previous !== 0n && current >= previous ||
        !title || !Number.isSafeInteger(savedAt) || !Number.isFinite(new Date(savedAt).getTime()) ||
        source < 0n || (source === 0n ? !!reason : source >= current - 1n || !validRollbackReason(reason)))
        throw new ProtocolError('Invalid revision history entry');
      items.push({ revision: current, title, savedAt, sourceRevision: source || null, reason });
      previous = current;
    }
    return { publishedRevision: published || null, nextCursor: next || null, items };
  }), signal);
}

export function compareDraftRevision(id: number, revision: bigint, sourceRevision: bigint, signal?: AbortSignal,
  session?: string): Promise<RevisionComparison> {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id))
    .replace('{sourceRevision:long}', String(sourceRevision));
  return sessionGet(`${path}?revision=${revision}`, FrameType.RevisionComparison, payload => {
    const pair = decodeRevisionComparison(payload);
    if (id <= 0 || pair.id !== id || pair.revision !== revision || pair.sourceRevision !== sourceRevision ||
      sourceRevision <= 0n || sourceRevision >= revision || !pair.title || !pair.sourceTitle)
      throw new ProtocolError('Invalid draft revision comparison');
    return pair;
  }, signal, session);
}

export function compareRevisionMetadata(id: number, revision: bigint, sourceRevision: bigint, session: string, signal: AbortSignal) {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id)).replace('{sourceRevision:long}', String(sourceRevision));
  return sessionGet(`${path}?revision=${revision}&map=metadata`, FrameType.RevisionMetadataComparison, (payload, headers) =>
    decodePod(payload, reader => {
      const invalid = () => new ProtocolError('Invalid saved revision metadata');
      if (reader.i32() !== id || reader.i64() !== revision || reader.i64() !== sourceRevision) throw invalid();
      const taxonomy = (itemId: number): ArticleTaxonomy => {
        const name = reader.text(WireLimits.TaxonomyNameBytes);
        if (itemId <= 0 || !name || name.includes('\0')) throw invalid();
        return { id: itemId, name };
      };
      const metadata = (): SavedRevisionMetadata => {
        const summary = reader.text(WireLimits.ArticleSummaryReadBytes);
        const categoryId = reader.i32(), category = categoryId === 0 ? null : taxonomy(categoryId), count = reader.i32();
        if (summary.includes('\0') || count < 0 || count > WireLimits.TaxonomyTagCount) throw invalid();
        const tags: ArticleTaxonomy[] = [];
        for (let index = 0; index < count; index++) {
          const tag = taxonomy(reader.i32());
          if (index > 0 && tag.id <= tags[index - 1].id) throw invalid();
          tags.push(tag);
        }
        return { summary, category, tags };
      };
      const current = metadata(), source = metadata();
      current.cover = decodeArticleCover(headers.get(WireHeaders.ArticleCover));
      source.cover = decodeArticleCover(headers.get(WireHeaders.SourceArticleCover));
      if ((current.cover === undefined) !== (source.cover === undefined)) throw invalid();
      return { current, source };
    }), signal, session);
}

export function rollbackDraft(input: DraftRollback, signal?: AbortSignal): Promise<Draft> {
  const frame = encodeFrame(FrameType.DraftRollback, encodeDraftRollback(input));
  return post(WireRoutes.DraftRollback, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n)
      throw new ProtocolError('Invalid rollback receipt');
    return draft;
  }, signal, frame, { [WireHeaders.ClientMutationId]: input.idempotencyKey });
}
