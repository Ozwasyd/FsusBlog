import { throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { PodWriter } from '../../src/Contracts/binary.ts';
import { FrameType, WireLayouts } from '../../src/Contracts/wire.generated.ts';

const encoder = new TextEncoder();

export const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const hexBytes = (hex: string) => Buffer.from(hex, 'hex');
export const sha256Hex = (value: string | Buffer | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function hexFixture(name: string, whitespace: 'trim' | 'strip' = 'trim') {
  const source = fixtureText(name);
  return Buffer.from(whitespace === 'strip' ? source.replace(/\s/g, '') : source.trim(), 'hex');
}

export const fixtureBytes = (name: string) => Uint8Array.from(hexFixture(name));

export function framedFixture(name: string, type: FrameType, whitespace?: 'trim' | 'strip') {
  return decodeFrame(Uint8Array.from(hexFixture(name, whitespace)), type).payload;
}

export function frameResponse(frame: BodyInit | null, headers: Record<string, string> = {}) {
  return new Response(frame, { headers: { 'Content-Type': 'application/octet-stream', ...headers } });
}

export function encodedResponse(type: FrameType, payload: Uint8Array, headers: Record<string, string> = {}) {
  return frameResponse(encodeFrame(type, payload), headers);
}

export function apiErrorResponse(status: number, details: string, message = 'Request failed', headers: Record<string, string> = {}): Response {
  const payload = new Uint8Array(WireLayouts.ErrorBytes);
  const view = new DataView(payload.buffer);
  payload[0] = 1;
  payload[1] = 1;
  view.setInt32(WireLayouts.ErrorStatusOffset, status, true);
  payload.set(encoder.encode(message).subarray(0, 255), WireLayouts.ErrorMessageOffset);
  payload.set(encoder.encode(details).subarray(0, 255), WireLayouts.ErrorDetailsOffset);
  return new Response(encodeFrame(FrameType.ApiError, payload), { status, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
}

export function podFrame(type: FrameType, write: (writer: PodWriter) => void) {
  const writer = new PodWriter();
  write(writer);
  return encodeFrame(type, writer.finish());
}

export function i32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}

export function i64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

export function text(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([i32(bytes.length), bytes]);
}

export const appendByte = (payload: Uint8Array, value = 0) => Uint8Array.from([...payload, value]);

export function withByte(payload: Uint8Array, offset: number, value: number) {
  const copy = Uint8Array.from(payload);
  copy[offset] = value;
  return copy;
}

export function withI32(payload: Uint8Array, offset: number, value: number) {
  const copy = Uint8Array.from(payload);
  new DataView(copy.buffer).setInt32(offset, value, true);
  return copy;
}

export function withI64(payload: Uint8Array, offset: number, value: bigint) {
  const copy = Uint8Array.from(payload);
  new DataView(copy.buffer).setBigInt64(offset, value, true);
  return copy;
}

export function rejectInputs<T>(fn: (input: T) => unknown, cases: Iterable<T>, error: unknown = ProtocolError) {
  for (const input of cases) throws(() => fn(input), error as never);
}

export function rejectPatches<T extends object>(fn: (input: T) => unknown, base: T, patches: Iterable<Partial<T>>, error: unknown = ProtocolError) {
  for (const patch of patches) throws(() => fn({ ...base, ...patch }), error as never);
}

export function rejectBytes(decode: (payload: Uint8Array) => unknown, payload: Uint8Array, mutations: Iterable<readonly [number, number]>) {
  for (const [offset, value] of mutations) throws(() => decode(withByte(payload, offset, value)), ProtocolError);
}

export function rejectWrongLength(decode: (payload: Uint8Array) => unknown, payload: Uint8Array) {
  throws(() => decode(payload.subarray(0, -1)), ProtocolError);
  throws(() => decode(appendByte(payload)), ProtocolError);
}

export function replaceProperty(t: TestContext, target: object, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}

export type RecordedCall = { url: string; method: string; headers: Headers; body: Uint8Array };

export function captureFetch(t: TestContext, responder: (call: RecordedCall, init?: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : new Uint8Array();
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body };
    calls.push(call);
    return responder(call, init);
  });
  return calls;
}
