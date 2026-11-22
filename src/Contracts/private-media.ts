import { decodeSuccess, ProtocolError } from './aeds.ts';
import { PodReader } from './binary.ts';
import { validSiteSessionId } from './client.ts';
import { getWithSession, post } from './internal/http-methods.ts';
import { FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes } from './wire.generated.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const zeroId = '00000000-0000-0000-0000-000000000000';
const calendarFloor = 621355968000000000n;
const calendarCeiling = 3155378975999999999n;
const formats = new Map<string, PrivateMediaItem['format']>([['image/png', 1], ['image/jpeg', 2], ['image/webp', 3]]);

export interface PrivateMediaItem {
  readonly id: string;
  readonly name: string;
  readonly format: 1 | 2 | 3;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly ticks: bigint;
}

export interface MediaPage {
  readonly items: readonly PrivateMediaItem[];
  readonly hasMore: boolean;
}

interface UploadManifest { file: File; key: string; digest: string }
export interface MediaUploadState {
  readonly id: string;
  readonly length: number;
  readonly partSize: number;
  readonly expiresAt: number;
  readonly reserved: boolean;
  readonly asset?: string;
  readonly received: readonly number[];
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
    if (!validId(id) || ids.has(id) || (format !== 1 && format !== 2 && format !== 3) || length < 1 || length > WireLimits.PrivateMediaBytes ||
        width < 1 || width > 8192 || height < 1 || height > 8192 || width * height > 16 * 1024 * 1024 ||
        ticks < calendarFloor || ticks > calendarCeiling || !name || /[\u0000-\u001f\u007f/\\]/.test(name)) throw invalid();
    ids.add(id);
    items.push({ id, format, length, width, height, ticks, name });
  }
  reader.finish();
  return { items, hasMore };
}

export function listMedia(before?: PrivateMediaItem, signal?: AbortSignal, current?: string): Promise<MediaPage & { resumable: boolean; webp: boolean }> {
  const query = before ? `?${new URLSearchParams({ before: String(before.ticks), beforeId: before.id })}` : '';
  return getWithSession(WireRoutes.PrivateMediaList + query, FrameType.PrivateMediaItems, (payload, headers) => {
    const flag = headers.get(WireHeaders.PrivateMediaResumable);
    const webp = headers.get(WireHeaders.PrivateMediaWebp);
    if ((flag !== null && flag !== '1') || (webp !== null && webp !== '1')) throw invalid();
    return { ...decodeMediaItems(payload), resumable: flag === '1', webp: webp === '1' };
  }, signal, current);
}

export function uploadMedia(file: File, key: string, signal?: AbortSignal): Promise<PrivateMediaItem> {
  validateFile(file, key);
  const path = `${WireRoutes.PrivateMediaUpload}?${new URLSearchParams({ name: file.name })}`;
  return post(path, FrameType.PrivateMediaItems, payload => uploaded(payload, file), signal, file,
    { [WireHeaders.ClientMutationId]: key, 'Content-Type': file.type });
}

export async function mediaDigest(file: Blob, signal: AbortSignal): Promise<string> {
  if (file.size < 1 || file.size > WireLimits.PrivateMediaBytes) throw invalid();
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function startMediaUpload(input: UploadManifest, current: string, signal: AbortSignal): Promise<MediaUploadState> {
  const { file, key, digest } = input;
  validateFile(file, key);
  const path = `${WireRoutes.PrivateMediaUploadBegin}?${new URLSearchParams({ name: file.name, type: file.type, length: String(file.size) })}`;
  return post(path, FrameType.PrivateMediaUploadState, payload => {
    const upload = decodeMediaUpload(payload);
    if (upload.length !== file.size) throw invalid();
    return upload;
  }, signal, undefined, { ...mediaHeader(current, digest), [WireHeaders.ClientMutationId]: key });
}

export function sendMediaPart(file: File, upload: MediaUploadState, part: number, body: Blob, digest: string,
  current: string, signal: AbortSignal): Promise<MediaUploadState> {
  const offset = part * upload.partSize;
  const path = itemPath(WireRoutes.PrivateMediaUploadPart, upload.id).replace('{part:int}', String(part)) + `?offset=${offset}`;
  return post(path, FrameType.PrivateMediaUploadState, payload => {
    const next = decodeMediaUpload(payload);
    if (next.id !== upload.id || next.length !== file.size || next.partSize !== upload.partSize ||
        next.reserved || !next.received.includes(part)) throw invalid();
    return next;
  }, signal, body, mediaHeader(current, digest));
}

export function finalizeMediaUpload(file: File, upload: MediaUploadState, current: string, signal: AbortSignal): Promise<PrivateMediaItem> {
  return post(itemPath(WireRoutes.PrivateMediaUploadFinalize, upload.id), FrameType.PrivateMediaItems, payload => {
    const value = uploaded(payload, file);
    if (upload.asset && value.id !== upload.asset) throw invalid();
    return value;
  }, signal, undefined, mediaHeader(current));
}

export function cancelMediaUpload(upload: MediaUploadState, current: string, signal: AbortSignal): Promise<void> {
  return post(itemPath(WireRoutes.PrivateMediaUploadCancel, upload.id), FrameType.EmptySuccess, decodeSuccess,
    signal, undefined, mediaHeader(current));
}

function decodeMediaUpload(payload: Uint8Array): MediaUploadState {
  const reader = new PodReader(payload);
  const id = reader.uuid();
  const length = reader.i32();
  const partSize = reader.i32();
  const expiresAt = Number(reader.i64());
  const reserved = reader.bool();
  const asset = reader.bool() ? reader.uuid() : undefined;
  const received = reader.i32s(320);
  reader.finish();
  const maximum = Math.ceil(length / partSize);
  if (!validId(id) || length < 1 || length > WireLimits.PrivateMediaBytes || partSize < 65536 || partSize > 2097152 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || (asset && (!validId(asset) || !reserved || received.length)) ||
      received.some((part, index) => part < 0 || part >= maximum || (index > 0 && part <= received[index - 1]))) throw invalid();
  return { id, length, partSize, expiresAt, reserved, asset, received };
}

function mediaHeader(current: string, digest?: string): Record<string, string> {
  if (!validSiteSessionId(current) || (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))) throw invalid();
  return { [WireHeaders.CurrentSession]: current, ...(digest ? { [WireHeaders.PrivateMediaDigest]: digest } : {}) };
}

function validateFile(file: File, key: string) {
  if (!validId(key) || file.size < 1 || file.size > WireLimits.PrivateMediaBytes || !formats.has(file.type)) throw invalid();
}

function uploaded(payload: Uint8Array, file: File): PrivateMediaItem {
  const page = decodeMediaItems(payload);
  if (page.hasMore || page.items.length !== 1 || page.items[0].name !== file.name ||
      page.items[0].format !== formats.get(file.type)) throw invalid();
  return page.items[0];
}

export function removeMedia(id: string, signal?: AbortSignal): Promise<void> {
  return post(itemPath(WireRoutes.PrivateMediaRemove, id), FrameType.EmptySuccess, decodeSuccess, signal);
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
