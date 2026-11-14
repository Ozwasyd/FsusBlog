import { ProtocolError } from './binary.ts';
import { encodeFrame } from './aeds.ts';
import { request } from './client.ts';
import { decodeArticleList } from './public-articles.ts';
import { decodeTaxonomyList, decodeTaxonomyMetadata, type TaxonomyKind } from './taxonomy.ts';
import {
  decodeDraftTaxonomy, encodeTaxonomyAssignment, FrameType, type TaxonomyAssignment, WireLimits, WireRoutes,
} from './wire.generated.ts';

export { type TaxonomyKind, type TaxonomyMetadata } from './taxonomy.ts';
export type TaxonomySelection = Readonly<{ categoryId: number | null; tagIds: readonly number[] }>;
export type DraftTaxonomy = TaxonomySelection & Readonly<{ id: number; revision: bigint }>;
export type TaxonomyAssignmentInput = Omit<TaxonomyAssignment, 'categoryId'> & { categoryId: number | null };

export function taxonomyList(kind: TaxonomyKind, signal?: AbortSignal) {
  return kind === 'category'
    ? request(WireRoutes.CategoryList, FrameType.CategoryList, decodeTaxonomyList, signal)
    : request(WireRoutes.TagList, FrameType.TagList, decodeTaxonomyList, signal);
}

export function taxonomyMetadata(kind: TaxonomyKind, id: number, signal?: AbortSignal) {
  const route = kind === 'category' ? WireRoutes.CategoryMetadata : WireRoutes.TagMetadata;
  return request(route.replace('{id:int}', String(id)), FrameType.TaxonomyExactMetadata, payload => {
    const item = decodeTaxonomyMetadata(payload);
    if (item.id !== id) throw new ProtocolError('Unexpected taxonomy ID');
    return item;
  }, signal);
}

export function taxonomyArticles(
  kind: TaxonomyKind, id: number, page: number, size: number, signal?: AbortSignal, cursor?: string,
) {
  const route = kind === 'category' ? WireRoutes.CategoryArticles : WireRoutes.TagArticles;
  const path = route.replace('{id:int}', String(id)).replace('{page:int}', String(page)).replace('{size:int}', String(size));
  const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor })}`;
  return request(`${path}${query}`, FrameType.ArticleList, payload => {
    const { articles, total, nextCursor } = decodeArticleList(payload);
    return { items: articles, total, nextCursor };
  }, signal);
}

export function draftTaxonomy(id: number, revision: bigint, signal?: AbortSignal): Promise<DraftTaxonomy> {
  const path = WireRoutes.DraftTaxonomy.replace('{id:int}', String(id));
  return request(`${path}?${new URLSearchParams({ revision: String(revision) })}`, FrameType.DraftTaxonomy,
    payload => readDraftTaxonomy(payload, id, revision), signal);
}

export function assignTaxonomy(input: TaxonomyAssignmentInput, signal?: AbortSignal): Promise<DraftTaxonomy> {
  const value = { ...input, categoryId: input.categoryId ?? 0 };
  const frame = encodeFrame(FrameType.TaxonomyAssignment, encodeTaxonomyAssignment(value));
  return request(WireRoutes.TaxonomyAssignment, FrameType.DraftTaxonomy,
    payload => readDraftTaxonomy(payload, input.id, input.expectedRevision + 1n), signal, 'POST', frame);
}

function readDraftTaxonomy(payload: Uint8Array, id: number, revision: bigint): DraftTaxonomy {
  const item = decodeDraftTaxonomy(payload);
  if (item.id <= 0 || item.id !== id || item.revision <= 0n || item.revision !== revision || item.categoryId < 0 ||
      item.tagIds.length > WireLimits.TaxonomyTagCount || item.tagIds.some((tag, index) => tag <= (item.tagIds[index - 1] ?? 0)))
    throw new ProtocolError('Invalid draft taxonomy snapshot');
  return { ...item, categoryId: item.categoryId || null };
}
