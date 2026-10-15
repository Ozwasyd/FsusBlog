import { useScrollReveal } from '@ozwasyd/element-plus/motion';
import { getCurrentInstance, h, nextTick, onUnmounted, ref, render, type MaybeRefOrGetter, toValue, watch, watchEffect } from 'vue';

import { fsusBlogScrollRevealOptions } from '@/fsusui/blogMotion';
import { FsusUiButton } from '@/fsusui/button';
import { toast } from '@/fsusui/feedback';
import { activeLocale, translate } from '@/locales';

const ENHANCED_ATTR = 'data-fsus-code-copy';

async function writeClipboard(text: string): Promise<void>
{
    if (navigator.clipboard?.writeText)
    {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.className = 'fsus-clipboard-fallback';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied)
    {
        throw new Error('copy rejected');
    }
}

export function useCodeBlockCopy(
    contentRoot: MaybeRefOrGetter<HTMLElement | null>,
    allowCodeCopy: MaybeRefOrGetter<boolean> = true
)
{
    const appContext = getCurrentInstance()?.appContext;
    if (!appContext)
    {
        throw new Error('useCodeBlockCopy requires an owning Vue component');
    }
    const mountedControls = new Map<HTMLElement, (() => void) | null>();
    const resetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
    const revealControls = useScrollReveal({ ...fsusBlogScrollRevealOptions });
    let enhancementGeneration = 0;
    let disposed = false;

    const cleanup = (): void =>
    {
        enhancementGeneration++;
        revealControls.kill();
        for (const [container, stopRendering] of mountedControls)
        {
            const resetTimer = resetTimers.get(container);
            if (resetTimer)
            {
                globalThis.clearTimeout(resetTimer);
                resetTimers.delete(container);
            }
            stopRendering?.();
            render(null, container);
            container.remove();
        }
        mountedControls.clear();
        const root = toValue(contentRoot);
        root?.querySelectorAll<HTMLElement>(`pre[${ENHANCED_ATTR}]`).forEach((pre) =>
        {
            pre.removeAttribute(ENHANCED_ATTR);
            pre.classList.remove('fsus-code-copy-host');
            pre.removeAttribute('data-fsus-motion-surface');
        });
    };

    const enhance = async (): Promise<void> =>
    {
        const generation = enhancementGeneration;
        await nextTick();
        if (disposed || generation !== enhancementGeneration)
        {
            return;
        }
        const root = toValue(contentRoot);
        if (!root)
        {
            cleanup();
            return;
        }
        if (!toValue(allowCodeCopy))
        {
            cleanup();
            return;
        }

        root.querySelectorAll<HTMLElement>('pre').forEach((pre) =>
        {
            if (pre.hasAttribute(ENHANCED_ATTR))
            {
                return;
            }

            const code = pre.querySelector<HTMLElement>('code');
            const source = code?.textContent ?? pre.textContent ?? '';
            pre.setAttribute(ENHANCED_ATTR, 'true');
            pre.classList.add('fsus-code-copy-host');
            pre.setAttribute('data-fsus-motion-surface', 'article-code-block');

            const container = document.createElement('span');
            const copied = ref(false);
            const copyCode = async (event: MouseEvent): Promise<void> =>
            {
                event.preventDefault();
                event.stopPropagation();
                try
                {
                    await writeClipboard(source);
                    copied.value = true;
                    toast.success(translate('article.actions.codeCopied'), 1200);
                    // Clipboard completion may follow cleanup; keep its toast without creating an orphan timer.
                    if (!mountedControls.has(container))
                    {
                        return;
                    }
                    const previousTimer = resetTimers.get(container);
                    if (previousTimer)
                    {
                        globalThis.clearTimeout(previousTimer);
                    }
                    const resetTimer = globalThis.setTimeout(() =>
                    {
                        copied.value = false;
                        resetTimers.delete(container);
                    }, 1400);
                    resetTimers.set(container, resetTimer);
                }
                catch
                {
                    toast.error(translate('article.actions.copyFailed'), 2200);
                }
            };

            mountedControls.set(container, null);
            pre.appendChild(container);
            const stopRendering = watchEffect(() =>
            {
                const label = translate(copied.value ? 'article.actions.codeCopied' : 'article.actions.copyCode');
                const button = h(FsusUiButton, {
                    nativeType: 'button',
                    size: 'small',
                    class: 'fsus-code-copy-button blog-motion-reading-control',
                    'aria-label': label,
                    'aria-live': 'polite',
                    onClick: copyCode
                }, { default: () => label });
                button.appContext = appContext;
                render(button, container);
            }, { flush: 'sync' });
            mountedControls.set(container, stopRendering);
            try
            {
                revealControls.reveal(pre, fsusBlogScrollRevealOptions);
            }
            catch
            {
                // Copy is a content right and must remain usable when motion is unavailable.
                pre.removeAttribute('data-fsus-motion-surface');
            }
        });
    };

    watch(() => [toValue(contentRoot), toValue(allowCodeCopy), activeLocale.value] as const, () =>
    {
        cleanup();
        void enhance();
    }, { flush: 'post' });

    onUnmounted(() =>
    {
        disposed = true;
        cleanup();
    });

    return {
        refresh: enhance,
        cleanup
    };
}
