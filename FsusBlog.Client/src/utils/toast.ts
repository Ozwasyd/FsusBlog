import { h } from 'vue'
import { ElMessage } from '@ozwasyd/element-plus'

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
    ? h('span', { onClick: opts.onClick, style: { cursor: 'pointer', textDecoration: 'underline' } }, opts.message)
    : opts.message

  const instance = ElMessage({
    message: messageVNode,
    type: elType as any,
    duration: opts.duration ?? 3000,
    offset: 24,
    appendTo: typeof document !== 'undefined' ? document.body : undefined,
    customClass: ['fsus-account-toast', opts.onClick ? 'cursor-pointer hover:opacity-80' : ''].filter(Boolean).join(' ')
  })

  return {
    close: () => {
      instance.close()
    }
  }
}

export const toast = {
  info: (msg: string, duration = 3000) => showToast({ message: msg, type: 'info', duration }),
  success: (msg: string, duration = 3000) => showToast({ message: msg, type: 'success', duration }),
  warning: (msg: string, duration = 3500) => showToast({ message: msg, type: 'warning', duration }),
  error: (msg: string, duration = 4000) => showToast({ message: msg, type: 'error', duration }),
  article: (msg: string, onClick?: () => void, duration = 6000) =>
    showToast({ message: msg, type: 'article', duration, onClick }),
}
