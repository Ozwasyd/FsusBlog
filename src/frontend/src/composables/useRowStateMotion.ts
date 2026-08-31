import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';

export type RowMotionState = 'pending' | 'updated' | 'error';
export type RowMotionKey = string | number;

type RowMotionOptions = Readonly<{
    settleMs?: number;
    visibleLimit?: number;
}>;

const DEFAULT_SETTLE_MS = 1_600;
const DEFAULT_VISIBLE_LIMIT = 20;

function normalizeKeys(keys: RowMotionKey | readonly RowMotionKey[]): string[]
{
    return (Array.isArray(keys) ? keys : [keys]).map((key) => String(key));
}

export function useRowStateMotion(options: RowMotionOptions = {})
{
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    const visibleLimit = options.visibleLimit ?? DEFAULT_VISIBLE_LIMIT;
    const states = ref<Record<string, RowMotionState>>({});
    const summary = ref('');
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearTimer = (key: string): void =>
    {
        const timer = timers.get(key);
        if (timer)
        {
            globalThis.clearTimeout(timer);
            timers.delete(key);
        }
    };

    const clear = (keys?: RowMotionKey | readonly RowMotionKey[]): void =>
    {
        if (keys === undefined)
        {
            for (const key of Array.from(timers.keys()))
            {
                clearTimer(key);
            }
            states.value = {};
            summary.value = '';
            return;
        }

        const next = { ...states.value };
        for (const key of normalizeKeys(keys))
        {
            clearTimer(key);
            delete next[key];
        }
        states.value = next;
    };

    const setState = (
        keys: RowMotionKey | readonly RowMotionKey[],
        state: RowMotionState,
        autoClear: boolean
    ): void =>
    {
        const normalizedKeys = normalizeKeys(keys);
        if (normalizedKeys.length === 0)
        {
            return;
        }

        if (normalizedKeys.length > visibleLimit)
        {
            summary.value = summary.value || `已更新 ${normalizedKeys.length} 行`;
            return;
        }

        const next = { ...states.value };
        for (const key of normalizedKeys)
        {
            clearTimer(key);
            next[key] = state;
            if (autoClear && settleMs > 0)
            {
                const timer = globalThis.setTimeout(() => clear(key), settleMs);
                timers.set(key, timer);
            }
        }
        states.value = next;
    };

    const markPending = (keys: RowMotionKey | readonly RowMotionKey[], nextSummary = ''): void =>
    {
        summary.value = nextSummary;
        setState(keys, 'pending', false);
    };

    const markUpdated = (keys: RowMotionKey | readonly RowMotionKey[], nextSummary = ''): void =>
    {
        summary.value = nextSummary;
        setState(keys, 'updated', true);
    };

    const markError = (keys: RowMotionKey | readonly RowMotionKey[], nextSummary = ''): void =>
    {
        summary.value = nextSummary;
        setState(keys, 'error', true);
    };

    const clearSummary = (): void =>
    {
        summary.value = '';
    };

    const stateFor = (key: RowMotionKey): RowMotionState | null => states.value[String(key)] ?? null;
    const classFor = (key: RowMotionKey): string =>
    {
        const state = stateFor(key);
        return state ? `blog-motion-row-state blog-motion-row-${state}` : 'blog-motion-row-state';
    };

    const hasActiveRows = computed(() => Object.keys(states.value).length > 0);

    if (getCurrentScope())
    {
        onScopeDispose(() => clear());
    }

    return {
        states,
        summary,
        hasActiveRows,
        stateFor,
        classFor,
        markPending,
        markUpdated,
        markError,
        clear,
        clearSummary
    };
}
