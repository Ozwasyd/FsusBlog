import { describe, it, expect } from 'vitest'
import {
  getKnownErrorInfo,
  isAuthFailureError
} from '@/utils/errorKinds'
import { AppError, AppErrorCode } from '@/utils/appError'
import { HttpApiError } from '@/api'
import { BinaryTransportError } from '@/services/binaryTransport'
import type { TransportFailureKind } from '@/contracts/binaryTransport'

function makeBinaryError(kind: TransportFailureKind = 'network', traceId?: string) {
  return new BinaryTransportError({ kind, message: 'transport error', traceId })
}

// ---------------------------------------------------------------------------
// getKnownErrorInfo
// ---------------------------------------------------------------------------
describe('getKnownErrorInfo', () => {
  it('handles AppError', () => {
    const e = new AppError(AppErrorCode.NotFound, 'not found', { status: 404, traceId: 'tid' })
    const info = getKnownErrorInfo(e)
    expect(info.kind).toBe('app_error')
    expect(info.message).toBe('not found [trace:tid]')
    expect(info.status).toBe(404)
    expect(info.appCode).toBe(AppErrorCode.NotFound)
    expect(info.traceId).toBe('tid')
  })

  it('handles BinaryTransportError (extends AppError, so kind=app_error)', () => {
    // BinaryTransportError extends AppError, so isAppError(e) is true and kind = 'app_error'
    const e = makeBinaryError('decode_failed', 'trace-b')
    const info = getKnownErrorInfo(e)
    expect(info.kind).toBe('app_error')
    expect(info.traceId).toBe('trace-b')
  })

  it('handles HttpApiError (extends AppError, so kind=app_error)', () => {
    // HttpApiError extends AppError, so isAppError(e) is true and kind = 'app_error'
    const e = new HttpApiError('server error', 503, 'trace-h')
    const info = getKnownErrorInfo(e)
    expect(info.kind).toBe('app_error')
    expect(info.status).toBe(503)
  })

  it('handles native Error', () => {
    const info = getKnownErrorInfo(new TypeError('type error'))
    expect(info.kind).toBe('error')
    expect(info.message).toBe('type error')
  })

  it('returns unknown kind for unrecognised errors', () => {
    const info = getKnownErrorInfo(42, 'fallback')
    expect(info.kind).toBe('unknown')
    expect(info.message).toBe('fallback')
  })
})

// ---------------------------------------------------------------------------
// isAuthFailureError
// ---------------------------------------------------------------------------
describe('isAuthFailureError', () => {
  it('returns true for Unauthorized AppError', () => {
    const e = new AppError(AppErrorCode.Unauthorized, 'unauth', { status: 401 })
    expect(isAuthFailureError(e)).toBe(true)
  })

  it('returns true for AppError with status 401', () => {
    const e = new AppError(AppErrorCode.Unknown, 'msg', { status: 401 })
    expect(isAuthFailureError(e)).toBe(true)
  })

  it('returns true for BinaryTransportError with auth_failed', () => {
    expect(isAuthFailureError(makeBinaryError('auth_failed'))).toBe(true)
  })

  it('returns true for HttpApiError with status 401', () => {
    const e = new HttpApiError('unauthorized', 401)
    expect(isAuthFailureError(e)).toBe(true)
  })

  it('returns false for non-auth errors', () => {
    expect(isAuthFailureError(new Error('generic'))).toBe(false)
    expect(isAuthFailureError(makeBinaryError('network'))).toBe(false)
    expect(isAuthFailureError(new HttpApiError('not found', 404))).toBe(false)
  })
})
