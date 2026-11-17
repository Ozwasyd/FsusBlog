<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
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
  <section class="appeal-review" aria-labelledby="admin-appeal-heading">
    <h3 id="admin-appeal-heading">{{ t('admin.appeals.m1') }}</h3>
    <ElButton native-type="button" :loading="busy" @click="load()">{{ t('admin.appeals.m2') }}</ElButton>
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" />
    <p v-if="notice" role="status">{{ t(notice) }}</p>
    <p v-if="list?.length === 0" role="status">{{ t('admin.appeals.m3') }}</p>
    <ol v-else-if="list" class="appeal-review-list">
      <li v-for="item in list" :key="item.id">
        <p>{{ t('admin.appeals.m13', { article: item.article, comment: item.comment }) }}</p>
        <p class="appeal-text">{{ item.body }}</p>
        <p class="appeal-text">{{ item.reason }}</p>
        <ElButton v-if="selected !== item.id" native-type="button" :disabled="busy"
          @click="selected = item.id; reason = ''">{{ t('admin.appeals.m4') }}</ElButton>
        <div v-else class="appeal-form">
          <label :for="`appeal-review-${item.id}`">{{ t('admin.appeals.m5') }}</label>
          <ElInput :id="`appeal-review-${item.id}`" v-model="reason" type="textarea" :disabled="busy" />
          <div class="appeal-actions">
            <ElButton native-type="button" type="primary" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'granted')">{{ t('admin.appeals.m6') }}</ElButton>
            <ElButton native-type="button" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'denied')">{{ t('admin.appeals.m7') }}</ElButton>
          </div>
        </div>
      </li>
    </ol>
    <ElButton v-if="more" native-type="button" :loading="busy" text @click="load(true)">{{ t('admin.appeals.m8') }}</ElButton>
  </section>
</template>

<style scoped>
.appeal-review, .appeal-form { display: grid; gap: var(--fsus-space-2); }
.appeal-review > button { justify-self: start; }
.appeal-review-list { display: grid; gap: var(--fsus-space-3); margin: 0; padding: 0; list-style: none; }
.appeal-text { overflow-wrap: anywhere; white-space: pre-wrap; }
.appeal-actions { display: flex; flex-wrap: wrap; gap: var(--fsus-space-2); }
.appeal-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
