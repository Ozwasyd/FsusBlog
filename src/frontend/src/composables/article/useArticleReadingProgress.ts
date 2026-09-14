import { onMounted, onUnmounted, ref, type MaybeRefOrGetter, toValue, watch } from 'vue';

export function useArticleReadingProgress(contentRoot: MaybeRefOrGetter<HTMLElement | null>)
{
    const progress = ref(0);
    let frame = 0;

    const calculate = (): void =>
    {
        frame = 0;
        const root = toValue(contentRoot);
        if (!root || typeof window === 'undefined')
        {
            progress.value = 0;
            return;
        }

        const rect = root.getBoundingClientRect();
        const start = window.scrollY + rect.top;
        const viewport = Math.max(1, window.innerHeight);
        const readableEnd = start + Math.max(0, root.scrollHeight - viewport * 0.45);
        const current = window.scrollY;
        const range = Math.max(1, readableEnd - start);
        progress.value = Math.min(1, Math.max(0, (current - start) / range));
    };

    const schedule = (): void =>
    {
        if (frame !== 0)
        {
            return;
        }
        frame = window.requestAnimationFrame(calculate);
    };

    onMounted(() =>
    {
        calculate();
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule, { passive: true });
    });

    onUnmounted(() =>
    {
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        if (frame !== 0)
        {
            window.cancelAnimationFrame(frame);
            frame = 0;
        }
    });

    watch(() => toValue(contentRoot), () =>
    {
        schedule();
    }, { flush: 'post' });

    return {
        progress,
        refresh: schedule
    };
}
