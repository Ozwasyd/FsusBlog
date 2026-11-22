import { encodeFrame, ProtocolError } from './aeds.ts';
import { PodWriter } from './binary.ts';
import { validSiteSessionId, type Draft } from './client.ts';
import { post, request } from './internal/http.ts';
import { decodeDraft, FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

import type { Article } from './public-articles.ts';

export function managedArticleCoverDigest(article: Pick<Article, 'id' | 'publication' | 'coverImageUrl'>): string | undefined {
  const digest = article.coverImageUrl.slice(-64);
  if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
  const expected = WireRoutes.PublicArticleMediaFile.replace('{id:int}', String(article.id))
    .replace('{publication:long}', String(article.publication)).replace('{digest}', digest);
  return article.coverImageUrl === expected ? digest : undefined;
}

const emptyId = '00000000-0000-0000-0000-000000000000';
const imageLimit = 32;
const publicationBytes = 40 * 1024 * 1024;

export interface PublicArticleImage {
  readonly digest: string;
  readonly format: 1 | 2 | 3;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

export interface PublishImagesSelection {
  readonly articleId: number;
  readonly revision: bigint;
  readonly credential: string;
  readonly assets: readonly string[];
}

export function publishArticleImages(id: number, revision: bigint, key: string, assets: readonly string[], current: string,
  signal: AbortSignal): Promise<Draft> {
  const selected = assets.map(asset => asset.toLowerCase());
  if (id <= 0 || revision <= 0n || key === emptyId || !validSiteSessionId(current) ||
      selected.length === 0 || selected.length > imageLimit || new Set(selected).size !== selected.length || selected.includes(emptyId))
    throw invalid();
  const writer = new PodWriter();
  writer.i32(id);
  writer.i64(revision);
  writer.uuid(key);
  writer.i32(selected.length);
  for (const asset of selected) writer.uuid(asset);
  const frame = encodeFrame(FrameType.ArticlePublishImages, writer.finish());
  return post(WireRoutes.ArticlePublishImages, FrameType.Draft, payload => {
    const result = decodeDraft(payload);
    if (result.id !== id || result.revision !== revision + 1n || !result.published) throw invalid();
    return result;
  }, signal, frame, { [WireHeaders.CurrentSession]: current, [WireHeaders.ClientMutationId]: key });
}

export function fetchPublicArticleMedia(id: number, publication: bigint, signal?: AbortSignal): Promise<readonly PublicArticleImage[]> {
  if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff || publication <= 0n || BigInt.asIntN(64, publication) !== publication)
    throw invalid();
  const coordinates = (route: string) => route.replace('{id:int}', String(id)).replace('{publication:long}', String(publication));
  return request(coordinates(WireRoutes.PublicArticleMedia), FrameType.PublicArticleMedia, payload => {
    const header = 16;
    const rowSize = 48;
    if (payload.length < header) throw invalid();
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getInt32(12, true);
    if (view.getInt32(0, true) !== id || view.getBigInt64(4, true) !== publication || count < 0 || count > imageLimit ||
        payload.length !== header + count * rowSize) throw invalid();

    const assets: PublicArticleImage[] = [];
    const known = new Set<string>();
    let total = 0;
    for (let index = 0; index < count; index++) {
      const start = header + index * rowSize;
      const digest = Array.from(payload.subarray(start, start + 32), byte => byte.toString(16).padStart(2, '0')).join('');
      const format = view.getInt32(start + 32, true);
      const length = view.getInt32(start + 36, true);
      const width = view.getInt32(start + 40, true);
      const height = view.getInt32(start + 44, true);
      if (known.has(digest) || (format !== 1 && format !== 2 && format !== 3) || length < 1 || length > WireLimits.PrivateMediaBytes ||
          width < 1 || width > 8192 || height < 1 || height > 8192 || width * height > 16 * 1024 * 1024) throw invalid();
      total += length;
      if (total > publicationBytes) throw invalid();
      known.add(digest);
      assets.push({ digest, format, length, width, height, url: coordinates(WireRoutes.PublicArticleMediaFile).replace('{digest}', digest) });
    }
    return assets;
  }, signal, 'GET', undefined, undefined, 'omit');
}

const invalid = () => new ProtocolError('Invalid article image publication data.');
