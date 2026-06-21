import type { App } from 'vue'
import { h } from 'vue'
import { ElButton, ElLoading, ElMessage, ElMessageBox } from '@ozwasyd/element-plus'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'
import { isFsusUiOk } from '@/fsusui/result'

type MessageBoxOptions = Record<string, unknown>

export const installFsusUiLoading = (app: App): void => {
  app.use(ElLoading)
}

export interface ToastOptions {
  message: string
  type?: 'success' | 'error' | 'info' | 'warning' | 'article'
  duration?: number
  onClick?: () => void
}

export interface ToastHandle {
  close: () => void
}

export const showToast = (options: ToastOptions | string): ToastHandle => {
  const opts = typeof options === 'string' ? { message: options } : options

  if (!opts.message) return { close: () => {} }

  const elType = opts.type === 'article' ? 'success' : opts.type

  const messageVNode = opts.onClick
    ? h(ElButton, { link: true, type: 'primary', onClick: opts.onClick }, () => opts.message)
    : opts.message

  const messageOptions: Record<string, unknown> = {
    message: messageVNode,
    type: elType as any,
    customClass: `fsusblog-motion-toast fsusblog-motion-toast--${fsusBlogMotionPresets.toast}`
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

async function runMessageBox(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action()
  } catch {
    return null
  }
}

export async function confirmWarning(
  message: string,
  title: string,
  options: MessageBoxOptions = {}
): Promise<boolean> {
  const result = await runMessageBox(() => ElMessageBox.confirm(message, title, {
    type: 'warning',
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    ...options
  }))
  return isFsusUiOk(result)
}

export async function confirmDanger(
  message: string,
  title: string,
  options: MessageBoxOptions = {}
): Promise<boolean> {
  return await confirmWarning(message, title, {
    confirmButtonText: '确认删除',
    ...options
  })
}

export async function confirmInfo(
  message: string,
  title: string,
  options: MessageBoxOptions = {}
): Promise<boolean> {
  const result = await runMessageBox(() => ElMessageBox.confirm(message, title, {
    type: 'info',
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    ...options
  }))
  return isFsusUiOk(result)
}

export async function alertInfo(
  message: string,
  title: string,
  options: MessageBoxOptions = {}
): Promise<boolean> {
  const result = await runMessageBox(() => ElMessageBox.alert(message, title, {
    confirmButtonText: '确定',
    ...options
  }))
  return isFsusUiOk(result)
}

export async function promptText(
  message: string,
  title: string,
  options: MessageBoxOptions = {}
): Promise<string | null> {
  const result = await runMessageBox(() => ElMessageBox.prompt(message, title, {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    ...options
  }))
  if (!isFsusUiOk(result)) {
    return null
  }

  return ((result as { value?: { value?: string } }).value?.value ?? '').trim()
}
