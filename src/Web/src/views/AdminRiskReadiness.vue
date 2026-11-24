<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onMounted, ref, shallowRef } from 'vue'
import {
  ElAlert, ElButton, ElCopyableDetail, ElFormSection, ElInlineActions, ElInput,
  ElKeyValueGrid, ElKeyValueItem, ElSettingsSection,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { readAdminRiskReadiness } from '../../../Contracts/admin-risk-readiness'
import { applyRootCommentPowPolicy, readRootCommentPowPolicy, validRootCommentPowSeconds } from '../../../Contracts/admin-root-comment-pow'
import { useDelayedBusy } from '../delayedBusy'
import { isAdminSessionLost, useAdminRequests } from './adminSessionClear'

const props = defineProps<{ session: AdminSession, sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const observation = shallowRef<Awaited<ReturnType<typeof readAdminRiskReadiness>>>()
const rootPolicy = shallowRef<Awaited<ReturnType<typeof readRootCommentPowPolicy>>>()
const seconds = ref('')
const busy = ref(false)
const checkLoading = useDelayedBusy(() => busy.value)
const error = ref<MessageKey | ''>('')

function clear() {
  observation.value = undefined
  rootPolicy.value = undefined
  seconds.value = ''
  busy.value = false
  error.value = ''
}

const requests = useAdminRequests(() => [props.session, props.sessionSignal] as const, clear)

async function check(force = true) {
  if (props.sessionSignal.aborted || (!force && busy.value)) return
  clear()
  const req = requests.start()
  busy.value = true
  try {
    const status = await readAdminRiskReadiness(props.session, req.signal)
    const policy = status.rootCommentPowPolicy ? await readRootCommentPowPolicy(props.session, req.signal) : undefined
    if (!req.signal.aborted) {
      observation.value = status
      rootPolicy.value = policy
      if (policy) seconds.value = String(policy.proofSeconds)
    }
  } catch (cause) {
    if (req.signal.aborted) return
    if (isAdminSessionLost(cause)) emit('session-lost', cause)
    else if (force || !(cause instanceof ApiError && cause.status === 403)) error.value = 'admin.riskCheckFailed'
  } finally {
    if (req.isCurrent()) { req.finish(); busy.value = false }
  }
}

async function change(rollback: boolean) {
  const policy = rootPolicy.value
  const value = rollback ? policy?.previousSeconds : Number(seconds.value)
  if (!policy || value === undefined || !validRootCommentPowSeconds(value) || value === policy.proofSeconds ||
      props.sessionSignal.aborted || busy.value) return
  const req = requests.start()
  busy.value = true
  error.value = ''
  try {
    const saved = await applyRootCommentPowPolicy(props.session, {
      expectedGeneration: policy.generation, expectedDigest: policy.digest, proofSeconds: value, rollback,
    }, req.signal)
    if (!req.signal.aborted) {
      rootPolicy.value = saved
      seconds.value = String(saved.proofSeconds)
    }
  } catch (cause) {
    if (req.signal.aborted) return
    rootPolicy.value = undefined
    if (isAdminSessionLost(cause)) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 409) error.value = 'admin.riskPolicyChanged'
    else error.value = 'admin.riskPolicyUnconfirmed'
  } finally {
    if (req.isCurrent()) { req.finish(); busy.value = false }
  }
}

onMounted(() => { void check(false) })
</script>

<template>
  <ElSettingsSection
    ariaLabelledby="admin-risk-controls-heading"
    :description="t('admin.riskSummary')"
    v-bind="{ 'aria-busy': busy }"
    density="compact"
  >
    <template #title>
      <span id="admin-risk-controls-heading">{{ t('admin.riskControls') }}</span>
    </template>
    <template #actions>
      <ElButton text :loading="checkLoading" @click="check(true)">{{ t('admin.checkRisk') }}</ElButton>
    </template>
    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" show-icon />
    <div aria-live="polite">
      <ElKeyValueGrid v-if="observation" density="compact">
        <ElKeyValueItem :label="t('admin.publicCommentReads')" :value="t('admin.fixedConcurrency')" />
        <ElKeyValueItem
          :label="t('admin.signedInRoots')"
          :value="observation.rootWriteMode === 1 ? t('admin.classicPowInstalled') : t('admin.routeNotInstalled')"
        />
        <ElKeyValueItem
          :label="t('admin.signedInReplies')"
          :value="observation.replyWriteMode === 2
            ? t('admin.replyTablePresent')
            : observation.replyWriteMode === 1
              ? t('admin.replyTableAbsent')
              : t('admin.routeNotInstalled')"
        />
        <ElKeyValueItem
          :label="t('admin.forwardedAddress')"
          :value="observation.forwardingMode === 1 ? t('admin.trustedLoopback') : t('admin.peerAddress')"
        />
        <ElKeyValueItem :label="t('admin.dynamicRisk')" :value="t('admin.notInstalled')" />
        <ElKeyValueItem :label="t('admin.strongAnonymous')" :value="t('admin.notInstalled')" />
      </ElKeyValueGrid>
    </div>
    <ElFormSection v-if="rootPolicy" title-tag="h3" ariaLabelledby="admin-root-comment-proof-heading" density="compact">
      <template #title>
        <span id="admin-root-comment-proof-heading">{{ t('admin.rootProofPolicy') }}</span>
      </template>
      <template #description>
        <span aria-live="polite">{{ t('admin.proofGeneration', { generation: rootPolicy.generation.toString(), seconds: rootPolicy.proofSeconds }) }}</span>
      </template>
      <ElCopyableDetail
        class="policy-digest"
        :value="rootPolicy.digest"
        :label="t('admin.copy')"
        :copied-label="t('admin.copied')"
        :error-label="t('admin.copyFailed')"
      />
      <div class="risk-policy-field">
        <label for="root-comment-proof-seconds">{{ t('admin.proofLifetime') }}</label>
        <ElInput id="root-comment-proof-seconds" v-model="seconds" v-bind="{ inputmode: 'numeric' }" :disabled="busy" />
      </div>
      <ElInlineActions>
        <ElButton
          type="primary"
          :disabled="busy || !validRootCommentPowSeconds(Number(seconds)) || Number(seconds) === rootPolicy.proofSeconds"
          @click="change(false)"
        >{{ t('admin.applyProofLifetime') }}</ElButton>
        <ElButton
          v-if="rootPolicy.previousSeconds > 0"
          :disabled="busy"
          @click="change(true)"
        >{{ t('admin.restoreProofLifetime') }}</ElButton>
      </ElInlineActions>
    </ElFormSection>
  </ElSettingsSection>
</template>

<style scoped lang="scss">
@use '../shared-fields' as fields;

.risk-policy-field {
  display: grid;
  gap: 6px;
  max-width: 280px;
}

.risk-policy-field label {

  @include fields.admin-label;
}

.policy-digest {
  overflow-wrap: anywhere;
}
</style>
