import { describe, it, expect } from 'vitest'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { AppError, AppErrorCode } from '@/utils/appError'

describe('isAbortError', () => {
  it('detects AbortError by name', () => {
    const e = Object.assign(new Error('abort'), { name: 'AbortError' })
    expect(isAbortError(e)).toBe(true)
  })

  it('detects PowAbortError by name', () => {
    const e = Object.assign(new Error('abort'), { name: 'PowAbortError' })
    expect(isAbortError(e)).toBe(true)
  })

  it('detects "canceled" message', () => {
    expect(isAbortError(new Error('canceled'))).toBe(true)
  })

  it('detects abort-related messages', () => {
    expect(isAbortError(new Error('The operation was aborted due to timeout'))).toBe(true)
  })

  it('returns false for normal errors', () => {
    expect(isAbortError(new Error('network error'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isAbortError(null)).toBe(false)
  })
})

describe('getErrorMessage', () => {
  it('returns string error directly', () => {
    expect(getErrorMessage('custom error', 'fallback')).toBe('custom error')
  })

  it('returns fallback for empty string', () => {
    expect(getErrorMessage('', 'fallback')).toBe('fallback')
  })

  it('returns AppError message for normal codes', () => {
    const e = new AppError(AppErrorCode.Forbidden, 'access denied')
    expect(getErrorMessage(e, 'fallback')).toBe('access denied')
  })

  it('maps known Validation message INVALID_TOTP', () => {
    const e = new AppError(AppErrorCode.Validation, 'INVALID_TOTP')
    expect(getErrorMessage(e, 'fallback')).toBe('验证码无效，请重试')
  })

  it('maps known Validation message BASEURL_PROTOCOL_INVALID', () => {
    const e = new AppError(AppErrorCode.Validation, 'BASEURL_PROTOCOL_INVALID')
    expect(getErrorMessage(e, 'fallback')).toBe('站点URL协议不合法')
  })

  it('maps known ProtocolFailure messages', () => {
    const e1 = new AppError(AppErrorCode.ProtocolFailure, 'login_response_invalid')
    expect(getErrorMessage(e1, 'fallback')).toBe('系统数据异常，请刷新页面后重试')

    const e2 = new AppError(AppErrorCode.ProtocolFailure, 'MFA_VERIFY_FAILED')
    expect(getErrorMessage(e2, 'fallback')).toBe('验证状态异常，请重新登录后再试')
  })

  it('returns fallback for null/undefined', () => {
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
    expect(getErrorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('reads response.data.message when available', () => {
    const e = {
      response: {
        data: {
          message: 'server error',
          traceId: 'trace-1'
        }
      }
    }
    const msg = getErrorMessage(e, 'fallback')
    expect(msg).toContain('server error')
    expect(msg).toContain('trace-1')
  })

  it('reads error.message with traceId', () => {
    const e = { message: 'something failed', traceId: 'tid-123' }
    const msg = getErrorMessage(e, 'fallback')
    expect(msg).toContain('something failed')
    expect(msg).toContain('tid-123')
  })
})
