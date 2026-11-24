import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { acknowledgeAdminInboxRead, adminInbox, adminReplyFrame, adminStatusFrame, decodeAdminStatusResult, watchAdminInboxWake } from '../../src/Contracts/admin-inbox.ts';
import { adminNoticeFrame, isNoticeRecipient } from '../../src/Contracts/admin-inbox-notice.ts';
import { decodeInboxCreated, decodeInboxReplied, decodeSystemNoticeSent } from '../../src/Contracts/inbox.ts';
import { decodeInboxReplay } from '../../src/Contracts/inbox-replay.ts';
import { inboxCreateFrame, inboxReplyFrame } from '../../src/Contracts/inbox-write.ts';
import { FrameType, WireHeaders, WireLayouts, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { captureFetch, framedFixture, frameResponse, hexBytes, hexFixture, podFrame, withI64 } from './fixture-source.ts';
import { emptySuccessFrame, replaceProperty } from './step-up-fixture.ts';

const fixture = (name: string) => Uint8Array.from(hexFixture(`${name}.hex`, 'strip'));

test('shared inbox ack posts the original visible snapshot and decodes the fixed success marker', async t => {
  const snapshot = { token: 'd'.repeat(64), through: 16777218n };
  const calls = captureFetch(t, ({ url, method, headers, body }) => {
    assert.equal(url, WireRoutes.AdminInboxAcknowledge.replace('{id:long}', '73'));
    assert.equal(method, 'POST');
    assert.equal(headers.get(WireHeaders.AdminInboxReadSnapshot), snapshot.token);
    const frame = decodeFrame(body, FrameType.ConversationReadRequest);
    assert.equal(new DataView(frame.payload.buffer, frame.payload.byteOffset).getBigInt64(0, true), snapshot.through);
    return frameResponse(emptySuccessFrame(), { [WireHeaders.AdminInboxUnread]: '3' });
  });
  assert.equal(await acknowledgeAdminInboxRead(73n, snapshot, new AbortController().signal), 3);
  assert.equal(calls.length, 1);
});

test('watchAdminInboxWake skips redundant refresh on initial connect but refreshes on wake and reconnect', t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    closed = false;
    url: URL;
    protocol: string;
    constructor(url: URL, protocol: string) { this.url = url; this.protocol = protocol; sockets.push(this); }
    close() { this.closed = true; }
  }
  const scheduled: Array<() => void> = [];
  replaceProperty(t, globalThis, 'WebSocket', FakeSocket);
  replaceProperty(t, globalThis, 'location', { href: 'https://admin.example/admin/interaction', origin: 'https://admin.example', protocol: 'https:' });
  replaceProperty(t, globalThis, 'setTimeout', (fn: () => void) => { scheduled.push(fn); return scheduled.length; });
  replaceProperty(t, globalThis, 'clearTimeout', () => {});

  let [refreshes, revoked] = [0, 0];
  const ac = new AbortController();
  watchAdminInboxWake(42n, ac.signal, () => { refreshes++; }, () => { revoked++; });
  assert.equal(sockets.length, 1);
  sockets[0]!.onopen?.();
  assert.equal(refreshes, 0);

  const wakeFrame = emptySuccessFrame();
  sockets[0]!.onmessage?.({ data: wakeFrame.buffer.slice(wakeFrame.byteOffset, wakeFrame.byteOffset + wakeFrame.byteLength) });
  assert.equal(refreshes, 1);

  sockets[0]!.onclose?.({ code: 4001 });
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  assert.equal(sockets.length, 2);
  sockets[1]!.onopen?.();
  assert.equal(refreshes, 2);

  sockets[1]!.onclose?.({ code: 1008 });
  assert.equal(revoked, 1);
  assert.equal(scheduled.length, 1);
  ac.abort();
});

test('activity queue accepts exact opaque cursor while legacy queue retains its own contract', async t => {
  const cursor = 'k'.repeat(75);
  const frame = podFrame(FrameType.AdminInboxSharedPage, packet => {
    packet.text(cursor, 100);
    packet.i32(24);
    for (let id = 1; id <= 24; id++) {
      packet.i64(BigInt(id));
      packet.uuid('4b95e43a-f694-4af4-a4c2-c6c14e05e825');
      packet.text(`Support case ${id}`, 640);
      packet.i32(0);
      packet.bool(false);
      packet.i64(1650000000103n);
      packet.i32(1);
    }
  });
  const calls = captureFetch(t, () => frameResponse(frame, {
    [WireHeaders.AdminInboxSharedRead]: '1', [WireHeaders.AdminInboxActivityOrder]: '1',
  }));
  const signal = new AbortController().signal;
  const page = await adminInbox('unread', cursor, signal, true, 'activity');
  assert.equal(page.next, cursor);
  assert.deepEqual(page.rows.map(row => row.id), Array.from({ length: 24 }, (_, index) => BigInt(index + 1)));
  assert.match(calls[0].url, /status=unread&cursor=k{75}&shared=1&order=activity$/);
  await assert.rejects(adminInbox('', null, signal, true), /Invalid administrator inbox response/);
});

test('administrator system notice uses an explicit current account UUID and strict UTF-8', () => {
  const recipient = '8c4e12f2-0f5c-4271-b028-1cf376a3b3bd';
  const encoded = decodeFrame(adminNoticeFrame(recipient, '系统', 'A café 🐈'), FrameType.AdminInboxNotice);
  assert.equal(Buffer.from(encoded.payload).toString('hex'),
    '8c4e12f20f5c4271b0281cf376a3b3bd06000000e7b3bbe7bb9f0c0000004120636166c3a920f09f9088');
  assert.equal(isNoticeRecipient('00000000-0000-0000-0000-000000000000'), false);
  for (const [to, subj, body] of [['', 'x', 'message'], [recipient, '', ' '], [recipient, 'x', '\ud800']] as const)
    assert.throws(() => adminNoticeFrame(to, subj, body));
});

test('system notice differentiates the shared v1 detail frame from account creation and honors replay', () => {
  const base = framedFixture('conversation-detail-v2.hex', FrameType.ConversationDetailV2, 'strip').slice();
  assert.throws(() => decodeSystemNoticeSent(base));
  base[32] = 1;
  base[34] = 0;
  assert.throws(() => decodeInboxCreated(base));
  assert.equal(decodeSystemNoticeSent(base).replayed, false);
  base[34] = 1;
  assert.equal(decodeSystemNoticeSent(base).replayed, true);
  assert.throws(() => decodeSystemNoticeSent(base.subarray(0, -1)));
});

test('inbox writes preserve the fixed v1 AEDS request and response layouts', () => {
  assert.deepEqual(inboxCreateFrame('申诉', 'A café 🐈'), fixture('conversation-create-request'));
  const expectedReply = fixture('conversation-reply-request');
  const read = decodeFrame(expectedReply, FrameType.AccountConversationReplyRequest).payload;
  assert.deepEqual(inboxReplyFrame(new DataView(read.buffer, read.byteOffset).getBigInt64(0, true), 'A café 🐈'), expectedReply);
  const created = framedFixture('conversation-detail-v2.hex', FrameType.ConversationDetailV2, 'strip');
  const replied = framedFixture('conversation-message-frame.hex', FrameType.ConversationMessage, 'strip');
  const coordinates = new DataView(replied.buffer, replied.byteOffset);
  assert.ok(decodeInboxCreated(created).id > 0n);
  assert.equal(decodeInboxReplied(replied, coordinates.getBigInt64(8, true)).id, coordinates.getBigInt64(0, true));
  assert.throws(() => decodeInboxReplied(replied, coordinates.getBigInt64(8, true) + 1n));
  assert.throws(() => decodeInboxCreated(created.subarray(0, -1)));
});

test('admin reply uses v1 packed string coordinates and multibyte UTF-8', () => {
  const bytes = decodeFrame(adminReplyFrame('A café 🐈'), FrameType.ConversationReplyRequest);
  assert.deepEqual(bytes.payload, Uint8Array.from(hexBytes('000000000c0000000c0000004120636166c3a920f09f9088')));
  assert.throws(() => adminReplyFrame('\ud800'));
});

test('administrator status preserves the fixed state, reason and result layouts', () => {
  const request = decodeFrame(adminStatusFrame(2, '待查 🐈'), FrameType.ConversationStatusRequest);
  assert.deepEqual(request.payload, Uint8Array.from(hexBytes('02000000000000000b0000000b000000e5be85e69fa520f09f9088')));
  assert.deepEqual(decodeAdminStatusResult(Uint8Array.from(hexBytes('000000000200000000000000')), 2), { previous: 0, current: 2, changed: true });
  assert.deepEqual(decodeAdminStatusResult(Uint8Array.from(hexBytes('020000000200000001000000')), 2), { previous: 2, current: 2, changed: false });
  assert.throws(() => decodeAdminStatusResult(Uint8Array.from(hexBytes('020000000200000001010000')), 2));
  assert.throws(() => decodeAdminStatusResult(Uint8Array.from(hexBytes('000000000200000000000000')), 1));
  assert.throws(() => adminStatusFrame(1, ' 🐈 '.repeat(100)));
  assert.throws(() => adminStatusFrame(1, '\ud800'));
});

test('inbox replay reads notifications, continuation, resync, and rejects invalid state', () => {
  const replay = framedFixture('inbox-replay.hex', FrameType.InboxReplay);
  const cursor = 'A'.repeat(54);
  const headers = new Headers({ [WireHeaders.InboxReplayCursor]: cursor });
  assert.deepEqual(decodeInboxReplay(replay.slice(), headers), {
    requiresResync: false, cursor, next: 702n, hasMore: true,
    events: [
      { sequence: 701n, kind: 12, conversationId: 1234567890123456n, messageId: 9102n, occurredAt: 1794659381000 },
      { sequence: 702n, kind: 13, conversationId: 1234567890123456n, messageId: 9102n, occurredAt: 1794659382000 },
    ],
  });
  assert.throws(() => decodeInboxReplay(withI64(replay, WireLayouts.InboxReplayHeaderBytes, 700n), headers), ProtocolError);
  assert.throws(() => decodeInboxReplay(replay.subarray(0, -1), headers), ProtocolError);
  assert.throws(() => decodeInboxReplay(replay, new Headers()), ProtocolError);

  const resync = new Uint8Array(WireLayouts.InboxReplayHeaderBytes);
  resync[0] = WireLayouts.InboxReplayVersion;
  resync[1] = WireLayouts.InboxReplayRequiresResync;
  assert.deepEqual(decodeInboxReplay(resync, new Headers()), { requiresResync: true });
  assert.throws(() => decodeInboxReplay(resync, headers), ProtocolError);
});
