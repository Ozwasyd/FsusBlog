<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
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
const error = ref<MessageKey | ''>('')
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
    else if (cause instanceof ApiError && cause.status === 403) error.value = 'admin.systemPermission'
    else error.value = 'admin.deploymentFailed'
  } finally {
    if (request === current) { request = undefined; busy.value = false }
  }
}

watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clear)
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-cluster-heading" :aria-busy="busy">
    <h2 id="admin-cluster-heading">{{ t('admin.deploymentStatus') }}</h2>
    <ElButton native-type="button" :loading="busy" @click="check">{{ t('admin.checkDeployment') }}</ElButton>
    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" />
    <div aria-live="polite">
      <dl v-if="observation">
        <dt>{{ t('admin.mode') }}</dt><dd>{{ t('admin.singleInstance') }}</dd>
        <dt>{{ t('admin.distributedScheduling') }}</dt><dd>{{ t('admin.singleInstanceUnavailable') }}</dd>
        <template v-if="observation.nodeId"><dt>{{ t('admin.nodeLabel') }}</dt><dd>{{ observation.nodeId }}</dd></template>
        <dt>{{ t('admin.instanceId') }}</dt><dd><code>{{ observation.instanceId }}</code></dd>
        <dt>{{ t('admin.buildVersion') }}</dt><dd>{{ observation.buildVersion }}</dd>
        <dt>{{ t('admin.processStart') }}</dt>
        <dd><time :datetime="new Date(observation.startedAt).toISOString()">{{ new Date(observation.startedAt).toLocaleString() }}</time></dd>
        <dt>{{ t('admin.observedAt') }}</dt>
        <dd><time :datetime="new Date(observation.observedAt).toISOString()">{{ new Date(observation.observedAt).toLocaleString() }}</time></dd>
        <dt>{{ t('admin.publicationLease') }}</dt><dd>{{ t('admin.leaseConfirmed', { age: observation.leaseAgeMs }) }}</dd>
        <dt>{{ t('admin.publicSnapshot') }}</dt><dd>{{ observation.snapshotReady ? t('admin.ready') : t('admin.notReady') }}</dd>
      </dl>
    </div>
  </section>
</template>

<style scoped>
dl { min-width: 0; }
dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
</style>
