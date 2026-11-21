import { encodeFrame, ProtocolError } from './aeds.ts';
import { assertAdminPermissionSession, type AdminSession } from './admin-identity.ts';
import { adminProofHeaders, proveAdminStepUp } from './admin-step-up.ts';
import { request } from './client.ts';
import { decodeAdminRootCommentPowPolicy, encodeAdminRootCommentPowCommand, FrameType, WireLimits, WireRoutes,
  type AdminRootCommentPowCommand, type AdminRootCommentPowPolicy } from './wire.generated.ts';

export const validRootCommentPowSeconds = (seconds: number) => Number.isInteger(seconds) &&
  seconds >= WireLimits.RootCommentPowMinSeconds && seconds <= WireLimits.PowChallengeSeconds;

function policyState(payload: Uint8Array, headers: Headers, session: AdminSession): AdminRootCommentPowPolicy {
  assertAdminPermissionSession(session, headers);
  const state = decodeAdminRootCommentPowPolicy(payload);
  if (state.generation < 1n || !/^[a-f0-9]{64}$/.test(state.digest) || !validRootCommentPowSeconds(state.proofSeconds) ||
      (state.generation === 1n ? state.proofSeconds !== WireLimits.PowChallengeSeconds || state.previousSeconds !== 0
        : !validRootCommentPowSeconds(state.previousSeconds) || state.previousSeconds === state.proofSeconds))
    throw new ProtocolError('Invalid root comment proof policy.');
  return state;
}

export function readRootCommentPowPolicy(session: AdminSession, signal: AbortSignal) {
  return request(WireRoutes.AdminRootCommentPowPolicy, FrameType.AdminRootCommentPowPolicy,
    (payload, headers) => policyState(payload, headers, session), signal);
}

export async function applyRootCommentPowPolicy(session: AdminSession, command: AdminRootCommentPowCommand, signal: AbortSignal) {
  const frame = encodeFrame(FrameType.AdminRootCommentPowCommand, encodeAdminRootCommentPowCommand(command));
  const proof = await proveAdminStepUp({
    begin: WireRoutes.AdminRootCommentPowBegin,
    complete: WireRoutes.AdminRootCommentPowComplete,
  }, frame, signal);
  return await request(WireRoutes.AdminRootCommentPowApply, FrameType.AdminRootCommentPowPolicy, (payload, headers) => {
    const current = policyState(payload, headers, session);
    if (current.generation !== command.expectedGeneration + 1n || current.proofSeconds !== command.proofSeconds)
      throw new ProtocolError('Invalid root comment proof policy receipt.');
    return current;
  }, signal, 'POST', frame, adminProofHeaders(proof));
}
