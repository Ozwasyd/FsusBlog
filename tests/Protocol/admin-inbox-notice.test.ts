import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminNoticeFrame, isNoticeRecipient } from '../../src/Contracts/admin-inbox-notice.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeInboxCreated, decodeSystemNoticeSent } from '../../src/Contracts/inbox.ts';
import { readFileSync } from 'node:fs';

test('administrator system notice uses an explicit current account UUID and strict UTF-8', () => {
  const recipient = '8c4e12f2-0f5c-4271-b028-1cf376a3b3bd';
  const encoded = decodeFrame(adminNoticeFrame(recipient, '系统', 'A café 🐈'), FrameType.AdminInboxNotice);
  assert.equal(Buffer.from(encoded.payload).toString('hex'),
    '8c4e12f20f5c4271b0281cf376a3b3bd06000000e7b3bbe7bb9f0c0000004120636166c3a920f09f9088');
  assert.equal(isNoticeRecipient('00000000-0000-0000-0000-000000000000'), false);
  assert.throws(() => adminNoticeFrame('', 'x', 'message'));
  assert.throws(() => adminNoticeFrame(recipient, '', ' '));
  assert.throws(() => adminNoticeFrame(recipient, 'x', '\ud800'));
});

test('system notice differentiates the shared v1 detail frame from account creation and honors replay', () => {
  const fixture = readFileSync(new URL('./fixtures/conversation-detail-v2.hex', import.meta.url), 'utf8').replace(/\s/g, '');
  const base = decodeFrame(Buffer.from(fixture, 'hex'), FrameType.ConversationDetailV2).payload.slice();
  assert.throws(() => decodeSystemNoticeSent(base));
  base[32] = 1;
  base[34] = 0;
  assert.throws(() => decodeInboxCreated(base));
  assert.equal(decodeSystemNoticeSent(base).replayed, false);
  base[34] = 1;
  assert.equal(decodeSystemNoticeSent(base).replayed, true);
  assert.throws(() => decodeSystemNoticeSent(base.subarray(0, base.length - 1)));
});
