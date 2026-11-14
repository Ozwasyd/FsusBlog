import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts';
import { acknowledgeAdminInboxRead } from '../../src/Contracts/admin-inbox.ts';
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
