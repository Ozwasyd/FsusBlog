import { ApiError, decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion, requestPasskeyAttestation } from './passkey.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
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
  const proof = await request(WireRoutes.RecoveryKeyStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, action, true), signal, 'POST', assertion);
  signal.throwIfAborted();
  return request(WireRoutes.RecoveryKeyIssue, FrameType.RecoveryKeyIssued, payload => {
    const issued = decodeRecoveryKeyIssued(payload);
    if (!validSiteRecoveryKey(issued.key) || issued.version <= 0n || issued.createdAt <= 0n)
      throw new ProtocolError('Invalid Recovery Key confirmation.');
    return issued.key;
  }, signal, 'POST', command, { [WireHeaders.MfaProof]: proof });
}

export async function verifySiteRecoveryKey(key: string, signal: AbortSignal): Promise<void> {
  if (!validSiteRecoveryKey(key)) throw new ProtocolError('Invalid Recovery Key.');
  const body = encodeFrame(FrameType.RecoveryKeyVerify, encodeRecoveryKeyVerify({ key }));
  const clientNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const challenge = await request(WireRoutes.RecoveryKeyPow, FrameType.PowChallenge, decodePowChallenge,
      signal, 'POST', body, { [WireHeaders.PowClientNonce]: clientNonce });
    const nonce = await solveScopedPow(challenge, clientNonce, signal);
    signal.throwIfAborted();
    await request(WireRoutes.RecoveryKeyVerify, FrameType.EmptySuccess, decodeSuccess, signal,
      'POST', body, { [WireHeaders.PowProof]: encodePowProof(challenge, nonce, clientNonce) });
  } finally {
    body.fill(0);
  }
}

export function beginSitePasskeyReplacement(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return requestPasskeyAttestation(WireRoutes.RecoveryKeyRebindBegin, signal);
}

export function completeSitePasskeyReplacement(attestation: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<void> {
  return request(WireRoutes.RecoveryKeyRebindComplete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', attestation);
}
