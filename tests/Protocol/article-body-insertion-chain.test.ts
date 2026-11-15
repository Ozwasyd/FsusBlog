import { deepEqual, equal, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeArticleBodyInsertionsCommand, decodeDraftRevisionBodyInsertionChain, encodeArticleBodyInsertionsCommand,
} from '../../src/Contracts/article-body-insertion.ts';
import { FrameType, WireLimits } from '../../src/Contracts/wire.generated.ts';

const sourceBody = 'A🐈\r\nZ';
const body = '>' + sourceBody + '.';
const insertions = [{ offset: 0, length: 1 }, { offset: 7, length: 1 }] as const;
const command = {
  id: 17, expectedRevision: 11n, idempotencyKey: '11111111-1111-4111-8111-111111111111',
  title: 'One', body, insertions,
};

test('ordered body insertion save carries sequential UTF-16 coordinates', () => {
  const golden = Buffer.from(
    '110000000b0000000000000011111111111141118111111111111111030000004f6e650a0000003e41f09f90880d0a5a2e' +
    '0200000000000000010000000700000001000000',
    'hex',
  );
  const frame = encodeArticleBodyInsertionsCommand(command);
  equal(FrameType.ArticleBodyInsertionsCommand, 33037);
  deepEqual(Buffer.from(decodeFrame(frame, FrameType.ArticleBodyInsertionsCommand).payload), golden);
  deepEqual(decodeArticleBodyInsertionsCommand(golden), command);
  throws(() => decodeFrame(frame, FrameType.ArticleBodyInsertionCommand), ProtocolError);
  throws(() => decodeArticleBodyInsertionsCommand(golden.subarray(0, -1)), ProtocolError);
  for (const invalid of [
    [], Array.from({ length: 9 }, () => ({ offset: 0, length: 1 })),
    [insertions[0], { offset: 8, length: 1 }], [{ offset: 0, length: 0 }],
  ]) throws(() => encodeArticleBodyInsertionsCommand({ ...command, insertions: invalid }), ProtocolError);
});

test('saved insertion chain validates available edges, identity, length, and contiguous digest order', () => {
  // This packs the response independently of the production codec.
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  function i32(value: number) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    return bytes;
  }
  function i64(value: bigint) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(value);
    return bytes;
  }
  function text(value: string) {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([i32(bytes.length), bytes]);
  }

  const identity = { sourceDigest: hash(sourceBody), digest: hash(sourceBody), insertions: [] };
  const changed = { sourceDigest: identity.digest, digest: hash(body), insertions };
  const encode = (edges = [identity, changed], revision = 13n, available = true, from = sourceBody, to = body) =>
    Buffer.concat([i32(17), i64(revision), i64(11n), Uint8Array.of(available ? 1 : 0), text(from), text(to), i32(edges.length),
      ...edges.flatMap(edge => [text(edge.sourceDigest), text(edge.digest), i32(edge.insertions.length),
        ...edge.insertions.flatMap(operation => [i32(operation.offset), i32(operation.length)])]),
    ]);

  equal(FrameType.DraftRevisionBodyInsertionChain, 33038);
  deepEqual(decodeDraftRevisionBodyInsertionChain(encode()), {
    id: 17, revision: 13n, sourceRevision: 11n, available: true, sourceBody, body, edges: [identity, changed],
  });
  deepEqual(decodeDraftRevisionBodyInsertionChain(encode([], 40n, false, '', '')).edges, []);
  for (const invalid of [
    encode([identity], 13n),
    encode(Array.from({ length: WireLimits.ArticleBodyInsertionChainEdges + 1 }, () => identity), 20n),
    encode([{ ...identity, digest: changed.digest }, changed]),
    encode([identity, { ...changed, sourceDigest: changed.digest }]),
    encode([identity, { ...changed, insertions: [] }]),
    encode([identity, changed], 13n, false),
    encode([], 13n, false, sourceBody, ''),
    encode().subarray(0, -1), Buffer.concat([encode(), Uint8Array.of(0)]),
  ]) throws(() => decodeDraftRevisionBodyInsertionChain(invalid), ProtocolError);
});
