import { decodeSuccess, ProtocolError } from './aeds.ts';
import { PodReader } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes } from './wire.generated.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const zeroId = '00000000-0000-0000-0000-000000000000';
const calendarFloor = 621355968000000000n;
const calendarCeiling = 3155378975999999999n;

export interface PrivateMediaItem {
  readonly id: string;
  readonly name: string;
  readonly format: 1 | 2;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly ticks: bigint;
}

export interface MediaPage {
  readonly items: readonly PrivateMediaItem[];
  readonly hasMore: boolean;
}

export function decodeMediaItems(payload: Uint8Array): MediaPage {
  const reader = new PodReader(payload);
  if (reader.i32() !== WireLayouts.PrivateMediaVersion) throw invalid();
  const hasMore = reader.bool();
  const count = reader.i32();
  if (count < 0 || count > 50 || (hasMore && count < 50)) throw invalid();
  const items: PrivateMediaItem[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index++) {
    const id = reader.uuid();
    const format = reader.i32();
    const length = reader.i32();
    const width = reader.i32();
    const height = reader.i32();
    const ticks = reader.i64();
    const name = reader.text(255);
    if (!validId(id) || ids.has(id) || (format !== 1 && format !== 2) || length < 1 || length > WireLimits.PrivateMediaBytes ||
        width < 1 || width > 8192 || height < 1 || height > 8192 || width * height > 16 * 1024 * 1024 ||
        ticks < calendarFloor || ticks > calendarCeiling || !name || /[\u0000-\u001f\u007f/\\]/.test(name)) throw invalid();
    ids.add(id);
    items.push({ id, format, length, width, height, ticks, name });
  }
  reader.finish();
  return { items, hasMore };
}

export function listMedia(before?: PrivateMediaItem, signal?: AbortSignal): Promise<MediaPage> {
  const query = before ? `?${new URLSearchParams({ before: String(before.ticks), beforeId: before.id })}` : '';
  return request(WireRoutes.PrivateMediaList + query, FrameType.PrivateMediaItems, decodeMediaItems, signal);
}

export function uploadMedia(file: File, key: string, signal?: AbortSignal): Promise<PrivateMediaItem> {
  if (!validId(key) || file.size < 1 || file.size > WireLimits.PrivateMediaBytes ||
      (file.type !== 'image/png' && file.type !== 'image/jpeg')) throw invalid();
  const path = `${WireRoutes.PrivateMediaUpload}?${new URLSearchParams({ name: file.name })}`;
  return request(path, FrameType.PrivateMediaItems, payload => {
    const page = decodeMediaItems(payload);
    if (page.hasMore || page.items.length !== 1 || page.items[0].name !== file.name) throw invalid();
    return page.items[0];
  }, signal, 'POST', file, { [WireHeaders.ClientMutationId]: key, 'Content-Type': file.type });
}

export function removeMedia(id: string, signal?: AbortSignal): Promise<void> {
  return request(itemPath(WireRoutes.PrivateMediaRemove, id), FrameType.EmptySuccess, decodeSuccess, signal, 'POST');
}

export function privateMediaHref(id: string): string {
  return itemPath(WireRoutes.PrivateMediaRead, id);
}

export function mediaDate(ticks: bigint): Date {
  return new Date(Number((ticks - calendarFloor) / 10000n));
}

function itemPath(route: string, id: string): string {
  if (!validId(id)) throw invalid();
  return route.replace('{id}', id);
}

const validId = (value: string) => uuid.test(value) && value.toLowerCase() !== zeroId;
const invalid = () => new ProtocolError('Invalid private media data.');
