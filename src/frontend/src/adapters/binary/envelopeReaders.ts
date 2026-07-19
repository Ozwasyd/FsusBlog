import type { BinaryPageResponse as PageResponse, CursorResponse } from '@/contracts/binaryApi';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readCountChecked } from '@/codecs/binary/reader';

function ensureConsumed(reader: BinaryReader, trailingErrorCode: string): void {
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, trailingErrorCode);
  }
}

export function readPageEnvelope<T>(
  reader: BinaryReader,
  itemReader: (reader: BinaryReader, index: number) => T,
  countErrorCode: string,
  trailingErrorCode: string
): PageResponse<T> {
  const total = reader.readInt32();
  const count = readCountChecked(reader, countErrorCode);
  const items: T[] = [];

  for (let i = 0; i < count; i++) {
    items.push(itemReader(reader, i));
  }

  ensureConsumed(reader, trailingErrorCode);

  return { items, total };
}

export function readCursorEnvelope<T>(
  reader: BinaryReader,
  itemReader: (reader: BinaryReader, index: number) => T,
  countErrorCode: string,
  trailingErrorCode: string
): CursorResponse<T> {
  const nextCursorRaw = reader.readInt64();
  const hasMore = reader.readByte() === 1;
  const count = readCountChecked(reader, countErrorCode);
  const data: T[] = [];

  for (let i = 0; i < count; i++) {
    data.push(itemReader(reader, i));
  }

  ensureConsumed(reader, trailingErrorCode);

  return {
    data,
    nextCursor: nextCursorRaw === 0 ? null : String(nextCursorRaw),
    hasMore
  };
}

export function readArrayEnvelope<T>(
  reader: BinaryReader,
  itemReader: (reader: BinaryReader, index: number) => T,
  countErrorCode: string,
  trailingErrorCode: string
): T[] {
  const count = readCountChecked(reader, countErrorCode);
  const items: T[] = [];

  for (let i = 0; i < count; i++) {
    items.push(itemReader(reader, i));
  }

  ensureConsumed(reader, trailingErrorCode);

  return items;
}
