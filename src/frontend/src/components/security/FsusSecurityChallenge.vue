<template>
  <section class="fsus-security-challenge" data-fsus-security-challenge="true" :aria-busy="busy">
    <header class="fsus-security-challenge__header">
      <div>
        <p class="fsus-security-challenge__eyebrow">安全验证</p>
        <h3 class="fsus-security-challenge__title">{{ title }}</h3>
      </div>
      <el-button
        data-test="security-challenge-refresh"
        :disabled="busy || disabled"
        @click="refreshChallenge"
      >
        刷新
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
      v-if="kindGroup === 'captcha'"
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
      v-else-if="kindGroup === 'perception' && perceptionRuntime"
      :challenge="perceptionRuntime.challenge"
      :renderer="perceptionRuntime.renderer"
      :client="perceptionRuntime.client"
      title="完成安全验证"
      eyebrow="Perception v2"
      refresh-label="刷新"
      retry-label="重试"
      cancel-label="取消"
      loading-text="正在准备安全验证"
      failed-text="验证未通过，请重试。"
      expired-text="验证已过期，请重试。"
      @verified="handlePerceptionVerified"
      @error="setError"
      @refresh="refreshChallenge"
      @retry="refreshChallenge"
      @expired="handlePerceptionExpired"
      @cancel="handlePerceptionCancel"
    />

    <FsusPowChallenge
      v-else-if="kindGroup === 'pow'"
      :assignment="assignment"
      :provider-payload="providerPayload"
      :refresh="refreshChallenge"
    >
      <template #default="slotProps">
        <slot name="pow" v-bind="slotProps" />
      </template>
    </FsusPowChallenge>

    <FsusPoSpaceChallenge
      v-else-if="kindGroup === 'pospace'"
      :assignment="assignment"
      :provider-payload="providerPayload"
      :refresh="refreshChallenge"
    >
      <template #default="slotProps">
        <slot name="pospace" v-bind="slotProps" />
      </template>
    </FsusPoSpaceChallenge>

    <FsusPasskeyStepUpChallenge
      v-else-if="kindGroup === 'passkey'"
      :assignment="assignment"
      :provider-payload="providerPayload"
      :refresh="refreshChallenge"
    >
      <template #default="slotProps">
        <slot name="passkey" v-bind="slotProps" />
      </template>
    </FsusPasskeyStepUpChallenge>

    <div v-else-if="kindGroup === 'unsupported'" class="fsus-security-challenge__panel">
      <slot name="unsupported" :assignment="assignment" :provider-payload="providerPayload" :refresh="refreshChallenge">
        <p data-test="security-challenge-unsupported">暂不支持该验证方式。</p>
      </slot>
    </div>

    <div v-else class="fsus-security-challenge__panel" role="status">
      <p>正在准备安全验证。</p>
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
import { FsusPerceptionChallenge, type PerceptionChallengeVerifyResult } from '@/fsusui/perceptionChallenge'
import FsusCaptchaChallenge from './FsusCaptchaChallenge.vue'
import FsusPasskeyStepUpChallenge from './FsusPasskeyStepUpChallenge.vue'
import FsusPoSpaceChallenge from './FsusPoSpaceChallenge.vue'
import FsusPowChallenge from './FsusPowChallenge.vue'
import {
  createSecurityChallengeClient,
  getChallengeKindGroup,
  type ChallengeKindGroup,
  type SecurityChallengeClient,
  type SecurityChallengeContext,
  type SecurityChallengeIssueResult
} from '@/security/challenge-client'
import type { SecurityChallengeProof } from '@/security/challenge-proof-store'
import {
  createPerceptionChallengeRuntime,
  isPerceptionChallengeKind,
  type PerceptionChallengeRuntime
} from '@/services/securityPerceptionChallengeFlow'

const props = withDefaults(defineProps<{
  action: string
  routeKey: string
  attributes?: Record<string, unknown>
  autoLoad?: boolean
  disabled?: boolean
  title?: string
  client?: SecurityChallengeClient
}>(), {
  autoLoad: true,
  disabled: false,
  title: '完成安全验证'
})

const emit = defineEmits<{
  issued: [value: SecurityChallengeIssueResult]
  verified: [value: SecurityChallengeVerifyResponse | SecurityChallengeProof]
  allow: [value: SecurityChallengeIssueResponse]
  unsupported: [value: SecurityChallengeIssueResult]
  error: [value: string]
  refresh: []
  expired: []
  cancel: []
}>()

const defaultClient = createSecurityChallengeClient()
const busy = ref(false)
const errorMessage = ref('')
const kindGroup = ref<ChallengeKindGroup | null>(null)
const assignment = ref<SecurityChallengeAssignment | null>(null)
const providerPayload = ref<SecurityChallengeProviderPayload | null>(null)
const preloadedIssueResponse = ref<SecurityChallengeIssueResponse | null>(null)
const captchaKey = ref(0)
const perceptionRuntime = ref<PerceptionChallengeRuntime | null>(null)

const title = computed(() => props.title)
const disabled = computed(() => props.disabled === true)

function context(): SecurityChallengeContext {
  return {
    action: props.action,
    routeKey: props.routeKey,
    attributes: props.attributes
  }
}

function client(): SecurityChallengeClient {
  return props.client ?? defaultClient
}

async function ensureChallenge(): Promise<void> {
  if (disabled.value || busy.value) {
    return
  }

  busy.value = true
  errorMessage.value = ''
  try {
    applyIssueResult(await client().issue(context()))
  } finally {
    busy.value = false
  }
}

async function refreshChallenge(): Promise<void> {
  if (disabled.value || busy.value) {
    return
  }

  emit('refresh')
  busy.value = true
  errorMessage.value = ''
  try {
    applyIssueResult(await client().refresh(context()))
  } finally {
    busy.value = false
  }
}

function applyIssueResult(result: SecurityChallengeIssueResult): void {
  resetPerceptionRuntime()
  emit('issued', result)
  assignment.value = result.assignment
  providerPayload.value = result.providerPayload
  kindGroup.value = result.kindGroup ?? (result.assignment ? getChallengeKindGroup(result.assignment.kind) : null)
  preloadedIssueResponse.value = result.response

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
  if (result.kindGroup === 'captcha') {
    captchaKey.value += 1
  }
}

async function verifyPerceptionChallenge(request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResponse> {
  const result = await client().verify(context(), request)
  return result.response ?? {
    verified: false,
    challengeId: request.challengeId,
    kind: request.kind,
    policyVersion: '',
    proofToken: '',
    reason: result.reason ?? 'security_challenge_verify_failed',
    retryAfterMs: result.retryAfterMs
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
  if (result.status === 'verified' && result.response) {
    return result.response
  }
  return result.response ?? {
    verified: false,
    challengeId: request.challengeId,
    kind: request.kind,
    policyVersion: '',
    proofToken: '',
    reason: result.reason ?? 'security_challenge_verify_failed',
    retryAfterMs: result.retryAfterMs
  }
}

function handleVerified(value: SecurityChallengeVerifyResponse): void {
  emit('verified', value)
}

function handlePerceptionVerified(value: PerceptionChallengeVerifyResult): void {
  const currentAssignment = assignment.value
  if (!value.verified || !currentAssignment) {
    setError('验证未通过，请重试。')
    return
  }

  emit('verified', {
    verified: true,
    challengeId: currentAssignment.challengeId,
    kind: currentAssignment.kind,
    policyVersion: preloadedIssueResponse.value?.policyVersion ?? '',
    proofToken: value.proofToken ?? '',
    reason: '',
    retryAfterMs: value.retryAfterMs ?? 0
  })
}

function handlePerceptionExpired(): void {
  client().clearProof(context())
  setError('验证已过期，请重试。')
  emit('expired')
}

function handlePerceptionCancel(): void {
  client().clearProof(context())
  setError('验证已取消。')
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
    kindGroup.value !== 'perception' ||
    !assignment.value ||
    !providerPayload.value ||
    !isPerceptionChallengeKind(assignment.value.kind)
  ) {
    return
  }

  perceptionRuntime.value = createPerceptionChallengeRuntime({
    assignment: assignment.value,
    providerPayload: providerPayload.value,
    verifyChallenge: verifyPerceptionChallenge
  })
}

onMounted(() => {
  if (props.autoLoad) {
    void ensureChallenge()
  }
})

onBeforeUnmount(() => {
  resetPerceptionRuntime()
})

watch([assignment, providerPayload, kindGroup], rebuildPerceptionRuntime)
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
  font-size: 13px;
  line-height: 1.5;
}
</style>
