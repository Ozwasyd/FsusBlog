import { describe, it, expect } from 'vitest'
import {
  AppError,
  AppErrorCode,
  ok,
  err,
  createAppError,
  isAppError,
  appErrorFromStatus,
  toAppError,
  unwrapResult
} from '@/utils/appError'

describe('AppError', () => {
  it('constructs with code and message', () => {
    const e = new AppError(AppErrorCode.NotFound, 'not found')
    expect(e.code).toBe(AppErrorCode.NotFound)
    expect(e.message).toBe('not found')
    expect(e.name).toBe('AppError')
  })

  it('appends traceId to message if not already present', () => {
    const e = new AppError(AppErrorCode.Unknown, 'oops', { traceId: 'abc' })
    expect(e.message).toContain('[trace:abc]')
    expect(e.traceId).toBe('abc')
  })

  it('does not duplicate traceId in message', () => {
    const e = new AppError(AppErrorCode.Unknown, 'oops [trace:abc]', { traceId: 'abc' })
    expect(e.message.split('[trace:abc]').length - 1).toBe(1)
  })

  it('stores optional fields', () => {
    const cause = new Error('cause')
    const e = new AppError(AppErrorCode.InfraFailure, 'fail', { status: 500, details: 'detail', cause })
    expect(e.status).toBe(500)
    expect(e.details).toBe('detail')
    expect(e.cause).toBe(cause)
  })
})

describe('ok / err / unwrapResult', () => {
  it('ok wraps a value', () => {
    const r = ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('err wraps an AppError', () => {
    const e = createAppError(AppErrorCode.Unknown, 'x')
    const r = err<number>(e)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(e)
  })

  it('unwrapResult returns value on success', () => {
    expect(unwrapResult(ok('hello'))).toBe('hello')
  })

  it('unwrapResult throws on error', () => {
    const r = err<string>(createAppError(AppErrorCode.NotFound, 'not found'))
    expect(() => unwrapResult(r)).toThrow()
  })
})

describe('createAppError / isAppError', () => {
  it('creates an AppError instance', () => {
    const e = createAppError(AppErrorCode.Forbidden, 'denied')
    expect(e).toBeInstanceOf(AppError)
    expect(isAppError(e)).toBe(true)
  })

  it('returns false for non-AppError', () => {
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError(null)).toBe(false)
    expect(isAppError('string')).toBe(false)
  })
})

describe('appErrorFromStatus', () => {
  const cases: [number, AppErrorCode][] = [
    [401, AppErrorCode.Unauthorized],
    [403, AppErrorCode.Forbidden],
    [404, AppErrorCode.NotFound],
    [409, AppErrorCode.Conflict],
    [408, AppErrorCode.Timeout],
    [504, AppErrorCode.Timeout],
    [429, AppErrorCode.RateLimited],
    [422, AppErrorCode.Validation],
    [500, AppErrorCode.InfraFailure],
    [503, AppErrorCode.InfraFailure]
  ]
  for (const [status, code] of cases) {
    it(`maps status ${status} to ${code}`, () => {
      const e = appErrorFromStatus(status, 'msg')
      expect(e.code).toBe(code)
      expect(e.status).toBe(status)
    })
  }
})

describe('toAppError', () => {
  it('returns AppError as-is', () => {
    const original = createAppError(AppErrorCode.NotFound, 'x')
    expect(toAppError(original)).toBe(original)
  })

  it('wraps native Error', () => {
    const e = toAppError(new Error('native'))
    expect(e.code).toBe(AppErrorCode.Unknown)
    expect(e.message).toBe('native')
  })

  it('wraps non-empty string', () => {
    const e = toAppError('some error')
    expect(e.code).toBe(AppErrorCode.Unknown)
    expect(e.message).toBe('some error')
  })

  it('wraps unknown values with fallback message', () => {
    const e = toAppError(null, 'fallback')
    expect(e.message).toBe('fallback')
  })
})
