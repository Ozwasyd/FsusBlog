import { decodeSuccess, encodeFrame, encodePod } from './aeds.ts';
import { ProtocolError } from './client.ts';
import { post, request } from './internal/http.ts';
import { decodePod, PodReader, ZERO_UUID } from './binary.ts';
import { decodeInboxReplied } from './inbox.ts';
import { watchInboxWake } from './inbox-wake.ts';
import { requestWithScopedPow } from './pow.ts';
import { FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export type AdminInboxFilter = AdminInboxLiveStatus | 'unread';
export type AdminInboxLiveStatus = '' | 'open' | 'pending' | 'closed' | 'system';

export function supportsAdminInboxLiveStatus(filter: AdminInboxFilter): filter is AdminInboxLiveStatus {
  return filter !== 'unread';
}
export type AdminInboxOrder = 'created' | 'activity';
export type AdminInboxStatus = 0 | 1 | 2;
export type AdminInboxRow = { id: bigint; account: string; subject: string; status: AdminInboxStatus; system: boolean; updated: number;
  unread: number | null };
export type AdminInboxMessage = { id: bigint; sender: 0 | 1 | 2; internal: boolean; at: number; body: string };
export type AdminInboxPage = { rows: AdminInboxRow[]; next: string | null; noticesEnabled: boolean; sharedAvailable: boolean;
  activityAvailable: boolean; liveEnabled: boolean };
export type AdminInboxThread = { conversation: AdminInboxRow; messages: AdminInboxMessage[]; previous: string | null; repliesEnabled: boolean;
  liveEnabled: boolean; version: string | null; readSnapshot: { token: string; through: bigint } | null };

export function adminInbox(filter: AdminInboxFilter, next: string | null, signal: AbortSignal, shared = false,
  order: AdminInboxOrder = 'created'): Promise<AdminInboxPage> {
  const query = new URLSearchParams();
  if (filter) query.set('status', filter);
  if (next) query.set('cursor', next);
  if (shared) query.set('shared', '1');
  if (order === 'activity') query.set('order', 'activity');
  const frame = shared ? FrameType.AdminInboxSharedPage : FrameType.AdminInboxPage;
  return request(`${WireRoutes.AdminInboxQueue}?${query}`, frame, (payload, headers) => {
    const { following, rows } = decodePod(payload, reader => {
      const following = cursor(reader, order === 'activity' ? 75 : 64);
      const rows = Array.from({ length: count(reader, following) }, () => row(reader, shared));
      if (new Set(rows.map(item => item.id)).size !== rows.length ||
          order === 'created' && rows.some((item, index) => index > 0 && item.id >= rows[index - 1].id)) throw invalid();
      return { following, rows };
    });
    const flag = headers.get(WireHeaders.AdminInboxNoticeEnabled);
    const capability = headers.get(WireHeaders.AdminInboxSharedRead);
    const activity = headers.get(WireHeaders.AdminInboxActivityOrder);
    const live = headers.get(WireHeaders.AdminInboxLive);
    if (flag !== null && flag !== '1' || capability !== null && capability !== '1' || shared && capability !== '1' ||
        activity !== null && activity !== '1' || order === 'activity' && activity !== '1' ||
        live !== null && (live !== '1' || !supportsAdminInboxLiveStatus(filter) || (filter === 'system' && !shared) ||
          next !== null || order !== 'created')) throw invalid();
    return { rows, next: following, noticesEnabled: flag === '1', sharedAvailable: capability === '1',
      activityAvailable: activity === '1', liveEnabled: live === '1' };
  }, signal);
}

export function adminInboxThread(id: bigint, before: string | null, signal: AbortSignal, shared = false): Promise<AdminInboxThread> {
  const path = WireRoutes.AdminInboxThread.replace('{id:long}', String(id));
  const query = new URLSearchParams();
  if (before) query.set('before', before);
  if (shared) query.set('shared', '1');
  const frame = shared ? FrameType.AdminInboxSharedThread : FrameType.AdminInboxThread;
  return request(`${path}?${query}`, frame, (payload, headers) => {
    const { conversation, previous, messages } = decodePod(payload, reader => {
      const conversation = row(reader, shared), previous = cursor(reader);
      const messages = Array.from({ length: count(reader, previous) }, () => ({ id: positive(reader.i64()), sender: kind(reader.i32()),
        internal: reader.bool(), at: time(reader.i64()), body: reader.text(16000) }));
      if (conversation.id !== id || !messages.length || messages.some((item, index) =>
        !item.body || index > 0 && item.id <= messages[index - 1].id)) throw invalid();
      return { conversation, previous, messages };
    });
    const flag = headers.get(WireHeaders.AdminInboxReplyEnabled);
    const live = headers.get(WireHeaders.AdminInboxLive);
    const version = headers.get(WireHeaders.AdminInboxVersion);
    const token = headers.get(WireHeaders.AdminInboxReadSnapshot);
    const through = shared && !before ? messages.filter(message => !message.internal).at(-1)?.id : undefined;
    if (flag !== null && flag !== '1' || live !== null && (live !== '1' || conversation.system) ||
        version !== null && !validVersion(version) ||
        token !== null && !validCursor(token) || (token === null) !== (through === undefined)) throw invalid();
    return { conversation, previous, messages, repliesEnabled: flag === '1', liveEnabled: live === '1', version,
      readSnapshot: token !== null && through !== undefined ? { token, through } : null };
  }, signal);
}

export function watchAdminInboxWake(scope: bigint | AdminInboxLiveStatus, signal: AbortSignal, refresh: () => void, onRevoked: () => void) {
  const query = typeof scope === 'string' && scope ? new URLSearchParams({ status: scope }) : undefined;
  if (scope === 'system') query?.set('shared', '1');
  const path = typeof scope === 'bigint' ? WireRoutes.AdminInboxWake.replace('{id:long}', String(scope)) :
    WireRoutes.AdminInboxQueueWake + (query ? `?${query}` : '');
  let seenDisconnect = false;
  watchInboxWake(signal, refresh, connected => {
    if (!connected) {
      seenDisconnect = true;
      return;
    }
    if (seenDisconnect) {
      seenDisconnect = false;
      refresh();
    }
  }, onRevoked, path);
}

export function acknowledgeAdminInboxRead(id: bigint, snapshot: NonNullable<AdminInboxThread['readSnapshot']>, signal: AbortSignal) {
  if (id <= 0n || !validCursor(snapshot.token) || snapshot.through <= 0n) throw invalid();
  const path = WireRoutes.AdminInboxAcknowledge.replace('{id:long}', String(id));
  return post(path, FrameType.EmptySuccess, (payload, headers) => {
    decodeSuccess(payload);
    const raw = headers.get(WireHeaders.AdminInboxUnread);
    if (raw === null || !/^(0|[1-9][0-9]{0,9})$/.test(raw) || Number(raw) > 0x7fffffff)
      throw invalid();
    return Number(raw);
  }, signal, encodePod(FrameType.ConversationReadRequest, f => f.i64(snapshot.through)),
    { [WireHeaders.AdminInboxReadSnapshot]: snapshot.token });
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
  const frame = adminReplyFrame(body);
  const at = (route: string) => route.replace('{id:long}', String(id));
  return requestWithScopedPow({
    challengePath: at(WireRoutes.AdminInboxReplyPow),
    submitPath: at(WireRoutes.AdminInboxReply),
    expected: FrameType.ConversationMessage,
    decode: payload => {
      const message = decodeInboxReplied(payload, id, 1);
      if (message.body !== body) throw invalid();
      return message;
    },
    body: frame,
    signal,
    headers: { [WireHeaders.ClientMutationId]: key },
  });
}

export function adminStatusFrame(status: AdminInboxStatus, reason: string) {
  kind(status);
  if (!reason.trim() || reason.trim().length > 256 || reason.includes('\0')) throw invalid();
  const bytes = new TextEncoder().encode(reason);
  if (bytes.length > 1024 || new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== reason) throw invalid();
  const payload = new Uint8Array(16 + bytes.length);
  const view = new DataView(payload.buffer);
  view.setInt32(0, status, true);
  view.setInt32(8, bytes.length, true);
  view.setInt32(12, bytes.length, true);
  payload.set(bytes, 16);
  return encodeFrame(FrameType.ConversationStatusRequest, payload);
}

export function decodeAdminStatusResult(payload: Uint8Array, target: AdminInboxStatus) {
  if (payload.byteLength !== 12) throw invalid();
  return decodePod(payload, reader => {
    const previous = kind(reader.i32()), current = kind(reader.i32());
    if (current !== target || reader.i32() !== (previous === current ? 1 : 0)) throw invalid();
    return { previous, current, changed: previous !== current };
  });
}

export async function adminChangeStatus(id: bigint, version: string, target: AdminInboxStatus, reason: string, signal: AbortSignal) {
  if (id <= 0n || BigInt.asIntN(64, id) !== id || !validVersion(version)) throw invalid();
  const frame = adminStatusFrame(target, reason);
  const at = (route: string) => route.replace('{id:long}', String(id));
  return requestWithScopedPow({
    challengePath: at(WireRoutes.AdminInboxStatusPow),
    submitPath: at(WireRoutes.AdminInboxStatus),
    expected: FrameType.ConversationStatusMutationResult,
    decode: payload => decodeAdminStatusResult(payload, target),
    body: frame,
    signal,
    headers: { [WireHeaders.AdminInboxVersion]: version },
  });
}

function validVersion(value: string) {
  return /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 0xffffffff;
}

function row(reader: PodReader, shared: boolean): AdminInboxRow {
  const item = { id: positive(reader.i64()), account: reader.uuid(), subject: reader.text(640), status: kind(reader.i32()),
    system: reader.bool(), updated: time(reader.i64()), unread: shared ? reader.i32() : null };
  if (item.account === ZERO_UUID || !item.subject || item.unread !== null && item.unread < 0)
    throw invalid();
  return item;
}

function cursor(reader: PodReader, length = 64) {
  const value = reader.text(100);
  if (value && !validCursor(value, length)) throw invalid();
  return value || null;
}

function validCursor(value: string, length = 64) { return value.length === length && /^[a-zA-Z0-9_-]+$/.test(value); }

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
