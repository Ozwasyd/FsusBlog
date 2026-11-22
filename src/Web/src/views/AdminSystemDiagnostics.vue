<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  ElAlert,
  ElButton,
  ElCopyableDetail,
  ElDiagnosticsItem,
  ElDiagnosticsList,
  ElKeyValueGrid,
  ElKeyValueItem,
  ElSettingsSection,
  ElSkeleton,
  ElStatusSummary,
  ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminCluster } from '../../../Contracts/admin-cluster'
import {
  readAdminAuthority,
  readAdminOperations,
  type AdminAuthority,
  type AdminOperationsStatus,
  type AdminSession,
} from '../../../Contracts/admin-identity'
import { useDelayedBusy } from '../delayedBusy'
import { siteLocale, t, type MessageKey } from '../siteLocale'
import { watchAdminSessionClear } from './adminSessionClear'

type RuntimeDiagnostics = Readonly<{
  operations: AdminOperationsStatus
  cluster: Awaited<ReturnType<typeof readAdminCluster>>
}>

const props = defineProps<{ session: AdminSession; sessionSignal: AbortSignal }>()
const emit = defineEmits<{
  'session-lost': [error: ApiError]
  'authority-changed': [authority: AdminAuthority]
}>()

const state = shallowRef<RuntimeDiagnostics | null>(null)
const busy = ref(false)
const checkLoading = useDelayedBusy(() => busy.value)
const error = ref<MessageKey | ''>('')
let request: AbortController | undefined

const snapshotReady = computed(() => Boolean(state.value?.operations.snapshotReady && state.value?.cluster.snapshotReady))
const pendingCount = computed(() => state.value?.operations.pendingPublicationEvents ?? 0n)
const hasPending = computed(() => pendingCount.value > 0n)
const summaryTone = computed<'success' | 'warning'>(() => (snapshotReady.value && !hasPending.value ? 'success' : 'warning'))
const shortVersion = computed(() => formatShortVersion(state.value?.cluster.buildVersion ?? ''))

function formatShortVersion(version: string): string {
  const plus = version.indexOf('+')
  if (plus < 0) return version
  const meta = version.slice(plus + 1)
  return meta.length > 8 ? `${version.slice(0, plus)}+${meta.slice(0, 8)}` : version
}

function formatTime(unixMs: number): string {
  return new Date(unixMs).toLocaleString(siteLocale.value)
}

function clear() {
  request?.abort()
  request = undefined
  state.value = null
  busy.value = false
  error.value = ''
}

async function check(force = true) {
  if (props.sessionSignal.aborted || (!force && busy.value)) return
  request?.abort()
  const activeSession = props.session
  const current = request = new AbortController()
  const signal = AbortSignal.any([current.signal, props.sessionSignal])
  const live = () => request === current && !signal.aborted && props.session === activeSession
  busy.value = true
  error.value = ''
  try {
    const [operations, cluster] = await Promise.all([
      readAdminOperations(activeSession, signal),
      readAdminCluster(activeSession, signal),
    ])
    if (!live()) return
    const observed = await readAdminAuthority(signal)
    if (!live()) return
    if (observed.status !== 'active' || observed.session.permissionSession !== activeSession.permissionSession) {
      state.value = null
      emit('authority-changed', observed)
      return
    }
    state.value = { operations, cluster }
  } catch (cause) {
    if (!live()) return
    state.value = null
    if (cause instanceof ApiError && cause.status === 401) {
      const observed = await readAdminAuthority(signal).catch(() => null)
      if (!live()) return
      if (observed?.status === 'signed-out') {
        emit('session-lost', cause)
        return
      }
      if (observed && (observed.status !== 'active' || observed.session.permissionSession !== activeSession.permissionSession)) {
        emit('authority-changed', observed)
        return
      }
    }
    if (force || !(cause instanceof ApiError && cause.status === 403)) error.value = 'admin.runtimeFailed'
  } finally {
    if (request === current) {
      request = undefined
      busy.value = false
    }
  }
}

watchAdminSessionClear(() => [props.session, props.sessionSignal] as const, clear)
onMounted(() => { void check(false) })
</script>

<template>
  <ElSettingsSection
    class="admin-runtime"
    ariaLabelledby="admin-runtime-heading"
    :description="t('admin.runtimeSummary')"
    v-bind="{ 'aria-busy': busy }"
    density="compact"
  >
    <template #title>
      <span id="admin-runtime-heading">{{ t('admin.runtimeTitle') }}</span>
    </template>
    <template #actions>
      <ElButton native-type="button" text :loading="checkLoading" @click="check(true)">
        {{ t('admin.runtimeRecheck') }}
      </ElButton>
    </template>

    <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" show-icon />

    <div v-if="state" class="runtime-body" aria-live="polite">
      <ElStatusSummary density="compact" :tone="summaryTone">
        <template #label>
          {{ snapshotReady ? t('admin.runtimeHealthy') : t('admin.runtimePreparing') }}
        </template>
        <template #status>
          <ElTag size="small" :type="snapshotReady ? (hasPending ? 'warning' : 'success') : 'warning'">
            {{ snapshotReady ? t('admin.snapshotReadySummary') : t('admin.snapshotNotReadySummary') }}
          </ElTag>
        </template>
        <template #updated>
          {{ t('admin.runtimeLastChecked') }} ·
          <time :datetime="new Date(state.cluster.observedAt).toISOString()">{{ formatTime(state.cluster.observedAt) }}</time>
        </template>
      </ElStatusSummary>

      <ElKeyValueGrid density="compact">
        <ElKeyValueItem
          :label="t('admin.runtimeSyncLabel')"
          :value="hasPending ? t('admin.runtimePendingCount', { count: pendingCount.toString() }) : t('admin.runtimeAllSynced')"
        />
        <ElKeyValueItem :label="t('admin.runtimeVersionLabel')" :value="shortVersion" monospace />
        <ElKeyValueItem :label="t('admin.processStart')">
          <time :datetime="new Date(state.cluster.startedAt).toISOString()">{{ formatTime(state.cluster.startedAt) }}</time>
        </ElKeyValueItem>
      </ElKeyValueGrid>

      <ElDiagnosticsList density="compact">
        <ElDiagnosticsItem density="compact" :detail-label="t('admin.runtimeTechnicalDetails')">
          <template #detail>
            <div class="runtime-technical">
              <ElKeyValueGrid density="compact">
                <ElKeyValueItem :label="t('admin.runtimeSyncedCursor')" :value="state.operations.publicationWatermark.toString()" monospace />
                <ElKeyValueItem :label="t('admin.runtimeLeaseCheck')" :value="t('admin.runtimeLeaseAge', { age: state.cluster.leaseAgeMs })" />
                <ElKeyValueItem v-if="state.cluster.nodeId" :label="t('admin.nodeLabel')" :value="state.cluster.nodeId" />
                <ElKeyValueItem v-if="state.operations.oldestPendingAt !== null" :label="t('admin.oldestPendingEvent')">
                  <time :datetime="new Date(state.operations.oldestPendingAt).toISOString()">{{ formatTime(state.operations.oldestPendingAt) }}</time>
                </ElKeyValueItem>
              </ElKeyValueGrid>
              <div class="runtime-identifiers">
                <div class="runtime-identifier">
                  <span class="runtime-identifier-label">{{ t('admin.buildVersion') }}</span>
                  <ElCopyableDetail
                    :value="state.cluster.buildVersion"
                    :label="t('admin.copy')"
                    :copied-label="t('admin.copied')"
                    :error-label="t('admin.copyFailed')"
                  />
                </div>
                <div class="runtime-identifier">
                  <span class="runtime-identifier-label">{{ t('admin.instanceId') }}</span>
                  <ElCopyableDetail
                    :value="state.cluster.instanceId"
                    :label="t('admin.copy')"
                    :copied-label="t('admin.copied')"
                    :error-label="t('admin.copyFailed')"
                  />
                </div>
              </div>
            </div>
          </template>
        </ElDiagnosticsItem>
      </ElDiagnosticsList>
    </div>

    <ElSkeleton v-else-if="checkLoading && !error" :rows="2" animated />
  </ElSettingsSection>
</template>

<style scoped>
.admin-runtime {
  min-width: 0;
}

.runtime-body {
  display: grid;
  gap: var(--fsus-space-3);
  min-width: 0;
}

.runtime-technical {
  display: grid;
  gap: var(--fsus-space-3);
  min-width: 0;
}

.runtime-identifiers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: var(--fsus-space-3) var(--fsus-space-4);
  min-width: 0;
}

.runtime-identifier {
  display: grid;
  gap: var(--fsus-space-1);
  min-width: 0;
}

.runtime-identifier-label {
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
  font-weight: 500;
  line-height: 1.45;
}
</style>
