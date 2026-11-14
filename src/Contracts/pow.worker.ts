import { WireLimits } from './wire.generated.ts';

type Input = { salt: string; clientNonce: string; difficulty: number };

async function solve({ salt, clientNonce, difficulty }: Input): Promise<string | null> {
  const encoder = new TextEncoder();
  const wholeBytes = Math.floor(difficulty / 8);
  const remaining = difficulty % 8;
  const stop = performance.now() + WireLimits.PowWorkerMilliseconds;
  for (let nonce = 0; nonce < 131_072 && performance.now() < stop; nonce++) {
    const input = encoder.encode(`${salt}:${nonce}:${clientNonce}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    if (hash.subarray(0, wholeBytes).every(byte => byte === 0) &&
        (remaining === 0 || hash[wholeBytes] >>> (8 - remaining) === 0)) return String(nonce);
  }
  return null;
}

self.onmessage = async (event: MessageEvent<Input>) => {
  try { self.postMessage(await solve(event.data)); }
  catch { self.postMessage(null); }
};
