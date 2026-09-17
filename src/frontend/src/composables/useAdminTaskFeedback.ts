import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';

import { toast } from '@/fsusui/feedback';
import type { ToastHandle } from '@/fsusui/feedback';

export type AdminTaskFeedbackPhase = 'idle' | 'pending' | 'success' | 'error' | 'partial';

type FeedbackKeyInput = string | readonly string[] | undefined;

type AdminTaskFeedbackOptions = Readonly<{
    settleMs?: number;
}>;

const DEFAULT_SETTLE_MS = 2_600;
const DEFAULT_TOAST_DURATION_MS = 2_600;
const ERROR_TOAST_DURATION_MS = 4_000;

function normalizeKeys(keys: FeedbackKeyInput): string[]
{
    if (!keys)
    {
        return [];
    }
    return typeof keys === 'string' ? [keys] : [...keys];
}

function errorDetail(error: unknown, fallback: string): string
{
    if (error instanceof Error && error.message.trim())
    {
        return error.message;
    }

    if (typeof error === 'string' && error.trim())
    {
        return error;
    }

    return fallback;
}

export function useAdminTaskFeedback(options: AdminTaskFeedbackOptions = {})
{
    const phase = ref<AdminTaskFeedbackPhase>('idle');
    const message = ref('');
    const detail = ref('');
    const assertiveMessage = ref('');
    const highlightedKeys = ref<string[]>([]);
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let activeToast: ToastHandle | null = null;

    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    const busy = computed(() => phase.value === 'pending');
    const visible = computed(() => phase.value !== 'idle' && message.value.trim().length > 0);
    const ariaMessage = computed(() =>
    {
        if (!message.value)
        {
            return '';
        }
        return detail.value ? `${message.value}：${detail.value}` : message.value;
    });

    const clearTimer = (): void =>
    {
        if (settleTimer !== null)
        {
            globalThis.clearTimeout(settleTimer);
        }
        settleTimer = null;
    };

    const scheduleSettle = (): void =>
    {
        clearTimer();
        if (settleMs <= 0)
        {
            return;
        }

        settleTimer = globalThis.setTimeout(() =>
        {
            phase.value = 'idle';
            highlightedKeys.value = [];
            settleTimer = null;
        }, settleMs);
    };

    const closeActiveToast = (): void =>
    {
        activeToast?.close();
        activeToast = null;
    };

    const replaceToast = (nextToast: ToastHandle): void =>
    {
        closeActiveToast();
        activeToast = nextToast;
    };

    const setState = (
        nextPhase: AdminTaskFeedbackPhase,
        nextMessage: string,
        nextDetail = '',
        keys?: FeedbackKeyInput
    ): void =>
    {
        clearTimer();
        phase.value = nextPhase;
        message.value = nextMessage;
        detail.value = nextDetail;
        assertiveMessage.value = '';
        highlightedKeys.value = normalizeKeys(keys);
    };

    const begin = (nextMessage: string, nextDetail = '', keys?: FeedbackKeyInput): void =>
    {
        setState('pending', nextMessage, nextDetail, keys);
        replaceToast(toast.info({
            message: nextMessage,
            detail: nextDetail,
            duration: DEFAULT_TOAST_DURATION_MS
        }));
    };

    const succeed = (nextMessage: string, nextDetail = '', keys?: FeedbackKeyInput): void =>
    {
        setState('success', nextMessage, nextDetail, keys);
        replaceToast(toast.success({
            message: nextMessage,
            detail: nextDetail,
            duration: DEFAULT_TOAST_DURATION_MS
        }));
        scheduleSettle();
    };

    const partial = (nextMessage: string, nextDetail = '', keys?: FeedbackKeyInput): void =>
    {
        setState('partial', nextMessage, nextDetail, keys);
        replaceToast(toast.partial({
            message: nextMessage,
            detail: nextDetail,
            duration: DEFAULT_TOAST_DURATION_MS
        }));
        scheduleSettle();
    };

    const fail = (nextMessage: string, error: unknown, fallback = '操作失败', keys?: FeedbackKeyInput): void =>
    {
        const nextDetail = errorDetail(error, fallback);
        setState('error', nextMessage, nextDetail, keys);
        assertiveMessage.value = ariaMessage.value;
        replaceToast(toast.error({
            message: nextMessage,
            detail: nextDetail,
            duration: ERROR_TOAST_DURATION_MS
        }));
        scheduleSettle();
    };

    const clear = (): void =>
    {
        clearTimer();
        closeActiveToast();
        phase.value = 'idle';
        message.value = '';
        detail.value = '';
        assertiveMessage.value = '';
        highlightedKeys.value = [];
    };

    const isHighlighted = (key: string): boolean => highlightedKeys.value.includes(key);

    if (getCurrentScope())
    {
        onScopeDispose(() =>
        {
            clearTimer();
            closeActiveToast();
        });
    }

    return {
        phase,
        message,
        detail,
        assertiveMessage,
        highlightedKeys,
        busy,
        visible,
        ariaMessage,
        begin,
        succeed,
        partial,
        fail,
        clear,
        isHighlighted
    };
}
