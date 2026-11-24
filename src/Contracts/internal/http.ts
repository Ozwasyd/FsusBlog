import { ApiError, decodeSuccess } from '../aeds.ts';
import { request, siteSessionHeader } from '../client.ts';
import { FrameType } from '../wire.generated.ts';

export { request, siteSessionHeader };

type Decoder<T> = (payload: Uint8Array, headers: Headers) => T;
type Body = Uint8Array<ArrayBuffer> | Blob;

export function post<T>(path: string, expected: FrameType, decode: Decoder<T>, signal: AbortSignal | undefined,
  body?: Body, headers?: HeadersInit): Promise<T> {
  return request(path, expected, decode, signal, 'POST', body, headers);
}

export function postEmpty(path: string, signal: AbortSignal | undefined, body?: Body, headers?: HeadersInit): Promise<void> {
  return post(path, FrameType.EmptySuccess, decodeSuccess, signal, body, headers);
}

export function sessionGet<T>(path: string, expected: FrameType, decode: Decoder<T>, signal: AbortSignal | undefined,
  session?: string): Promise<T> {
  return request(path, expected, decode, signal, 'GET', undefined, siteSessionHeader(session));
}

export function sessionPost<T>(path: string, expected: FrameType, decode: Decoder<T>, signal: AbortSignal | undefined,
  body: Body, session?: string): Promise<T> {
  return post(path, expected, decode, signal, body, siteSessionHeader(session));
}

export async function readAvailability(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request(path, FrameType.EmptySuccess, decodeSuccess, signal);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}
