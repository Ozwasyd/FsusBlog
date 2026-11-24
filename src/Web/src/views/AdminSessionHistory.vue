<script setup lang="ts">
import { t } from '../siteLocale'
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElEmptyState, ElMetadataItem, ElMetadataRow, ElResourceList, ElResourceListItem, ElSettingsSection, ElSkeleton, ElTag } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { readAdminSessionHistory, type AdminSessionHistoryRow } from '../../../Contracts/admin-session-history'
import { useDelayedBusy } from '../delayedBusy'

const props = defineProps<{ session: AdminSession; sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const lifetime = new AbortController()
const history = shallowRef<readonly AdminSessionHistoryRow[] | null>(null)
const loading = ref(false)
const refreshLoading = useDelayedBusy(() => loading.value)
const failure = ref(false)
const stateLabel = (state: AdminSessionHistoryRow['state']) => ({ current: t('admin.sessionCurrent'), ended: t('admin.sessionEnded'), expired: t('admin.sessionExpired') })[state]
const stateTagType = (state: AdminSessionHistoryRow['state']) => ({ current: 'success', ended: 'info', expired: 'warning' } as const)[state]

onMounted(() => { void loadHistory() })
onUnmounted(() => lifetime.abort())

async function loadHistory() {
  if (loading.value || props.sessionSignal.aborted) return
  const session = props.session
  const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
  loading.value = true
  failure.value = false
  try {
    const records = await readAdminSessionHistory(session, signal)
    if (!signal.aborted && props.session === session && session.expiresAt > Date.now()) history.value = records
  } catch (error) {
    if (signal.aborted) return
    history.value = null
    if (error instanceof ApiError && error.status === 401) emit('sessionLost', error)
    else failure.value = true
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
</script>

<template>
  <ElSettingsSection
    class="admin-session-history"
    ariaLabelledby="admin-session-history-heading"
    :description="t('admin.sessionHistorySummary')"
    density="compact"
  >
    <template #title><span id="admin-session-history-heading">{{ t('admin.sessionHistory') }}</span></template>
    <template #actions>
      <ElButton text :loading="refreshLoading" @click="loadHistory">{{ t('account.inboxRefresh') }}</ElButton>
    </template>
    <ElAlert v-if="failure" :title="t('admin.sessionHistoryFailed')" type="error" :closable="false" show-icon />
    <ElSkeleton v-else-if="loading && !history" :rows="2" animated />
    <ElEmptyState v-else-if="history?.length === 0" :title="t('admin.noSessionHistory')" role="status" />
    <ElResourceList v-else-if="history" density="compact">
      <ElResourceListItem
        v-for="(row, index) in history"
        :key="index"
        :title="`${t('admin.signedIn')} · ${new Date(row.startedAt).toLocaleString()}`"
        density="compact"
      >
        <template #badge>
          <ElTag size="small" :type="stateTagType(row.state)">{{ stateLabel(row.state) }}</ElTag>
        </template>
        <ElMetadataRow density="compact">
          <ElMetadataItem :label="t('admin.scheduledExpiry')">
            <time :datetime="new Date(row.expiresAt).toISOString()">{{ new Date(row.expiresAt).toLocaleString() }}</time>
          </ElMetadataItem>
          <ElMetadataItem v-if="row.state === 'ended' && row.endedAt !== null" :label="t('admin.endedAt')">
            <time :datetime="new Date(row.endedAt).toISOString()">{{ new Date(row.endedAt).toLocaleString() }}</time>
          </ElMetadataItem>
        </ElMetadataRow>
      </ElResourceListItem>
    </ElResourceList>
  </ElSettingsSection>
</template>

<style scoped>
.admin-session-history { min-width: 0; }
</style>
