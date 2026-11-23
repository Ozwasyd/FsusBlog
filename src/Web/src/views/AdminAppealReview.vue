<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElEmptyState, ElInlineActions, ElInput,
  ElResourceList, ElResourceListItem, ElSkeleton,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { appealReason, decideAdminAppeal, readAdminAppeals, type PendingAppeal } from '../../../Contracts/comment-appeals'
import { useDelayedBusy } from '../delayedBusy'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const list = shallowRef<PendingAppeal[] | null>(null)
const selected = ref<string>()
const reason = ref('')
const busy = ref(false)
const busySource = ref<'initial' | 'refresh' | 'more' | 'decide' | null>(null)
const refreshLoading = useDelayedBusy(() => busy.value && busySource.value === 'refresh')
const moreLoading = useDelayedBusy(() => busy.value && busySource.value === 'more')
const failure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const more = ref(false)
const lifetime = new AbortController()
onMounted(() => {
  if (!props.sessionSignal.aborted && list.value === null) void load(false, 'initial')
})
watch(() => props.sessionSignal, signal => {
  list.value = null
  selected.value = undefined
  reason.value = ''
  failure.value = ''
  notice.value = ''
  more.value = false
  if (!signal.aborted) void load(false, 'initial')
})
onBeforeUnmount(() => lifetime.abort())

async function run(source: 'initial' | 'refresh' | 'more' | 'decide', task: (signal: AbortSignal) => Promise<void>) {
  if (busy.value || props.sessionSignal.aborted) return
  const signal = AbortSignal.any([props.sessionSignal, lifetime.signal])
  busy.value = true
  busySource.value = source
  failure.value = ''
  notice.value = ''
  try { await task(signal) }
  catch (error) {
    if (signal.aborted) return
    if (error instanceof ApiError && error.status === 401) emit('sessionLost', error)
    else failure.value = error instanceof ApiError && error.status === 409
      ? 'admin.appeals.m9'
      : 'admin.appeals.m10'
  } finally {
    if (!signal.aborted) {
      busy.value = false
      busySource.value = null
    }
  }
}

function load(append = false, source: 'initial' | 'refresh' | 'more' = append ? 'more' : 'refresh') {
  return run(source, async signal => {
    const before = append ? list.value?.at(-1)?.id ?? null : null
    const page = await readAdminAppeals(before, signal)
    if (signal.aborted) return
    list.value = before ? [...(list.value ?? []), ...page.rows] : page.rows
    more.value = page.more
    selected.value = undefined
    reason.value = ''
  })
}

function decide(id: string, decision: 'granted' | 'denied') {
  if (selected.value !== id || !appealReason(reason.value)) return
  const explanation = reason.value
  return run('decide', async signal => {
    await decideAdminAppeal(id, decision, explanation, signal)
    if (signal.aborted) return
    list.value = list.value?.filter(item => item.id !== id) ?? null
    selected.value = undefined
    reason.value = ''
    notice.value = decision === 'granted' ? 'admin.appeals.m11' : 'admin.appeals.m12'
  })
}
</script>

<template>
  <section class="appeal-review" aria-labelledby="admin-appeal-heading">
    <h2 id="admin-appeal-heading" class="appeal-sr-title">{{ t('admin.appeals.m1') }}</h2>
    <div class="appeal-panel-actions">
      <ElButton text :loading="refreshLoading" @click="load()">{{ t('admin.appeals.refresh') }}</ElButton>
    </div>
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" />
    <p v-if="notice" class="appeal-status" role="status">{{ t(notice) }}</p>
    <ElSkeleton v-if="busy && list === null" :rows="2" animated />
    <ElEmptyState v-else-if="list?.length === 0" :title="t('admin.appeals.m3')" role="status" />
    <ElResourceList v-else-if="list" class="appeal-review-list" density="compact">
      <ElResourceListItem
        v-for="item in list"
        :key="item.id"
        :title="t('admin.appeals.m13', { article: item.article, comment: item.comment })"
      >
        <p class="appeal-text">{{ item.body }}</p>
        <p class="appeal-text appeal-reason">{{ item.reason }}</p>
        <template v-if="selected !== item.id" #actions>
          <ElButton :disabled="busy"
            @click="selected = item.id; reason = ''">{{ t('admin.appeals.m4') }}</ElButton>
        </template>
        <div v-if="selected === item.id" class="appeal-form">
          <div class="appeal-field">
            <label :for="`appeal-review-${item.id}`">{{ t('admin.appeals.m5') }}</label>
            <ElInput :id="`appeal-review-${item.id}`" v-model="reason" type="textarea" :disabled="busy" />
          </div>
          <ElInlineActions>
            <ElButton type="primary" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'granted')">{{ t('admin.appeals.m6') }}</ElButton>
            <ElButton :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'denied')">{{ t('admin.appeals.m7') }}</ElButton>
            <ElButton text :disabled="busy"
              @click="selected = undefined; reason = ''">{{ t('admin.taxonomy.deleteCancel') }}</ElButton>
          </ElInlineActions>
        </div>
      </ElResourceListItem>
    </ElResourceList>
    <div v-if="more" class="appeal-more">
      <ElButton :loading="moreLoading" text @click="load(true)">{{ t('admin.appeals.m8') }}</ElButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '../review-panel' as layout;
@use '../shared-fields' as fields;

@include layout.review-panel('.appeal-review', '.appeal-sr-title', '.appeal-panel-actions', '.appeal-review-list');

.appeal-status {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.appeal-text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: var(--el-font-size-base);
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.appeal-reason {
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
}

.appeal-form,
.appeal-field {
  display: grid;
  gap: 8px;
}

.appeal-field label {

  @include fields.admin-label;
}

.appeal-more {
  display: flex;
  justify-content: flex-start;
}
</style>
