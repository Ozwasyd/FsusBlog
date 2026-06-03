import { confirmWarning } from '@/fsusui/feedback'

type GlobalConfirmRequest = Readonly<{
  title: string
  content: string
  confirmText?: string
  cancelText?: string
}>

export const requestGlobalConfirm = async (request: GlobalConfirmRequest): Promise<boolean> => {
  return await confirmWarning(request.content, request.title, {
    confirmButtonText: request.confirmText ?? '确认',
    cancelButtonText: request.cancelText ?? '取消'
  })
}
