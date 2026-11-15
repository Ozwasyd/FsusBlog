<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElDialog, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { executeTrashRestore, readTrashRestoreAvailability, requestTrashRestoreProof } from '../../../Contracts/admin-article-trash'
import { listAdminArticles, type AuthorArticlePage, type AuthorArticleQuery, type AuthorArticleRow } from '../../../Contracts/author-articles'
import type { AdminArticleTrashRestoreIntent } from '../../../Contracts/wire.generated'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [cause: ApiError] }>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const page = shallowRef<AuthorArticlePage>()
const query = shallowRef<AuthorArticleQuery>({ trash: false })
const keyword = ref('')
const reading = ref(false)
const failed = ref(false)
const restoreAvailable = ref(false)
const selected = shallowRef<AuthorArticleRow>()
const retry = shallowRef<AdminArticleTrashRestoreIntent>()
const restoring = ref(false)
const restoreFailure = ref('')
const notice = ref('')
const busy = computed(() => reading.value || restoring.value || !!retry.value)
onScopeDispose(() => lifetime.abort())

onMounted(async () => {
  try { restoreAvailable.value = await readTrashRestoreAvailability(signal) }
  catch (cause) { if (!signal.aborted && cause instanceof ApiError && cause.status === 401) emit('session-lost', cause) }
})

async function load(next: AuthorArticleQuery) {
  if (busy.value || signal.aborted) return
  reading.value = true
  failed.value = false
  page.value = undefined
  query.value = next
  try {
    const result = await listAdminArticles(next, signal)
    if (!signal.aborted) page.value = result
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else failed.value = true
  } finally { reading.value = false }
}

function search(trash = query.value.trash) {
  return load({ trash, keyword: keyword.value.trim(), match: 'title-summary' })
}

function nextPage() {
  if (page.value?.nextId) return load({ ...query.value, beforeId: page.value.nextId })
}

async function restore() {
  const pending = retry.value
  const row = selected.value
  if (!restoreAvailable.value || restoring.value || reading.value || signal.aborted || (!pending && !row)) return
  const intent = pending ?? { articleId: row!.id, expectedRevision: row!.revision, idempotencyKey: crypto.randomUUID() }
  restoreFailure.value = ''
  notice.value = ''
  restoring.value = true
  let submitted = !!pending
  let refresh = false
  try {
    const proof = pending ? undefined : await requestTrashRestoreProof(intent, signal)
    signal.throwIfAborted()
    submitted = true
    const receipt = await executeTrashRestore(intent, proof, signal)
    if (signal.aborted) return
    retry.value = undefined
    selected.value = undefined
    notice.value = `Article ${receipt.articleId} restored as private revision ${receipt.revision}.`
    refresh = true
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) {
      emit('session-lost', cause)
    } else if (submitted && (!(cause instanceof ApiError) || cause.status >= 500)) {
      selected.value = undefined
      retry.value = intent
      restoreFailure.value = 'The result is unknown. Check this same restore before trying again.'
    } else {
      retry.value = undefined
      selected.value = undefined
      restoreFailure.value = 'Could not restore this revision. Reload the article trash and try again.'
      refresh = true
    }
  } finally { restoring.value = false }
  if (refresh && !signal.aborted) await load({ ...query.value, beforeId: undefined })
}
</script>

<template>
  <section class="inventory" aria-labelledby="admin-article-inventory-heading" :aria-busy="reading">
    <h2 id="admin-article-inventory-heading">Article inventory</h2>
    <div class="inventory-actions">
      <ElButton native-type="button" :disabled="busy" v-bind="{ 'aria-pressed': !query.trash }" @click="search(false)">Active articles</ElButton>
      <ElButton native-type="button" :disabled="busy" v-bind="{ 'aria-pressed': query.trash }" @click="search(true)">Article trash</ElButton>
    </div>
    <form class="inventory-actions" @submit.prevent="search()">
      <label for="admin-article-keyword">Title or summary</label>
      <ElInput id="admin-article-keyword" v-model="keyword" :disabled="busy" />
      <ElButton native-type="submit" :disabled="busy" :loading="reading">Search articles</ElButton>
    </form>
    <ElAlert v-if="failed" title="Could not load the article inventory. Try again." type="error" :closable="false" />
    <ElAlert v-if="restoreFailure" :title="restoreFailure" type="warning" :closable="false" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <ElButton v-if="retry" native-type="button" :loading="restoring" @click="restore">Check restore result</ElButton>
    <template v-if="page">
      <p role="status">{{ page.total }} {{ query.trash ? 'deleted' : 'active' }} {{ page.total === 1 ? 'article' : 'articles' }}</p>
      <ul v-if="page.items.length" class="inventory-list">
        <li v-for="item in page.items" :key="item.id">
          <strong>{{ item.title }}</strong>
          <div>Article {{ item.id }} · Revision {{ item.revision }} · {{ item.state }}</div>
          <div v-if="item.category || item.tags.length">{{ [item.category, ...item.tags].filter(Boolean).map(entry => entry?.name).join(' · ') }}</div>
          <ElButton v-if="query.trash && restoreAvailable" native-type="button" :disabled="busy" @click="selected = item">Restore to draft</ElButton>
        </li>
      </ul>
      <div v-if="query.beforeId || page.nextId" class="inventory-actions">
        <ElButton v-if="query.beforeId" native-type="button" :disabled="busy" @click="load({ ...query, beforeId: undefined })">First page</ElButton>
        <ElButton v-if="page.nextId" native-type="button" :disabled="busy" @click="nextPage">Next page</ElButton>
      </div>
    </template>
    <ElDialog :model-value="!!selected" title="Restore deleted article" width="min(30rem, 90vw)"
      :close-on-press-escape="!restoring" :close-on-click-modal="!restoring" :show-close="!restoring"
      @update:model-value="visible => { if (!visible && !restoring) selected = undefined }">
      <p v-if="selected">Restore revision {{ selected.revision }} of {{ selected.title }} to its author as a private draft.</p>
      <template #footer>
        <ElButton native-type="button" :disabled="restoring" @click="selected = undefined">Cancel</ElButton>
        <ElButton native-type="button" type="primary" :loading="restoring" @click="restore">Restore draft with Passkey</ElButton>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.inventory, .inventory-list { display: grid; gap: var(--fsus-space-2); overflow-wrap: anywhere; }
.inventory-actions { display: flex; gap: var(--fsus-space-2); flex-wrap: wrap; align-items: center; }
.inventory-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
