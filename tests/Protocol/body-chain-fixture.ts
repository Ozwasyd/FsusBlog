import { createHash } from 'node:crypto';

// Assemble revision-chain vectors with Node buffers independently of the protocol codec.
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function i32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}

export function i64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

export function text(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([i32(bytes.length), bytes]);
}
