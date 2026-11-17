import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { ApiError, request } from './client.ts';
import { requestPasskeyAttestation } from './passkey.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import { FrameType, WireHeaders } from './wire.generated.ts';

const routes = {
  status: '/api/v2/identity/reader-registration/status.aeds',
  pow: '/api/v2/identity/reader-registration/pow.aeds',
  begin: '/api/v2/identity/reader-registration/begin.aeds',
  complete: '/api/v2/identity/reader-registration/complete.aeds',
} as const;

function supported(): boolean {
  return globalThis.isSecureContext && typeof PublicKeyCredential === 'function' &&
    typeof globalThis.navigator?.credentials?.create === 'function';
}

export async function readerRegistrationAvailable(signal?: AbortSignal): Promise<boolean> {
  if (!supported()) return false;
  try {
    await request(routes.status, FrameType.EmptySuccess, decodeSuccess, signal);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

// Call only after the reader explicitly chooses to register. Completion never signs in.
export async function registerReaderPasskey(signal: AbortSignal): Promise<void> {
  if (!supported()) throw new ProtocolError('Reader registration requires a secure WebAuthn context.');
  signal.throwIfAborted();
  const consent = encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0));
  const clientNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const challenge = await request(routes.pow, FrameType.PowChallenge, decodePowChallenge,
    signal, 'POST', consent, { [WireHeaders.PowClientNonce]: clientNonce });
  const nonce = await solveScopedPow(challenge, clientNonce, signal);
  signal.throwIfAborted();
  // A new reader has no existing credentials to exclude: preserve the provision decoder's zero-exclusion contract.
  const attestation = await requestPasskeyAttestation(routes.begin, signal, consent,
    { [WireHeaders.PowProof]: encodePowProof(challenge, nonce, clientNonce) });
  signal.throwIfAborted();
  await request(routes.complete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', attestation);
}
