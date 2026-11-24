import { encodePod } from './aeds.ts';
import { dataView, isNonZeroUuid } from './binary.ts';
import { ProtocolError } from './client.ts';
import { decodeSystemNoticeSent } from './inbox.ts';
import { requestWithScopedPow } from './pow.ts';
import { FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export const isNoticeRecipient = isNonZeroUuid;

export function adminNoticeFrame(account: string, subject: string, body: string) {
  if (!isNoticeRecipient(account) || !body.trim() || body.includes('\0') || subject.includes('\0'))
    throw new ProtocolError('Invalid administrator notice input');
  return encodePod(FrameType.AdminInboxNotice, w => w.uuid(account).text(subject, 640).text(body, 16000));
}

export function newNoticeEventId() {
  const full = dataView(crypto.getRandomValues(new Uint8Array(8))).getBigUint64(0, true);
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
