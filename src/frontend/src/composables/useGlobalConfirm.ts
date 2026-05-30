import { ElMessageBox } from '@ozwasyd/element-plus'
import { isFsusUiOk } from '@/utils/fsusUiResult'

type GlobalConfirmRequest = Readonly<{
  title: string
  content: string
  confirmText?: string
  cancelText?: string
}>

export const requestGlobalConfirm = async (request: GlobalConfirmRequest): Promise<boolean> => {
  const result = await ElMessageBox.confirm(request.content, request.title, {
    confirmButtonText: request.confirmText ?? '确认',
    cancelButtonText: request.cancelText ?? '取消',
    type: 'warning'
  })
  return isFsusUiOk(result)
}
