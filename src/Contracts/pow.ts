import { decodeUtf8, ProtocolError } from './binary.ts';
import { WireLayouts, WireLimits } from './wire.generated.ts';

export type PowChallenge = { salt: string; signature: string; difficulty: number; timestamp: number };

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
    const timer = setTimeout(() => finish(null, new Error('The security challenge timed out')), WireLimits.PowWorkerMilliseconds);
    const cancel = () => finish(null, signal.reason);
    const finish = (nonce: string | null, failure?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      worker.terminate();
      if (nonce !== null) resolve(nonce);
      else reject(failure ?? new Error('The security challenge could not be solved'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      finish(typeof value === 'string' && /^[0-9]{1,10}$/.test(value) ? value : null);
    };
    worker.onerror = () => finish(null);
    worker.postMessage({ salt: challenge.salt, difficulty: challenge.difficulty, clientNonce });
  });
}
