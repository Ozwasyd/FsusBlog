import { encodeFrame } from './aeds.ts';
import { ProtocolError, request } from './client.ts';
import { PodReader } from './binary.ts';
import { decodeInboxReplied } from './inbox.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import { FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export type AdminInboxFilter = '' | 'open' | 'pending' | 'closed';
export type AdminInboxRow = { id: bigint; account: string; subject: string; status: 0 | 1 | 2; system: boolean; updated: number };
export type AdminInboxMessage = { id: bigint; sender: 0 | 1 | 2; internal: boolean; at: number; body: string };
export type AdminInboxPage = { rows: AdminInboxRow[]; next: string | null };
export type AdminInboxThread = { conversation: AdminInboxRow; messages: AdminInboxMessage[]; previous: string | null; repliesEnabled: boolean };

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
  return request(before ? `${path}?${new URLSearchParams({ before })}` : path, FrameType.AdminInboxThread, (payload, headers) => {
    const reader = new PodReader(payload);
    const conversation = row(reader);
    const previous = cursor(reader);
    const messages = Array.from({ length: count(reader, previous) }, () => ({ id: positive(reader.i64()), sender: kind(reader.i32()),
      internal: reader.bool(), at: time(reader.i64()), body: reader.text(16000) }));
    if (conversation.id !== id || !messages.length || messages.some((item, index) =>
      !item.body || index > 0 && item.id <= messages[index - 1].id)) throw invalid();
    reader.finish();
    const flag = headers.get(WireHeaders.AdminInboxReplyEnabled);
    if (flag !== null && flag !== '1') throw invalid();
    return { conversation, previous, messages, repliesEnabled: flag === '1' };
  }, signal);
}

export function adminReplyFrame(body: string) {
  if (!body.trim() || body.length > 16000 || body.includes('\0')) throw invalid();
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > 16000 || new TextDecoder().decode(bytes) !== body) throw invalid();
  const payload = new Uint8Array(12 + bytes.length);
  const view = new DataView(payload.buffer);
  view.setInt32(4, bytes.length, true);
  view.setInt32(8, bytes.length, true);
  payload.set(bytes, 12);
  return encodeFrame(FrameType.ConversationReplyRequest, payload);
}

export async function adminReply(id: bigint, body: string, key: string, signal: AbortSignal) {
  if (id <= 0n || BigInt.asIntN(64, id) !== id || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) throw invalid();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const frame = adminReplyFrame(body);
  const at = (route: string) => route.replace('{id:long}', String(id));
  const challenge = await request(at(WireRoutes.AdminInboxReplyPow), FrameType.PowChallenge, decodePowChallenge, signal, 'POST', frame,
    { [WireHeaders.ClientMutationId]: key, [WireHeaders.PowClientNonce]: nonce });
  const work = await solveScopedPow(challenge, nonce, signal);
  const proof = encodePowProof(challenge, work, nonce);
  return request(at(WireRoutes.AdminInboxReply), FrameType.ConversationMessage, payload => {
    const message = decodeInboxReplied(payload, id, 1);
    if (message.body !== body) throw invalid();
    return message;
  }, signal, 'POST', frame, { [WireHeaders.ClientMutationId]: key, [WireHeaders.PowProof]: proof });
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
