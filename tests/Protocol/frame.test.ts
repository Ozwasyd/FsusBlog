import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { fixtureBytes } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeApiError, decodeFrame, decodeSuccess, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeArticleCommand, encodeArticleCommand, FrameType } from '../../src/Contracts/wire.generated.ts';

test('reads the pinned v1 ApiError with its HTTP semantics', () => {
  const frame = decodeFrame(fixtureBytes('api-error-v1.hex'), FrameType.ApiError);
  const error = decodeApiError(frame.payload, 403);
  equal(error.message, '权限不足');
  equal(error.details, 'role_required');
  equal(error.traceId, 'trace-123');
  equal(error.status, 403);
  equal(error.code, 5);
  equal(error.category, 3);
  throws(() => decodeApiError(frame.payload, 200), ProtocolError);
});

test('matches the independently assembled C# and TypeScript command vector', () => {
  const expected = fixtureBytes('article-command.hex');
  const command = {
    id: 0,
    expectedRevision: 0n,
    idempotencyKey: '00446688-2244-6688-99aa-bbccddeeff00',
    title: '独立向量',
    body: 'first draft 🐈\n',
  };
  deepStrictEqual(encodeFrame(FrameType.ArticleCommand, encodeArticleCommand(command)), expected);
  deepStrictEqual(decodeArticleCommand(decodeFrame(expected).payload), command);
});

test('rejects all one-bit mutations and truncated inputs across the frame', () => {
  const bytes = fixtureBytes('article-command.hex');
  for (let offset = 0; offset < bytes.length; offset++) {
    throws(() => decodeFrame(bytes.subarray(0, offset), FrameType.ArticleCommand), ProtocolError);
    for (let bit = 0; bit < 8; bit++) {
      bytes[offset] ^= 1 << bit;
      throws(() => decodeFrame(bytes, FrameType.ArticleCommand), ProtocolError);
      bytes[offset] ^= 1 << bit;
    }
  }
});

test('checks command payload even inside a valid frame', () => {
  const payload = decodeFrame(fixtureBytes('article-command.hex'), FrameType.ArticleCommand).payload;
  payload[32] = 255;
  const frame = encodeFrame(FrameType.ArticleCommand, payload);
  throws(() => decodeArticleCommand(decodeFrame(frame).payload), ProtocolError);
  throws(() => decodeSuccess(Uint8Array.of(1, 0, 1, 0)), ProtocolError);
});
