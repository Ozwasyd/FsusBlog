import { encodeFrame } from './aeds.ts';
import { ProtocolError } from './client.ts';
import { PodWriter } from './binary.ts';
import { decodeSystemNoticeSent } from './inbox.ts';
import { requestWithScopedPow } from './pow.ts';
import { FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export function isNoticeRecipient(account: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account) &&
    account !== '00000000-0000-0000-0000-000000000000';
}

export function adminNoticeFrame(account: string, subject: string, body: string) {
  if (!isNoticeRecipient(account) || !body.trim() || body.includes('\0') || subject.includes('\0'))
    throw new ProtocolError('Invalid administrator notice input');
  const writer = new PodWriter();
  writer.uuid(account);
  writer.text(subject, 640);
  writer.text(body, 16000);
  return encodeFrame(FrameType.AdminInboxNotice, writer.finish());
}

export function newNoticeEventId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const full = new DataView(bytes.buffer).getBigUint64(0, true);
  return BigInt.asUintN(63, full) || 1n;
}

export async function adminSendNotice(account: string, subject: string, body: string, sourceEvent: bigint, signal: AbortSignal) {
  if (sourceEvent <= 0n || BigInt.asIntN(64, sourceEvent) !== sourceEvent)
    throw new ProtocolError('Invalid system notice source event ID');
  const frame = adminNoticeFrame(account, subject, body);
  return requestWithScopedPow({
    challengePath: WireRoutes.AdminInboxSendNoticePow,
    submitPath: WireRoutes.AdminInboxSendNotice,
    expected: FrameType.ConversationDetailV2,
    decode: decodeSystemNoticeSent,
    body: frame,
    signal,
    headers: { [WireHeaders.SourceEventId]: String(sourceEvent) },
  });
}
