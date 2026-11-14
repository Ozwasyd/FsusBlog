import { decodeUtf8, ProtocolError } from './binary.ts';
import { WireLayouts, WireLimits } from './wire.generated.ts';

export type TaxonomyKind = 'category' | 'tag';
export type TaxonomyMetadata = Readonly<{ id: number; name: string; description: string | null }>;
export type TaxonomyListItem = Readonly<{ id: number; name: string; articleCount: number }>;

export function decodeTaxonomyList(payload: Uint8Array): TaxonomyListItem[] {
  const { view, records, blob } = taxonomyBody(payload);
  const count = view.getInt32(0, true);
  if (count < 0 || records + count * WireLayouts.TaxonomyListRecordSize !== payload.length)
    throw new ProtocolError('Invalid taxonomy list size');
  const items: TaxonomyListItem[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = records + index * WireLayouts.TaxonomyListRecordSize;
    const id = view.getInt32(offset, true);
    const articleCount = view.getInt32(offset + 4, true);
    const name = readSlice(view, offset + 8, blob, WireLimits.TaxonomyNameBytes);
    if (id <= 0 || seen.has(id) || articleCount < 0 || name.length === 0)
      throw new ProtocolError('Invalid taxonomy list record');
    seen.add(id);
    items.push({ id, name, articleCount });
  }
  return items;
}

export function decodeTaxonomyMetadata(payload: Uint8Array): TaxonomyMetadata {
  const { view, records, blob } = taxonomyBody(payload);
  if (records + WireLayouts.TaxonomyMetadataRecordSize !== payload.length)
    throw new ProtocolError('Invalid taxonomy metadata size');
  const id = view.getInt32(0, true);
  const name = readSlice(view, records, blob, WireLimits.TaxonomyNameBytes);
  const description = readSlice(view, records + 8, blob, WireLimits.TaxonomyDescriptionBytes);
  if (id <= 0 || name.length === 0) throw new ProtocolError('Invalid taxonomy metadata record');
  return { id, name, description: description || null };
}

function taxonomyBody(payload: Uint8Array) {
  if (payload.length < WireLayouts.TaxonomyHeaderBytes || payload.length > WireLimits.MaxPayloadBytes)
    throw new ProtocolError('Invalid taxonomy payload size');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const length = view.getInt32(4, true);
  const records = WireLayouts.TaxonomyHeaderBytes + length;
  if (length < 0 || records > payload.length) throw new ProtocolError('Invalid taxonomy blob size');
  return { view, records, blob: payload.subarray(WireLayouts.TaxonomyHeaderBytes, records) };
}

function readSlice(view: DataView, field: number, blob: Uint8Array, max: number): string {
  const offset = view.getInt32(field, true);
  const length = view.getInt32(field + 4, true);
  if (offset < 0 || length < 0 || length > max || offset + length > blob.length)
    throw new ProtocolError('Invalid taxonomy text slice');
  const text = decodeUtf8(blob.subarray(offset, offset + length));
  if (text.includes('\0')) throw new ProtocolError('Invalid taxonomy text');
  return text;
}
