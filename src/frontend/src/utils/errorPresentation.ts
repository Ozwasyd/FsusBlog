import { getErrorMessage } from '@/utils/errors'
import { toast } from '@/utils/toast'

export const showErrorToast = (error: unknown, fallback = '请求失败', duration?: number): string => {
  const message = getErrorMessage(error, fallback)
  toast.error(message, duration)
  return message
}

export const showWarningToast = (error: unknown, fallback = typeof error === 'string' ? error : '请求失败', duration?: number): string => {
  const message = getErrorMessage(error, fallback)
  toast.warning(message, duration)
  return message
}
