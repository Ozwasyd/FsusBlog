import { describe, expect, it } from 'vitest'
import {
  AppError,
  AppErrorCode,
  appErrorFromStatus,
  createAppError,
  err,
  isAppError,
  ok,
  toAppError,
  unwrapResult
} from '@/utils/appError'

describe('appError utilities', () => {
  it('appends trace id once when constructing AppError', () => {
    const error = createAppError(AppErrorCode.Unknown, 'failure', { traceId: 'trace-1' })
    expect(error.message).toBe('failure [trace:trace-1]')
  })

  it('maps representative http statuses to stable error codes', () => {
    expect(appErrorFromStatus(401, 'x').code).toBe(AppErrorCode.Unauthorized)
    expect(appErrorFromStatus(403, 'x').code).toBe(AppErrorCode.Forbidden)
    expect(appErrorFromStatus(404, 'x').code).toBe(AppErrorCode.NotFound)
    expect(appErrorFromStatus(409, 'x').code).toBe(AppErrorCode.Conflict)
    expect(appErrorFromStatus(408, 'x').code).toBe(AppErrorCode.Timeout)
    expect(appErrorFromStatus(504, 'x').code).toBe(AppErrorCode.Timeout)
    expect(appErrorFromStatus(429, 'x').code).toBe(AppErrorCode.RateLimited)
    expect(appErrorFromStatus(418, 'x').code).toBe(AppErrorCode.Validation)
    expect(appErrorFromStatus(500, 'x').code).toBe(AppErrorCode.InfraFailure)
  })

  it('normalizes unknown values with toAppError', () => {
    const known = createAppError(AppErrorCode.Forbidden, 'known')
    expect(toAppError(known)).toBe(known)

    const fromError = toAppError(new Error('native'))
    expect(fromError.message).toBe('native')
    expect(fromError.code).toBe(AppErrorCode.Unknown)

    const fromEmptyError = toAppError(new Error(''), 'fallback-msg')
    expect(fromEmptyError.message).toBe('fallback-msg')

    const fromString = toAppError('boom')
    expect(fromString.code).toBe(AppErrorCode.Unknown)
    expect(fromString.message).toBe('boom')

    const fromObject = toAppError({ bad: true }, 'fallback')
    expect(fromObject.message).toBe('fallback')
  })

  it('supports result helpers and unwrap semantics', () => {
    const success = ok(42)
    expect(unwrapResult(success)).toBe(42)

    const failure = err(new AppError(AppErrorCode.Validation, 'invalid'))
    expect(failure.ok).toBe(false)
    expect(isAppError((failure as { ok: false; error: AppError }).error)).toBe(true)
    expect(() => unwrapResult(failure)).toThrow('invalid')
  })

})
