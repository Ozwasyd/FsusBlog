import { AppErrorCode, createAppError } from '@/utils/appError';
import type { SliceRef } from './types';

const decoder = new TextDecoder();

export function readInt32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  );
}

export function readInt64Number(bytes: Uint8Array, offset: number): number {
  const low = BigInt(
    ((bytes[offset] ?? 0))
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  ) & 0xffffffffn;
  const high = BigInt(
    ((bytes[offset + 4] ?? 0))
    | ((bytes[offset + 5] ?? 0) << 8)
    | ((bytes[offset + 6] ?? 0) << 16)
    | ((bytes[offset + 7] ?? 0) << 24)
  ) & 0xffffffffn;
  return Number(BigInt.asIntN(64, low | (high << 32n)));
}

export function readByte(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

export function readFixedUtf8(bytes: Uint8Array, offset: number, length: number): string {
  const end = offset + length;
  let actualEnd = offset;
  while (actualEnd < end && bytes[actualEnd] !== 0) {
    actualEnd++;
  }

  return decoder.decode(bytes.subarray(offset, actualEnd));
}

export function readSliceRef(bytes: Uint8Array, offset: number): SliceRef {
  return {
    offset: readInt32(bytes, offset),
    length: readInt32(bytes, offset + 4)
  };
}

export function readSliceText(blob: Uint8Array, slice: SliceRef): string {
  if (slice.offset < 0 || slice.length < 0 || slice.offset + slice.length > blob.byteLength) {
    return '';
  }

  return decoder.decode(blob.subarray(slice.offset, slice.offset + slice.length));
}

export function readCountChecked(reader: BinaryReader, errorCode: string): number {
  const count = reader.readInt32();
  if (count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return count;
}

export function readIsoDate64(bytes: Uint8Array, offset: number): string {
  return new Date(readInt64Number(bytes, offset)).toISOString();
}

export function readNullableId64(bytes: Uint8Array, offset: number): string | null {
  const value = readInt64Number(bytes, offset);
  return value === 0 ? null : String(value);
}

export function readBlobText(pod: Uint8Array, blob: Uint8Array, sliceOffset: number): string {
  return readSliceText(blob, readSliceRef(pod, sliceOffset));
}

export function readFixedTextNullable(bytes: Uint8Array, offset: number, length: number): string | null {
  const value = readFixedUtf8(bytes, offset, length).trim();
  return value.length === 0 ? null : value;
}

export class BinaryReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  readInt32(): number {
    if (this.remaining() < 4) throw createAppError(AppErrorCode.ProtocolFailure, 'binary_read_int32_overflow');
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readInt64(): number {
    if (this.remaining() < 8) throw createAppError(AppErrorCode.ProtocolFailure, 'binary_read_int64_overflow');
    const value = Number(this.view.getBigInt64(this.offset, true));
    this.offset += 8;
    return value;
  }

  readByte(): number {
    if (this.remaining() < 1) throw createAppError(AppErrorCode.ProtocolFailure, 'binary_read_byte_overflow');
    const value = readByte(this.bytes, this.offset);
    this.offset += 1;
    return value;
  }

  readSpan(length: number): Uint8Array {
    if (length < 0 || this.remaining() < length) throw createAppError(AppErrorCode.ProtocolFailure, 'binary_read_span_overflow');
    const span = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return span;
  }

  readBlob(): Uint8Array {
    const length = this.readInt32();
    return this.readSpan(length);
  }
}
