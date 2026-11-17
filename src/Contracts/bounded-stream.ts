import { ProtocolError } from './aeds.ts';

export async function collectBounded(body: ReadableStream<Uint8Array<ArrayBuffer>>, limit: number, overflow: string,
  { allowLargerBacking = false } = {}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const length = await consumeBounded(body, limit, overflow, chunk => { chunks.push(chunk); });
  if (chunks.length === 1 && (allowLargerBacking || chunks[0].buffer.byteLength === length)) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function consumeBounded(body: ReadableStream<Uint8Array<ArrayBuffer>>, limit: number, overflow: string,
  accept: (chunk: Uint8Array<ArrayBuffer>, offset: number) => void): Promise<number> {
  const reader = body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return offset;
      if (value.length > limit - offset) {
        await reader.cancel();
        throw new ProtocolError(overflow);
      }
      accept(value, offset);
      offset += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}
