<script setup lang="ts">
import { t } from '../siteLocale'
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElButton, ElLink } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { savedViewPlacement, type SavedViewPlacement } from '../../../Contracts/saved-views'
import { WireLimits } from '../../../Contracts/wire.generated'
import { credentialEpoch, currentSession } from '../session'

defineProps<{ active: boolean; disabled: boolean }>()
const emit = defineEmits<{ available: [value: boolean] }>()
const placement = shallowRef<SavedViewPlacement>()
const offset = ref(0)
const loading = ref(false)
const failure = ref('')
const navigation = ref<HTMLElement>()
let request: AbortController | undefined

async function load(page?: { offset: number; revision: bigint }) {
  request?.abort()
  placement.value = undefined
  loading.value = false
  failure.value = ''
  offset.value = 0
  const session = currentSession.value
  const handle = session?.siteSessionId
  if (!handle || !session?.canAuthor || session.expiresAt <= Date.now()) return

  const epoch = credentialEpoch.value
  const controller = request = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)])
  const current = () => {
    const observed = currentSession.value
    return !controller.signal.aborted && credentialEpoch.value === epoch && observed?.canAuthor === true &&
      observed.siteSessionId === handle && observed.expiresAt > Date.now()
  }
  loading.value = true
  try {
    const result = await savedViewPlacement(handle, page, signal)
    if (!current() || signal.aborted) return
    placement.value = result
    offset.value = page?.offset ?? 0
    if (!page) emit('available', result.pins.length > 0)
  } catch (error) {
    if (!current()) return
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      emit('available', false)
      return
    }
    failure.value = error instanceof ApiError && error.status === 409
      ? t('author.articleLibrarySaved.pinned.views.changed.reload.them.from.the.first.page') : t('author.articleLibrarySaved.could.not.load.pinned.views')
  } finally {
    if (current()) loading.value = false
  }
}

async function movePage(direction: -1 | 1) {
  const current = placement.value
  if (!current || loading.value) return
  const page = direction === 1 ? current.offset : offset.value - WireLimits.SavedViewPageSize
  if (page < 0 || direction === 1 && page === 0) return
  const started = load(page === 0 ? undefined : { offset: page, revision: current.revision })
  const pending = request
  await started
  await nextTick()
  if (request === pending && !pending?.signal.aborted)
    navigation.value?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus()
}

watch(credentialEpoch, () => {
  emit('available', false)
  void load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <nav v-if="active" ref="navigation" :aria-label="t('author.articleLibrarySaved.pinned.saved.views')" class="pinned-views">
    <p v-if="loading" role="status">{{ t('author.articleLibrarySaved.loading.pinned.views') }}</p>
    <p v-else-if="failure" role="alert">{{ failure }}</p>
    <ElButton v-if="failure" text native-type="button" @click="load()">{{ t('author.articleLibrarySaved.reload.pinned.views') }}</ElButton>
    <p v-if="placement?.pins.length === 0" role="status">{{ t('author.articleLibrarySaved.no.pinned.views.on.this.page') }}</p>
    <ul v-if="placement?.pins.length">
      <li v-for="view in placement.pins" :key="view.id">
        <RouterLink :to="{ name: 'article-list', query: { view: view.id, viewSchema: '1' } }" custom v-slot="{ href, navigate }">
          <ElLink :href="href" :disabled="disabled" @click="navigate">{{ view.name }}</ElLink>
        </RouterLink>
      </li>
    </ul>
    <div v-if="offset || placement?.offset" class="pinned-pages">
      <ElButton text native-type="button" :disabled="!offset" @click="movePage(-1)">{{ t('author.articleLibrarySaved.previous.pinned.views') }}</ElButton>
      <ElButton text native-type="button" :disabled="!placement?.offset" @click="movePage(1)">{{ t('author.articleLibrarySaved.next.pinned.views') }}</ElButton>
    </div>
  </nav>
</template>

<style scoped>
.pinned-views ul { list-style: none; padding: 0; margin-block: 0; }
.pinned-views li { padding-block: var(--fsus-space-1); overflow-wrap: anywhere; }
.pinned-views .el-link { min-block-size: var(--fsus-control-height-action); max-inline-size: 100%; text-align: start; }
.pinned-pages { display: flex; flex-wrap: wrap; justify-content: space-between; }
</style>
