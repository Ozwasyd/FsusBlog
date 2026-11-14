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

  i32(): number {
    return this.view(4).getInt32(0, true);
  }

  i32s(limit: number): number[] {
    const count = this.i32();
    if (count < 0 || count > limit || count > (this.payload.length - this.offset) / 4)
      throw new ProtocolError('Invalid AEDS collection length');
    return Array.from({ length: count }, () => this.i32());
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

  i32(value: number): void {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
      throw new ProtocolError('Value outside AEDS int32 range');
    this.number(4, view => view.setInt32(0, value, true));
  }

  i32s(values: readonly number[], limit: number): void {
    if (values.length > limit) throw new ProtocolError('AEDS collection exceeds its item limit');
    this.i32(values.length);
    for (const value of values) this.i32(value);
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
