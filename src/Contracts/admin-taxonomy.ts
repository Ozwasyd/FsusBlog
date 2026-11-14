import { PodReader, ProtocolError } from './binary.ts';
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

export function decodeAdminTaxonomyPage(payload: Uint8Array): AdminTaxonomyPage {
  const reader = new PodReader(payload);
  const nextId = reader.i32();
  const count = reader.i32();
  if (nextId < 0 || count < 0 || count > WireLimits.AdminTaxonomyPageSize || nextId > 0 && count !== WireLimits.AdminTaxonomyPageSize)
    throw new ProtocolError('Invalid administrator taxonomy page');

  const items: AdminTaxonomyItem[] = [];
  let previous = 0;
  for (let index = 0; index < count; index++) {
    const id = reader.i32();
    const name = reader.text(WireLimits.TaxonomyNameBytes);
    const published = reader.i32();
    const drafts = reader.i32();
    const scheduled = reader.i32();
    const retracted = reader.i32();
    const deleted = reader.i32();
    const retainedArticles = reader.i32();
    if (id <= previous || !name || Math.min(published, drafts, scheduled, retracted, deleted) < 0 ||
        retainedArticles < published || retainedArticles < drafts + scheduled + retracted + deleted)
      throw new ProtocolError('Invalid administrator taxonomy item');
    items.push({ id, name, published, drafts, scheduled, retracted, deleted, retainedArticles });
    previous = id;
  }
  reader.finish();
  if (nextId !== 0 && nextId !== previous) throw new ProtocolError('Invalid administrator taxonomy cursor');
  return { nextId: nextId || null, items };
}

export async function readAdminTaxonomy(kind: AdminTaxonomyKind, after: number | null, signal?: AbortSignal): Promise<AdminTaxonomyPage> {
  const path = kind === 'categories' ? WireRoutes.AdminCategories : WireRoutes.AdminTags;
  const page = await request(path + (after === null ? '' : `?after=${after}`), FrameType.AdminTaxonomyPage, decodeAdminTaxonomyPage, signal);
  if (after !== null && page.items.length > 0 && page.items[0].id <= after)
    throw new ProtocolError('Administrator taxonomy cursor did not advance');
  return page;
}
