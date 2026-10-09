<template>
    <div
        class="fsus-security-challenge__panel fsus-pospace-challenge"
        data-fsus-pospace-challenge="true"
        :data-pospace-state="state"
        :aria-busy="isBusy"
    >
        <p
            data-test="pospace-status"
            role="status"
        >{{ stateCopy[state] }}</p>
        <div class="fsus-pospace-challenge__actions">
            <ElButton
                data-test="pospace-refresh"
                :disabled="disabled || refreshing"
                @click="refreshChallenge"
            >
                刷新
            </ElButton>
            <ElButton
                data-test="pospace-cancel"
                :disabled="disabled || !activeExecutor"
                @click="cancelChallenge"
            >
                取消
            </ElButton>
        </div>
    </div>
</template>

<script lang="ts">
import type {
    SecurityChallengeAssignment as ExecutorAssignment,
    SecurityChallengeProviderPayload as ExecutorProviderPayload,
    SecurityChallengeVerifyResponse as ExecutorVerifyResponse
} from '@/api/security';
import type {
    SecurityChallengeContext as ExecutorContext,
    SecurityChallengeIssueResult as ExecutorIssueResult
} from '@/security/challenge-client';
import type { SecurityChallengeProof as ExecutorProof } from '@/security/challenge-proof-store';

export type PoSpaceUiState =
    | 'preparing'
    | 'solving'
    | 'verifying'
    | 'verified'
    | 'failed'
    | 'unsupported'
    | 'expired'
    | 'cancelled';

export interface PoSpaceExecutorResult {
    status: 'verified' | 'continued' | 'unsupported' | 'failed' | 'expired' | 'cancelled';
    proof?: ExecutorProof | null;
    response?: ExecutorVerifyResponse | null;
    reason?: string | null;
    reissueAttributes?: Record<string, unknown> | null;
    next?: ExecutorIssueResult | null;
}

export interface PoSpaceUnsupportedResult extends PoSpaceExecutorResult {
    status: 'unsupported';
}

export interface PoSpaceChallengeExecutorLike {
    execute(input: {
        context: ExecutorContext;
        assignment: ExecutorAssignment;
        providerPayload: ExecutorProviderPayload;
        policyVersion: string;
        onState?: (state: unknown) => void;
    }): Promise<PoSpaceExecutorResult>;
    cancel(): void;
    dispose(): void;
}

export type PoSpaceChallengeExecutorFactory = () => PoSpaceChallengeExecutorLike;
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

const props = withDefaults(defineProps<{
    assignment: ExecutorAssignment | null;
    providerPayload: ExecutorProviderPayload | null;
    context: ExecutorContext;
    policyVersion: string;
    refresh: () => Promise<void>;
    disabled?: boolean;
    executorFactory?: PoSpaceChallengeExecutorFactory;
}>(), {
    disabled: false
});

const emit = defineEmits<{
    verified: [value: ExecutorProof | ExecutorVerifyResponse];
    continued: [value: import('@/security/challenge-client').SecurityChallengeIssueResult];
    unsupported: [value: PoSpaceUnsupportedResult];
    error: [value: string];
    refresh: [];
    expired: [];
    cancel: [];
}>();

const state = ref<PoSpaceUiState>('preparing');
const refreshing = ref(false);
const activeExecutor = shallowRef<PoSpaceChallengeExecutorLike | null>(null);
let generation = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const stateCopy: Record<PoSpaceUiState, string> = {
    preparing: '正在准备验证。',
    solving: '正在完成设备验证。',
    verifying: '正在确认验证结果。',
    verified: '验证已完成。',
    failed: '验证未通过。',
    unsupported: '当前设备无法完成此验证。',
    expired: '验证已过期。',
    cancelled: '验证已取消。'
};

const isBusy = computed(() => state.value === 'preparing' || state.value === 'solving' || state.value === 'verifying');

function clearExpiryTimer(): void
{
    if (expiryTimer !== null)
    {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
}

function releaseExecutor(cancel = false): void
{
    clearExpiryTimer();
    const executor = activeExecutor.value;
    activeExecutor.value = null;
    if (!executor)
    {
        return;
    }
    if (cancel)
    {
        try
        {
            executor.cancel();
        }
        catch
        {
            // Disposal remains mandatory even when cancellation cannot be acknowledged.
        }
    }
    try
    {
        executor.dispose();
    }
    catch
    {
    // The local generation guard still prevents late executor events.
    }
}

function invalidate(cancel = false): void
{
    generation += 1;
    releaseExecutor(cancel);
}

function normalizeState(value: unknown): PoSpaceUiState | null
{
    const candidate = typeof value === 'string'
        ? value
        : value && typeof value === 'object'
            ? Reflect.get(value, 'status') ?? Reflect.get(value, 'state')
            : null;
    return candidate === 'preparing' || candidate === 'solving' || candidate === 'verifying'
        || candidate === 'verified' || candidate === 'failed' || candidate === 'unsupported' || candidate === 'expired'
        || candidate === 'cancelled'
        ? candidate
        : null;
}

async function startChallenge(): Promise<void>
{
    invalidate();
    state.value = 'preparing';

    const assignment = props.assignment;
    const providerPayload = props.providerPayload;
    if (props.disabled || !assignment || !providerPayload)
    {
        return;
    }
    if (!props.policyVersion)
    {
        state.value = 'failed';
        emit('error', 'security_challenge_policy_version_missing');
        return;
    }

    const run = generation;
    let executor: PoSpaceChallengeExecutorLike;
    try
    {
        const factory = props.executorFactory
            ?? (await import('@/services/securityPoSpaceChallengeExecutor')).createPoSpaceChallengeExecutor;
        executor = factory();
    }
    catch
    {
        state.value = 'failed';
        emit('error', 'security_challenge_execution_failed');
        return;
    }
    activeExecutor.value = executor;

    const remainingMs = assignment.expiresAtUnixMs - Date.now();
    if (remainingMs <= 0)
    {
        invalidate();
        state.value = 'expired';
        emit('expired');
        return;
    }

    expiryTimer = setTimeout(() =>
    {
        if (run !== generation || activeExecutor.value !== executor)
        {
            return;
        }
        invalidate();
        state.value = 'expired';
        emit('expired');
    }, remainingMs);

    try
    {
        const result = await executor.execute({
            context: props.context,
            assignment,
            providerPayload,
            policyVersion: props.policyVersion,
            onState(value)
            {
                if (run !== generation || activeExecutor.value !== executor)
                {
                    return;
                }
                const nextState = normalizeState(value);
                if (nextState)
                {
                    state.value = nextState;
                }
            }
        });

        if (run !== generation || activeExecutor.value !== executor)
        {
            return;
        }
        releaseExecutor();

        if (result.status === 'verified')
        {
            const verified = result.proof ?? result.response;
            if (verified)
            {
                state.value = 'verified';
                emit('verified', verified);
                return;
            }
            state.value = 'failed';
            emit('error', 'security_challenge_verify_result_missing');
            return;
        }
        if (result.status === 'continued' && result.next)
        {
            state.value = 'verified';
            emit('continued', result.next);
            return;
        }
        if (result.status === 'unsupported')
        {
            state.value = 'unsupported';
            emit('unsupported', result as PoSpaceUnsupportedResult);
            return;
        }
        if (result.status === 'expired')
        {
            state.value = 'expired';
            emit('expired');
            return;
        }
        if (result.status === 'cancelled')
        {
            state.value = 'cancelled';
            emit('cancel');
            return;
        }

        state.value = 'failed';
        emit('error', result.reason ?? 'security_challenge_execution_failed');
    }
    catch
    {
        if (run !== generation || activeExecutor.value !== executor)
        {
            return;
        }
        releaseExecutor();
        state.value = 'failed';
        emit('error', 'security_challenge_execution_failed');
    }
}

async function refreshChallenge(): Promise<void>
{
    if (props.disabled || refreshing.value)
    {
        return;
    }
    invalidate();
    const run = generation;
    state.value = 'preparing';
    refreshing.value = true;
    emit('refresh');
    try
    {
        await props.refresh();
    }
    catch
    {
        if (run !== generation)
        {
            return;
        }
        state.value = 'failed';
        emit('error', 'security_challenge_refresh_failed');
    }
    finally
    {
        refreshing.value = false;
    }
}

function cancelChallenge(): void
{
    if (!activeExecutor.value)
    {
        return;
    }
    invalidate(true);
    state.value = 'cancelled';
    emit('cancel');
}

function disposeChallenge(): void
{
    invalidate();
    state.value = 'preparing';
}

defineExpose({ dispose: disposeChallenge });

watch(
    () => [props.assignment, props.providerPayload, props.context, props.policyVersion, props.disabled, props.executorFactory] as const,
    () =>
    {
        void startChallenge();
    },
    { immediate: true }
);

onBeforeUnmount(() =>
{
    disposeChallenge();
});
</script>

<style scoped>
.fsus-pospace-challenge
 {
    display: grid;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--fsusblog-panel-border, var(--el-border-color));
    border-radius: var(--fsus-radius-control, 6px);
    background: var(--el-fill-color-lighter);
    color: var(--fsusblog-text-muted, var(--el-text-color-secondary));
}

.fsus-pospace-challenge p
 {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
}

.fsus-pospace-challenge__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
</style>
