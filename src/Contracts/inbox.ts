import { decodeUtf8, ProtocolError } from './binary.ts';
import { validReplayCursor } from './inbox-replay.ts';
import { WireHeaders } from './wire.generated.ts';

const subjectBytes = 640;
const bodyBytes = 16_000;
const listRecordBytes = 76;
const threadHeaderBytes = 52;
const messageRecordBytes = 48;
const cursorEnvelope = 0x4d534743;

type InboxStatus = 0 | 1 | 2;
type InboxSender = 0 | 1 | 2;
export type InboxFilter = 'all' | 'unread' | 'system' | 'open' | 'pending' | 'closed';

export interface InboxMessage {
  readonly id: bigint;
  readonly sender: InboxSender;
  readonly createdAt: number;
  readonly name: string | null;
  readonly body: string;
}

interface InboxConversation {
  readonly id: bigint;
  readonly subject: string;
  readonly status: InboxStatus;
  readonly isSystem: boolean;
  readonly unreadCount: number;
  readonly lastMessageAt: number;
}

export interface InboxListItem extends InboxConversation {
  readonly preview: string | null;
}

export interface InboxListPage {
  readonly items: readonly InboxListItem[];
  readonly total: number;
  readonly next: string | null;
  readonly replayCursor: string | null;
}

export interface InboxThread extends InboxConversation {
  readonly readThrough: bigint;
  readonly previous: bigint | null;
  readonly messages: readonly InboxMessage[];
}

const invalid = (): never => { throw new ProtocolError('Invalid AEDS inbox payload'); };

class Packet {
  readonly data: DataView;
  private readonly payload: Uint8Array;
  private arena = 0;

  constructor(payload: Uint8Array) {
    this.payload = payload;
    this.data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  bounds(start: number, length: number): void {
    if (start < 0 || length < 0 || start > this.payload.length - length) invalid();
  }

  i32(offset: number): number {
    this.bounds(offset, 4);
    return this.data.getInt32(offset, true);
  }

  i64(offset: number): bigint {
    this.bounds(offset, 8);
    return this.data.getBigInt64(offset, true);
  }

  position(offset: number): bigint {
    const value = this.i64(offset);
    return value > 0n ? value : invalid();
  }

  time(offset: number): number {
    const value = Number(this.i64(offset));
    return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000 ? value : invalid();
  }

  flag(offset: number): boolean {
    this.bounds(offset, 1);
    const value = this.data.getUint8(offset);
    if (value !== 0 && value !== 1) invalid();
    return value === 1;
  }

  reserved(offset: number, size: number): void {
    this.bounds(offset, size);
    for (let index = 0; index < size; index++) if (this.data.getUint8(offset + index) !== 0) invalid();
  }

  inline(offset: number, length: number): string {
    this.bounds(offset, length);
    return decodeUtf8(this.payload.subarray(offset, offset + length));
  }

  setArena(fieldsEnd: number): void {
    this.arena = fieldsEnd + 4;
    if (this.i32(fieldsEnd) !== this.payload.length - this.arena) invalid();
  }

  text(offset: number, limit: number): string {
    const start = this.i32(offset);
    const length = this.i32(offset + 4);
    if (start < 0 || length > limit) invalid();
    return this.inline(this.arena + start, length);
  }
}

function knownValue(packet: Packet, offset: number): 0 | 1 | 2 {
  const value = packet.i32(offset);
  return value === 0 || value === 1 || value === 2 ? value : invalid();
}

function unread(packet: Packet, offset: number): number {
  const value = packet.i32(offset);
  return value >= 0 ? value : invalid();
}

const validListCursor = (value: string) => /^[A-Za-z0-9_-]{32}$/.test(value);

export function decodeInboxList(payload: Uint8Array, headers: Headers): InboxListPage {
  const packet = new Packet(payload);
  let next: string | null = null;
  let offset = 0;
  if (packet.i32(0) === cursorEnvelope) {
    if (packet.i32(4) !== 1 || !packet.flag(8) || packet.i32(9) !== 32) invalid();
    next = packet.inline(13, 32);
    if (!validListCursor(next)) invalid();
    offset = 45;
  }
  const total = packet.i32(offset);
  const count = packet.i32(offset + 4);
  if (count < 0 || count > 50 || total < count || next !== null && count === 0) invalid();
  const first = offset + 8;
  packet.setArena(first + count * listRecordBytes);

  const items: InboxListItem[] = [];
  const ids = new Set<bigint>();
  for (let index = 0; index < count; index++) {
    const start = first + index * listRecordBytes;
    const id = packet.position(start);
    if (ids.has(id)) invalid();
    ids.add(id);
    const state = knownValue(packet, start + 8);
    const canReply = packet.flag(start + 33);
    const hasPreview = packet.flag(start + 34);
    if (canReply !== (state !== 2)) invalid();
    packet.reserved(start + 35, 1);
    let preview: string | null = null;
    if (hasPreview) {
      knownValue(packet, start + 44);
      packet.time(start + 48);
      const hasName = packet.flag(start + 56);
      packet.reserved(start + 57, 3);
      if (hasName !== Boolean(packet.text(start + 60, subjectBytes))) invalid();
      preview = packet.text(start + 68, bodyBytes);
    } else {
      packet.reserved(start + 44, 32);
    }
    packet.time(start + 24);
    items.push({ id, status: state, unreadCount: unread(packet, start + 12), lastMessageAt: packet.time(start + 16),
      isSystem: packet.flag(start + 32), subject: packet.text(start + 36, subjectBytes), preview });
  }
  const replayCursor = headers.get(WireHeaders.InboxReplayCursor);
  if (replayCursor !== null && !validReplayCursor(replayCursor)) invalid();
  return { items, total, next, replayCursor };
}

export function decodeInboxThread(payload: Uint8Array): InboxThread {
  return decodeThread(payload, false);
}

export function decodeInboxCreated(payload: Uint8Array): InboxThread {
  return decodeThread(payload, true);
}

function decodeThread(payload: Uint8Array, created: boolean): InboxThread {
  const packet = new Packet(payload);
  const id = packet.position(0);
  const state = knownValue(packet, 8);
  const readThrough = packet.position(24);
  const flags = created ? 32 : 40;
  const header = created ? threadHeaderBytes - 8 : threadHeaderBytes;
  const previous = created ? 0n : packet.i64(32);
  const isSystem = packet.flag(flags);
  const canReply = packet.flag(flags + 1);
  const hasPreviousOrReplayed = packet.flag(flags + 2);
  if (previous < 0n || canReply !== (state !== 2) || (!created && hasPreviousOrReplayed !== (previous > 0n))) invalid();
  packet.reserved(flags + 3, 1);
  const count = packet.i32(header);
  if (count < (created ? 1 : 0) || count > 50 || (created && isSystem)) invalid();
  const first = header + 4;
  packet.setArena(first + count * messageRecordBytes);
  const messages: InboxMessage[] = [];
  let lastMessage = 0n;
  for (let index = 0; index < count; index++) {
    const message = readMessage(packet, first + index * messageRecordBytes, id);
    if (message.id <= lastMessage) invalid();
    lastMessage = message.id;
    messages.push(message);
  }
  if (count > 0 && lastMessage !== readThrough) invalid();
  return { id, status: state, unreadCount: unread(packet, 12), lastMessageAt: packet.time(16), readThrough,
    previous: previous === 0n ? null : previous, isSystem, subject: packet.text(flags + 4, subjectBytes), messages };
}

export function decodeInboxReplied(payload: Uint8Array, conversation: bigint, expectedSender: InboxSender = 0): InboxMessage {
  const packet = new Packet(payload);
  packet.setArena(messageRecordBytes);
  const message = readMessage(packet, 0, conversation);
  if (message.sender !== expectedSender) invalid();
  return message;
}

function readMessage(packet: Packet, start: number, conversation: bigint): InboxMessage {
  if (packet.position(start + 8) !== conversation) invalid();
  const hasName = packet.flag(start + 28);
  packet.flag(start + 29);
  packet.reserved(start + 30, 2);
  const name = packet.text(start + 32, subjectBytes);
  if (hasName !== Boolean(name)) invalid();
  return { id: packet.position(start), sender: knownValue(packet, start + 16), createdAt: packet.time(start + 20),
    name: hasName ? name : null, body: packet.text(start + 40, bodyBytes) };
}
