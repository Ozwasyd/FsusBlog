const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
export const isNonZeroUuid = (value: string): boolean =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) && value.toLowerCase() !== ZERO_UUID;
export const isValidUnixMs = (value: bigint): boolean => value >= -62_135_596_800_000n && value <= 253_402_300_799_999n;
export const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const dataView = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

export class ByteView {
  readonly data: Uint8Array;
  readonly view: DataView;
  private readonly fail: (field: string) => never;

  constructor(data: Uint8Array, fail: (field: string) => never) {
    this.data = data;
    this.view = dataView(data);
    this.fail = fail;
  }

  get length(): number { return this.data.byteLength; }
  private at(offset: number, length: number, field = 'range'): DataView {
    if (offset < 0 || length < 0 || offset > this.length - length) this.fail(field);
    return this.view;
  }
  u8(at: number): number { return this.at(at, 1, 'byte offset').getUint8(at); }
  u16(at: number): number { return this.at(at, 2, 'uint16 offset').getUint16(at, true); }
  u32(at: number): number { return this.at(at, 4, 'uint32 offset').getUint32(at, true); }
  i32(at: number): number { return this.at(at, 4, 'int32 offset').getInt32(at, true); }
  i64(at: number): bigint { return this.at(at, 8, 'int64 offset').getBigInt64(at, true); }
  f32(at: number): number { return this.at(at, 4, 'float32 offset').getFloat32(at, true); }
  span(offset: number, length: number, field = 'byte slice'): Uint8Array {
    this.at(offset, length, field);
    return this.data.subarray(offset, offset + length);
  }
  sub(start: number, end: number): Uint8Array { return this.span(start, end - start, 'range'); }
  record(offset: number, length: number): ByteView { return new ByteView(this.span(offset, length), this.fail); }
  zero(offset: number, length: number): void {
    if (this.span(offset, length, 'reserved bytes').some(Boolean)) this.fail('reserved bytes');
  }
  timestamp(at: number, allowZero = true): number {
    const value = this.i64(at);
    if ((!allowZero && value === 0n) || !isValidUnixMs(value)) this.fail(allowZero ? 'timestamp' : 'publish timestamp');
    return Number(value);
  }
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

  optional<T>(read: (reader: PodReader) => T): T | null {
    return this.bool() ? read(this) : null;
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
    const hex = toHex(this.take(16));
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
    return dataView(this.take(length));
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

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff)
      throw new ProtocolError('Value outside AEDS uint8 range');
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  i32(value: number): this {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
      throw new ProtocolError('Value outside AEDS int32 range');
    return this.number(4, view => view.setInt32(0, value, true));
  }

  i32s(values: readonly number[], limit: number): this {
    return this.list(values, limit, (writer, value) => writer.i32(value));
  }

  list<T>(values: readonly T[], limit: number, writeItem: (writer: PodWriter, value: T) => void): this {
    if (values.length > limit) throw new ProtocolError('AEDS collection exceeds its item limit');
    this.i32(values.length);
    for (const value of values) writeItem(this, value);
    return this;
  }

  optional<T>(value: T | null | undefined, writeItem: (writer: PodWriter, value: T) => void): this {
    this.bool(value !== null && value !== undefined);
    if (value !== null && value !== undefined) writeItem(this, value);
    return this;
  }

  i64(value: bigint): this {
    if (BigInt.asIntN(64, value) !== value) throw new ProtocolError('Value outside AEDS int64 range');
    return this.number(8, view => view.setBigInt64(0, value, true));
  }

  bool(value: boolean): this {
    this.parts.push(Uint8Array.of(value ? 1 : 0));
    return this;
  }

  uuid(value: string): this {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      throw new ProtocolError('Invalid AEDS UUID');
    const hex = value.replaceAll('-', '');
    this.parts.push(Uint8Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16)));
    return this;
  }

  text(value: string, limit: number): this {
    if (value.length > limit) throw new ProtocolError('AEDS text exceeds its byte limit');
    const bytes = encoder.encode(value);
    if (bytes.length > limit) throw new ProtocolError('AEDS text exceeds its byte limit');
    if (decodeUtf8(bytes) !== value) throw new ProtocolError('Invalid AEDS source text');
    this.i32(bytes.length);
    this.parts.push(bytes);
    return this;
  }

  bytes(value: Uint8Array): this {
    return this.i32(value.length).fixedBytes(value);
  }

  fixedBytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
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

  private number(length: number, write: (view: DataView) => void): this {
    const bytes = new Uint8Array(length);
    write(new DataView(bytes.buffer));
    this.parts.push(bytes);
    return this;
  }
}

export function writePod(write: (writer: PodWriter) => void): Uint8Array {
  const writer = new PodWriter();
  write(writer);
  return writer.finish();
}

export function decodePod<T>(
  payload: Uint8Array, read: (reader: PodReader) => T, maxPayload?: number, onLimit?: () => ProtocolError,
): T {
  if (maxPayload !== undefined && payload.length > maxPayload) throw onLimit ? onLimit() : new ProtocolError('AEDS payload exceeds limit');
  const reader = new PodReader(payload);
  const value = read(reader);
  reader.finish();
  return value;
}

export function decodeFixedText(bytes: Uint8Array, onPadding?: () => ProtocolError, requireNull = false): string {
  const end = bytes.indexOf(0);
  if (end < 0) {
    if (requireNull) throw onPadding ? onPadding() : new ProtocolError('Invalid AEDS text padding');
    return decodeUtf8(bytes);
  }
  if (bytes.subarray(end).some(Boolean)) throw onPadding ? onPadding() : new ProtocolError('Invalid AEDS text padding');
  return decodeUtf8(bytes.subarray(0, end));
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ProtocolError('Invalid AEDS UTF-8');
  }
}
