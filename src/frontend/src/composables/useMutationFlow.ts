import type { AbortableExecutor } from '@/composables/useAbortableTask'
import { useViewTask } from '@/composables/useViewTask'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { requestGlobalConfirm } from '@/composables/useGlobalConfirm'

type MutationMessageType = 'success' | 'warning' | 'error' | 'info'

type MutationConfirmOptions = Readonly<{
  message: string
  title: string
  confirmButtonText: string
  cancelButtonText?: string
}>

type MutationRunOptions = Readonly<{
  fallbackMessage: string
  successMessage?: string
  successType?: MutationMessageType
  onSuccess?: () => Promise<boolean | void> | boolean | void
  postSuccessWarningMessage?: string
}>

export type MutationRunResult = Readonly<{
  ok: boolean
  mutationSucceeded: boolean
  postSuccessSyncFailed: boolean
  postSuccessError?: unknown
}>

export function useMutationFlow() {
  const task = useViewTask()

  const run = async (
    executor: AbortableExecutor<unknown>,
    options: MutationRunOptions
  ): Promise<MutationRunResult> => {
    const result = await task.run(executor, {
      fallbackMessage: options.fallbackMessage
    })

    if (result === undefined && task.errorMessage.value) {
      toast.error(task.errorMessage.value)
      return {
        ok: false,
        mutationSucceeded: false,
        postSuccessSyncFailed: false
      }
    }

    let postSuccessSyncFailed = false
    let postSuccessError: unknown
    if (options.onSuccess) {
      try {
        const syncResult = await options.onSuccess()
        postSuccessSyncFailed = syncResult === false
      } catch (error: unknown) {
        postSuccessSyncFailed = true
        postSuccessError = error
        console.error('[MutationFlow] post-success sync failed:', error)
      }
    }

    if (options.successMessage) {
      const type = options.successType ?? 'success'
      if (type === 'warning') {
        toast.warning(options.successMessage)
      } else if (type === 'error') {
        toast.error(options.successMessage)
      } else if (type === 'info') {
        toast.info(options.successMessage)
      } else {
        toast.success(options.successMessage)
      }
    }

    if (postSuccessSyncFailed) {
      const fallback = options.postSuccessWarningMessage ?? '操作已生效，但界面同步失败，请稍后刷新'
      showWarningToast(postSuccessError ?? fallback, fallback)
    }

    return {
      ok: true,
      mutationSucceeded: true,
      postSuccessSyncFailed,
      postSuccessError
    }
  }

  const confirmThenRun = async (
    confirm: MutationConfirmOptions,
    executor: AbortableExecutor<unknown>,
    options: MutationRunOptions
  ): Promise<MutationRunResult> => {
    try {
      const confirmed = await requestGlobalConfirm({
        title: confirm.title,
        content: confirm.message,
        confirmText: confirm.confirmButtonText,
        cancelText: confirm.cancelButtonText
      })

      if (!confirmed) {
        return {
          ok: false,
          mutationSucceeded: false,
          postSuccessSyncFailed: false
        }
      }
    } catch (error: unknown) {
      showErrorToast(error, options.fallbackMessage)
      return {
        ok: false,
        mutationSucceeded: false,
        postSuccessSyncFailed: false,
        postSuccessError: error
      }
    }

    return run(executor, options)
  }

  return {
    task,
    loading: task.loading,
    errorMessage: task.errorMessage,
    run,
    confirmThenRun,
    cancel: task.cancel
  }
}
