<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { readAdminRiskReadiness } from '../../../Contracts/admin-risk-readiness'
import { applyRootCommentPowPolicy, readRootCommentPowPolicy, validRootCommentPowSeconds } from '../../../Contracts/admin-root-comment-pow'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ session: AdminSession, sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const observation = shallowRef<Awaited<ReturnType<typeof readAdminRiskReadiness>>>()
const rootPolicy = shallowRef<Awaited<ReturnType<typeof readRootCommentPowPolicy>>>()
const seconds = ref('')
const busy = ref(false)
const error = ref<MessageKey | ''>('')
let request: AbortController | undefined

function clear() {
  request?.abort()
  request = undefined
  observation.value = undefined
  rootPolicy.value = undefined
  seconds.value = ''
  busy.value = false
  error.value = ''
}

async function check() {
  if (props.sessionSignal.aborted || busy.value) return
  clear()
  const current = request = new AbortController()
  const signal = AbortSignal.any([current.signal, props.sessionSignal])
  busy.value = true
  try {
    const status = await readAdminRiskReadiness(props.session, signal)
    const policy = status.rootCommentPowPolicy ? await readRootCommentPowPolicy(props.session, signal) : undefined
    if (!signal.aborted) {
      observation.value = status
      rootPolicy.value = policy
      if (policy) seconds.value = String(policy.proofSeconds)
    }
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 403) error.value = 'admin.systemPermission'
    else error.value = 'admin.riskCheckFailed'
  } finally {
    if (request === current) {
      request = undefined
      busy.value = false
    }
  }
}

async function change(rollback: boolean) {
  const policy = rootPolicy.value
  const value = rollback ? policy?.previousSeconds : Number(seconds.value)
  if (!policy || value === undefined || !validRootCommentPowSeconds(value) || value === policy.proofSeconds ||
      props.sessionSignal.aborted || busy.value) return
  const current = request = new AbortController()
  const signal = AbortSignal.any([current.signal, props.sessionSignal])
  busy.value = true
  error.value = ''
  try {
    const saved = await applyRootCommentPowPolicy(props.session, {
      expectedGeneration: policy.generation, expectedDigest: policy.digest, proofSeconds: value, rollback,
    }, signal)
    if (!signal.aborted) {
      rootPolicy.value = saved
      seconds.value = String(saved.proofSeconds)
    }
  } catch (cause) {
    if (signal.aborted) return
    rootPolicy.value = undefined
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 409) error.value = 'admin.riskPolicyChanged'
    else error.value = 'admin.riskPolicyUnconfirmed'
  } finally {
    if (request === current) {
      request = undefined
      busy.value = false
    }
  }
}

watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clear)
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-risk-controls-heading" :aria-busy="busy">
    <h2 id="admin-risk-controls-heading">{{ t('admin.riskControls') }}</h2>
    <ElButton native-type="button" :loading="busy" @click="check">{{ t('admin.checkRisk') }}</ElButton>
    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" />
    <div aria-live="polite">
      <dl v-if="observation">
        <dt>{{ t('admin.publicCommentReads') }}</dt>
        <dd>{{ t('admin.fixedConcurrency') }}</dd>
        <dt>{{ t('admin.signedInRoots') }}</dt>
        <dd>{{ observation.rootWriteMode === 1 ? t('admin.classicPowInstalled') : t('admin.routeNotInstalled') }}</dd>
        <dt>{{ t('admin.signedInReplies') }}</dt>
        <dd v-if="observation.replyWriteMode === 2">{{ t('admin.replyTablePresent') }}</dd>
        <dd v-else-if="observation.replyWriteMode === 1">{{ t('admin.replyTableAbsent') }}</dd>
        <dd v-else>{{ t('admin.routeNotInstalled') }}</dd>
        <dt>{{ t('admin.forwardedAddress') }}</dt>
        <dd>{{ observation.forwardingMode === 1 ? t('admin.trustedLoopback') : t('admin.peerAddress') }}</dd>
        <dt>{{ t('admin.dynamicRisk') }}</dt>
        <dd>{{ t('admin.notInstalled') }}</dd>
        <dt>{{ t('admin.strongAnonymous') }}</dt>
        <dd>{{ t('admin.notInstalled') }}</dd>
      </dl>
    </div>
    <section v-if="rootPolicy" aria-labelledby="admin-root-comment-proof-heading">
      <h3 id="admin-root-comment-proof-heading">{{ t('admin.rootProofPolicy') }}</h3>
      <p aria-live="polite">{{ t('admin.proofGeneration', { generation: rootPolicy.generation.toString(), seconds: rootPolicy.proofSeconds }) }}</p>
      <p><code class="policy-digest">{{ rootPolicy.digest }}</code></p>
      <label for="root-comment-proof-seconds">{{ t('admin.proofLifetime') }}</label>
      <ElInput id="root-comment-proof-seconds" v-model="seconds" v-bind="{ inputmode: 'numeric' }" :disabled="busy" />
      <ElButton native-type="button" :disabled="busy || !validRootCommentPowSeconds(Number(seconds)) ||
        Number(seconds) === rootPolicy.proofSeconds" @click="change(false)">{{ t('admin.applyProofLifetime') }}</ElButton>
      <ElButton v-if="rootPolicy.previousSeconds > 0" native-type="button" :disabled="busy"
        @click="change(true)">{{ t('admin.restoreProofLifetime') }}</ElButton>
    </section>
  </section>
</template>

<style scoped>
dd { margin: 0 0 .5rem; }
.policy-digest { overflow-wrap: anywhere; }
</style>
