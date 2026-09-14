import { onMounted, onUnmounted, ref } from 'vue';

export function useMediaQuery(query: string, fallback = false)
{
    const matches = ref(fallback);
    let mediaQuery: MediaQueryList | null = null;

    const sync = (event?: MediaQueryListEvent): void =>
    {
        matches.value = event?.matches ?? mediaQuery?.matches ?? fallback;
    };

    onMounted(() =>
    {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
        {
            return;
        }

        mediaQuery = window.matchMedia(query);
        sync();
        mediaQuery.addEventListener('change', sync);
    });

    onUnmounted(() =>
    {
        mediaQuery?.removeEventListener('change', sync);
        mediaQuery = null;
    });

    return matches;
}
