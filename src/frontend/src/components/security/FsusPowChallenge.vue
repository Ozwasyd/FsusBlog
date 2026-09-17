<template>
    <div
        class="fsus-security-challenge__panel fsus-pow-challenge"
        data-fsus-pow-challenge="true"
        :data-pow-state="state"
        :aria-busy="busy"
    >
        <p
            data-test="pow-status"
            role="status"
        >{{ stateCopy[state] }}</p>
        <ElProgress
            data-test="pow-progress"
            :percentage="progress"
            :status="state === 'failed' ? 'exception' : state === 'verified' ? 'success' : undefined"
        />
        <div class="fsus-pow-challenge__actions">
            <ElButton
                data-test="pow-refresh"
                :disabled="disabled || busy"
                @click="refreshChallenge"
            >
                刷新
            </ElButton>
            <ElButton
                data-test="pow-cancel"
                :disabled="disabled || !active"
                @click="cancelChallenge"
            >
                取消
            </ElButton>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type {
    SecurityChallengeAssignment,
    SecurityChallengeProviderPayload,
    SecurityChallengeVerifyResponse
} from '@/api/security';
import { usePow } from '@/composables/usePow';
import type {
    SecurityChallengeClient,
    SecurityChallengeContext,
    SecurityChallengeIssueResult
} from '@/security/challenge-client';
import type { SecurityChallengeProof } from '@/security/challenge-proof-store';
import { encodeBinaryPowProofHeader } from '@/services/powProofCodec';
import { getBrowserFp } from '@/utils/fingerprint';

type PowUiState = 'preparing' | 'solving' | 'verifying' | 'verified' | 'failed' | 'expired' | 'cancelled';

const MAX_POW_DIFFICULTY = 32;
const MAX_POW_TEXT_FIELD_CHARS = 256;

const props = withDefaults(defineProps<{
    assignment: SecurityChallengeAssignment;
    providerPayload: SecurityChallengeProviderPayload;
    context: SecurityChallengeContext;
    client: SecurityChallengeClient;
    refresh: () => Promise<void>;
    disabled?: boolean;
}>(), {
    disabled: false
});

const emit = defineEmits<{
    verified: [value: SecurityChallengeProof | SecurityChallengeVerifyResponse];
    continued: [value: SecurityChallengeIssueResult];
    error: [value: string];
    expired: [];
    cancel: [];
}>();

const state = ref<PowUiState>('preparing');
const progress = ref(0);
const active = ref(false);
const { calculate, prewarm } = usePow();
let generation = 0;
let activeController: AbortController | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const stateCopy: Record<PowUiState, string> = {
    preparing: '正在准备工作量验证。',
    solving: '正在计算工作量证明。',
    verifying: '正在确认验证结果。',
    verified: '验证已完成。',
    failed: '验证未通过。',
    expired: '验证已过期。',
    cancelled: '验证已取消。'
};

const busy = computed(() => state.value === 'preparing' || state.value === 'solving' || state.value === 'verifying');
const disabled = computed(() => props.disabled === true);

function invalidate(): void
{
    generation += 1;
    activeController?.abort();
    activeController = null;
    active.value = false;
    if (expiryTimer !== null)
    {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
}

function fail(reason: string): void
{
    state.value = 'failed';
    progress.value = 0;
    emit('error', reason);
}

async function startChallenge(): Promise<void>
{
    invalidate();
    state.value = 'preparing';
    progress.value = 10;
    if (disabled.value)
    {
        return;
    }

    const run = generation;
    const controller = new AbortController();
    activeController = controller;
    active.value = true;
    const payload = props.providerPayload.payload;
    const salt = payload.salt?.trim();
    const signature = payload.signature?.trim();
    const difficulty = Number(payload.difficulty);
    const timestamp = Number(payload.timestamp);
    if (!salt || salt.length > MAX_POW_TEXT_FIELD_CHARS || !signature || signature.length > MAX_POW_TEXT_FIELD_CHARS ||
        !Number.isInteger(difficulty) || difficulty <= 0 || difficulty > MAX_POW_DIFFICULTY ||
        !Number.isInteger(timestamp) || timestamp <= 0)
    {
        invalidate();
        fail('security_challenge_pow_payload_invalid');
        return;
    }

    const remainingMs = props.assignment.expiresAtUnixMs - Date.now();
    if (remainingMs <= 0)
    {
        invalidate();
        state.value = 'expired';
        progress.value = 0;
        emit('expired');
        return;
    }

    expiryTimer = setTimeout(() =>
    {
        if (run !== generation)
        {
            return;
        }
        invalidate();
        state.value = 'expired';
        progress.value = 0;
        emit('expired');
    }, remainingMs);

    try
    {
        prewarm();
        state.value = 'solving';
        progress.value = 35;
        const browserFp = props.context.deviceFingerprint?.trim() || getBrowserFp();
        const solved = await calculate(
            salt,
            browserFp,
            difficulty,
            Math.min(30_000, remainingMs),
            controller.signal);
        if (run !== generation || controller.signal.aborted)
        {
            return;
        }

        state.value = 'verifying';
        progress.value = 80;
        const proof = encodeBinaryPowProofHeader({
            salt,
            nonce: solved.nonce,
            timestamp,
            difficulty,
            signature,
            browserFp
        });
        const verified = await props.client.verify(props.context, {
            challengeId: props.assignment.challengeId,
            kind: props.assignment.kind,
            action: props.context.action,
            routeKey: props.context.routeKey,
            providerPayload: { proof }
        });
        if (run !== generation || controller.signal.aborted)
        {
            return;
        }

        invalidate();
        if (verified.status === 'verified')
        {
            const result = verified.proof ?? verified.response;
            if (result)
            {
                state.value = 'verified';
                progress.value = 100;
                emit('verified', result);
                return;
            }
        }
        if ((verified.status === 'continue' || verified.status === 'unsupported') && verified.next)
        {
            state.value = 'verified';
            progress.value = 100;
            emit('continued', verified.next);
            return;
        }
        fail(verified.reason ?? 'security_challenge_pow_verify_failed');
    }
    catch
    {
        if (run !== generation || controller.signal.aborted)
        {
            return;
        }
        invalidate();
        fail('security_challenge_pow_execution_failed');
    }
}

async function refreshChallenge(): Promise<void>
{
    invalidate();
    await props.refresh();
}

function cancelChallenge(): void
{
    invalidate();
    state.value = 'cancelled';
    progress.value = 0;
    emit('cancel');
}

function dispose(): void
{
    invalidate();
}

defineExpose({ dispose });

watch(
    () => [props.assignment.challengeId, props.providerPayload.challengeId, props.disabled] as const,
    () =>
    {
        void startChallenge();
    },
    { immediate: true }
);

onBeforeUnmount(dispose);
</script>

<style scoped>
.fsus-pow-challenge
 {
    display: grid;
    gap: 12px;
}

.fsus-pow-challenge__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
</style>
