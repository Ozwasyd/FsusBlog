import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { ApiError } from './client.ts';
import { post, request } from './internal/http.ts';
import { requestPasskeyAttestation } from './passkey.ts';
import { powProofHeaders, proveScopedPow } from './pow.ts';
import { FrameType } from './wire.generated.ts';

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
  const proof = await proveScopedPow(routes.pow, consent, signal);
  // A new reader has no existing credentials to exclude: preserve the provision decoder's zero-exclusion contract.
  const attestation = await requestPasskeyAttestation(routes.begin, signal, consent, powProofHeaders(proof));
  signal.throwIfAborted();
  await post(routes.complete, FrameType.EmptySuccess, decodeSuccess, signal, attestation);
}
