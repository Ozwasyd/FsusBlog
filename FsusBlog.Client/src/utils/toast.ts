import { createVNode, render } from 'vue'
import ToastComponent from '@/components/ui/Toast.vue'

export interface ToastOptions {
  message: string
  type?: 'success' | 'error' | 'info' | 'article' // 新增 article 类型
  duration?: number
  onClick?: () => void // 新增点击回调
}

const showToast = (options: ToastOptions | string) => {
  const opts = typeof options === 'string' ? { message: options } : options
  const container = document.createElement('div')
  document.body.appendChild(container)

  const destroy = () => {
    render(null, container)
    container.remove()
  }

  const vnode = createVNode(ToastComponent, {
    ...opts,
    onDestroy: destroy
  })

  render(vnode, container)
}

export const toast = {
  info: (msg: string, duration = 3000) => showToast({ message: msg, type: 'info', duration }),
  success: (msg: string, duration = 3000) => showToast({ message: msg, type: 'success', duration }),
  error: (msg: string, duration = 4000) => showToast({ message: msg, type: 'error', duration }),
  article: (msg: string, onClick?: () => void, duration = 6000) => 
    showToast({ message: msg, type: 'article', duration, onClick }),
}