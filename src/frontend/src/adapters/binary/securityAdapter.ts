import { AppErrorCode, createAppError } from '@/utils/appError';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeSecurityJsonRequest(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value ?? {}));
}

export function mapSecurityJsonFromPayload<T = unknown>(payload: Uint8Array): T {
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_json_payload_invalid');
  }
}
