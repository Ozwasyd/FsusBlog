import type { CursorResponse } from '@/api/comment';
import type { PageResponse } from '@/api/article';
import { BinaryReader, readCountChecked } from './reader';

export function readPageEnvelope<T>(
  reader: BinaryReader,
  itemReader: (reader: BinaryReader, index: number) => T,
  countErrorCode: string
): PageResponse<T> {
  const total = reader.readInt32();
  const count = readCountChecked(reader, countErrorCode);
  const items: T[] = [];

  for (let i = 0; i < count; i++) {
    items.push(itemReader(reader, i));
  }

  return { items, total };
}

export function readCursorEnvelope<T>(
  reader: BinaryReader,
  itemReader: (reader: BinaryReader, index: number) => T,
  countErrorCode: string
): CursorResponse<T> {
  const nextCursorRaw = reader.readInt64();
  const hasMore = reader.readByte() === 1;
  const count = readCountChecked(reader, countErrorCode);
  const data: T[] = [];

  for (let i = 0; i < count; i++) {
    data.push(itemReader(reader, i));
  }

  return {
    data,
    nextCursor: nextCursorRaw === 0 ? null : String(nextCursorRaw),
    hasMore
  };
}

export function readArrayEnvelope<T>(
  reader: BinaryReader,
  itemReader: (reader: BinaryReader, index: number) => T,
  countErrorCode: string
): T[] {
  const count = readCountChecked(reader, countErrorCode);
  const items: T[] = [];

  for (let i = 0; i < count; i++) {
    items.push(itemReader(reader, i));
  }

  return items;
}
