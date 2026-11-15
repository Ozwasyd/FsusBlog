import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeArticleSummary, encodeArticleSummaryCommand } from '../../src/Contracts/article-summary.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';

const key = '00112233-4455-6677-8899-aabbccddeeff';

test('manual summary save carries the exact CAS and a canonical empty clear', () => {
  const command = { id: 51, expectedRevision: 7n, idempotencyKey: key, text: '' };
  const payload = decodeFrame(encodeArticleSummaryCommand(command), FrameType.ArticleSummaryCommand).payload;
  equal(Buffer.from(payload).toString('hex'), '33000000070000000000000000112233445566778899aabbccddeeff00000000');
  throws(() => encodeArticleSummaryCommand({ ...command, text: 'a'.repeat(251) }), ProtocolError);
  throws(() => encodeArticleSummaryCommand({ ...command, text: 'bad\0' }), ProtocolError);
});

test('summary read retains the full UTF-8 bounds of an imported revision', () => {
  const text = '🧭'.repeat(512);
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(16);
  header.writeInt32LE(51);
  header.writeBigInt64LE(7n, 4);
  header.writeInt32LE(bytes.length, 12);
  const payload = Buffer.concat([header, bytes]);
  deepEqual(decodeArticleSummary(payload), { id: 51, revision: 7n, text });
  throws(() => decodeArticleSummary(payload.subarray(0, -1)), ProtocolError);
  throws(() => decodeArticleSummary(Buffer.concat([payload, Buffer.of(0)])), ProtocolError);
});
