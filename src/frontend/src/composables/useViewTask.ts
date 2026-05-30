import { computed, ref } from 'vue'
import { useAbortableTask, type AbortableExecutor } from '@/composables/useAbortableTask'
import { getErrorMessage, isAbortError } from '@/utils/errors'

type ViewTaskRunOptions = Readonly<{
  fallbackMessage?: string
  clearError?: boolean
  onError?: (error: unknown, message: string) => void
}>

export function useViewTask() {
  const task = useAbortableTask()
  const loading = ref(false)
  const errorMessage = ref('')

  const clearError = (): void => {
    errorMessage.value = ''
  }

  const run = async <T>(executor: AbortableExecutor<T>, options: ViewTaskRunOptions = {}): Promise<T | undefined> => {
    if (options.clearError !== false) {
      errorMessage.value = ''
    }

    loading.value = true
    try {
      return await task.run(executor)
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return undefined
      }

      const message = getErrorMessage(error, options.fallbackMessage || '请求失败')
      errorMessage.value = message
      options.onError?.(error, message)
      return undefined
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    errorMessage,
    hasError: computed(() => errorMessage.value.length > 0),
    run,
    clearError,
    cancel: task.cancel,
    isRunning: task.isRunning,
    currentSignal: task.currentSignal
  }
}
