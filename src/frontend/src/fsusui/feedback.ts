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
  detail?: string
  type?: 'success' | 'error' | 'info' | 'warning' | 'article'
  duration?: number
  onClick?: () => void
}

export interface ToastHandle {
  close: () => void
}

type ToastInput = string | Readonly<{
  message: string
  detail?: string
  duration?: number
}>

export function formatToastMessage(options: Pick<ToastOptions, 'message' | 'detail'>): string {
  const message = options.message.trim()
  const detail = options.detail?.trim()
  return detail ? `${message}：${detail}` : message
}

function normalizeToastInput(input: ToastInput, duration?: number): Pick<ToastOptions, 'message' | 'detail' | 'duration'> {
  if (typeof input === 'string') {
    return { message: input, duration }
  }

  return {
    message: input.message,
    detail: input.detail,
    duration: input.duration ?? duration
  }
}

export const showToast = (options: ToastOptions | string): ToastHandle => {
  const opts = typeof options === 'string' ? { message: options } : options
  const displayMessage = formatToastMessage(opts)

  if (!displayMessage) return { close: () => {} }

  const elType = opts.type === 'article' ? 'success' : opts.type
  const liveRegionAttrs = {
    'aria-live': opts.type === 'error' ? 'assertive' : 'polite',
    'aria-atomic': 'true'
  }

  const messageVNode = opts.onClick
    ? h('span', liveRegionAttrs, [
        h(ElButton, { link: true, type: 'primary', onClick: opts.onClick }, () => displayMessage)
      ])
    : h('span', liveRegionAttrs, displayMessage)

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
  info: (input: ToastInput, duration?: number) =>
    showToast({ ...normalizeToastInput(input, duration), type: 'info' }),
  success: (input: ToastInput, duration?: number) =>
    showToast({ ...normalizeToastInput(input, duration), type: 'success' }),
  warning: (input: ToastInput, duration = 3500) =>
    showToast({ ...normalizeToastInput(input, duration), type: 'warning' }),
  partial: (input: ToastInput, duration = 3500) =>
    showToast({ ...normalizeToastInput(input, duration), type: 'warning' }),
  error: (input: ToastInput, duration = 4000) =>
    showToast({ ...normalizeToastInput(input, duration), type: 'error' }),
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
