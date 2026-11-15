import assert from 'node:assert/strict';
import { hexFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { inboxCreateFrame, inboxReplyFrame } from '../../src/Contracts/inbox-write.ts';
import { decodeInboxCreated, decodeInboxReplied } from '../../src/Contracts/inbox.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';
import { adminReplyFrame, adminStatusFrame, decodeAdminStatusResult } from '../../src/Contracts/admin-inbox.ts';

const fixture = (name: string) => Uint8Array.from(hexFixture(`${name}.hex`, 'strip'));

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

test('admin reply uses v1 packed string coordinates and multibyte UTF-8', () => {
  const bytes = decodeFrame(adminReplyFrame('A café 🐈'), FrameType.ConversationReplyRequest);
  assert.deepEqual(bytes.payload, Uint8Array.from(Buffer.from('000000000c0000000c0000004120636166c3a920f09f9088', 'hex')));
  assert.throws(() => adminReplyFrame('\ud800'));
});

test('administrator status preserves the fixed state, reason and result layouts', () => {
  const request = decodeFrame(adminStatusFrame(2, '待查 🐈'), FrameType.ConversationStatusRequest);
  assert.deepEqual(request.payload, Uint8Array.from(Buffer.from('02000000000000000b0000000b000000e5be85e69fa520f09f9088', 'hex')));
  const result = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
  assert.deepEqual(decodeAdminStatusResult(result('000000000200000000000000'), 2), { previous: 0, current: 2, changed: true });
  assert.deepEqual(decodeAdminStatusResult(result('020000000200000001000000'), 2), { previous: 2, current: 2, changed: false });
  assert.throws(() => decodeAdminStatusResult(result('020000000200000001010000'), 2));
  assert.throws(() => decodeAdminStatusResult(result('000000000200000000000000'), 1));
  assert.throws(() => adminStatusFrame(1, ' 🐈 '.repeat(100)));
  assert.throws(() => adminStatusFrame(1, '\ud800'));
});
