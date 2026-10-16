import { onMounted, onUnmounted, ref } from 'vue';

export function usePublicPageLifecycle(options?: { debounceMs?: number; onDispose?: () => void; })
{
    const isMounted = ref(false);
    let debounceTimer: ReturnType<Window['setTimeout']> | null = null;

    const isActive = (): boolean => isMounted.value;

    const runIfActive = (callback: () => void): void =>
    {
        if (isMounted.value)
        {
            callback();
        }
    };

    const scheduleSync = (callback: () => void, delayMs = options?.debounceMs ?? 500): void =>
    {
        if (debounceTimer)
        {
            clearTimeout(debounceTimer);
        }

        debounceTimer = window.setTimeout(() =>
        {
            debounceTimer = null;
            if (isMounted.value)
            {
                callback();
            }
        }, delayMs);
    };

    const cancelScheduledSync = (): void =>
    {
        if (!debounceTimer)
        {
            return;
        }

        clearTimeout(debounceTimer);
        debounceTimer = null;
    };

    onMounted(() =>
    {
        isMounted.value = true;
    });

    onUnmounted(() =>
    {
        isMounted.value = false;
        cancelScheduledSync();
        options?.onDispose?.();
    });

    return {
        isMounted,
        isActive,
        runIfActive,
        scheduleSync,
        cancelScheduledSync
    };
}
