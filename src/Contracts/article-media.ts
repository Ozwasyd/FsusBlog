import { encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader, PodWriter } from './binary.ts';
import { request, validSiteSessionId, type Draft } from './client.ts';
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export interface ArticleAttachment { readonly id: string; readonly ticket: string }
export interface AttachmentEdit { readonly assetId: string; readonly attach: boolean }

export function articleMedia(id: number, revision: bigint, signal?: AbortSignal): Promise<readonly ArticleAttachment[]> {
  const path = WireRoutes.ArticleMedia.replace('{id:int}', String(id)) + `?revision=${revision}`;
  return request(path, FrameType.ArticleMedia, payload => {
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
    return entries;
  }, signal);
}

export function editArticleMedia(id: number, revision: bigint, key: string, edit: AttachmentEdit, current: string,
  signal: AbortSignal): Promise<Draft> {
  if (id <= 0 || revision <= 0n || key === empty || edit.assetId === empty || !validSiteSessionId(current)) throw invalid();
  const writer = new PodWriter();
  writer.i32(id);
  writer.i64(revision);
  writer.uuid(key);
  writer.uuid(edit.assetId);
  writer.bool(edit.attach);
  const frame = encodeFrame(FrameType.ArticleMediaCommand, writer.finish());
  return request(WireRoutes.ArticleMediaCommand, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== id || draft.revision !== revision + 1n) throw invalid();
    return draft;
  }, signal, 'POST', frame, { [WireHeaders.CurrentSession]: current });
}

export async function privateArticlePreview(ticket: string, signal?: AbortSignal): Promise<Blob> {
  if (!validTicket(ticket)) throw invalid();
  const response = await fetch(WireRoutes.ArticleMediaPreview, {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Authorization: `Bearer ${ticket}`, Accept: 'image/png, image/jpeg' },
  });
  const type = response.headers.get('content-type');
  if (!response.ok || type !== 'image/png' && type !== 'image/jpeg') {
    await response.body?.cancel();
    throw invalid();
  }
  return response.blob();
}

const empty = '00000000-0000-0000-0000-000000000000';
const validTicket = (value: string) => /^[A-Za-z0-9_-]{91}$/.test(value);
const invalid = () => new ProtocolError('Invalid private article attachment');
