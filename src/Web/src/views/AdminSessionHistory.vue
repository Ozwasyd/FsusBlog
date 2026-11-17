<script setup lang="ts">
import { t } from '../siteLocale'
import { onUnmounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { readAdminSessionHistory, type AdminSessionHistoryRow } from '../../../Contracts/admin-session-history'

const props = defineProps<{ session: AdminSession; sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const lifetime = new AbortController()
const history = shallowRef<readonly AdminSessionHistoryRow[] | null>(null)
const loading = ref(false)
const failure = ref(false)
const stateLabel = (state: AdminSessionHistoryRow['state']) => ({ current: t('admin.sessionCurrent'), ended: t('admin.sessionEnded'), expired: t('admin.sessionExpired') })[state]

onUnmounted(() => lifetime.abort())

async function loadHistory() {
  if (loading.value || props.sessionSignal.aborted) return
  const session = props.session
  const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
  loading.value = true
  history.value = null
  failure.value = false
  try {
    const records = await readAdminSessionHistory(session, signal)
    if (!signal.aborted && props.session === session && session.expiresAt > Date.now()) history.value = records
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof ApiError && error.status === 401) emit('sessionLost', error)
    else failure.value = true
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
</script>

<template>
  <section class="auth-form admin-session-history" aria-labelledby="admin-session-history-heading">
    <h2 id="admin-session-history-heading">{{ t('admin.sessionHistory') }}</h2>
    <ElButton native-type="button" :loading="loading" @click="loadHistory">{{ t('admin.loadSessionHistory') }}</ElButton>
    <ElAlert v-if="failure" :title="t('admin.sessionHistoryFailed')" type="error" :closable="false" show-icon />
    <p v-if="history?.length === 0" role="status">{{ t('admin.noSessionHistory') }}</p>
    <ol v-else-if="history" class="history-list">
      <li v-for="(row, index) in history" :key="index">
        <strong>{{ stateLabel(row.state) }}</strong>
        <dl>
          <dt>{{ t('admin.signedIn') }}</dt>
          <dd><time :datetime="new Date(row.startedAt).toISOString()">{{ new Date(row.startedAt).toLocaleString() }}</time></dd>
          <dt>{{ t('admin.scheduledExpiry') }}</dt>
          <dd><time :datetime="new Date(row.expiresAt).toISOString()">{{ new Date(row.expiresAt).toLocaleString() }}</time></dd>
          <template v-if="row.state === 'ended' && row.endedAt !== null">
            <dt>{{ t('admin.endedAt') }}</dt>
            <dd><time :datetime="new Date(row.endedAt).toISOString()">{{ new Date(row.endedAt).toLocaleString() }}</time></dd>
          </template>
        </dl>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.admin-session-history { margin-block-start: 1.5rem; }
.history-list { display: grid; gap: 1rem; padding-inline-start: 1.5rem; }
.history-list dl { display: grid; grid-template-columns: minmax(6rem, auto) 1fr; gap: 0.25rem 1rem; }
.history-list dd { margin-inline-start: 0; }
</style>
