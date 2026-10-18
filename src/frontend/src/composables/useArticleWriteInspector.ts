import { getCurrentScope, nextTick, onScopeDispose, ref, shallowReactive } from 'vue';

export const articleWriteInspectorRegistry = [
    { id: 'publish', label: '发布' },
    { id: 'rights', label: '版权' },
    { id: 'check', label: '检查' },
    { id: 'preview', label: '预览' },
    { id: 'versions', label: '版本' },
    { id: 'resources', label: '资源' }
] as const;

export type ArticleWriteInspectorView = typeof articleWriteInspectorRegistry[number]['id'];

type ArticleWriteInspectorLoader = () => void | Promise<void>;

interface ArticleWriteInspectorOptions {
    initialInspector?: ArticleWriteInspectorView | null;
    loadView?: Partial<Record<ArticleWriteInspectorView, ArticleWriteInspectorLoader>>;
}

export function useArticleWriteInspector(options: ArticleWriteInspectorOptions = {})
{
    const activeInspector = ref<ArticleWriteInspectorView | null>(options.initialInspector ?? null);
    const requestedViews = shallowReactive(new Set<ArticleWriteInspectorView>());
    const scrollPositions = shallowReactive(new Map<ArticleWriteInspectorView, number>());
    const scrollContainers = new Map<ArticleWriteInspectorView, HTMLElement>();
    const railTriggers = new Map<ArticleWriteInspectorView, HTMLElement>();
    const pendingLoads = new Map<ArticleWriteInspectorView, Promise<void>>();
    let focusReturnTarget: HTMLElement | null = null;
    let closingInspector: ArticleWriteInspectorView | null = null;
    let focusGeneration = 0;
    let disposed = false;
    let pendingFocusFrame: { id: number; finish: () => void; } | null = null;

    const invalidateFocusRestore = (): void =>
    {
        focusGeneration += 1;
        const frame = pendingFocusFrame;
        pendingFocusFrame = null;
        if (frame)
        {
            if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
            {
                window.cancelAnimationFrame(frame.id);
            }
            // Cancellation must also settle callers awaiting the old frame.
            frame.finish();
        }
    };

    const canRestoreFocus = (target: HTMLElement | null): target is HTMLElement =>
    {
        if (!target?.isConnected || target.matches(':disabled, [aria-disabled="true"]'))
        {
            return false;
        }
        for (let element: HTMLElement | null = target; element; element = element.parentElement)
        {
            if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true')
            {
                return false;
            }
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse')
            {
                return false;
            }
        }
        return true;
    };

    const rememberScroll = (view: ArticleWriteInspectorView | null): void =>
    {
        if (!view)
        {
            return;
        }

        const container = scrollContainers.get(view);
        if (container)
        {
            scrollPositions.set(view, container.scrollTop);
        }
    };

    const restoreScroll = async (view: ArticleWriteInspectorView): Promise<void> =>
    {
        await nextTick();
        if (disposed || activeInspector.value !== view)
        {
            return;
        }
        const container = scrollContainers.get(view);
        if (container)
        {
            container.scrollTop = scrollPositions.get(view) ?? 0;
        }
    };

    const ensureLoaded = (view: ArticleWriteInspectorView): Promise<void> =>
    {
        const pending = pendingLoads.get(view);
        if (pending)
        {
            return pending;
        }
        if (requestedViews.has(view))
        {
            return Promise.resolve();
        }

        requestedViews.add(view);
        const loader = options.loadView?.[view];
        const request = Promise.resolve(loader?.())
            .finally(() =>
            {
                pendingLoads.delete(view);
            });
        pendingLoads.set(view, request);
        return request;
    };

    const open = (
        view: ArticleWriteInspectorView,
        trigger?: HTMLElement | null
    ): Promise<void> =>
    {
        if (disposed)
        {
            return Promise.resolve();
        }
        invalidateFocusRestore();
        closingInspector = null;
        if (activeInspector.value !== view)
        {
            rememberScroll(activeInspector.value);
        }

        focusReturnTarget = trigger ?? railTriggers.get(view) ?? focusReturnTarget;
        activeInspector.value = view;
        const loading = ensureLoaded(view);
        void restoreScroll(view);
        return loading;
    };

    const switchTo = (view: ArticleWriteInspectorView): Promise<void> =>
    {
        if (disposed)
        {
            return Promise.resolve();
        }
        invalidateFocusRestore();
        closingInspector = null;
        if (activeInspector.value !== view)
        {
            rememberScroll(activeInspector.value);
        }

        activeInspector.value = view;
        const loading = ensureLoaded(view);
        void restoreScroll(view);
        return loading;
    };

    const close = (): void =>
    {
        if (disposed || activeInspector.value === null)
        {
            return;
        }
        invalidateFocusRestore();
        closingInspector = activeInspector.value;
        rememberScroll(closingInspector);
        activeInspector.value = null;
    };

    const toggle = (
        view: ArticleWriteInspectorView,
        trigger?: HTMLElement | null
    ): Promise<void> =>
    {
        if (activeInspector.value === view)
        {
            close();
            return Promise.resolve();
        }

        return open(view, trigger);
    };

    const registerTrigger = (
        view: ArticleWriteInspectorView,
        element: HTMLElement | null
    ): void =>
    {
        if (disposed)
        {
            return;
        }
        if (element)
        {
            railTriggers.set(view, element);
            return;
        }
        railTriggers.delete(view);
    };

    const registerScrollContainer = (
        view: ArticleWriteInspectorView,
        element: HTMLElement | null
    ): void =>
    {
        if (disposed)
        {
            return;
        }
        if (!element)
        {
            scrollContainers.delete(view);
            return;
        }

        scrollContainers.set(view, element);
        if (view === activeInspector.value)
        {
            element.scrollTop = scrollPositions.get(view) ?? 0;
        }
    };

    const updateScroll = (view: ArticleWriteInspectorView, scrollTop: number): void =>
    {
        scrollPositions.set(view, scrollTop);
    };

    const restoreFocus = async (): Promise<void> =>
    {
        if (disposed || activeInspector.value !== null || closingInspector === null)
        {
            return;
        }
        invalidateFocusRestore();
        const generation = focusGeneration;
        await nextTick();
        if (disposed || generation !== focusGeneration || activeInspector.value !== null)
        {
            return;
        }
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
        {
            await new Promise<void>((resolve) =>
            {
                const frame = { id: 0, finish: resolve };
                pendingFocusFrame = frame;
                frame.id = window.requestAnimationFrame(() =>
                {
                    if (pendingFocusFrame === frame)
                    {
                        pendingFocusFrame = null;
                    }
                    resolve();
                });
            });
        }
        if (disposed || generation !== focusGeneration || activeInspector.value !== null)
        {
            return;
        }
        const fallback = closingInspector ? railTriggers.get(closingInspector) ?? null : null;
        const target = canRestoreFocus(focusReturnTarget) ? focusReturnTarget
            : canRestoreFocus(fallback) ? fallback : null;
        focusReturnTarget = null;
        closingInspector = null;
        target?.focus({ preventScroll: true });
    };

    if (getCurrentScope())
    {
        onScopeDispose(() =>
        {
            disposed = true;
            invalidateFocusRestore();
            focusReturnTarget = null;
            closingInspector = null;
            railTriggers.clear();
            scrollContainers.clear();
        });
    }

    if (activeInspector.value)
    {
        void ensureLoaded(activeInspector.value);
    }

    return {
        activeInspector,
        requestedViews,
        scrollPositions,
        open,
        switchTo,
        close,
        toggle,
        ensureLoaded,
        registerTrigger,
        registerScrollContainer,
        updateScroll,
        restoreFocus
    };
}
