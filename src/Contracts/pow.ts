import { decodeUtf8, ProtocolError } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireHeaders, WireLayouts, WireLimits } from './wire.generated.ts';

export type PowChallenge = { salt: string; signature: string; difficulty: number; timestamp: number };
export type ScopedPowRequest<T> = {
  challengePath: string;
  submitPath: string;
  expected: FrameType;
  decode: (payload: Uint8Array, headers: Headers) => T;
  body: Uint8Array<ArrayBuffer>;
  signal: AbortSignal;
  method?: 'POST' | 'PUT';
  headers?: HeadersInit;
  submitHeaders?: HeadersInit;
};

export function decodePowChallenge(payload: Uint8Array): PowChallenge {
  if (payload.length !== WireLayouts.PowChallengeBytes) throw new ProtocolError('Invalid PoW challenge size');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const timestamp = view.getBigInt64(WireLayouts.PowChallengeTimestampOffset, true);
  const difficulty = view.getInt32(WireLayouts.PowChallengeSaltBytes, true);
  if (timestamp <= 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER) || difficulty < 1 || difficulty > 28)
    throw new ProtocolError('Invalid PoW challenge coordinates');

  function fixed(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    if (end === -1) return decodeUtf8(bytes);
    if (bytes.subarray(end).some(Boolean)) throw new ProtocolError('Invalid PoW challenge padding');
    return decodeUtf8(bytes.subarray(0, end));
  }

  const salt = fixed(payload.subarray(0, WireLayouts.PowChallengeSaltBytes));
  const signature = fixed(payload.subarray(WireLayouts.PowChallengeSignatureOffset));
  if (!salt || !signature) throw new ProtocolError('Incomplete PoW challenge');
  return { salt, signature, difficulty, timestamp: Number(timestamp) };
}

export function encodePowProof(challenge: PowChallenge, nonce: string, clientNonce: string): string {
  const encoder = new TextEncoder();
  const fields = [challenge.salt, nonce, challenge.signature, clientNonce].map(value => encoder.encode(value));
  const size = WireLayouts.PowProofHeaderBytes + fields.reduce((total, field) => total + 2 + field.length, 0);
  if (Math.ceil(size / 3) * 4 > WireLimits.PowProofHeaderChars || fields.some(field => field.byteLength === 0))
    throw new ProtocolError('PoW proof exceeds its field limit');
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set([70, 80, 79, 87, 1]);
  view.setInt32(5, challenge.difficulty, true);
  view.setBigInt64(9, BigInt(challenge.timestamp), true);
  let offset = WireLayouts.PowProofHeaderBytes;
  for (const field of fields) {
    view.setUint16(offset, field.length, true);
    bytes.set(field, offset + 2);
    offset += 2 + field.length;
  }
  return btoa(String.fromCharCode(...bytes));
}

export function solveScopedPow(challenge: PowChallenge, clientNonce: string, signal: AbortSignal): Promise<string> {
  if (!/^[A-Fa-f0-9]{32}$/.test(challenge.salt) || !/^[A-Za-z0-9_-]{43}$/.test(challenge.signature) ||
      !/^[A-Fa-f0-9]{32}$/.test(clientNonce) || challenge.difficulty !== WireLimits.PowChallengeDifficulty)
    throw new ProtocolError('Unsupported security challenge');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const cancel = () => finish(null, signal.reason);
    const finish = (nonce: string | null, failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      if (nonce !== null) resolve(nonce);
      else reject(failure ?? new Error('The security challenge could not be solved'));
    };
    const timer = setTimeout(() => finish(null, new Error('The security challenge timed out')), WireLimits.PowWorkerMilliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      finish(typeof value === 'string' && /^[0-9]{1,10}$/.test(value) ? value : null);
    };
    worker.onerror = () => finish(null);
    try {
      worker.postMessage({ salt: challenge.salt, difficulty: challenge.difficulty, clientNonce });
    } catch (error) {
      finish(null, error);
    }
  });
}

function requirePowRoute(route: string): void {
  if (!route || !route.trim()) throw new ProtocolError('Missing PoW route.');
}

function withHeaders(base: HeadersInit | undefined, extra?: HeadersInit): Headers {
  const merged = new Headers(base);
  if (extra) new Headers(extra).forEach((value, key) => merged.set(key, value));
  return merged;
}

export function createPowClientNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function powProofHeaders(proof: string): Record<string, string> {
  if (!proof || proof.length > WireLimits.PowProofHeaderChars) throw new ProtocolError('Invalid PoW proof');
  return { [WireHeaders.PowProof]: proof };
}

export async function proveScopedPow(
  challengePath: string,
  body: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<string> {
  requirePowRoute(challengePath);
  signal.throwIfAborted();
  const clientNonce = createPowClientNonce();
  const challengeHeaders = withHeaders(headers);
  challengeHeaders.delete(WireHeaders.PowProof);
  challengeHeaders.set(WireHeaders.PowClientNonce, clientNonce);
  const challenge = await request(challengePath, FrameType.PowChallenge, decodePowChallenge,
    signal, 'POST', body, challengeHeaders);
  signal.throwIfAborted();
  const nonce = await solveScopedPow(challenge, clientNonce, signal);
  signal.throwIfAborted();
  return encodePowProof(challenge, nonce, clientNonce);
}

export async function requestWithScopedPow<T>(options: ScopedPowRequest<T>): Promise<T> {
  const { challengePath, submitPath, expected, decode, body, signal, method = 'POST', headers, submitHeaders } = options;
  requirePowRoute(challengePath);
  requirePowRoute(submitPath);
  signal.throwIfAborted();
  const proof = await proveScopedPow(challengePath, body, signal, headers);
  signal.throwIfAborted();
  const finalHeaders = withHeaders(headers, submitHeaders);
  finalHeaders.delete(WireHeaders.PowClientNonce);
  finalHeaders.set(WireHeaders.PowProof, proof);
  return request(submitPath, expected, decode, signal, method, body, finalHeaders);
}
