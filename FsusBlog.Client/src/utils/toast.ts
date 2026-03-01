import { createVNode, render, type VNode } from 'vue'
import ToastComponent from '@/components/ui/Toast.vue'

export interface ToastOptions {
  message: string
  type?: 'success' | 'error' | 'info' | 'article'
  duration?: number
  onClick?: () => void
}

export interface ToastHandle {
  close: () => void
}

// [修复 2026-02-23] P1 修复：全局单例根容器，减少 Layout Thrashing
let toastRoot: HTMLElement | null = null

const ensureRoot = () => {
  if (typeof document === 'undefined') return null // P0 修复：SSR 环境安全
  if (!toastRoot) {
    toastRoot = document.getElementById('fsus-toast-root')
    if (!toastRoot) {
      toastRoot = document.createElement('div')
      toastRoot.id = 'fsus-toast-root'
      // 逻辑自洽：容器负责物理定位，不阻断背景点击
      toastRoot.className = 'fixed top-0 left-0 right-0 z-[9999] pointer-events-none'
      document.body.appendChild(toastRoot)
    }
  }
  return toastRoot
}

/**
 * 核心调度函数
 * [修复 2026-02-23] P0 修复：增加物理中断句柄与资源回收兜底
 */
const showToast = (options: ToastOptions | string): ToastHandle => {
  const opts = typeof options === 'string' ? { message: options } : options
  
  // 1. 安全性保障：Guard 空消息
  if (!opts.message) return { close: () => {} }

  const root = ensureRoot()
  if (!root) return { close: () => {} }

  // 2. 创建挂载容器
  const container = document.createElement('div')
  root.appendChild(container)

  let isDestroyed = false
  const destroy = () => {
    if (isDestroyed) return
    isDestroyed = true
    render(null, container)
    if (container.parentNode) {
      container.parentNode.removeChild(container)
    }
  }

  // 3. 渲染虚拟节点
  // [修复 2026-02-23] P2 修复：支持 programmatic 关闭
  const vnode: VNode = createVNode(ToastComponent, {
    ...opts,
    onDestroy: destroy
  })

  try {
    render(vnode, container)
  } catch (err) {
    console.error('[Toast Scheduler] Render failed:', err)
    destroy()
    return { close: () => {} }
  }

  // 4. P0 修复：物理回收兜底机制
  // 即使组件内部动画或逻辑发生异常，duration + 1s 后强制物理销毁 DOM
  const safetyTimer = setTimeout(destroy, (opts.duration || 3000) + 2000)

  return {
    close: () => {
      clearTimeout(safetyTimer)
      // 通过修改组件 visible 触发其退场动画
      if (vnode.component?.exposed) {
        vnode.component.exposed.hide()
      } else {
        destroy()
      }
    }
  }
}

export const toast = {
  info: (msg: string, duration = 3000) => showToast({ message: msg, type: 'info', duration }),
  success: (msg: string, duration = 3000) => showToast({ message: msg, type: 'success', duration }),
  error: (msg: string, duration = 4000) => showToast({ message: msg, type: 'error', duration }),
  article: (msg: string, onClick?: () => void, duration = 6000) => 
    showToast({ message: msg, type: 'article', duration, onClick }),
}