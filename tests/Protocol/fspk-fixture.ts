// Independent FSPK v4 encoder for synthetic test pages without categories or tags.
import { WireLayouts as L } from '../../src/Contracts/wire.generated.ts';

export type FspkPosition = { offset: number; width: number; field: number };
type StringSlice = { offset: number; length: number };
type FspkDocument = {
  id: number;
  length: number;
  time: number;
  publication: bigint;
  title: StringSlice;
  summary?: StringSlice;
};
type FspkPosting = {
  id: number;
  frequencies: readonly [number, number, number];
  positions: readonly FspkPosition[];
};
export type FspkTerm = { hash: number; idf: number; postings: readonly FspkPosting[] };

const align8 = (value: number) => Math.ceil(value / 8) * 8;

export function packFspk(
  documents: readonly FspkDocument[],
  terms: readonly FspkTerm[],
  strings: readonly Uint8Array[],
  averageLength: number,
) {
  const postingBytes: number[] = [];
  const entries = terms.map(term => {
    const start = postingBytes.length;
    let previousId = 0;
    writeVarint(term.postings.length);
    for (const posting of term.postings) {
      writeVarint(posting.id - previousId);
      previousId = posting.id;
      postingBytes.push(...posting.frequencies);
      writeVarint(posting.positions.length);
      let previousPosition = 0;
      for (const position of posting.positions) {
        writeVarint(position.offset - previousPosition);
        writeVarint(position.width);
        writeVarint(position.field);
        previousPosition = position.offset;
      }
    }
    return { term, start, length: postingBytes.length - start };
  });

  const termAt = L.SearchShardHeaderSize;
  const documentAt = align8(termAt + terms.length * L.SearchTermRecordSize);
  const stringAt = align8(documentAt + documents.length * L.SearchDocumentRecordSize);
  const postingAt = align8(stringAt + strings.reduce((sum, chunk) => sum + chunk.length, 0));
  const payloadAt = L.SearchPackagePayloadOffset;
  const bytes = new Uint8Array(payloadAt + postingAt + postingBytes.length);
  const frame = new DataView(bytes.buffer);
  const shard = new DataView(bytes.buffer, payloadAt);

  frame.setUint32(0, L.SearchPackageMagic, true);
  frame.setUint32(4, L.SearchArtifactVersion, true);
  frame.setUint32(8, 1, true);
  frame.setUint32(L.SearchPackageEntryOffset + 8, payloadAt, true);
  frame.setUint32(L.SearchPackageEntryOffset + 12, shard.byteLength, true);
  [
    L.SearchShardMagic, L.SearchArtifactVersion, 0, 1, terms.length, documents.length, 0, 0, 0,
    termAt, documentAt, stringAt, stringAt, stringAt, stringAt, postingAt, postingBytes.length,
  ].forEach((value, index) => shard.setUint32(index * 4, value, true));
  shard.setFloat32(68, averageLength, true);
  for (const [index, { term, start, length }] of entries.entries()) {
    const at = termAt + index * L.SearchTermRecordSize;
    shard.setUint32(at, term.hash, true);
    shard.setFloat32(at + 4, term.idf, true);
    shard.setUint32(at + 8, start, true);
    shard.setUint32(at + 12, length, true);
    shard.setUint32(at + 16, Number(term.postings.some(row => row.positions.length > 0)), true);
  }
  for (const [index, document] of documents.entries()) {
    const at = documentAt + index * L.SearchDocumentRecordSize;
    shard.setUint32(at, document.id, true);
    shard.setUint16(at + 4, 65535, true);
    shard.setUint32(at + 20, document.length, true);
    shard.setBigInt64(at + 24, BigInt(document.time), true);
    shard.setUint32(at + 32, document.title.offset, true);
    shard.setUint16(at + 36, document.title.length, true);
    if (document.summary) {
      shard.setUint32(at + 40, document.summary.offset, true);
      shard.setUint16(at + 44, document.summary.length, true);
    }
    shard.setBigInt64(at + 52, 1n, true);
    shard.setUint32(at + 60, 1, true);
    shard.setBigInt64(at + 64, document.publication, true);
    shard.setUint32(at + 72, 1, true);
  }
  let cursor = payloadAt + stringAt;
  for (const chunk of strings) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  bytes.set(postingBytes, payloadAt + postingAt);
  return bytes;

  function writeVarint(value: number) {
    for (; value >= 128; value = Math.floor(value / 128)) postingBytes.push(value % 128 + 128);
    postingBytes.push(value);
  }
}
