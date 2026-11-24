import { decodePod, ProtocolError } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireLimits, WireRoutes } from './wire.generated.ts';

export type AdminTaxonomyKind = 'categories' | 'tags';
export type AdminTaxonomyItem = Readonly<{
  id: number;
  name: string;
  published: number;
  drafts: number;
  scheduled: number;
  retracted: number;
  deleted: number;
  retainedArticles: number;
}>;
export type AdminTaxonomyPage = Readonly<{ nextId: number | null; items: readonly AdminTaxonomyItem[] }>;
export type AdminTaxonomyDependencies = Readonly<{
  id: number;
  activeArticles: number;
  retainedOnlyArticles: number;
  reservedAliases: number;
}>;

export function decodeAdminTaxonomyPage(payload: Uint8Array): AdminTaxonomyPage {
  return decodePod(payload, reader => {
    const nextId = reader.i32(), count = reader.i32();
    if (nextId < 0 || count < 0 || count > WireLimits.AdminTaxonomyPageSize || nextId > 0 && count !== WireLimits.AdminTaxonomyPageSize)
      throw new ProtocolError('Invalid administrator taxonomy page');
    const items: AdminTaxonomyItem[] = [];
    let previous = 0;
    for (let index = 0; index < count; index++) {
      const id = reader.i32(), name = reader.text(WireLimits.TaxonomyNameBytes);
      const published = reader.i32(), drafts = reader.i32(), scheduled = reader.i32();
      const retracted = reader.i32(), deleted = reader.i32(), retainedArticles = reader.i32();
      if (id <= previous || !name || Math.min(published, drafts, scheduled, retracted, deleted) < 0 ||
          retainedArticles < published || retainedArticles < drafts + scheduled + retracted + deleted)
        throw new ProtocolError('Invalid administrator taxonomy item');
      items.push({ id, name, published, drafts, scheduled, retracted, deleted, retainedArticles });
      previous = id;
    }
    if (nextId !== 0 && nextId !== previous) throw new ProtocolError('Invalid administrator taxonomy cursor');
    return { nextId: nextId || null, items };
  });
}

export async function readAdminTaxonomy(kind: AdminTaxonomyKind, after: number | null, signal?: AbortSignal): Promise<AdminTaxonomyPage> {
  const path = kind === 'categories' ? WireRoutes.AdminCategories : WireRoutes.AdminTags;
  const page = await request(path + (after === null ? '' : `?after=${after}`), FrameType.AdminTaxonomyPage, decodeAdminTaxonomyPage, signal);
  if (after !== null && page.items.length > 0 && page.items[0].id <= after)
    throw new ProtocolError('Administrator taxonomy cursor did not advance');
  return page;
}

export function readAdminTaxonomyDependencies(kind: AdminTaxonomyKind, id: number, signal: AbortSignal) {
  if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff)
    throw new ProtocolError('Invalid taxonomy dependency ID');

  const path = kind === 'categories' ? WireRoutes.AdminCategories : WireRoutes.AdminTags;
  return request(`${path}?dependency=${id}`, FrameType.AdminTaxonomyDependencies, payload => {
    const result: AdminTaxonomyDependencies = decodePod(payload, reader => ({
      id: reader.i32(), activeArticles: reader.i32(), retainedOnlyArticles: reader.i32(), reservedAliases: reader.i32(),
    }));
    if (result.id !== id || Math.min(result.activeArticles, result.retainedOnlyArticles, result.reservedAliases) < 0 ||
        kind === 'categories' && result.reservedAliases !== 0)
      throw new ProtocolError('Invalid taxonomy dependency response');
    return result;
  }, signal);
}
