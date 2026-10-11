import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue';

import type {
    ArticleDocumentTaskKind,
    ArticleDocumentTaskLease,
    ArticleDocumentTaskRegistry
} from '@/services/authoring/articleDocumentContext';

export type AbortableExecutor<T> = (signal: AbortSignal) => Promise<T>;

export interface UseAbortableTaskOptions {
    readonly registry?: ArticleDocumentTaskRegistry;
    readonly kind?: ArticleDocumentTaskKind;
    readonly producerRef?: string;
    readonly producerVersion?: string;
}

export function useAbortableTask(options: UseAbortableTaskOptions = {})
{
    const signal = shallowRef<AbortSignal | null>(null);
    let localController: AbortController | null = null;
    let activeLease: ArticleDocumentTaskLease | null = null;

    const cancel = () =>
    {
        if (activeLease)
        {
            activeLease.cancel('task-canceled');
            activeLease = null;
            signal.value = null;
            return;
        }
        if (!localController)
        {
            return;
        }

        localController.abort();
        localController = null;
        signal.value = null;
    };

    const run = async <T>(executor: AbortableExecutor<T>): Promise<T> =>
    {
        cancel();
        const lease = options.registry && options.kind
            ? options.registry.beginTask(
                options.kind,
                options.producerRef ?? 'abortable-task',
                options.producerVersion ?? 'v1.0'
            )
            : null;
        const current = lease ? null : new AbortController();
        activeLease = lease;
        localController = current;
        const currentSignal = lease?.signal ?? current!.signal;
        signal.value = currentSignal;

        try
        {
            const result = await executor(currentSignal);
            if (lease && activeLease === lease)
            {
                lease.complete(undefined, result);
            }
            return result;
        }
        finally
        {
            if (activeLease === lease)
            {
                if (lease)
                {
                    lease.complete();
                }
                activeLease = null;
                signal.value = null;
            }
            if (localController === current)
            {
                localController = null;
            }
            // Only the actual awaited executor and this cleanup have finished here.
            // cancel()/logical complete()/scope disposal alone never settle its work.
            lease?.settle();
        }
    };

    if (getCurrentScope())
    {
        onScopeDispose(cancel);
    }

    return {
        run,
        cancel,
        isRunning: computed(() => signal.value !== null),
        currentSignal: computed(() => signal.value)
    };
}
