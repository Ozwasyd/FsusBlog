import { readonly, ref } from 'vue'
import { ElMessageBox } from '@ozwasyd/element-plus'

type GlobalConfirmRequest = Readonly<{
  title: string
  content: string
  confirmText?: string
  cancelText?: string
}>

// Keep backward compatibility for the hook just in case, but redirect to ElMessageBox
const visible = ref(false)
const title = ref('')
const content = ref('')
const confirmText = ref('确认')
const cancelText = ref('取消')

export const requestGlobalConfirm = async (request: GlobalConfirmRequest): Promise<boolean> => {
  try {
    await ElMessageBox.confirm(request.content, request.title, {
      confirmButtonText: request.confirmText || '确认',
      cancelButtonText: request.cancelText || '取消',
      type: 'warning',
      customClass: 'fsus-confirm-box',
      lockScroll: false
    })
    return true
  } catch {
    return false
  }
}

export function useGlobalConfirmHost() {
  const confirm = (): void => {
    // dummy to satisfy typing if still imported somewhere temporarily
  }

  const cancel = (): void => {
    // dummy
  }

  return {
    visible: readonly(visible),
    title: readonly(title),
    content: readonly(content),
    confirmText: readonly(confirmText),
    cancelText: readonly(cancelText),
    confirm,
    cancel
  }
}
