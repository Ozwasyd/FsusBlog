type ErrorWithName = { name?: string }
type ErrorWithMessage = { message?: string; response?: { data?: { message?: string } } }

export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as ErrorWithName).name === 'AbortError'

export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error !== 'object' || error === null) {
    return fallback
  }

  const known = error as ErrorWithMessage
  if (typeof known.response?.data?.message === 'string' && known.response.data.message.length > 0) {
    return known.response.data.message
  }

  if (typeof known.message === 'string' && known.message.length > 0) {
    return known.message
  }

  return fallback
}
