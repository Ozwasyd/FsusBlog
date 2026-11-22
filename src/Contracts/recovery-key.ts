import { ApiError, decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { validSiteSessionId } from './client.ts';
import { post, request } from './internal/http.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion, requestPasskeyAttestation } from './passkey.ts';
import { requestWithScopedPow } from './pow.ts';
import {
  decodeRecoveryKeyIssued,
  decodeRecoveryKeyStatus,
  encodeRecoveryKeyOperation,
  encodeRecoveryKeyVerify,
  FrameType,
  WireHeaders,
  WireRoutes,
} from './wire.generated.ts';

type KeyOperation = 1 | 2;

export function validSiteRecoveryKey(key: string): boolean {
  return /^frk_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(key);
}

export async function siteRecoveryAvailable(signal: AbortSignal): Promise<boolean> {
  if (!globalThis.isSecureContext || typeof PublicKeyCredential !== 'function') return false;
  try {
    await request(WireRoutes.RecoveryKeyAvailability, FrameType.EmptySuccess, decodeSuccess, signal);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

export function siteRecoveryStatus(signal: AbortSignal): Promise<boolean> {
  return request(WireRoutes.RecoveryKeyStatus, FrameType.RecoveryKeyStatus,
    payload => decodeRecoveryKeyStatus(payload).active, signal);
}

export async function issueSiteRecoveryKey(operation: KeyOperation, signal: AbortSignal): Promise<string> {
  const command = encodeFrame(FrameType.RecoveryKeyOperation, encodeRecoveryKeyOperation({ operation }));
  const action = operation === 1 ? 'recovery-key.create' : 'recovery-key.rotate';
  const assertion = await requestPasskeyAssertion(WireRoutes.RecoveryKeyStepUpBegin, signal, command, true);
  const proof = await post(WireRoutes.RecoveryKeyStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, action, true), signal, assertion);
  signal.throwIfAborted();
  return post(WireRoutes.RecoveryKeyIssue, FrameType.RecoveryKeyIssued, payload => {
    const issued = decodeRecoveryKeyIssued(payload);
    if (!validSiteRecoveryKey(issued.key) || issued.version <= 0n || issued.createdAt <= 0n)
      throw new ProtocolError('Invalid Recovery Key confirmation.');
    return issued.key;
  }, signal, command, { [WireHeaders.MfaProof]: proof });
}

export async function verifySiteRecoveryKey(key: string, signal: AbortSignal): Promise<void> {
  if (!validSiteRecoveryKey(key)) throw new ProtocolError('Invalid Recovery Key.');
  const body = encodeFrame(FrameType.RecoveryKeyVerify, encodeRecoveryKeyVerify({ key }));
  try {
    await requestWithScopedPow({
      challengePath: WireRoutes.RecoveryKeyPow,
      submitPath: WireRoutes.RecoveryKeyVerify,
      expected: FrameType.EmptySuccess,
      decode: decodeSuccess,
      body,
      signal,
    });
  } finally {
    body.fill(0);
  }
}

export async function removeCurrentSitePasskey(key: string, expectedSession: string, signal: AbortSignal): Promise<void> {
  if (!validSiteSessionId(expectedSession)) throw new ProtocolError('Invalid site session.');
  const headers = { [WireHeaders.CurrentSession]: expectedSession };
  await verifySiteRecoveryKey(key, signal);
  signal.throwIfAborted();
  const assertion = await requestPasskeyAssertion(WireRoutes.SitePasskeyRemoveCurrentBegin, signal, undefined, true, false, headers);
  await post(WireRoutes.SitePasskeyRemoveCurrentComplete, FrameType.EmptySuccess, decodeSuccess, signal, assertion, headers);
}

export function beginSitePasskeyReplacement(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return requestPasskeyAttestation(WireRoutes.RecoveryKeyRebindBegin, signal);
}

export function completeSitePasskeyReplacement(attestation: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<void> {
  return post(WireRoutes.RecoveryKeyRebindComplete, FrameType.EmptySuccess, decodeSuccess, signal, attestation);
}
