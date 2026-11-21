import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts';
import { acknowledgeAdminInboxRead, watchAdminInboxWake } from '../../src/Contracts/admin-inbox.ts';
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts';

test('shared inbox ack posts the original visible snapshot and decodes the fixed success marker', async t => {
  const snapshot = { token: 'd'.repeat(64), through: 16777218n };
  const mocked = t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, WireRoutes.AdminInboxAcknowledge.replace('{id:long}', '73'));
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get(WireHeaders.AdminInboxReadSnapshot), snapshot.token);
    const frame = decodeFrame(init.body, FrameType.ConversationReadRequest);
    assert.equal(new DataView(frame.payload.buffer, frame.payload.byteOffset).getBigInt64(0, true), snapshot.through);
    return new Response(encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0)), {
      headers: { 'Content-Type': 'application/octet-stream', [WireHeaders.AdminInboxUnread]: '3' },
    });
  });
  assert.equal(await acknowledgeAdminInboxRead(73n, snapshot, new AbortController().signal), 3);
  assert.equal(mocked.mock.callCount(), 1);
});

test('watchAdminInboxWake skips redundant refresh on initial connect but refreshes on wake and reconnect', t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    closed = false;
    readonly url: URL;
    readonly protocol: string;
    constructor(url: URL, protocol: string) {
      this.url = url;
      this.protocol = protocol;
      sockets.push(this);
    }
    close() { this.closed = true; }
  }
  const prevSocket = globalThis.WebSocket;
  const prevLocation = globalThis.location;
  const scheduled: Array<() => void> = [];
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://admin.example/admin/interaction', origin: 'https://admin.example', protocol: 'https:' } });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => { scheduled.push(fn); return scheduled.length; } });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: () => {} });
  t.after(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: prevSocket });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: prevLocation });
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: prevSetTimeout });
    Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: prevClearTimeout });
  });

  let refreshes = 0;
  let revoked = 0;
  const ac = new AbortController();
  watchAdminInboxWake(42n, ac.signal, () => { refreshes++; }, () => { revoked++; });
  assert.equal(sockets.length, 1);

  // Initial connect must NOT trigger a redundant refetch.
  sockets[0]!.onopen?.();
  assert.equal(refreshes, 0);

  // Incoming wake frame refreshes immediately.
  const wakeFrame = encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0));
  sockets[0]!.onmessage?.({ data: wakeFrame.buffer.slice(wakeFrame.byteOffset, wakeFrame.byteOffset + wakeFrame.byteLength) });
  assert.equal(refreshes, 1);

  // Disconnect then reconnect MUST refresh to recover missed offline events.
  sockets[0]!.onclose?.({ code: 4001 });
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  assert.equal(sockets.length, 2);
  sockets[1]!.onopen?.();
  assert.equal(refreshes, 2);

  // 1008 revocation notifies onRevoked without scheduling reconnect.
  sockets[1]!.onclose?.({ code: 1008 });
  assert.equal(revoked, 1);
  assert.equal(scheduled.length, 1);
  ac.abort();
});
