import { encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader, PodWriter } from './binary.ts';
import { validSiteSessionId, type Draft } from './client.ts';
import { getWithSession, post } from './internal/http-methods.ts';
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export interface ArticleAttachment { readonly id: string; readonly ticket: string }
export type AttachmentEdit = Readonly<{ assetId: string; attach: boolean } | { cover: string | null }>;
export interface ArticleMediaState {
  readonly entries: readonly ArticleAttachment[];
  readonly publishImages: boolean;
  readonly publishCover: boolean;
  readonly cover: string | null | undefined;
}

export function articleMedia(id: number, revision: bigint, current: string, signal?: AbortSignal): Promise<ArticleMediaState> {
  const path = WireRoutes.ArticleMedia.replace('{id:int}', String(id)) + `?revision=${revision}`;
  return getWithSession(path, FrameType.ArticleMedia, (payload, headers) => {
    const reader = new PodReader(payload);
    if (id <= 0 || revision <= 0n || reader.i32() !== id || reader.i64() !== revision) throw invalid();
    const count = reader.i32();
    if (count < 0 || count > 32) throw invalid();
    const entries: ArticleAttachment[] = [];
    const known = new Set<string>();
    for (let index = 0; index < count; index++) {
      const asset = reader.uuid();
      const ticket = reader.text(91);
      if (known.has(asset) || asset === empty || !validTicket(ticket)) throw invalid();
      entries.push({ id: asset, ticket });
      known.add(asset);
    }
    reader.finish();
    const cover = decodeArticleCover(headers.get(WireHeaders.ArticleCover));
    if (cover && !known.has(cover)) throw invalid();
    return { entries, cover, publishImages: headers.get(WireHeaders.ArticlePublishImagesEnabled) === '1',
      publishCover: headers.get(WireHeaders.ArticlePublishCoverEnabled) === '1' };
  }, signal, current);
}

export function editArticleMedia(id: number, revision: bigint, key: string, edit: AttachmentEdit, current: string,
  signal: AbortSignal): Promise<Draft> {
  if (id <= 0 || revision <= 0n || key === empty || !validSiteSessionId(current)) throw invalid();
  const writer = new PodWriter();
  writer.i32(id);
  writer.i64(revision);
  writer.uuid(key);
  const cover = 'cover' in edit;
  if (cover ? edit.cover !== null && !validAsset(edit.cover) : !validAsset(edit.assetId)) throw invalid();
  writer.uuid(cover ? edit.cover ?? empty : edit.assetId);
  if (!cover) writer.bool(edit.attach);
  const frame = encodeFrame(cover ? FrameType.ArticleCoverCommand : FrameType.ArticleMediaCommand, writer.finish());
  return post(cover ? WireRoutes.ArticleCoverSave : WireRoutes.ArticleMediaCommand, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== id || draft.revision !== revision + 1n) throw invalid();
    return draft;
  }, signal, frame, { [WireHeaders.CurrentSession]: current, [WireHeaders.ClientMutationId]: key });
}

export async function privateArticlePreview(ticket: string, signal?: AbortSignal): Promise<Blob> {
  if (!validTicket(ticket)) throw invalid();
  const response = await fetch(WireRoutes.ArticleMediaPreview, {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Authorization: `Bearer ${ticket}`, Accept: 'image/png, image/jpeg, image/webp' },
  });
  const type = response.headers.get('content-type');
  if (!response.ok || type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') {
    await response.body?.cancel();
    throw invalid();
  }
  return response.blob();
}

const empty = '00000000-0000-0000-0000-000000000000';
const validAsset = (value: string) => value !== empty && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export function decodeArticleCover(value: string | null): string | null | undefined {
  if (value === null) return undefined;
  if (value === 'none') return null;
  if (!validAsset(value)) throw invalid();
  return value;
}
const validTicket = (value: string) => /^[A-Za-z0-9_-]{91}$/.test(value);
const invalid = () => new ProtocolError('Invalid private article attachment');
