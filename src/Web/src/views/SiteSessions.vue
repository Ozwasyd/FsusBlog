<script setup lang="ts">
import { siteLocale, t } from '../siteLocale'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert,
  ElButton,
  ElInlineActions,
  ElMetadataItem,
  ElMetadataRow,
  ElResourceList,
  ElResourceListItem,
  ElSkeleton,
  ElTag,
} from '@ozwasyd/element-plus'
import { listSiteSessions, revokeSiteSessions, type SessionList } from '../../../Contracts/site-sessions'
import { ApiError } from '../../../Contracts/client'
import SecuritySectionCard from '../components/SecuritySectionCard.vue'
import { currentSession, identityEpoch } from '../session'
import { useDelayedBusy } from '../delayedBusy'

const list = shallowRef<SessionList | null>(null)
const error = ref('')
const busy = ref(false)
const actionKind = ref<'load' | 'revoke' | null>(null)
const refreshLoading = useDelayedBusy(() => busy.value && actionKind.value === 'load')
const showSkeleton = useDelayedBusy(() => busy.value && !list.value)
const dateTime = computed(() => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'medium', timeStyle: 'short' }))
let operation: AbortController | undefined

onUnmounted(() => operation?.abort())
watch(identityEpoch, () => {
  operation?.abort()
  operation = undefined
  list.value = null
  error.value = ''
  busy.value = false
  actionKind.value = null
  void load()
}, { immediate: true, flush: 'sync' })

function load() {
  return run('load', async (id, signal) => listSiteSessions(id, signal))
}

async function revoke(target?: string) {
  if (!list.value) return
  await run('revoke', async (id, signal) => {
    await revokeSiteSessions(id, target, signal)
    return listSiteSessions(id, signal)
  })
}

async function run(kind: 'load' | 'revoke', action: (id: string, signal: AbortSignal) => Promise<SessionList>) {
  const id = currentSession.value?.siteSessionId
  if (!id || busy.value) return
  const epoch = identityEpoch.value
  const request = new AbortController()
  operation = request
  busy.value = true
  actionKind.value = kind
  error.value = ''
  const isCurrent = () => !request.signal.aborted && epoch === identityEpoch.value
  try {
    const result = await action(id, request.signal)
    if (isCurrent()) list.value = result
  } catch (failure) {
    if (!isCurrent()) return
    list.value = null
    error.value = failure instanceof ApiError && (failure.status === 409 || failure.status === 401)
      ? t('account.message76')
      : t('account.message77')
  } finally {
    if (operation === request) {
      operation = undefined
      busy.value = false
      actionKind.value = null
    }
  }
}
</script>

<template>
  <SecuritySectionCard
    v-if="currentSession?.siteSessionId"
    heading-id="active-sessions-heading"
    :title="t('account.message67')"
    :description="list?.hasMore ? t('account.message68') : t('account.sessionsSummary')"
    :flush="!error && !showSkeleton"
    :has-body="Boolean(error || showSkeleton || list)"
  >
    <template #actions>
      <ElInlineActions density="compact">
        <ElButton native-type="button" text :loading="refreshLoading" @click="load">{{ t('account.message74') }}</ElButton>
        <ElButton
          v-if="list && list.sessions.length > 1"
          native-type="button"
          text
          type="danger"
          :disabled="busy"
          @click="revoke()"
        >{{ t('account.message75') }}</ElButton>
      </ElInlineActions>
    </template>

    <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <ElSkeleton v-else-if="showSkeleton" :rows="2" animated />

    <ElResourceList v-else-if="list" divided>
      <ElResourceListItem
        v-for="item in list.sessions"
        :key="item.id"
        :title="item.current ? t('account.message69') : t('account.message70')"
      >
        <template v-if="item.current" #badge>
          <ElTag size="small" type="success" disable-transitions>{{ t('account.sessionCurrentBadge') }}</ElTag>
        </template>
        <template v-if="!item.current" #actions>
          <ElButton native-type="button" text type="danger" :disabled="busy" @click="revoke(item.id)">
            {{ t('account.message73') }}
          </ElButton>
        </template>
        <ElMetadataRow density="compact">
          <ElMetadataItem :label="t('account.sessionIdLabel')" :value="item.id.slice(0, 10)" monospace />
          <ElMetadataItem
            :label="t('account.sessionMethodLabel')"
            :value="item.method === 'ticket' ? t('account.message71') : item.mfa ? t('account.message72') : t('account.message29')"
          />
          <ElMetadataItem :label="t('account.sessionExpiresLabel')">
            <time :datetime="new Date(item.expiresAt).toISOString()">{{ dateTime.format(new Date(item.expiresAt)) }}</time>
          </ElMetadataItem>
        </ElMetadataRow>
      </ElResourceListItem>
    </ElResourceList>
  </SecuritySectionCard>
</template>
