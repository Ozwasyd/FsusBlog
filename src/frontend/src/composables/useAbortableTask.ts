import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue';

export type AbortableExecutor<T> = (signal: AbortSignal) => Promise<T>;

export function useAbortableTask() {
  const controller = shallowRef<AbortController | null>(null);

  const cancel = () => {
    if (!controller.value) {
      return;
    }

    controller.value.abort();
    controller.value = null;
  };

  const run = async <T>(executor: AbortableExecutor<T>): Promise<T> => {
    cancel();
    const current = new AbortController();
    controller.value = current;

    try {
      return await executor(current.signal);
    } finally {
      if (controller.value === current) {
        controller.value = null;
      }
    }
  };

  if (getCurrentScope()) {
    onScopeDispose(cancel);
  }

  return {
    run,
    cancel,
    isRunning: computed(() => controller.value !== null),
    currentSignal: computed(() => controller.value?.signal ?? null)
  };
}
