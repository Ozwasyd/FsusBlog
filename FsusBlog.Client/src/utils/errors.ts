import { AppErrorCode, isAppError } from '@/utils/appError'

type ErrorWithName = { name?: string }
type ErrorWithMessage = {
  message?: string
  traceId?: string
  response?: { data?: { message?: string; traceId?: string; TraceId?: string } }
}

export const isAbortError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const name = (error as ErrorWithName).name
  if (name === 'AbortError' || name === 'PowAbortError') {
    return true
  }

  const message = typeof (error as ErrorWithMessage).message === 'string'
    ? (error as ErrorWithMessage).message
    : ''

  return message === 'canceled'
    || message.includes('The operation was aborted')
    || message.includes('signal is aborted')
    || message.includes('aborted without reason')
}

export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'string') {
    return error.length > 0 ? error : fallback
  }

  if (isAppError(error)) {
    switch (error.code) {
      case AppErrorCode.Validation:
        if (error.message === 'INVALID_TOTP') {
          return '验证码无效，请重试'
        }
        if (error.message === 'BASEURL_PROTOCOL_INVALID') {
          return '站点URL协议不合法'
        }
        return error.message || fallback
      case AppErrorCode.ProtocolFailure:
        if (error.message === 'login_response_invalid' || error.message === 'home_articles_response_invalid') {
          return '系统数据异常，请刷新页面后重试'
        }
        if (error.message === 'MFA_VERIFY_FAILED') {
          return '验证状态异常，请重新登录后再试'
        }
        return error.message || fallback
      default:
        return error.message || fallback
    }
  }

  if (typeof error !== 'object' || error === null) {
    return fallback
  }

  const known = error as ErrorWithMessage
  const traceId =
    (typeof known.traceId === 'string' && known.traceId.length > 0 ? known.traceId : undefined)
    ?? (typeof known.response?.data?.traceId === 'string' && known.response.data.traceId.length > 0 ? known.response.data.traceId : undefined)
    ?? (typeof known.response?.data?.TraceId === 'string' && known.response.data.TraceId.length > 0 ? known.response.data.TraceId : undefined)

  if (typeof known.response?.data?.message === 'string' && known.response.data.message.length > 0) {
    return traceId ? `${known.response.data.message} [trace:${traceId}]` : known.response.data.message
  }

  if (typeof known.message === 'string' && known.message.length > 0) {
    return traceId && !known.message.includes('[trace:') ? `${known.message} [trace:${traceId}]` : known.message
  }

  return fallback
}
