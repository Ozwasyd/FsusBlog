import { ProtocolError, request } from './client.ts';
import { PodReader } from './binary.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export type AdminInboxFilter = '' | 'open' | 'pending' | 'closed';
export type AdminInboxRow = { id: bigint; account: string; subject: string; status: 0 | 1 | 2; system: boolean; updated: number };
export type AdminInboxMessage = { id: bigint; sender: 0 | 1 | 2; internal: boolean; at: number; body: string };
export type AdminInboxPage = { rows: AdminInboxRow[]; next: string | null };
export type AdminInboxThread = { conversation: AdminInboxRow; messages: AdminInboxMessage[]; previous: string | null };

export function adminInbox(filter: AdminInboxFilter, next: string | null, signal: AbortSignal): Promise<AdminInboxPage> {
  const query = new URLSearchParams();
  if (filter) query.set('status', filter);
  if (next) query.set('cursor', next);
  return request(`${WireRoutes.AdminInboxQueue}?${query}`, FrameType.AdminInboxPage, payload => {
    const reader = new PodReader(payload);
    const following = cursor(reader);
    const rows = Array.from({ length: count(reader, following) }, () => row(reader));
    if (rows.some((item, index) => index > 0 && item.id >= rows[index - 1].id)) throw invalid();
    reader.finish();
    return { rows, next: following };
  }, signal);
}

export function adminInboxThread(id: bigint, before: string | null, signal: AbortSignal): Promise<AdminInboxThread> {
  const path = WireRoutes.AdminInboxThread.replace('{id:long}', String(id));
  return request(before ? `${path}?${new URLSearchParams({ before })}` : path, FrameType.AdminInboxThread, payload => {
    const reader = new PodReader(payload);
    const conversation = row(reader);
    const previous = cursor(reader);
    const messages = Array.from({ length: count(reader, previous) }, () => ({ id: positive(reader.i64()), sender: kind(reader.i32()),
      internal: reader.bool(), at: time(reader.i64()), body: reader.text(16000) }));
    if (conversation.id !== id || !messages.length || messages.some((item, index) =>
      !item.body || index > 0 && item.id <= messages[index - 1].id)) throw invalid();
    reader.finish();
    return { conversation, previous, messages };
  }, signal);
}

function row(reader: PodReader): AdminInboxRow {
  const item = { id: positive(reader.i64()), account: reader.uuid(), subject: reader.text(640), status: kind(reader.i32()),
    system: reader.bool(), updated: time(reader.i64()) };
  if (item.account === '00000000-0000-0000-0000-000000000000' || !item.subject) throw invalid();
  return item;
}

function cursor(reader: PodReader) {
  const value = reader.text(100);
  if (value && !/^[a-zA-Z0-9_-]{64}$/.test(value)) throw invalid();
  return value || null;
}

function count(reader: PodReader, more: string | null) {
  const value = reader.i32();
  if (value < 0 || value > 24 || more && value !== 24) throw invalid();
  return value;
}

function kind(value: number): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) throw invalid();
  return value;
}

function positive(value: bigint) {
  if (value <= 0n) throw invalid();
  return value;
}

function time(value: bigint) {
  if (value <= 0n || value > 8_640_000_000_000_000n) throw invalid();
  return Number(value);
}

const invalid = () => new ProtocolError('Invalid administrator inbox response');
