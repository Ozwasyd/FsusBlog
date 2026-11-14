import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import { request, validSiteSessionId } from './client.ts';
import { decodeInboxCreated, decodeInboxReplied } from './inbox.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import { FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

const textEncoder = new TextEncoder();

export function inboxCreateFrame(subject: string, body: string) {
  const title = bounded(subject, 640);
  const message = bounded(body, 16000);
  const payload = new Uint8Array(20 + title.length + message.length);
  const view = new DataView(payload.buffer);
  view.setInt32(4, title.length, true);
  view.setInt32(8, title.length, true);
  view.setInt32(12, message.length, true);
  view.setInt32(16, title.length + message.length, true);
  payload.set(title, 20);
  payload.set(message, 20 + title.length);
  return encodeFrame(FrameType.ConversationCreateRequest, payload);
}

export function inboxReplyFrame(readThrough: bigint, body: string) {
  if (readThrough <= 0n || BigInt.asIntN(64, readThrough) !== readThrough) throw invalid();
  const message = bounded(body, 16000);
  const payload = new Uint8Array(20 + message.length);
  const view = new DataView(payload.buffer);
  view.setBigInt64(0, readThrough, true);
  view.setInt32(12, message.length, true);
  view.setInt32(16, message.length, true);
  payload.set(message, 20);
  return encodeFrame(FrameType.AccountConversationReplyRequest, payload);
}

export function createInboxConversation(subject: string, body: string, key: string, signal: AbortSignal, session: string): Promise<bigint> {
  return send(WireRoutes.InboxCreatePowChallenge, WireRoutes.InboxList, key, inboxCreateFrame(subject, body),
    FrameType.ConversationDetailV2, payload => decodeInboxCreated(payload).id, signal, session);
}

export function replyInboxConversation(id: bigint, readThrough: bigint, body: string, key: string, signal: AbortSignal, session: string): Promise<bigint> {
  if (id <= 0n || BigInt.asIntN(64, id) !== id) throw invalid();
  return send(WireRoutes.InboxReplyPowChallenge.replace('{id:long}', String(id)), WireRoutes.InboxReply.replace('{id:long}', String(id)),
    key, inboxReplyFrame(readThrough, body), FrameType.ConversationMessage, payload => decodeInboxReplied(payload, id).id, signal, session);
}

export function inboxComposeEnabled(signal: AbortSignal): Promise<boolean> {
  return request(WireRoutes.InboxWriteAvailability, FrameType.EmptySuccess, (payload, headers) => {
    decodeSuccess(payload);
    const enabled = headers.get(WireHeaders.InboxWriteEnabled);
    if (enabled !== '0' && enabled !== '1') throw invalid();
    return enabled === '1';
  }, signal);
}

async function send(challengePath: string, commandPath: string, key: string, frame: Uint8Array<ArrayBuffer>, response: FrameType,
  accept: (payload: Uint8Array) => bigint, signal: AbortSignal, session: string): Promise<bigint> {
  if (!/^[A-Za-z0-9_:.\-]{1,64}$/.test(key) || !validSiteSessionId(session)) throw invalid();
  const scopeNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  const headers = { [WireHeaders.ClientMutationId]: key, [WireHeaders.CurrentSession]: session };
  const challenge = await request(challengePath, FrameType.PowChallenge, decodePowChallenge, signal, 'POST', frame,
    { ...headers, [WireHeaders.PowClientNonce]: scopeNonce });
  const work = await solveScopedPow(challenge, scopeNonce, signal);
  signal.throwIfAborted();
  return request(commandPath, response, accept, signal, 'POST', frame,
    { ...headers, [WireHeaders.PowProof]: encodePowProof(challenge, work, scopeNonce) });
}

function bounded(value: string, limit: number): Uint8Array {
  if (value.length > limit || value.includes('\0')) throw invalid();
  const encoded = textEncoder.encode(value);
  if (encoded.length > limit || decodeUtf8(encoded) !== value) throw invalid();
  return encoded;
}

const invalid = () => new ProtocolError('Invalid inbox command or confirmation');
