<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElEmptyState, ElInlineActions, ElInput,
  ElResourceList, ElResourceListItem, ElSettingsSection, ElSkeleton,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { appealReason, decideAdminAppeal, readAdminAppeals, type PendingAppeal } from '../../../Contracts/comment-appeals'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const list = shallowRef<PendingAppeal[] | null>(null)
const selected = ref<string>()
const reason = ref('')
const busy = ref(false)
const failure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const more = ref(false)
const lifetime = new AbortController()
onMounted(() => {
  if (!props.sessionSignal.aborted && list.value === null) void load()
})
watch(() => props.sessionSignal, signal => {
  list.value = null
  selected.value = undefined
  reason.value = ''
  failure.value = ''
  notice.value = ''
  more.value = false
  if (!signal.aborted) void load()
})
onBeforeUnmount(() => lifetime.abort())

async function run(task: (signal: AbortSignal) => Promise<void>) {
  if (busy.value || props.sessionSignal.aborted) return
  const signal = AbortSignal.any([props.sessionSignal, lifetime.signal])
  busy.value = true
  failure.value = ''
  notice.value = ''
  try { await task(signal) }
  catch (error) {
    if (signal.aborted) return
    if (error instanceof ApiError && error.status === 401) emit('sessionLost', error)
    else failure.value = error instanceof ApiError && error.status === 409
      ? 'admin.appeals.m9'
      : 'admin.appeals.m10'
  } finally { if (!signal.aborted) busy.value = false }
}

function load(append = false) {
  return run(async signal => {
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
  return run(async signal => {
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
  <ElSettingsSection class="appeal-review" title-tag="h3" ariaLabelledby="admin-appeal-heading" density="compact">
    <template #title>
      <span id="admin-appeal-heading">{{ t('admin.appeals.m1') }}</span>
    </template>
    <template #actions>
      <ElButton native-type="button" :text="list !== null" :loading="busy" @click="load()">{{ t('admin.appeals.m2') }}</ElButton>
    </template>
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" />
    <p v-if="notice" class="appeal-status" role="status">{{ t(notice) }}</p>
    <ElSkeleton v-if="busy && list === null" :rows="2" animated />
    <ElEmptyState v-else-if="list?.length === 0" size="inline" :title="t('admin.appeals.m3')" role="status" />
    <ElResourceList v-else-if="list" class="appeal-review-list" density="compact">
      <ElResourceListItem
        v-for="item in list"
        :key="item.id"
        :title="t('admin.appeals.m13', { article: item.article, comment: item.comment })"
      >
        <p class="appeal-text">{{ item.body }}</p>
        <p class="appeal-text appeal-reason">{{ item.reason }}</p>
        <template v-if="selected !== item.id" #actions>
          <ElButton native-type="button" :disabled="busy"
            @click="selected = item.id; reason = ''">{{ t('admin.appeals.m4') }}</ElButton>
        </template>
        <div v-if="selected === item.id" class="appeal-form">
          <div class="appeal-field">
            <label :for="`appeal-review-${item.id}`">{{ t('admin.appeals.m5') }}</label>
            <ElInput :id="`appeal-review-${item.id}`" v-model="reason" type="textarea" :disabled="busy" />
          </div>
          <ElInlineActions>
            <ElButton native-type="button" type="primary" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'granted')">{{ t('admin.appeals.m6') }}</ElButton>
            <ElButton native-type="button" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'denied')">{{ t('admin.appeals.m7') }}</ElButton>
          </ElInlineActions>
        </div>
      </ElResourceListItem>
    </ElResourceList>
    <div v-if="more" class="appeal-more">
      <ElButton native-type="button" :loading="busy" text @click="load(true)">{{ t('admin.appeals.m8') }}</ElButton>
    </div>
  </ElSettingsSection>
</template>

<style scoped>
.appeal-review-list {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
  overflow: hidden;
}

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
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.appeal-more {
  display: flex;
  justify-content: flex-start;
}
</style>
