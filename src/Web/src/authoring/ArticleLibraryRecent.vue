<script setup lang="ts">
import { t, siteLocale } from '../siteLocale'
import { ref, shallowRef, watch } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import { listRecentOpens, type RecentOpenCursor, type RecentOpens } from '../../../Contracts/author-recent-opens'
import { ApiError } from '../../../Contracts/client'
import { currentSession, identityEpoch } from '../session'
import { moveLibraryFocus } from './articleLibraryKeyboard'

const props = defineProps<{ active: boolean; version: number; articleId?: number; disabled: boolean }>()
const emit = defineEmits<{ open: [id: number, separate: boolean]; supported: [value: boolean] }>()
const page = shallowRef<RecentOpens>()
const cursors = shallowRef<readonly (RecentOpenCursor | undefined)[]>([undefined])
const loading = ref(false)
const failed = ref(false)
const retry = ref(0)
const results = ref<HTMLElement>()
const format = { format: (value: number | Date) => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(value) }
let availability: boolean | undefined

watch([identityEpoch, () => currentSession.value?.siteSessionId, () => currentSession.value?.canAuthor], () => {
  availability = undefined
  page.value = undefined
  emit('supported', false)
}, { flush: 'sync' })

const reloadSources = [() => props.active, () => props.version, identityEpoch, () => currentSession.value?.siteSessionId,
  () => currentSession.value?.canAuthor, retry] as const
watch(reloadSources, () => { cursors.value = [undefined] }, { flush: 'sync' })
watch([cursors, ...reloadSources], async ([trail, active, , epoch, handle], _, cleanup) => {
  // Opening the ordinary library probes only once for whether this site has recent history.
  if (!active && availability !== undefined) return
  page.value = undefined
  loading.value = false
  failed.value = false
  const session = currentSession.value
  if (!handle || !session?.canAuthor || session.expiresAt <= Date.now()) return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  const valid = () => {
    const current = currentSession.value
    return !controller.signal.aborted && epoch === identityEpoch.value && current?.siteSessionId === handle &&
      current.canAuthor && current.expiresAt > Date.now()
  }
  loading.value = true
  try {
    const value = await listRecentOpens(handle, AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]), trail.at(-1))
    if (!valid()) return
    availability = true
    emit('supported', true)
    page.value = value
  } catch (error) {
    if (!valid()) return
    if (error instanceof ApiError && error.status === 404) {
      availability = false
      emit('supported', false)
      return
    }
    failed.value = true
  } finally {
    if (valid()) loading.value = false
  }
}, { immediate: true })

function movePage(forward: boolean) {
  const value = page.value
  if (!value || loading.value || (forward ? !value.next : cursors.value.length === 1)) return
  cursors.value = forward ? [...cursors.value, { token: value.next, revision: value.revision }] : cursors.value.slice(0, -1)
}

function keyEvent(event: KeyboardEvent, id: number) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || props.disabled) return
  event.preventDefault()
  emit('open', id, true)
}
</script>

<template>
  <section v-if="active" :aria-label="t('author.articleLibraryRecent.recent.article.opens')">
    <p v-if="loading" role="status">{{ t('author.articleLibraryRecent.loading.recent.opens') }}</p>
    <p v-else-if="failed" role="alert">{{ t('author.articleLibraryRecent.could.not.load.recent.opens') }}</p>
    <ElButton v-if="failed" text native-type="button" @click="retry++">{{ t('author.articleLibraryRecent.retry.recent.opens') }}</ElButton>
    <p v-if="page?.items.length === 0" role="status">{{ t('author.articleLibraryRecent.no.recent.opens') }}</p>
    <ul v-if="page?.items.length" ref="results" class="recent-results" @keydown="moveLibraryFocus($event, results)">
      <li v-for="item in page.items" :key="item.articleId">
        <button type="button" :disabled="disabled" :aria-current="item.articleId === articleId ? 'true' : undefined"
          @click="emit('open', item.articleId, false)" @keydown="keyEvent($event, item.articleId)">
          <span>{{ item.title }}</span>
          <time :datetime="new Date(item.openedAt).toISOString()">{{ format.format(item.openedAt) }}</time>
        </button>
      </li>
    </ul>
    <div v-if="cursors.length > 1 || page?.next" class="recent-pages">
      <ElButton text native-type="button" :disabled="loading || !page || cursors.length === 1" @click="movePage(false)">{{ t('author.articleLibraryRecent.previous.recent.opens') }}</ElButton>
      <ElButton text native-type="button" :disabled="loading || !page?.next" @click="movePage(true)">{{ t('author.articleLibraryRecent.next.recent.opens') }}</ElButton>
    </div>
  </section>
</template>

<style scoped>
.recent-results { display: grid; gap: .2rem; list-style: none; padding: 0; }
.recent-results button { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; inline-size: 100%;
  min-block-size: var(--fsus-control-height-action); border: 1px solid transparent; border-radius: var(--fsus-radius-control); background: transparent;
  color: var(--fsus-ink); text-align: start; font: inherit; overflow-wrap: anywhere; cursor: pointer; }
.recent-results button:hover:not(:disabled), .recent-results button[aria-current] { border-color: var(--fsus-color-action-primary); }
.recent-results time { font-size: .8em; flex: none; color: var(--fsus-color-text-muted); }
.recent-pages { display: flex; flex-wrap: wrap; justify-content: space-between; }
</style>
