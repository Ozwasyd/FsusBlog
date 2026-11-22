import { encodeFrame, ProtocolError } from './aeds.ts';
import { post } from './internal/http-methods.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { encodeAdminModerationDecision, encodeAdminModerationIntent, FrameType, WireHeaders, WireRoutes,
  type AdminModerationDecision, type AdminModerationIntent } from './wire.generated.ts';

/**
 * Each sensitive administrator action keeps its own begin/complete pair. The
 * business module owns the intent frame, the routes, and any receipt checks.
 */
export type AdminStepUpRoutes = Readonly<{ begin: string; complete: string }>;

/**
 * Runs one administrator Passkey Step-Up ceremony for the exact intent frame:
 * begin (restricted allow-list), authenticator assertion, complete. Returns the
 * single-use `admin-sensitive` proof. `beginHeaders` are sent to the begin route
 * only. Abort, Passkey cancellation, and begin/complete failures propagate
 * unchanged; nothing is retried.
 */
export async function proveAdminStepUp(routes: AdminStepUpRoutes, intent: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal, beginHeaders?: HeadersInit): Promise<string> {
  if (!routes.begin || !routes.complete) throw new ProtocolError('Invalid administrator Step-Up routes');
  signal?.throwIfAborted();
  const assertion = await requestPasskeyAssertion(routes.begin, signal, intent, true, false, beginHeaders);
  signal?.throwIfAborted();
  const proof = await post(routes.complete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, assertion);
  signal?.throwIfAborted();
  return proof;
}

/** Header carrying a required Step-Up proof. */
export function adminProofHeaders(proof: string): Record<string, string> {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof))
    throw new ProtocolError('Invalid administrator Step-Up proof');
  return { [WireHeaders.MfaProof]: proof };
}

/** Header carrying a Step-Up proof when present; `undefined` intentionally omits it for receipt replay. */
export function optionalAdminProofHeaders(proof: string | undefined): Record<string, string> | undefined {
  return proof === undefined ? undefined : adminProofHeaders(proof);
}

export async function proveAdminModeration(intent: AdminModerationIntent, signal?: AbortSignal): Promise<string> {
  const body = encodeFrame(FrameType.AdminModerationIntent, encodeAdminModerationIntent(intent));
  return proveAdminStepUp({ begin: WireRoutes.AdminStepUpBegin, complete: WireRoutes.AdminStepUpComplete }, body, signal);
}

export async function proveAdminModerationDecision(intent: AdminModerationDecision, signal?: AbortSignal): Promise<string> {
  const body = encodeFrame(FrameType.AdminModerationDecision, encodeAdminModerationDecision(intent));
  return proveAdminStepUp({ begin: WireRoutes.AdminModerationStepUpBegin, complete: WireRoutes.AdminStepUpComplete }, body, signal);
}
