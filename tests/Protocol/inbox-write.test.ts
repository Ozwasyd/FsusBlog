import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { inboxCreateFrame, inboxReplyFrame } from '../../src/Contracts/inbox-write.ts';
import { decodeInboxCreated, decodeInboxReplied } from '../../src/Contracts/inbox.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';

const fixture = (name: string) => Uint8Array.from(Buffer.from(readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8').replace(/\s/g, ''), 'hex'));

test('inbox writes preserve the fixed v1 AEDS request and response layouts', () => {
  assert.deepEqual(inboxCreateFrame('申诉', 'A café 🐈'), fixture('conversation-create-request'));
  const expectedReply = fixture('conversation-reply-request');
  const read = decodeFrame(expectedReply, FrameType.AccountConversationReplyRequest).payload;
  assert.deepEqual(inboxReplyFrame(new DataView(read.buffer, read.byteOffset).getBigInt64(0, true), 'A café 🐈'), expectedReply);
  const created = decodeFrame(fixture('conversation-detail-v2'), FrameType.ConversationDetailV2).payload;
  const replied = decodeFrame(fixture('conversation-message-frame'), FrameType.ConversationMessage).payload;
  const coordinates = new DataView(replied.buffer, replied.byteOffset);
  assert.ok(decodeInboxCreated(created).id > 0n);
  assert.equal(decodeInboxReplied(replied, coordinates.getBigInt64(8, true)).id, coordinates.getBigInt64(0, true));
  assert.throws(() => decodeInboxReplied(replied, coordinates.getBigInt64(8, true) + 1n));
  assert.throws(() => decodeInboxCreated(created.subarray(0, created.length - 1)));
});
