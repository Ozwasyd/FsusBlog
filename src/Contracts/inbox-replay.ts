import { ProtocolError } from './binary.ts';
import { WireHeaders, WireLayouts, WireLimits } from './wire.generated.ts';

export type InboxEventKind = typeof WireLayouts.InboxConversationUpsert | typeof WireLayouts.InboxMessageAppend |
  typeof WireLayouts.InboxReadUpdated;

export interface InboxReplayEvent {
  readonly sequence: bigint;
  readonly kind: InboxEventKind;
  readonly conversationId: bigint;
  readonly messageId: bigint;
  readonly occurredAt: number;
}

export type InboxReplay = Readonly<{
  requiresResync: false;
  cursor: string;
  next: bigint;
  hasMore: boolean;
  events: readonly InboxReplayEvent[];
}> | Readonly<{ requiresResync: true }>;

export function validReplayCursor(value: string): boolean {
  return value.length === WireLimits.InboxReplayCursorChars && /^[A-Za-z0-9_-]+$/.test(value);
}

export function decodeInboxReplay(payload: Uint8Array, headers: Headers): InboxReplay {
  if (payload.length < WireLayouts.InboxReplayHeaderBytes) throw new ProtocolError('Truncated inbox replay page');
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = data.getUint8(1);
  if (data.getUint8(0) !== WireLayouts.InboxReplayVersion || data.getUint16(2, true) !== 0 ||
      (flags & ~(WireLayouts.InboxReplayHasMore | WireLayouts.InboxReplayRequiresResync)) !== 0)
    throw new ProtocolError('Unknown inbox replay format');
  const hasMore = (flags & WireLayouts.InboxReplayHasMore) !== 0;
  const requiresResync = (flags & WireLayouts.InboxReplayRequiresResync) !== 0;
  const count = data.getInt32(4, true);
  const next = data.getBigInt64(8, true);
  const cursor = headers.get(WireHeaders.InboxReplayCursor);
  if (count < 0 || count > WireLimits.InboxReplayMaxEvents || next < 0n ||
      payload.length !== WireLayouts.InboxReplayHeaderBytes + count * WireLayouts.InboxReplayEventBytes ||
      (hasMore && count === 0) || (requiresResync && (hasMore || count > 0 || cursor !== null)))
    throw new ProtocolError('Invalid inbox replay page');

  if (requiresResync) return { requiresResync: true };
  if (cursor === null || !validReplayCursor(cursor)) throw new ProtocolError('Missing or invalid inbox replay cursor');
  const events: InboxReplayEvent[] = [];
  for (let index = 0; index < count; index++) {
    const offset = WireLayouts.InboxReplayHeaderBytes + index * WireLayouts.InboxReplayEventBytes;
    const sequence = data.getBigInt64(offset, true);
    const kind = data.getInt32(offset + 8, true);
    const conversationId = data.getBigInt64(offset + 12, true);
    const messageId = data.getBigInt64(offset + 20, true);
    const occurredAt = Number(data.getBigInt64(offset + 28, true));
    if (sequence <= 0n || sequence !== next - BigInt(count - 1 - index) || conversationId <= 0n || messageId <= 0n ||
        !Number.isSafeInteger(occurredAt) || Math.abs(occurredAt) > 8_640_000_000_000_000 ||
        (kind !== WireLayouts.InboxConversationUpsert && kind !== WireLayouts.InboxMessageAppend && kind !== WireLayouts.InboxReadUpdated))
      throw new ProtocolError('Invalid inbox replay event');
    events.push({ sequence, kind, conversationId, messageId, occurredAt });
  }
  return { requiresResync: false, cursor, next, hasMore, events };
}
