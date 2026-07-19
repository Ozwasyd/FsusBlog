<template>
  <section class="fsus-security-challenge" data-fsus-security-challenge="true" :aria-busy="busy">
    <header class="fsus-security-challenge__header">
      <div>
        <p class="fsus-security-challenge__eyebrow">{{ copy.eyebrow }}</p>
        <h3 class="fsus-security-challenge__title">{{ title }}</h3>
      </div>
      <el-button
        data-test="security-challenge-refresh"
        :disabled="busy || disabled"
        @click="refreshChallenge"
      >
        {{ copy.refreshCta }}
      </el-button>
    </header>

    <el-alert
      v-if="errorMessage"
      class="fsus-security-challenge__alert"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
    />

    <FsusCaptchaChallenge
      v-if="capability?.uiHost === 'captcha'"
      :key="captchaKey"
      :action="action"
      :route-key="routeKey"
      :attributes="attributes"
      :disabled="disabled"
      :issue-challenge="issueCaptchaChallenge"
      :verify-challenge="verifyCaptchaChallenge"
      @verified="handleVerified"
      @error="setError"
      @refresh="emit('refresh')"
    />

    <FsusPerceptionChallenge
      v-else-if="capability?.uiHost === 'perception' && perceptionRuntime"
      :challenge="perceptionRuntime.challenge"
      :renderer="perceptionRuntime.renderer"
      :client="perceptionRuntime.client"
      :title="copy.perceptionTitle"
      :eyebrow="copy.perceptionEyebrow"
      :refresh-label="copy.perceptionRefresh"
      :retry-label="copy.perceptionRetry"
      :cancel-label="copy.perceptionCancel"
      :loading-text="copy.perceptionLoading"
      :failed-text="copy.perceptionFailed"
      :expired-text="copy.perceptionExpired"
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

    <div v-else-if="capability && !capability.policyEligible" class="fsus-security-challenge__panel">
      <slot name="unsupported" :assignment="assignment" :provider-payload="providerPayload" :refresh="refreshChallenge">
        <p data-test="security-challenge-unsupported">{{ copy.unsupported }}</p>
      </slot>
    </div>

    <div v-else class="fsus-security-challenge__panel" role="status">
      <p>{{ copy.preparing }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  SecurityChallengeKind,
  type IssueSecurityChallengeRequest,
  type SecurityChallengeAssignment,
  type SecurityChallengeIssueResponse,
  type SecurityChallengeProviderPayload,
  type SecurityChallengeVerifyResponse,
  type VerifySecurityChallengeRequest
} from '@/api/security'
import { FsusPerceptionChallenge, type PerceptionChallengeVerifyResult } from '@ozwasyd/element-plus/perception-challenge'
import FsusCaptchaChallenge from './FsusCaptchaChallenge.vue'
import FsusPoSpaceChallenge, {
  type PoSpaceChallengeExecutorFactory,
  type PoSpaceUnsupportedResult
} from './FsusPoSpaceChallenge.vue'
import {
  createSecurityChallengeClient,
  type SecurityChallengeClient,
  type SecurityChallengeContext,
  type SecurityChallengeIssueResult
} from '@/security/challenge-client'
import {
  resolveChallengeCapability,
  type ChallengeCapabilityResolution
} from '@/security/challenge-capability-registry'
import type { SecurityChallengeProof } from '@/security/challenge-proof-store'
import {
  createPerceptionChallengeRuntime,
  isPerceptionChallengeKind,
  type PerceptionChallengeRuntime
} from '@/services/securityPerceptionChallengeFlow'
import { FSUSBLOG_SECURITY_COPY } from '@/copy'

const copy = FSUSBLOG_SECURITY_COPY.challenge

const props = withDefaults(defineProps<{
  action: string
  routeKey: string
  attributes?: Record<string, unknown>
  autoLoad?: boolean
  disabled?: boolean
  title?: string
  client?: SecurityChallengeClient
  executorFactory?: PoSpaceChallengeExecutorFactory
}>(), {
  autoLoad: true,
  disabled: false,
  title: FSUSBLOG_SECURITY_COPY.challenge.defaultTitle
})

const emit = defineEmits<{
  issued: [value: SecurityChallengeIssueResult]
  verified: [value: SecurityChallengeVerifyResponse | SecurityChallengeProof]
  allow: [value: SecurityChallengeIssueResponse]
  unsupported: [value: SecurityChallengeIssueResult | PoSpaceUnsupportedResult]
  error: [value: string]
  refresh: []
  expired: []
  cancel: []
}>()

const defaultClient = createSecurityChallengeClient()
const busy = ref(false)
const errorMessage = ref('')
const capability = ref<ChallengeCapabilityResolution | null>(null)
const assignment = ref<SecurityChallengeAssignment | null>(null)
const providerPayload = ref<SecurityChallengeProviderPayload | null>(null)
const preloadedIssueResponse = ref<SecurityChallengeIssueResponse | null>(null)
const issuePolicyVersion = ref('')
const captchaKey = ref(0)
const perceptionRuntime = ref<PerceptionChallengeRuntime | null>(null)
const poSpaceHost = ref<{ dispose?: () => void } | null>(null)
const lastVerifyResponse = ref<SecurityChallengeVerifyResponse | null>(null)
let hostGeneration = 0

const title = computed(() => props.title)
const disabled = computed(() => props.disabled === true)
const executorFactory = computed(() => props.executorFactory)
const challengeContext = computed<SecurityChallengeContext>(() => ({
  action: props.action,
  routeKey: props.routeKey,
  attributes: props.attributes
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

function applyIssueResult(result: SecurityChallengeIssueResult): void {
  resetPerceptionRuntime()
  emit('issued', result)
  assignment.value = result.assignment
  providerPayload.value = result.providerPayload
  capability.value = result.capability ?? (result.assignment
    ? resolveChallengeCapability(result.assignment.kind, { action: props.action, mode: 'ui' })
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
  if (result.status === 'unsupported') {
    emit('unsupported', result)
    setError(result.reason ?? 'security_challenge_kind_unsupported')
    return
  }
  if (result.status === 'failed') {
    setError(result.reason ?? 'security_challenge_issue_failed')
    return
  }
  if (capability.value?.uiHost === 'captcha') {
    captchaKey.value += 1
  }
}

async function verifyPerceptionChallenge(request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResponse> {
  const result = await client().verify(context(), request)
  lastVerifyResponse.value = result.response
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
  }
}

async function issueCaptchaChallenge(request: IssueSecurityChallengeRequest): Promise<SecurityChallengeIssueResponse> {
  const preloaded = preloadedIssueResponse.value
  if (preloaded) {
    preloadedIssueResponse.value = null
    return preloaded
  }

  const result = await client().refresh({
    action: request.action,
    routeKey: request.routeKey,
    attributes: request.attributes,
    deviceFingerprint: request.deviceFingerprint
  })
  applyIssueResult(result)
  if (!result.response || result.assignment?.kind !== SecurityChallengeKind.CaptchaV1) {
    throw new Error(result.reason ?? 'captcha_assignment_missing')
  }
  preloadedIssueResponse.value = null
  return result.response
}

async function verifyCaptchaChallenge(request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResponse> {
  const result = await client().verify(context(), request)
  lastVerifyResponse.value = result.response
  if (result.next) {
    applyIssueResult(result.next)
  }
  if (result.status === 'verified' && result.response) {
    return result.response
  }
  return result.response ?? failedVerifyResponse(request, result.reason, result.retryAfterMs)
}

function handleVerified(value: SecurityChallengeVerifyResponse): void {
  if (value.envelopeCompleted) {
    emit('verified', value)
  }
}

function handlePerceptionVerified(value: PerceptionChallengeVerifyResult): void {
  const response = lastVerifyResponse.value
  if (!value.verified || !response) {
    setError(copy.perceptionFailed)
    return
  }
  handleVerified(response)
}

function handlePerceptionExpired(): void {
  client().clearProof(context())
  setError(copy.perceptionExpired)
  emit('expired')
}

function handlePerceptionCancel(): void {
  client().clearProof(context())
  setError(copy.perceptionCancelled)
  emit('cancel')
}

function handlePoSpaceExpired(): void {
  client().clearProof(context())
  emit('expired')
}

function handlePoSpaceError(message: string): void {
  errorMessage.value = '验证未通过。'
  emit('error', message)
}

function handlePoSpaceCancel(): void {
  client().clearProof(context())
  emit('cancel')
}

function setError(message: string): void {
  errorMessage.value = message
  emit('error', message)
}

function resetPerceptionRuntime(): void {
  perceptionRuntime.value?.dispose()
  perceptionRuntime.value = null
}

function rebuildPerceptionRuntime(): void {
  resetPerceptionRuntime()
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
  client().cancelEnvelope(context())
  resetPerceptionRuntime()
})

watch([assignment, providerPayload, capability], rebuildPerceptionRuntime)
watch(
  () => [props.action, props.routeKey] as const,
  (_current, previous) => {
    if (!previous) {
      return
    }
    client().cancelEnvelope({ action: previous[0], routeKey: previous[1] })
    hostGeneration += 1
    poSpaceHost.value?.dispose?.()
    resetPerceptionRuntime()
    assignment.value = null
    providerPayload.value = null
    capability.value = null
    void ensureChallenge()
  }
)
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
