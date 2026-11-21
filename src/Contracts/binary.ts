const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

export class PodReader {
  private readonly payload: Uint8Array;
  private offset = 0;

  constructor(payload: Uint8Array) {
    this.payload = payload;
  }

  u8(): number {
    return this.take(1)[0];
  }

  i32(): number {
    return this.view(4).getInt32(0, true);
  }

  i32s(limit: number): number[] {
    return this.list(limit, 4, reader => reader.i32());
  }

  list<T>(limit: number, minItemBytes: number, readItem: (reader: PodReader) => T): T[] {
    if (!Number.isSafeInteger(minItemBytes) || minItemBytes < 1)
      throw new ProtocolError('Invalid AEDS item size');
    const count = this.i32();
    if (count < 0 || count > limit || count > (this.payload.length - this.offset) / minItemBytes)
      throw new ProtocolError('Invalid AEDS collection length');
    return Array.from({ length: count }, () => readItem(this));
  }

  i64(): bigint {
    return this.view(8).getBigInt64(0, true);
  }

  bool(): boolean {
    const value = this.take(1)[0];
    if (value !== 0 && value !== 1) throw new ProtocolError('Invalid AEDS boolean');
    return value === 1;
  }

  uuid(): string {
    const hex = Array.from(this.take(16), value => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }

  text(limit: number): string {
    const length = this.i32();
    if (length < 0 || length > limit) throw new ProtocolError('Invalid AEDS text length');
    return decodeUtf8(this.take(length));
  }

  bytes(limit: number): Uint8Array {
    const length = this.i32();
    if (length < 0 || length > limit) throw new ProtocolError('Invalid AEDS byte collection length');
    return this.take(length);
  }

  fixedBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new ProtocolError('Invalid AEDS fixed byte length');
    return this.take(length);
  }

  finish(): void {
    if (this.offset !== this.payload.length) throw new ProtocolError('Trailing AEDS payload data');
  }

  private view(length: number): DataView {
    const part = this.take(length);
    return new DataView(part.buffer, part.byteOffset, part.byteLength);
  }

  private take(length: number): Uint8Array {
    const start = this.offset;
    if (length > this.payload.length - start) throw new ProtocolError('Truncated AEDS payload');
    this.offset += length;
    return this.payload.subarray(start, this.offset);
  }
}

export class PodWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff)
      throw new ProtocolError('Value outside AEDS uint8 range');
    this.parts.push(Uint8Array.of(value));
  }

  i32(value: number): void {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
      throw new ProtocolError('Value outside AEDS int32 range');
    this.number(4, view => view.setInt32(0, value, true));
  }

  i32s(values: readonly number[], limit: number): void {
    this.list(values, limit, (writer, value) => writer.i32(value));
  }

  list<T>(values: readonly T[], limit: number, writeItem: (writer: PodWriter, value: T) => void): void {
    if (values.length > limit) throw new ProtocolError('AEDS collection exceeds its item limit');
    this.i32(values.length);
    for (const value of values) writeItem(this, value);
  }

  i64(value: bigint): void {
    if (BigInt.asIntN(64, value) !== value) throw new ProtocolError('Value outside AEDS int64 range');
    this.number(8, view => view.setBigInt64(0, value, true));
  }

  bool(value: boolean): void {
    this.parts.push(Uint8Array.of(value ? 1 : 0));
  }

  uuid(value: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      throw new ProtocolError('Invalid AEDS UUID');
    const hex = value.replaceAll('-', '');
    this.parts.push(Uint8Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16)));
  }

  text(value: string, limit: number): void {
    if (value.length > limit) throw new ProtocolError('AEDS text exceeds its byte limit');
    const bytes = encoder.encode(value);
    if (bytes.length > limit) throw new ProtocolError('AEDS text exceeds its byte limit');
    if (decodeUtf8(bytes) !== value) throw new ProtocolError('Invalid AEDS source text');
    this.i32(bytes.length);
    this.parts.push(bytes);
  }

  bytes(value: Uint8Array): void {
    this.i32(value.length);
    this.fixedBytes(value);
  }

  fixedBytes(value: Uint8Array): void {
    this.parts.push(value);
  }

  finish(): Uint8Array {
    const bytes = new Uint8Array(this.parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of this.parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  }

  private number(length: number, write: (view: DataView) => void): void {
    const bytes = new Uint8Array(length);
    write(new DataView(bytes.buffer));
    this.parts.push(bytes);
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ProtocolError('Invalid AEDS UTF-8');
  }
}
