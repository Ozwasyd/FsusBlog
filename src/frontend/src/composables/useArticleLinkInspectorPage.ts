import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref, type ShallowRef } from 'vue';

import type { ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from '@/services/authoring/articleDocumentContext';
import type { ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';

export interface ArticleLinkInspectorPageOptions {
    readonly owner: ArticleDocumentContextAdapter;
    readonly runtime: Readonly<Ref<ArticleEditorRuntimeBinding | null>>;
    readonly active: Readonly<Ref<boolean>>;
    // Supplied only for an admitted page by the original permission/query owner.
    // An index/snippet digest alone cannot enable this consumer.
    readonly admittedCoordinate: Readonly<Ref<string | null>>;
    readonly section: 'outgoing' | 'backlinks' | 'risks' | 'mentions';
}

/** UI lifecycle only; neither a query implementation nor a result/permission validator. */
export function useArticleLinkInspectorPage<T>(options: ArticleLinkInspectorPageOptions)
{
    const data: ShallowRef<T | null> = shallowRef<T | null>(null);
    const status = shallowRef<'unavailable' | 'idle' | 'loading' | 'current' | 'stale' | 'error'>('unavailable');
    const contextKey = shallowRef<string | null>(null);
    let task: ArticleDocumentTaskLease | null = null;
    let disposed = false;
    let ownerDisposed = false;

    const bindingKey = (): string | null =>
    {
        const runtime = options.runtime.value;
        if (disposed || ownerDisposed || !runtime || !options.active.value || !options.admittedCoordinate.value)
        {
            return null;
        }
        try
        {
            if (!options.owner.isCurrentContext(runtime.context)
                || !options.owner.isCurrentContext(runtime.positionBinding().document))
            {
                return null;
            }
            return JSON.stringify([runtime.context.contextDigest, options.admittedCoordinate.value]);
        }
        catch
        {
            return null;
        }
    };

    const invalidate = (reason: string): void =>
    {
        const previous = task;
        task = null;
        previous?.cancel(reason);
        data.value = null;
        contextKey.value = null;
        status.value = bindingKey() === null ? 'unavailable' : 'stale';
    };

    const unsubscribe = options.owner.subscribeContext(context =>
    {
        ownerDisposed = context === null;
        invalidate('article-links-document-changed');
    });
    const stopWatch = watch(
        [options.runtime, options.active, options.admittedCoordinate],
        () => invalidate('article-links-owner-state-changed'),
        { flush: 'sync' }
    );
    if (bindingKey() !== null)
    {
        status.value = 'idle';
    }

    // The integration owner supplies its real admitted-page loader. No transport,
    // index inspection, snippet disclosure or replacement DTO is provided here.
    const load = async (loader: (signal: AbortSignal) => Promise<T>): Promise<boolean> =>
    {
        invalidate('article-links-page-superseded');
        const key = bindingKey();
        if (key === null)
        {
            return false;
        }
        const lease = options.owner.beginTask('feature', `article-links:${options.section}`, 'article-links-page:v1');
        task = lease;
        status.value = 'loading';
        const abort = (): void =>
        {
            if (task === lease)
            {
                task = null;
                invalidate('article-links-lease-aborted');
            }
        };
        lease.signal.addEventListener('abort', abort, { once: true });
        try
        {
            const page = await loader(lease.signal);
            if (task !== lease || bindingKey() !== key || !lease.isCurrent())
            {
                if (task === lease)
                {
                    invalidate('article-links-page-stale');
                }
                return false;
            }
            // The existing lease decides document/revision acceptance. Do not put
            // private page content into its task metadata or claim query admission.
            const acceptance = lease.accept(null, lease.envelope.startedRevision);
            if (!acceptance.accepted)
            {
                invalidate('article-links-page-stale');
                return false;
            }
            data.value = page;
            contextKey.value = key;
            status.value = 'current';
            return true;
        }
        catch
        {
            if (task === lease)
            {
                data.value = null;
                contextKey.value = null;
                status.value = bindingKey() === null ? 'unavailable'
                    : lease.isCurrent() && bindingKey() === key ? 'error' : 'stale';
            }
            return false;
        }
        finally
        {
            // Finishes only this owner's request, never a later request.
            lease.signal.removeEventListener('abort', abort);
            lease.complete();
            if (task === lease)
            {
                task = null;
            }
        }
    };

    const cancel = (): void => invalidate('article-links-page-canceled');
    const dispose = (): void =>
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        unsubscribe();
        stopWatch();
        invalidate('article-links-page-disposed');
    };
    if (getCurrentScope())
    {
        onScopeDispose(dispose);
    }
    return { data: computed(() => data.value), status: computed(() => status.value), contextKey: computed(() => contextKey.value),
        loading: computed(() => status.value === 'loading'), load, cancel, dispose };
}
