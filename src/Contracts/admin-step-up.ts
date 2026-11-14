import { encodeFrame } from './aeds.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { encodeAdminModerationDecision, encodeAdminModerationIntent, FrameType, WireRoutes,
  type AdminModerationDecision, type AdminModerationIntent } from './wire.generated.ts';

export async function proveAdminModeration(intent: AdminModerationIntent, signal?: AbortSignal): Promise<string> {
  const body = encodeFrame(FrameType.AdminModerationIntent, encodeAdminModerationIntent(intent));
  return prove(WireRoutes.AdminStepUpBegin, body, signal);
}

export async function proveAdminModerationDecision(intent: AdminModerationDecision, signal?: AbortSignal): Promise<string> {
  const body = encodeFrame(FrameType.AdminModerationDecision, encodeAdminModerationDecision(intent));
  return prove(WireRoutes.AdminModerationStepUpBegin, body, signal);
}

async function prove(begin: string, body: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
  const assertion = await requestPasskeyAssertion(begin, signal, body, true);
  return request(WireRoutes.AdminStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, 'POST', assertion);
}
