import { confirmWarning, toast } from '@/fsusui/feedback'

type GlobalConfirmRequest = Readonly<{
  title: string
  content: string
  confirmText?: string
  cancelText?: string
}>

export const requestGlobalConfirm = async (request: GlobalConfirmRequest): Promise<boolean> => {
  const result = await confirmWarning(request.content, request.title, {
    confirmButtonText: request.confirmText ?? '确认',
    cancelButtonText: request.cancelText ?? '取消'
  })

  switch (result.kind) {
    case 'confirmed':
      return true
    case 'cancelled':
      return false
    case 'error':
      toast.error({
        message: '确认对话框打开失败',
        detail: result.error instanceof Error ? result.error.message : undefined
      })
      return false
  }
}
