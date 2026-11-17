<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminCluster } from '../../../Contracts/admin-cluster'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ session: AdminSession, sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const observation = shallowRef<Awaited<ReturnType<typeof readAdminCluster>>>()
const busy = ref(false)
const error = ref('')
let request: AbortController | undefined

function clear() {
  request?.abort()
  request = undefined
  observation.value = undefined
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
    const status = await readAdminCluster(props.session, signal)
    if (!signal.aborted) observation.value = status
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 403) error.value = 'The system.config permission is required.'
    else error.value = 'Could not check deployment status. Try again.'
  } finally {
    if (request === current) { request = undefined; busy.value = false }
  }
}

watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clear)
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-cluster-heading" :aria-busy="busy">
    <h2 id="admin-cluster-heading">Deployment status</h2>
    <ElButton native-type="button" :loading="busy" @click="check">Check deployment status</ElButton>
    <ElAlert v-if="error" :title="error" :closable="false" type="error" />
    <div aria-live="polite">
      <dl v-if="observation">
        <dt>Mode</dt><dd>Single instance</dd>
        <dt>Distributed scheduling</dt><dd>Unavailable in single-instance mode</dd>
        <template v-if="observation.nodeId"><dt>Node label</dt><dd>{{ observation.nodeId }}</dd></template>
        <dt>Instance ID</dt><dd><code>{{ observation.instanceId }}</code></dd>
        <dt>Build version</dt><dd>{{ observation.buildVersion }}</dd>
        <dt>Process start</dt>
        <dd><time :datetime="new Date(observation.startedAt).toISOString()">{{ new Date(observation.startedAt).toLocaleString() }}</time></dd>
        <dt>Observed at</dt>
        <dd><time :datetime="new Date(observation.observedAt).toISOString()">{{ new Date(observation.observedAt).toLocaleString() }}</time></dd>
        <dt>Publication lease</dt><dd>Confirmed on the configured primary ({{ observation.leaseAgeMs }} ms old)</dd>
        <dt>Public snapshot</dt><dd>{{ observation.snapshotReady ? 'Ready' : 'Not ready' }}</dd>
      </dl>
    </div>
  </section>
</template>

<style scoped>
dl { min-width: 0; }
dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
</style>
