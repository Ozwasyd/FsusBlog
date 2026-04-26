import { decodeUtf8 } from '@/utils/utf8'

export function decodeJsonPayload<T>(payload: Uint8Array): T {
  return JSON.parse(decodeUtf8(payload)) as T
}
