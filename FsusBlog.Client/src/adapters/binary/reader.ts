import type { SliceRef } from './types';

const decoder = new TextDecoder();

export function readInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
}

export function readInt64Number(bytes: Uint8Array, offset: number): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, true);
  return Number(value);
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
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return {
    offset: view.getInt32(0, true),
    length: view.getInt32(4, true)
  };
}

export function readSliceText(blob: Uint8Array, slice: SliceRef): string {
  if (slice.offset < 0 || slice.length < 0 || slice.offset + slice.length > blob.byteLength) {
    return '';
  }

  return decoder.decode(blob.subarray(slice.offset, slice.offset + slice.length));
}

export class BinaryReader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  readInt32(): number {
    if (this.remaining() < 4) throw new Error('binary_read_int32_overflow');
    const value = readInt32(this.bytes, this.offset);
    this.offset += 4;
    return value;
  }

  readInt64(): number {
    if (this.remaining() < 8) throw new Error('binary_read_int64_overflow');
    const value = readInt64Number(this.bytes, this.offset);
    this.offset += 8;
    return value;
  }

  readByte(): number {
    if (this.remaining() < 1) throw new Error('binary_read_byte_overflow');
    const value = readByte(this.bytes, this.offset);
    this.offset += 1;
    return value;
  }

  readSpan(length: number): Uint8Array {
    if (length < 0 || this.remaining() < length) throw new Error('binary_read_span_overflow');
    const span = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return span;
  }

  readBlob(): Uint8Array {
    const length = this.readInt32();
    return this.readSpan(length);
  }
}
