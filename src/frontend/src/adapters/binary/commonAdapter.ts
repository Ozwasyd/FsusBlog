import { AppErrorCode, createAppError } from '@/utils/appError'
import { readInt64Number } from './reader'

export function mapEmptySuccessFromPayload(payload: Uint8Array): null {
  if (payload.byteLength !== 4 || payload[0] !== 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'empty_success_payload_invalid')
  }

  return null
}

export function mapMutationIdFromPayload(payload: Uint8Array): { id: number } {
  if (payload.byteLength !== 8) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'mutation_id_payload_invalid')
  }

  return { id: readInt64Number(payload, 0) }
}
