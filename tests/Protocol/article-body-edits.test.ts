import { deepEqual, equal, throws } from 'node:assert/strict';
import { hash, i32, i64, text } from './body-chain-fixture.ts';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeArticleBodyEditsCommand, decodeDraftRevisionBodyEditChain, encodeArticleBodyEditsCommand,
} from '../../src/Contracts/article-body-edits.ts';
import { FrameType, WireLimits } from '../../src/Contracts/wire.generated.ts';

const edits = [{ offset: 0, removedLength: 4, insert: '' }, { offset: 1, removedLength: 5, insert: 'tail' }];
const input = { id: 17, expectedRevision: 11n, idempotencyKey: '11111111-1111-4111-8111-111111111111',
  title: 'One', body: 'Xtail', edits };

test('body edit commands encode exact deletion and replacement without changing insertion frames', () => {
  // Independently packed from the field lengths, network-order UUID and UTF-8 strings.
  const bytes = Buffer.from(
    '110000000b0000000000000011111111111141118111111111111111030000004f6e6505000000587461696c' +
    '020000000000000004000000000000000100000005000000040000007461696c',
    'hex',
  );
  const frame = encodeArticleBodyEditsCommand(input);
  equal(FrameType.ArticleBodyEditsCommand, 33042);
  deepEqual(Buffer.from(decodeFrame(frame, FrameType.ArticleBodyEditsCommand).payload), bytes);
  deepEqual(decodeArticleBodyEditsCommand(bytes), input);
  throws(() => decodeFrame(frame, FrameType.ArticleBodyInsertionsCommand), ProtocolError);
  throws(() => decodeArticleBodyEditsCommand(bytes.subarray(0, -1)), ProtocolError);
  throws(() => encodeArticleBodyEditsCommand({ ...input, edits: [{ offset: 0, removedLength: 0, insert: '' }] }), ProtocolError);
  throws(() => encodeArticleBodyEditsCommand({ ...input, edits: [{ offset: 0, removedLength: 4, insert: '\0' }] }), ProtocolError);
  throws(() => encodeArticleBodyEditsCommand({ ...input, edits: [{ ...edits[0], offset: 99 }, edits[1]] }), ProtocolError);

  const padding = '北'.repeat(Math.floor(WireLimits.BodyBytes / 5));
  const transientEdits = [{ offset: 0, removedLength: 0, insert: padding }, { offset: 0, removedLength: padding.length, insert: padding },
    { offset: 0, removedLength: padding.length, insert: '' }, ...edits];
  throws(() => encodeArticleBodyEditsCommand({ ...input, edits: transientEdits }), ProtocolError);
});

test('body edit chains accept unchanged data and preserve the exact order of written splices', () => {
  // Packs one identity edge and an edit edge outside the production codec.
  const sourceBody = 'dropXother';
  const from = hash(sourceBody);
  const to = hash(input.body);
  const payload = Buffer.concat([i32(17), i64(13n), i64(11n), Uint8Array.of(1), text(sourceBody), text(input.body), i32(2),
    text(from), text(from), i32(0),
    text(from), text(to), i32(edits.length), ...edits.flatMap(edit => [i32(edit.offset), i32(edit.removedLength), text(edit.insert)]),
  ]);
  equal(FrameType.DraftRevisionBodyEditChain, 33043);
  deepEqual(decodeDraftRevisionBodyEditChain(payload), {
    id: 17, revision: 13n, sourceRevision: 11n, available: true, sourceBody, body: input.body,
    edges: [{ sourceDigest: from, digest: from, edits: [] }, { sourceDigest: from, digest: to, edits }],
  });
  throws(() => decodeDraftRevisionBodyEditChain(payload.subarray(0, -1)), ProtocolError);
  const wrongRevision = Buffer.from(payload);
  wrongRevision.writeBigInt64LE(14n, 4);
  throws(() => decodeDraftRevisionBodyEditChain(wrongRevision), ProtocolError);
  const unavailableWithEvidence = Buffer.from(payload);
  unavailableWithEvidence[20] = 0;
  throws(() => decodeDraftRevisionBodyEditChain(unavailableWithEvidence), ProtocolError);
});
