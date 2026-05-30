import { HttpApiError } from '@/api'
import { BinaryTransportError } from '@/services/binaryTransport'
import type { TransportFailureKind } from '@/services/binaryTransport'
import { isAppError } from '@/utils/appError'

type KnownErrorKind = 'app_error' | 'binary_transport' | 'http_api' | 'error' | 'unknown'

export interface KnownErrorInfo {
  kind: KnownErrorKind
  message: string
  traceId?: string
  status?: number
  binaryKind?: TransportFailureKind
  appCode?: string
  raw: unknown
}

type ErrorLike = {
  name?: unknown
  message?: unknown
  traceId?: unknown
  status?: unknown
  kind?: unknown
}

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isBinaryTransportError = (error: unknown): error is BinaryTransportError => {
  if (error instanceof BinaryTransportError) {
    return true
  }
  if (!isObjectLike(error)) {
    return false
  }
  const candidate = error as ErrorLike
  return candidate.name === 'BinaryTransportError' && typeof candidate.kind === 'string' && typeof candidate.message === 'string'
}

const isHttpApiError = (error: unknown): error is HttpApiError => {
  if (error instanceof HttpApiError) {
    return true
  }
  if (!isObjectLike(error)) {
    return false
  }
  const candidate = error as ErrorLike
  return candidate.name === 'HttpApiError' && typeof candidate.message === 'string'
}

const isNativeError = (error: unknown): error is Error =>
  error instanceof Error

export const getKnownErrorInfo = (error: unknown, fallback = '请求失败'): KnownErrorInfo => {
  if (isAppError(error)) {
    return {
      kind: 'app_error',
      message: error.message || fallback,
      traceId: error.traceId,
      status: error.status,
      appCode: error.code,
      raw: error
    }
  }

  if (isBinaryTransportError(error)) {
    return {
      kind: 'binary_transport',
      message: error.message || fallback,
      traceId: error.traceId,
      binaryKind: error.kind,
      raw: error
    }
  }

  if (isHttpApiError(error)) {
    return {
      kind: 'http_api',
      message: error.message || fallback,
      traceId: error.traceId,
      status: error.status,
      raw: error
    }
  }

  if (isNativeError(error)) {
    return {
      kind: 'error',
      message: error.message || fallback,
      raw: error
    }
  }

  return {
    kind: 'unknown',
    message: fallback,
    raw: error
  }
}

export const isAuthFailureError = (error: unknown): boolean => {
  const info = getKnownErrorInfo(error)
  if (info.kind === 'app_error') {
    return info.appCode === 'Unauthorized' || info.status === 401
  }
  if (info.kind === 'binary_transport') {
    return info.binaryKind === 'auth_failed'
  }
  if (info.kind === 'http_api') {
    return info.status === 401
  }
  return false
}
