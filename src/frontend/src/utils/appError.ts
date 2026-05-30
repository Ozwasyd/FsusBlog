export const AppErrorCode = {
  Validation: 'Validation',
  Unauthorized: 'Unauthorized',
  Forbidden: 'Forbidden',
  NotFound: 'NotFound',
  Conflict: 'Conflict',
  RateLimited: 'RateLimited',
  InfraFailure: 'InfraFailure',
  ProtocolFailure: 'ProtocolFailure',
  Timeout: 'Timeout',
  InvariantViolation: 'InvariantViolation',
  Unknown: 'Unknown'
} as const

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode]

export interface AppErrorOptions {
  status?: number
  traceId?: string
  cause?: unknown
  details?: string
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status?: number
  readonly traceId?: string
  readonly cause?: unknown
  readonly details?: string

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(options.traceId && !message.includes(`[trace:${options.traceId}]`)
      ? `${message} [trace:${options.traceId}]`
      : message)
    this.name = 'AppError'
    this.code = code
    this.status = options.status
    this.traceId = options.traceId
    this.cause = options.cause
    this.details = options.details
  }
}

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError }

export const ok = <T>(value: T): AppResult<T> => ({ ok: true, value })

export const err = <T = never>(error: AppError): AppResult<T> => ({ ok: false, error })

export function createAppError(
  code: AppErrorCode,
  message: string,
  options?: AppErrorOptions
): AppError {
  return new AppError(code, message, options)
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

export function appErrorFromStatus(status: number, message: string, options?: AppErrorOptions): AppError {
  if (status === 401) {
    return createAppError(AppErrorCode.Unauthorized, message, { ...options, status })
  }
  if (status === 403) {
    return createAppError(AppErrorCode.Forbidden, message, { ...options, status })
  }
  if (status === 404) {
    return createAppError(AppErrorCode.NotFound, message, { ...options, status })
  }
  if (status === 409) {
    return createAppError(AppErrorCode.Conflict, message, { ...options, status })
  }
  if (status === 408 || status === 504) {
    return createAppError(AppErrorCode.Timeout, message, { ...options, status })
  }
  if (status === 429) {
    return createAppError(AppErrorCode.RateLimited, message, { ...options, status })
  }
  if (status >= 400 && status < 500) {
    return createAppError(AppErrorCode.Validation, message, { ...options, status })
  }
  return createAppError(AppErrorCode.InfraFailure, message, { ...options, status })
}

export function toAppError(error: unknown, fallback = 'unexpected_failure'): AppError {
  if (isAppError(error)) {
    return error
  }

  if (error instanceof Error) {
    return createAppError(AppErrorCode.Unknown, error.message || fallback, { cause: error })
  }

  if (typeof error === 'string' && error.length > 0) {
    return createAppError(AppErrorCode.Unknown, error)
  }

  return createAppError(AppErrorCode.Unknown, fallback, { cause: error })
}

export function unwrapResult<T>(result: AppResult<T>): T {
  if (!result.ok) {
    throw result.error
  }
  return result.value
}
