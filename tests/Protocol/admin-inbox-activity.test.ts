import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFrame } from '../../src/Contracts/aeds.ts';
import { adminInbox } from '../../src/Contracts/admin-inbox.ts';
import { PodWriter } from '../../src/Contracts/binary.ts';
import { FrameType, WireHeaders } from '../../src/Contracts/wire.generated.ts';

test('activity queue accepts exact opaque cursor while legacy queue retains its own contract', async t => {
  const cursor = 'k'.repeat(75);
  const packet = new PodWriter();
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

  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    requests.push(path);
    return new Response(encodeFrame(FrameType.AdminInboxSharedPage, packet.finish()), {
      headers: { 'Content-Type': 'application/octet-stream', [WireHeaders.AdminInboxSharedRead]: '1',
        [WireHeaders.AdminInboxActivityOrder]: '1' },
    });
  });
  const signal = new AbortController().signal;
  const page = await adminInbox('unread', cursor, signal, true, 'activity');
  assert.equal(page.next, cursor);
  assert.deepEqual(page.rows.map(row => row.id), Array.from({ length: 24 }, (_, index) => BigInt(index + 1)));
  assert.match(requests[0], /status=unread&cursor=k{75}&shared=1&order=activity$/);
  await assert.rejects(adminInbox('', null, signal, true), /Invalid administrator inbox response/);
});
