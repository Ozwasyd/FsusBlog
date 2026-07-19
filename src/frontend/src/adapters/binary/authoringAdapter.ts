import { AppErrorCode, createAppError } from '@/utils/appError';

const decoder = new TextDecoder('utf-8', { fatal: true });

export function mapAuthoringJsonFromPayload<T = unknown>(payload: Uint8Array): T {
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    throw createAppError(AppErrorCode.ProtocolFailure, 'authoring_json_payload_invalid');
  }
}
