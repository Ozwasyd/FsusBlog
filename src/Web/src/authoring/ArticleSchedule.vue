<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readArticleSchedule, type ArticleSchedule } from '../../../Contracts/article-schedule'

const props = defineProps<{ articleId: number; revision: bigint; canChange: boolean }>()
const emit = defineEmits<{ schedule: [due: bigint] }>()
const current = shallowRef<ArticleSchedule>()
const due = ref('')
const failure = ref('')
const open = ref(false)
const attempt = ref(0)
const input = computed(() => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(due.value)) return 0n
  const millis = Date.parse(due.value)
  if (!Number.isFinite(millis) || millis <= 0) return 0n
  const canonical = new Date(millis).toISOString()
  return canonical === due.value || canonical.replace('.000Z', 'Z') === due.value ? BigInt(millis) : 0n
})

watch(() => [props.articleId, props.revision, open.value, attempt.value] as const, async ([id, revision, showing], _, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  current.value = undefined
  due.value = ''
  failure.value = ''
  if (!showing) return
  try {
    const state = await readArticleSchedule(id, revision, controller.signal)
    if (controller.signal.aborted) return
    current.value = state
    if (state.dueUnixMs) due.value = new Date(Number(state.dueUnixMs)).toISOString().replace('.000Z', 'Z')
  } catch (error) {
    if (controller.signal.aborted) return
    failure.value = error instanceof ApiError && error.status === 409
      ? 'Load the current draft to see its schedule.'
      : 'Could not load the schedule. Reopen the panel to retry.'
  }
}, { flush: 'sync' })

function toggle(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
}
</script>

<template>
  <details class="article-schedule" @toggle="toggle">
    <summary>Scheduled publication</summary>
    <ElAlert v-if="failure" type="error" :closable="false" :title="failure" />
    <p v-else-if="open && !current" role="status">Loading schedule…</p>
    <template v-if="current">
      <p v-if="current.dueUnixMs">
        Scheduled for {{ new Date(Number(current.dueUnixMs)).toISOString() }}.
        Editing and saving the draft clears this schedule.
      </p>
      <label for="article-schedule-time">Publish at (UTC)</label>
      <ElInput id="article-schedule-time" v-model="due" placeholder="2027-01-30T12:00:00Z" :disabled="!canChange" />
      <div class="schedule-actions">
        <ElButton :disabled="!canChange || !input || input === current.dueUnixMs" @click="emit('schedule', input)">
          {{ current.dueUnixMs ? 'Reschedule publication' : 'Schedule publication' }}
        </ElButton>
        <ElButton v-if="current.dueUnixMs" :disabled="!canChange" text @click="emit('schedule', 0n)">Cancel schedule</ElButton>
        <ElButton v-if="current.dueUnixMs" text @click="attempt++">Refresh schedule</ElButton>
      </div>
    </template>
  </details>
</template>

<style scoped>
.article-schedule summary { cursor: pointer; }
.schedule-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .5rem; }
</style>
