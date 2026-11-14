import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeInboxReplay } from '../../src/Contracts/inbox-replay.ts';
import { FrameType, WireHeaders, WireLayouts } from '../../src/Contracts/wire.generated.ts';

const bytes = Uint8Array.from(Buffer.from(readFileSync(new URL('./fixtures/inbox-replay.hex', import.meta.url), 'utf8').trim(), 'hex'));
const payload = () => decodeFrame(bytes, FrameType.InboxReplay).payload.slice();
const cursor = 'A'.repeat(54);

test('reads independently assembled inbox replay notifications and continuation', () => {
  const data = decodeInboxReplay(payload(), new Headers({ [WireHeaders.InboxReplayCursor]: cursor }));
  assert.deepEqual(data, {
    requiresResync: false,
    cursor,
    next: 702n,
    hasMore: true,
    events: [
      { sequence: 701n, kind: 12, conversationId: 1234567890123456n, messageId: 9102n, occurredAt: 1794659381000 },
      { sequence: 702n, kind: 13, conversationId: 1234567890123456n, messageId: 9102n, occurredAt: 1794659382000 },
    ],
  });
});

test('does not advance through missing data or accept unauthorized response state', () => {
  const headers = new Headers({ [WireHeaders.InboxReplayCursor]: cursor });
  const invalidEvent = payload();
  const event = new DataView(invalidEvent.buffer);
  event.setBigInt64(WireLayouts.InboxReplayHeaderBytes, 700n, true);
  assert.throws(() => decodeInboxReplay(invalidEvent, headers), ProtocolError);
  assert.throws(() => decodeInboxReplay(payload().subarray(0, -1), headers), ProtocolError);
  assert.throws(() => decodeInboxReplay(payload(), new Headers()), ProtocolError);

  const resync = new Uint8Array(WireLayouts.InboxReplayHeaderBytes);
  resync[0] = WireLayouts.InboxReplayVersion;
  resync[1] = WireLayouts.InboxReplayRequiresResync;
  assert.deepEqual(decodeInboxReplay(resync, new Headers()), { requiresResync: true });
  assert.throws(() => decodeInboxReplay(resync, headers), ProtocolError);
});
