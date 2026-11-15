<script setup lang="ts">
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { readAdminRiskReadiness } from '../../../Contracts/admin-risk-readiness'
import { applyRootCommentPowPolicy, readRootCommentPowPolicy, validRootCommentPowSeconds } from '../../../Contracts/admin-root-comment-pow'

const props = defineProps<{ session: AdminSession, sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const observation = shallowRef<Awaited<ReturnType<typeof readAdminRiskReadiness>>>()
const rootPolicy = shallowRef<Awaited<ReturnType<typeof readRootCommentPowPolicy>>>()
const seconds = ref('')
const busy = ref(false)
const error = ref('')
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
    else if (cause instanceof ApiError && cause.status === 403) error.value = 'The system.config permission is required.'
    else error.value = 'Could not check risk controls. Try again.'
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
    else if (cause instanceof ApiError && cause.status === 409) error.value = 'The root comment proof policy changed. Check risk controls again.'
    else error.value = 'Could not confirm the root comment proof policy change. Check risk controls again.'
  } finally {
    if (request === current) {
      request = undefined
      busy.value = false
    }
  }
}

watch(() => [props.session, props.sessionSignal] as const, ([, signal], _, cleanup) => {
  clear()
  signal.addEventListener('abort', clear, { once: true })
  cleanup(() => signal.removeEventListener('abort', clear))
}, { flush: 'sync', immediate: true })
onScopeDispose(clear)
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-risk-controls-heading" :aria-busy="busy">
    <h2 id="admin-risk-controls-heading">Risk controls</h2>
    <ElButton native-type="button" :loading="busy" @click="check">Check risk controls</ElButton>
    <ElAlert v-if="error" :title="error" :closable="false" type="error" />
    <div aria-live="polite">
      <dl v-if="observation">
        <dt>Public comment reads</dt>
        <dd>Fixed query concurrency limit</dd>
        <dt>Signed-in top-level comments</dt>
        <dd>{{ observation.rootWriteMode === 1 ? 'Classic PoW route installed' : 'Route not installed' }}</dd>
        <dt>Signed-in comment replies</dt>
        <dd v-if="observation.replyWriteMode === 2">Classic PoW route installed. Reply notice table present.</dd>
        <dd v-else-if="observation.replyWriteMode === 1">Classic PoW route installed. Reply notice table absent.</dd>
        <dd v-else>Route not installed</dd>
        <dt>Forwarded client address</dt>
        <dd>{{ observation.forwardingMode === 1 ? 'Trusted loopback proxy' : 'Connection peer address' }}</dd>
        <dt>Dynamic risk policy</dt>
        <dd>Not installed</dd>
        <dt>Strong anonymous comments</dt>
        <dd>Not installed</dd>
      </dl>
    </div>
    <section v-if="rootPolicy" aria-labelledby="admin-root-comment-proof-heading">
      <h3 id="admin-root-comment-proof-heading">Root comment proof policy</h3>
      <p aria-live="polite">Generation {{ rootPolicy.generation.toString() }} · {{ rootPolicy.proofSeconds }} seconds</p>
      <p><code class="policy-digest">{{ rootPolicy.digest }}</code></p>
      <label for="root-comment-proof-seconds">Proof lifetime in seconds</label>
      <ElInput id="root-comment-proof-seconds" v-model="seconds" v-bind="{ inputmode: 'numeric' }" :disabled="busy" />
      <ElButton native-type="button" :disabled="busy || !validRootCommentPowSeconds(Number(seconds)) ||
        Number(seconds) === rootPolicy.proofSeconds" @click="change(false)">Apply proof lifetime</ElButton>
      <ElButton v-if="rootPolicy.previousSeconds > 0" native-type="button" :disabled="busy"
        @click="change(true)">Restore previous proof lifetime</ElButton>
    </section>
  </section>
</template>

<style scoped>
dd { margin: 0 0 .5rem; }
.policy-digest { overflow-wrap: anywhere; }
</style>
