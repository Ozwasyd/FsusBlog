import { h } from 'vue'
import { ElButton, ElMessage } from '@ozwasyd/element-plus'

export interface ToastOptions {
  message: string
  type?: 'success' | 'error' | 'info' | 'warning' | 'article'
  duration?: number
  onClick?: () => void
}

export interface ToastHandle {
  close: () => void
}

const showToast = (options: ToastOptions | string): ToastHandle => {
  const opts = typeof options === 'string' ? { message: options } : options

  if (!opts.message) return { close: () => {} }

  const elType = opts.type === 'article' ? 'success' : opts.type

  const messageVNode = opts.onClick
    ? h(ElButton, { link: true, type: 'primary', onClick: opts.onClick }, () => opts.message)
    : opts.message

  const messageOptions: Record<string, unknown> = {
    message: messageVNode,
    type: elType as any
  }

  if (opts.duration !== undefined) {
    messageOptions.duration = opts.duration
  }

  const instance = ElMessage(messageOptions as any)

  return {
    close: () => {
      instance.close()
    }
  }
}

export const toast = {
  info: (msg: string, duration?: number) => showToast({ message: msg, type: 'info', duration }),
  success: (msg: string, duration?: number) => showToast({ message: msg, type: 'success', duration }),
  warning: (msg: string, duration = 3500) => showToast({ message: msg, type: 'warning', duration }),
  error: (msg: string, duration = 4000) => showToast({ message: msg, type: 'error', duration }),
  article: (msg: string, onClick?: () => void, duration = 6000) =>
    showToast({ message: msg, type: 'article', duration, onClick }),
}
