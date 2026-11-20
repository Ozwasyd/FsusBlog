<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElCopyableDetail, ElKeyValueGrid, ElKeyValueItem, ElSettingsSection, ElTag } from '@ozwasyd/element-plus'
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
    else error.value = 'admin.deploymentFailed'
  } finally {
    if (request === current) { request = undefined; busy.value = false }
  }
}

watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clear)
</script>

<template>
  <ElSettingsSection ariaLabelledby="admin-cluster-heading" v-bind="{ 'aria-busy': busy }" density="compact">
    <template #title>
      <span id="admin-cluster-heading">{{ t('admin.deploymentStatus') }}</span>
    </template>
    <template #actions>
      <ElButton native-type="button" :loading="busy" @click="check">{{ t('admin.checkDeployment') }}</ElButton>
    </template>
    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" />
    <div aria-live="polite">
      <ElKeyValueGrid v-if="observation" density="compact">
        <ElKeyValueItem :label="t('admin.mode')" :value="t('admin.singleInstance')" />
        <ElKeyValueItem :label="t('admin.distributedScheduling')" :value="t('admin.singleInstanceUnavailable')" />
        <ElKeyValueItem v-if="observation.nodeId" :label="t('admin.nodeLabel')" :value="observation.nodeId" />
        <ElKeyValueItem :label="t('admin.instanceId')" monospace>
          <ElCopyableDetail :value="observation.instanceId" />
        </ElKeyValueItem>
        <ElKeyValueItem :label="t('admin.buildVersion')" :value="observation.buildVersion" />
        <ElKeyValueItem :label="t('admin.processStart')">
          <time :datetime="new Date(observation.startedAt).toISOString()">{{ new Date(observation.startedAt).toLocaleString() }}</time>
        </ElKeyValueItem>
        <ElKeyValueItem :label="t('admin.observedAt')">
          <time :datetime="new Date(observation.observedAt).toISOString()">{{ new Date(observation.observedAt).toLocaleString() }}</time>
        </ElKeyValueItem>
        <ElKeyValueItem :label="t('admin.publicationLease')" :value="t('admin.leaseConfirmed', { age: observation.leaseAgeMs })" />
        <ElKeyValueItem :label="t('admin.publicSnapshot')">
          <ElTag size="small" :type="observation.snapshotReady ? 'success' : 'warning'">
            {{ observation.snapshotReady ? t('admin.ready') : t('admin.notReady') }}
          </ElTag>
        </ElKeyValueItem>
      </ElKeyValueGrid>
    </div>
  </ElSettingsSection>
</template>
