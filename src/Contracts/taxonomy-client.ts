import { ProtocolError } from './binary.ts';
import { request } from './client.ts';
import { decodeArticleList } from './public-articles.ts';
import { decodeTaxonomyList, decodeTaxonomyMetadata, type TaxonomyKind } from './taxonomy.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export { type TaxonomyKind, type TaxonomyMetadata } from './taxonomy.ts';

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
