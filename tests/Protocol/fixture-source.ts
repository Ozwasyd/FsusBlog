import { readFileSync } from 'node:fs';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import type { FrameType } from '../../src/Contracts/wire.generated.ts';

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export function hexFixture(name: string, whitespace: 'trim' | 'strip' = 'trim'): Buffer {
  const source = fixtureText(name);
  return Buffer.from(whitespace === 'strip' ? source.replace(/\s/g, '') : source.trim(), 'hex');
}

export function framedFixture(name: string, type: FrameType, whitespace?: 'trim' | 'strip'): Uint8Array {
  return decodeFrame(Uint8Array.from(hexFixture(name, whitespace)), type).payload;
}

export function frameResponse(frame: BodyInit | null, headers: Record<string, string> = {}): Response {
  return new Response(frame, { headers: { 'Content-Type': 'application/octet-stream', ...headers } });
}
