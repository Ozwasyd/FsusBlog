import { encodeFrame } from './aeds.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { encodeAdminModerationIntent, FrameType, WireRoutes, type AdminModerationIntent } from './wire.generated.ts';

export async function proveAdminModeration(intent: AdminModerationIntent, signal?: AbortSignal): Promise<string> {
  const body = encodeFrame(FrameType.AdminModerationIntent, encodeAdminModerationIntent(intent));
  const assertion = await requestPasskeyAssertion(WireRoutes.AdminStepUpBegin, signal, body, true);
  return request(WireRoutes.AdminStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, 'POST', assertion);
}
