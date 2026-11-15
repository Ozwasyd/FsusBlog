<script setup lang="ts">
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
const failure = ref('')
const notice = ref('')
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
      ? 'The appeal changed. Reload the appeal queue.'
      : 'Could not complete the appeal request. Check access and try again.'
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
    notice.value = decision === 'granted' ? 'Appeal granted.' : 'Appeal denied.'
  })
}
</script>

<template>
  <section class="appeal-review" aria-labelledby="admin-appeal-heading">
    <h3 id="admin-appeal-heading">Comment appeals</h3>
    <ElButton native-type="button" :loading="busy" @click="load()">Load appeal queue</ElButton>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="list?.length === 0" role="status">No appeals are waiting for your review.</p>
    <ol v-else-if="list" class="appeal-review-list">
      <li v-for="item in list" :key="item.id">
        <p>Article {{ item.article }} · Comment {{ item.comment }}</p>
        <p class="appeal-text">{{ item.body }}</p>
        <p class="appeal-text">{{ item.reason }}</p>
        <ElButton v-if="selected !== item.id" native-type="button" :disabled="busy"
          @click="selected = item.id; reason = ''">Review appeal</ElButton>
        <div v-else class="appeal-form">
          <label :for="`appeal-review-${item.id}`">Reason for appeal decision</label>
          <ElInput :id="`appeal-review-${item.id}`" v-model="reason" type="textarea" :disabled="busy" />
          <div class="appeal-actions">
            <ElButton native-type="button" type="primary" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'granted')">Grant with Passkey</ElButton>
            <ElButton native-type="button" :disabled="busy || !appealReason(reason)"
              @click="decide(item.id, 'denied')">Deny with Passkey</ElButton>
          </div>
        </div>
      </li>
    </ol>
    <ElButton v-if="more" native-type="button" :loading="busy" text @click="load(true)">Load more appeals</ElButton>
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
