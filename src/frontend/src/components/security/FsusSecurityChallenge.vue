<template>
    <section
        class="fsus-security-challenge"
        :class="{ 'is-dialog-composition': dialogComposition }"
        data-fsus-security-challenge="true"
        :aria-busy="busy"
    >
        <header v-if="!dialogComposition"
class="fsus-security-challenge__header">
            <div>
                <p class="fsus-security-challenge__eyebrow">{{ localizedCopy.eyebrow }}</p>
                <h3 class="fsus-security-challenge__title">{{ title }}</h3>
            </div>
            <el-button
        data-test="security-challenge-refresh"
                :disabled="busy || disabled"
                @click="refreshChallenge"
            >
                {{ localizedCopy.refresh }}
            </el-button>
        </header>

        <el-alert
            v-if="errorMessage && !isPerceptionCharacterV3"
            class="fsus-security-challenge__alert"
            :title="errorMessage"
            type="error"
      show-icon
            :closable="false"
        />

        <div v-if="isPerceptionCharacterV3"
class="fsus-security-challenge__v3">
            <el-alert
                v-if="v3State === 'unavailable'"
                data-test="perception-character-blocking-error"
                :title="localizedCopy.unavailable"
                type="error"
                show-icon
                :closable="false"
            />
            <el-button
                v-if="v3Flow && (v3State === 'ready' || v3State === 'retryable')"
                data-test="perception-character-representation"
                :disabled="busy || disabled"
                @click="switchV3Representation"
            >
                {{ v3Flow.representation === 'visual' ? localizedCopy.useAudio : localizedCopy.useImage }}
            </el-button>
            <FsusUiPerceptionCharacterChallenge
                ref="v3Primitive"
                v-model="v3Answer"
                :challenge-id="v3Flow?.challengeId ?? ''"
                :state="v3State"
                :media="v3Media"
                :prompt="localizedCopy.prompt"
                :description="localizedCopy.description"
                :input-label="localizedCopy.inputLabel"
                :placeholder="localizedCopy.placeholder"
                :media-alt="localizedCopy.mediaAlt"
                :submit-label="localizedCopy.submit"
                :refresh-label="localizedCopy.refresh"
                :retry-label="localizedCopy.retry"
                :reissue-label="localizedCopy.reissue"
                :loading-text="localizedCopy.loading"
                :verifying-text="localizedCopy.verifying"
                :retryable-text="localizedCopy.retryable"
                :reissue-text="localizedCopy.reissueRequired"
                unavailable-text=""
                :expired-text="localizedCopy.expired"
                :disabled-text="localizedCopy.disabled"
                @submit="submitV3Answer"
                @refresh="refreshV3Challenge"
                @retry="retryV3Answer"
                @reissue="refreshV3Challenge"
            />
        </div>

        <FsusPerceptionChallenge
            v-else-if="capability?.uiHost === 'perception' && perceptionRuntime"
            :challenge="perceptionRuntime.challenge"
            :renderer="perceptionRuntime.renderer"
            :client="perceptionRuntime.client"
            :title="localizedCopy.perceptionTitle"
            :eyebrow="localizedCopy.perceptionEyebrow"
            :refresh-label="localizedCopy.perceptionRefresh"
            :retry-label="localizedCopy.perceptionRetry"
            :cancel-label="localizedCopy.perceptionCancel"
            :loading-text="localizedCopy.perceptionLoading"
            :failed-text="localizedCopy.perceptionFailed"
            :expired-text="localizedCopy.perceptionExpired"
            @verified="handlePerceptionVerified"
            @error="setError"
            @refresh="refreshChallenge"
      @retry="refreshChallenge"
      @expired="handlePerceptionExpired"
      @cancel="handlePerceptionCancel"
    />

    <FsusPoSpaceChallenge
      v-else-if="capability?.uiHost === 'pospace' && assignment && providerPayload"
      ref="poSpaceHost"
      :assignment="assignment"
      :provider-payload="providerPayload"
      :context="challengeContext"
      :policy-version="issuePolicyVersion"
      :refresh="refreshChallenge"
      :disabled="disabled"
      :executor-factory="executorFactory"
      @verified="emit('verified', $event)"
      @continued="applyIssueResult"
      @error="handlePoSpaceError"
      @unsupported="emit('unsupported', $event)"
      @expired="handlePoSpaceExpired"
      @cancel="handlePoSpaceCancel"
    />

    <FsusPowChallenge
      v-else-if="capability?.uiHost === 'sha256-pow' && assignment && providerPayload"
      ref="powHost"
      :assignment="assignment"
      :provider-payload="providerPayload"
      :context="challengeContext"
      :client="client()"
      :refresh="refreshChallenge"
      :disabled="disabled"
      @verified="emit('verified', $event)"
      @continued="applyIssueResult"
      @error="handlePowError"
      @expired="handlePowExpired"
      @cancel="handlePowCancel"
    />

        <div v-else-if="capability && !capability.policyEligible"
class="fsus-security-challenge__panel">
            <slot name="unsupported"
:assignment="assignment" :provider-payload="providerPayload" :refresh="refreshChallenge">
                <p data-test="security-challenge-unsupported">{{ localizedCopy.unsupported }}</p>
            </slot>
        </div>

        <div v-else
class="fsus-security-challenge__panel" role="status">
            <p>{{ localizedCopy.preparing }}</p>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
    SecurityChallengeKind,
    type SecurityChallengeAssignment,
    type SecurityChallengeIssueResponse,
    type SecurityChallengeProviderPayload,
    type SecurityChallengeVerifyResponse,
    type VerifySecurityChallengeRequest
} from '@/api/security';
import FsusPoSpaceChallenge, {
    type PoSpaceChallengeExecutorFactory,
    type PoSpaceUnsupportedResult
} from './FsusPoSpaceChallenge.vue'
import FsusPowChallenge from './FsusPowChallenge.vue'
import {
  createSecurityChallengeClient,
  type SecurityChallengeClient,
  type SecurityChallengeContext,
  type SecurityChallengeIssueResult
} from '@/security/challenge-client'
import {
  resolveChallengeCapability,
  SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
  type ChallengeCapabilityResolution
} from '@/security/challenge-capability-registry'
import type { SecurityChallengeProof } from '@/security/challenge-proof-store'
import {
  createPerceptionChallengeRuntime,
    isPerceptionChallengeKind,
    type PerceptionChallengeRuntime
} from '@/services/securityPerceptionChallengeFlow';
import { useI18nText } from '@/composables/useI18nText';
import {
    FsusUiPerceptionCharacterChallenge,
    FsusPerceptionChallenge,
    type PerceptionChallengeVerifyResult,
    type FsusUiPerceptionCharacterMedia,
    type FsusUiPerceptionCharacterSubmitPayload
} from '@/fsusui/perceptionCharacterChallenge';
import {
    createPerceptionCharacterV3Flow,
    type PerceptionCharacterV3Flow,
    type PerceptionCharacterV3MediaResource
} from '@/services/securityPerceptionCharacterV3Flow';

const props = withDefaults(defineProps<{
    action: string;
  routeKey: string
  attributes?: Record<string, unknown>
  autoLoad?: boolean
  disabled?: boolean
  title?: string
    client?: SecurityChallengeClient;
    executorFactory?: PoSpaceChallengeExecutorFactory;
    identity?: string;
    dialogComposition?: boolean;
}>(), {
    autoLoad: true,
    disabled: false,
    title: ''
});

const emit = defineEmits<{
  issued: [value: SecurityChallengeIssueResult]
  verified: [value: SecurityChallengeVerifyResponse | SecurityChallengeProof]
  allow: [value: SecurityChallengeIssueResponse]
  unsupported: [value: SecurityChallengeIssueResult | PoSpaceUnsupportedResult]
  error: [value: string]
    refresh: [];
    expired: [];
    cancel: [];
    ready: [];
}>();

const defaultClient = createSecurityChallengeClient();
const busy = ref(false)
const errorMessage = ref('')
const capability = ref<ChallengeCapabilityResolution | null>(null)
const assignment = ref<SecurityChallengeAssignment | null>(null);
const providerPayload = ref<SecurityChallengeProviderPayload | null>(null);
const preloadedIssueResponse = ref<SecurityChallengeIssueResponse | null>(null);
const issuePolicyVersion = ref('');
const perceptionRuntime = ref<PerceptionChallengeRuntime | null>(null);
const poSpaceHost = ref<{ dispose?: () => void; } | null>(null);
const powHost = ref<{ dispose?: () => void; } | null>(null);
const lastVerifyResponse = ref<SecurityChallengeVerifyResponse | null>(null);
const v3Flow = shallowRef<PerceptionCharacterV3Flow | null>(null);
const v3MediaResource = shallowRef<PerceptionCharacterV3MediaResource | null>(null);
const v3Media = shallowRef<FsusUiPerceptionCharacterMedia | null>(null);
const v3Answer = ref('');
const v3Primitive = ref<{ focus?: () => void; reset?: () => void; } | null>(null);
const v3State = ref<'loading' | 'ready' | 'verifying' | 'retryable' | 'reissue' | 'unavailable' | 'expired' | 'disabled'>('loading');
const { messages } = useI18nText();
const localizedCopy = computed(() => messages.value.security.challenge);
let hostGeneration = 0;
let v3ExpiryTimer: ReturnType<typeof setTimeout> | null = null;

const title = computed(() => props.title || localizedCopy.value.title);
const disabled = computed(() => props.disabled === true);
const executorFactory = computed(() => props.executorFactory);
const isPerceptionCharacterV3 = computed(() => assignment.value?.kind === SecurityChallengeKind.PerceptionCharacterV3);
const challengeContext = computed<SecurityChallengeContext>(() => ({
    action: props.action,
    routeKey: props.routeKey,
  attributes: props.attributes,
  capabilityManifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
  identity: props.identity
}))

function context(): SecurityChallengeContext {
  return challengeContext.value
}

function client(): SecurityChallengeClient {
  return props.client ?? defaultClient
}

async function ensureChallenge(): Promise<void> {
  if (disabled.value) {
    return
  }

  const generation = ++hostGeneration
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await client().issue(context())
    if (generation === hostGeneration) {
      applyIssueResult(result)
    }
  } finally {
    if (generation === hostGeneration) {
      busy.value = false
    }
  }
}

async function refreshChallenge(): Promise<void> {
  if (disabled.value) {
    return
  }

  const generation = ++hostGeneration
  emit('refresh')
  poSpaceHost.value?.dispose?.()
  powHost.value?.dispose?.()
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await client().refresh(context())
    if (generation === hostGeneration) {
      applyIssueResult(result)
    }
  } finally {
    if (generation === hostGeneration) {
      busy.value = false
    }
  }
}

function applyIssueResult(result: SecurityChallengeIssueResult): void
{
    resetPerceptionRuntime();
    resetV3Runtime();
    emit('issued', result);
    assignment.value = result.assignment;
    providerPayload.value = result.providerPayload;
  capability.value = result.capability ?? (result.assignment
    ? resolveChallengeCapability(result.assignment.kind, {
        action: props.action,
        mode: 'ui',
        manifestVersion: SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
      })
    : null)
  preloadedIssueResponse.value = memberIssueResponse(result)
  issuePolicyVersion.value = result.response?.policyVersion ?? ''

  if (result.status === 'verified' && result.proof) {
    emit('verified', result.proof)
    return
  }
  if (result.status === 'allow' && result.response) {
    emit('allow', result.response)
    return
    }
    if (result.status === 'unsupported')
{
        emit('unsupported', result);
        setError('security_challenge_unsupported');
        return;
    }
    if (result.status === 'failed')
{
        if (result.reason === 'security_challenge_capability_reload_requested'
            || result.reason === 'security_challenge_capability_reload_suppressed')
{
            capability.value = null;
            assignment.value = null;
            providerPayload.value = null;
            errorMessage.value = result.reason === 'security_challenge_capability_reload_requested'
                ? localizedCopy.value.capabilityUpdate
                : localizedCopy.value.capabilityUpdateFailed;
            emit('error', result.reason);
            return;
        }
        setError('security_challenge_unavailable');
        return;
    }
    if (assignment.value?.kind === SecurityChallengeKind.PerceptionCharacterV3)
{
        rebuildV3Runtime();
    }
}

async function submitV3Answer(payload: FsusUiPerceptionCharacterSubmitPayload): Promise<void>
{
    const flow = v3Flow.value;
    if (!flow || payload.challengeId !== flow.challengeId || v3State.value === 'verifying')
{
        return;
    }
    const generation = hostGeneration;
    v3State.value = 'verifying';
    try
{
        const result = await flow.verify(payload.value);
        if (generation !== hostGeneration || flow !== v3Flow.value)
{
            return;
        }
        if (result.verified)
{
            const response = lastVerifyResponse.value;
            v3State.value = 'ready';
            if (response)
{
                handleVerified(response);
            }
            return;
        }
        v3State.value = result.retryable
            ? 'retryable'
            : result.reissueRequired || result.rejected
                ? 'reissue'
                : 'unavailable';
    }
 catch (error)
{
        if (generation !== hostGeneration || flow !== v3Flow.value)
{
            return;
        }
        v3State.value = coarseV3State(error);
    }
}

function retryV3Answer(): void
{
    if (v3State.value !== 'retryable')
{
        return;
    }
    v3State.value = 'ready';
    void nextTick(() => v3Primitive.value?.focus?.());
}

async function refreshV3Challenge(): Promise<void>
{
    const representation = v3Flow.value?.representation;
    if (!representation || busy.value || disabled.value)
{
        return;
    }
    await replaceV3Challenge(() => client().refresh(context(), representation));
}

async function switchV3Representation(): Promise<void>
{
    const representation = v3Flow.value?.representation;
    if (!representation || busy.value || disabled.value || !client().replace)
{
        return;
    }
    const next = representation === 'visual' ? 'audio' : 'visual';
    await replaceV3Challenge(() => client().replace(context(), next));
}

async function replaceV3Challenge(load: () => Promise<SecurityChallengeIssueResult>): Promise<void>
{
    const generation = ++hostGeneration;
    busy.value = true;
    v3State.value = 'loading';
    v3Answer.value = '';
    try
{
        const result = await load();
        if (generation !== hostGeneration)
{
            return;
        }
        if (result.status === 'challenge' && result.assignment?.kind === SecurityChallengeKind.PerceptionCharacterV3)
{
            applyIssueResult(result);
            return;
        }
        resetV3Runtime();
        v3State.value = 'unavailable';
    }
 catch (error)
{
        if (generation === hostGeneration)
{
            resetV3Runtime();
            v3State.value = coarseV3State(error);
        }
    }
 finally
{
        if (generation === hostGeneration)
{
            busy.value = false;
        }
    }
}

function coarseV3State(error: unknown): 'retryable' | 'reissue' | 'unavailable'
{
    const reason = error instanceof Error ? error.message : '';
    if (reason.includes('retryable')) {return 'retryable'};
    if (reason.includes('reissue') || reason.includes('rejected')) {return 'reissue'};
    return 'unavailable';
}

async function verifyPerceptionChallenge(request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResponse>
{
    const result = await client().verify(context(), request);
    lastVerifyResponse.value = result.response;
  if (result.next) {
    applyIssueResult(result.next)
  }
  return result.response ?? failedVerifyResponse(request, result.reason, result.retryAfterMs)
}

function failedVerifyResponse(
  request: VerifySecurityChallengeRequest,
  reason: string | null,
  retryAfterMs: number
): SecurityChallengeVerifyResponse {
  return {
    verified: false,
    envelopeId: request.envelopeId,
    challengeId: request.challengeId,
    kind: request.kind,
    policyVersion: '',
    completedCount: 0,
    memberCount: 1,
    envelopeCompleted: false,
    proofToken: '',
    expiresAtUnixMs: 0,
    reason: reason ?? 'security_challenge_verify_failed',
        retryAfterMs
    };
}

function handleVerified(value: SecurityChallengeVerifyResponse): void
{
    if (value.envelopeCompleted)
{
        emit('verified', value);
  }
}

function handlePerceptionVerified(value: PerceptionChallengeVerifyResult): void
{
    const response = lastVerifyResponse.value;
    if (!value.verified || !response)
{
        setError('security_challenge_verify_failed');
        return;
    }
    handleVerified(response);
}

function handlePerceptionExpired(): void
{
    client().clearProof(context());
    setError('security_challenge_expired');
    emit('expired');
}

function handlePerceptionCancel(): void
{
    client().clearProof(context());
    setError('security_challenge_cancelled');
    emit('cancel');
}

function handlePoSpaceExpired(): void {
  client().clearProof(context())
    emit('expired');
}

function handlePoSpaceError(): void
{
    errorMessage.value = localizedCopy.value.perceptionFailed;
    emit('error', 'security_challenge_verify_failed');
}

function handlePoSpaceCancel(): void
{
  client().clearProof(context())
  emit('cancel')
}

function handlePowExpired(): void {
  client().clearProof(context())
    emit('expired');
}

function handlePowError(): void
{
    errorMessage.value = localizedCopy.value.perceptionFailed;
    emit('error', 'security_challenge_verify_failed');
}

function handlePowCancel(): void
{
  client().clearProof(context())
  emit('cancel')
}

function setError(message: string): void
{
    const stableCode = message.includes('unsupported')
        ? 'security_challenge_unsupported'
        : 'security_challenge_unavailable';
    errorMessage.value = stableCode === 'security_challenge_unsupported'
        ? localizedCopy.value.unsupported
        : localizedCopy.value.unavailable;
    emit('error', stableCode);
}

function resetPerceptionRuntime(): void
{
  perceptionRuntime.value?.dispose()
    perceptionRuntime.value = null;
}

function resetV3Runtime(): void
{
    if (v3ExpiryTimer !== null)
{
        clearTimeout(v3ExpiryTimer);
        v3ExpiryTimer = null;
    }
    v3Flow.value?.dispose();
    v3Flow.value = null;
    v3MediaResource.value = null;
    v3Media.value = null;
    v3Answer.value = '';
}

function rebuildV3Runtime(): void
{
    const currentAssignment = assignment.value;
    const typed = providerPayload.value?.perceptionCharacterV3;
    if (!currentAssignment || currentAssignment.kind !== SecurityChallengeKind.PerceptionCharacterV3 || !typed)
{
        return;
    }
    try
{
        const flow = createPerceptionCharacterV3Flow({
            assignment: currentAssignment,
            payload: typed,
            verifyChallenge: verifyPerceptionChallenge
        });
        const resource = flow.createMedia();
        v3Flow.value = flow;
        v3MediaResource.value = resource;
        v3Media.value = resource.media;
        const remainingMs = flow.expiresAtUnixMs - Date.now();
        v3State.value = disabled.value ? 'disabled' : remainingMs <= 0 ? 'expired' : 'ready';
        if (!disabled.value && remainingMs > 0)
{
            v3ExpiryTimer = setTimeout(() =>
{
                if (v3Flow.value === flow && v3State.value !== 'verifying')
{
                    v3State.value = 'expired';
                    v3Answer.value = '';
                }
            }, remainingMs);
        }
        emit('ready');
    }
 catch
{
        resetV3Runtime();
        v3State.value = 'unavailable';
    }
}

function rebuildPerceptionRuntime(): void
{
    resetPerceptionRuntime();
    if (
    capability.value?.uiHost !== 'perception' ||
    !assignment.value ||
    !providerPayload.value ||
    !isPerceptionChallengeKind(assignment.value.kind)
  ) {
    return
  }

  perceptionRuntime.value = createPerceptionChallengeRuntime({
    envelopeId: preloadedIssueResponse.value?.envelope?.envelopeId ?? '',
    assignment: assignment.value,
    providerPayload: providerPayload.value,
    verifyChallenge: verifyPerceptionChallenge
  })
}

function memberIssueResponse(result: SecurityChallengeIssueResult): SecurityChallengeIssueResponse | null {
  if (!result.response || !result.assignment) {
    return result.response
  }
  return {
    ...result.response,
    envelope: result.response.envelope
      ? { ...result.response.envelope, assignments: [result.assignment] }
      : null,
    providerPayloads: result.providerPayload ? [result.providerPayload] : []
  }
}

onMounted(() => {
  if (props.autoLoad) {
    void ensureChallenge()
  }
})

onBeforeUnmount(() => {
  hostGeneration += 1
  poSpaceHost.value?.dispose?.()
    powHost.value?.dispose?.();
    client().cancelEnvelope(context());
    resetPerceptionRuntime();
    resetV3Runtime();
});

watch([assignment, providerPayload, capability], rebuildPerceptionRuntime);
watch(
  () => [props.action, props.routeKey, props.identity ?? ''] as const,
  (_current, previous) => {
    if (!previous) {
      return
    }
    client().cancelEnvelope({ action: previous[0], routeKey: previous[1], identity: previous[2] })
    hostGeneration += 1
        poSpaceHost.value?.dispose?.();
        powHost.value?.dispose?.();
        resetPerceptionRuntime();
        resetV3Runtime();
        assignment.value = null;
        providerPayload.value = null;
        capability.value = null;
        void ensureChallenge();
    }
);

defineExpose({
    focus()
{
        v3Primitive.value?.focus?.();
    }
});
</script>

<style scoped>
.fsus-security-challenge {
  display: grid;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--fsusblog-panel-border, var(--el-border-color));
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--fsusblog-panel-bg, var(--el-bg-color));
  color: var(--fsusblog-text-primary, var(--el-text-color-primary));
}

.fsus-security-challenge.is-dialog-composition {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.fsus-security-challenge__v3 {
  display: grid;
  gap: var(--fsus-space-3, 12px);
}

.fsus-security-challenge__v3 > :first-child:not(:last-child) {
  justify-self: start;
}

.fsus-security-challenge__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.fsus-security-challenge__eyebrow {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fsusblog-text-muted, var(--el-text-color-secondary));
}

.fsus-security-challenge__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.35;
}

.fsus-security-challenge__panel {
  padding: 12px;
  border: 1px solid var(--fsusblog-panel-border, var(--el-border-color));
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--el-fill-color-lighter);
  color: var(--fsusblog-text-muted, var(--el-text-color-secondary));
}

.fsus-security-challenge__panel p {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
}
</style>
