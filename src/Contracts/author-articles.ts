import { PodReader, ProtocolError } from './binary.ts';
import { request, validSiteSessionId } from './client.ts';
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

const states = ['draft', 'scheduled', 'published', 'retracted', 'deleted'] as const;
export type AuthorArticleState = typeof states[number];
export type ArticleTaxonomy = Readonly<{ id: number; name: string }>;
export type AuthorArticleRow = Readonly<{
  id: number;
  revision: bigint;
  title: string;
  state: AuthorArticleState;
  modifiedAt: number;
  scheduledAt: number | null;
  category: ArticleTaxonomy | null;
  tags: readonly ArticleTaxonomy[];
}>;
export type AuthorArticlePage = Readonly<{ total: number; nextId: number | null; items: readonly AuthorArticleRow[] }>;
export type AuthorArticleQuery = Readonly<{
  trash: boolean;
  keyword?: string;
  categoryId?: number;
  tagId?: number;
  state?: Exclude<AuthorArticleState, 'deleted'>;
  beforeId?: number;
  articleId?: number;
}>;

export function decodeAuthorArticlePage(bytes: Uint8Array): AuthorArticlePage {
  const input = new PodReader(bytes);
  const total = input.i32(), nextId = input.i32(), count = input.i32();
  if (total < count || nextId < 0 || count < 0 || count > WireLimits.AuthorArticlePageSize ||
      nextId !== 0 && count !== WireLimits.AuthorArticlePageSize) throw new ProtocolError('Invalid author article page');
  const items: AuthorArticleRow[] = [];
  const taxonomy = (id: number): ArticleTaxonomy => {
    const name = input.text(WireLimits.TaxonomyNameBytes);
    if (id <= 0 || !name) throw new ProtocolError('Invalid author taxonomy');
    return { id, name };
  };
  for (let index = 0; index < count; index++) {
    const id = input.i32(), revision = input.i64(), title = input.text(WireLimits.TitleBytes);
    const state = states[input.i32() - 1];
    const modifiedAt = Number(input.i64()), due = Number(input.i64());
    const categoryId = input.i32();
    const category = categoryId === 0 ? null : taxonomy(categoryId);
    const tagCount = input.i32();
    if (id <= 0 || (index > 0 && id >= items[index - 1].id) || revision <= 0n || title.length === 0 || !state ||
        !Number.isSafeInteger(modifiedAt) || !Number.isSafeInteger(due) || due < 0 || (state === 'scheduled') !== (due > 0) ||
        tagCount < 0 || tagCount > WireLimits.TaxonomyTagCount) throw new ProtocolError('Invalid author article entry');
    const tags: ArticleTaxonomy[] = [];
    for (let tag = 0; tag < tagCount; tag++) {
      const item = taxonomy(input.i32());
      if (tag > 0 && item.id <= tags[tag - 1].id) throw new ProtocolError('Invalid author tag order');
      tags.push(item);
    }
    items.push({ id, revision, title, state, modifiedAt, scheduledAt: due || null, category, tags });
  }
  input.finish();
  if (nextId !== 0 && items.at(-1)?.id !== nextId) throw new ProtocolError('Invalid author article page position');
  return { total, nextId: nextId || null, items };
}

export async function listAuthorArticles(query: AuthorArticleQuery, signal?: AbortSignal, session?: string): Promise<AuthorArticlePage> {
  const parameters = new URLSearchParams({ scope: query.trash ? 'trash' : 'active' });
  if (query.keyword) parameters.set('keyword', query.keyword);
  if (query.categoryId !== undefined) parameters.set('category', String(query.categoryId));
  if (query.tagId !== undefined) parameters.set('tag', String(query.tagId));
  if (query.state) parameters.set('state', query.state);
  if (query.beforeId !== undefined) parameters.set('before', String(query.beforeId));
  if (query.articleId !== undefined) parameters.set('article', String(query.articleId));
  if (session !== undefined && !validSiteSessionId(session)) throw new ProtocolError('Invalid author inventory session');
  const page = await request(`${WireRoutes.AuthorArticles}?${parameters}`, FrameType.AuthorArticlePage, decodeAuthorArticlePage,
    signal, 'GET', undefined, session === undefined ? undefined : { [WireHeaders.CurrentSession]: session });
  if (page.items.some(row => (row.state === 'deleted') !== query.trash || query.state !== undefined && row.state !== query.state ||
      query.articleId !== undefined && row.id !== query.articleId) || query.articleId !== undefined && (page.total > 1 || page.nextId !== null))
    throw new ProtocolError('Unexpected author article scope');
  return page;
}
