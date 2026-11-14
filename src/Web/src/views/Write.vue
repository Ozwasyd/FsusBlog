<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElMarkdownEditor, ElMessageBox } from '@ozwasyd/element-plus'
import { api, ApiError, type Draft } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import { assignTaxonomy, type TaxonomySelection } from '../../../Contracts/taxonomy-client'
import ArticleTaxonomy from './ArticleTaxonomy.vue'
import ArticleProperties from './ArticleProperties.vue'
import { editorRecovery } from '../authoring/editorRecovery'
import type { RecoveryCandidate } from '../authoring/draftJournal'
import { currentSession, identityEpoch, invalidateSession, refreshSession } from '../session'
import {
  WorkspaceRegistry,
  type DraftSave,
  type WorkspaceBlock,
  type WorkspaceTab,
} from '../authoring/workspaceRegistry'

type ArticleAction = 'save' | 'publish' | 'retract'
type Action = ArticleAction | 'assign-taxonomy'
const route = useRoute()
const router = useRouter()
const nativeMarkdown = import.meta.env.FSUS_MARKDOWN_NATIVE
const id = computed(() => route.name === 'write' ? 0 : Number(route.params.id))
const notice = ref('')
const taxonomyDirty = ref(false)
const taxonomyStale = ref(false)
const propertyPending = ref(false)
const recovery = editorRecovery()
const recoveryItems = recovery.candidates
const recoveryFailure = recovery.failure
const recoveryWorking = ref(false)
const recoveryBlocked = computed(() => recoveryWorking.value || recovery.guarded.value || recoveryItems.value.length > 0)
const failure = ref('')
const authorizationReady = ref(false)
const loading = ref(false)
const reload = ref(0)
const lifetime = new AbortController()
const original = shallowRef<Draft>()
const tab = shallowRef<WorkspaceTab>()
const articleDirty = computed(() => tab.value?.risk === 'dirty' || tab.value?.risk === 'conflict')
const dirty = computed(() => articleDirty.value || taxonomyDirty.value)
const hasConflict = computed(() => taxonomyStale.value || tab.value?.risk === 'conflict')
const articlePending = computed(() => tab.value?.risk === 'saving')
const pending = computed(() => articlePending.value || propertyPending.value)
const retry = computed(() => tab.value?.retry)
const encoder = new TextEncoder()
const titleLength = computed(() => encoder.encode(original.value?.title.trim() ?? '').length)
const validTitle = computed(() => titleLength.value > 0 && titleLength.value <= WireLimits.TitleBytes
  && !/[\x00-\x1f\x7f-\x9f]/.test(original.value?.title.trim() ?? ''))
const validBody = computed(() => {
  const body = original.value?.body ?? ''
  return body.length <= 200_000 && !body.includes('\0') && encoder.encode(body).length <= WireLimits.BodyBytes
})
const editable = computed(() => Boolean(currentSession.value?.canAuthor && original.value?.id === id.value && !loading.value))
const cannotWrite = computed(() => pending.value || recoveryBlocked.value || hasConflict.value || taxonomyDirty.value || !validBody.value || !validTitle.value)
const publishedPath = computed(() => original.value?.published ? `/article/${original.value.id}` : '')

const failureByReason: Record<WorkspaceBlock, string> = {
  missing: 'The article is unavailable.',
  deleted: 'The article is unavailable.',
  forbidden: 'You can no longer edit this article.',
  expired: 'Log in again to continue writing.',
  unavailable: 'The server could not confirm this change. Try again.',
}

function workspaceBlock(error: unknown): WorkspaceBlock {
  if (!(error instanceof ApiError)) return 'unavailable'
  if (error.status === 401) {
    invalidateSession()
    return 'expired'
  }
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'missing'
  return 'unavailable'
}

async function mutationResult(operation: () => Promise<Draft>, signal: AbortSignal): Promise<DraftSave<Draft>> {
  try {
    return { kind: 'saved', draft: await operation() }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 409) return { kind: 'conflict' }
      if (error.status === 400) return { kind: 'rejected' }
    }
    return { kind: 'blocked', reason: signal.aborted ? 'unavailable' : workspaceBlock(error) }
  }
}

const send = (action: ArticleAction) => (draft: Draft, signal: AbortSignal, idempotencyKey: string): Promise<DraftSave<Draft>> =>
  mutationResult(() => api[action]({
    id: draft.id,
    expectedRevision: draft.revision,
    title: action === 'save' ? draft.title.trim() : '',
    body: action === 'save' ? draft.body : '',
    idempotencyKey,
  }, signal), signal)

const saveTaxonomy = (selection: TaxonomySelection) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(async () => {
    const stored = await assignTaxonomy({
      id: draft.id, expectedRevision: draft.revision, idempotencyKey,
      categoryId: selection.categoryId, tagIds: selection.tagIds.slice(),
    }, signal)
    return { ...draft, id: stored.id, revision: stored.revision }
  }, signal)

const registry = new WorkspaceRegistry<Draft>({
  async load(articleId, signal) {
    try {
      return { kind: 'ready', draft: await api.draft(articleId, signal) }
    } catch (error) {
      return { kind: 'blocked', reason: signal.aborted ? 'unavailable' : workspaceBlock(error) }
    }
  },
  save: send('save'),
  confirmed: recovery.confirmed,
})
const unsubscribe = registry.subscribe(() => {
  const next = registry.activeDraft
  if (next?.id !== original.value?.id || next?.revision !== original.value?.revision) {
    taxonomyDirty.value = false
    taxonomyStale.value = false
  }
  original.value = next
  tab.value = registry.activeTab
  recovery.setCurrent(tab.value, next, registry.activeEditSequence)
})
watch([currentSession, identityEpoch], ([session, epoch]) => {
  registry.setIdentity(session?.canAuthor
    ? { site: location.origin, principalId: String(epoch), generation: session.generation, expiresAt: session.expiresAt }
    : null)
}, { immediate: true, flush: 'sync' })
watch([identityEpoch, () => currentSession.value?.canAuthor], ([epoch, author]) => {
  if (!author) recovery.close()
  else void recovery.attach(epoch, () => identityEpoch.value === epoch && currentSession.value?.canAuthor === true)
}, { immediate: true, flush: 'post' })

onMounted(() => {
  void refreshSession(lifetime.signal).catch(() => {
    if (!lifetime.signal.aborted) failure.value = 'Could not verify your session.'
  }).finally(() => {
    if (!lifetime.signal.aborted) authorizationReady.value = true
  })
  window.addEventListener('beforeunload', onUnload)
})
onUnmounted(() => {
  lifetime.abort()
  recovery.close()
  registry.setIdentity(null)
  unsubscribe()
  window.removeEventListener('beforeunload', onUnload)
})

watch([id, identityEpoch, authorizationReady, reload], async ([articleId, identity], _, cleanup) => {
  let valid = true
  cleanup(() => { valid = false })
  if (!authorizationReady.value || !currentSession.value?.canAuthor) {
    loading.value = false
    return
  }
  const alreadyActive = original.value?.id === articleId
  loading.value = !alreadyActive
  if (!alreadyActive) {
    failure.value = ''
    notice.value = ''
  }
  const result = await (articleId === 0
    ? registry.startDraft({ id: 0, revision: 0n, title: '', body: '', published: false })
    : registry.openOrActivate(articleId))
  if (!valid || identity !== identityEpoch.value) return
  loading.value = false
  if (result.kind === 'blocked') failure.value = failureByReason[result.reason]
  if (result.kind === 'capacity') failure.value = 'Close an open draft before opening this article.'
}, { immediate: true })

function onUnload(event: BeforeUnloadEvent) {
  if (dirty.value || pending.value || retry.value) event.preventDefault()
}

async function allowLeave() {
  if (propertyPending.value) return false
  const current = tab.value
  if (!current || current.risk === 'clean' && !taxonomyDirty.value) return true
  if (current.risk === 'saving' || current.risk === 'pending' || current.retry) return false
  const revision = registry.revision
  const edit = registry.activeEditSequence
  try {
    const outcome = await ElMessageBox.confirm('Your changes will be lost if you leave this page.', 'Discard unsaved changes?', {
      type: 'warning',
      confirmButtonText: 'Discard changes',
      cancelButtonText: 'Keep writing',
      closeOnClickModal: false,
    })
    if (!outcome.ok || registry.discard(current, revision).kind !== 'closed') return false
    await recovery.discardArticle(current.articleId, current.sessionId, edit)
    return true
  } catch {
    return false
  }
}
onBeforeRouteLeave(allowLeave)
onBeforeRouteUpdate((to, from) => to.path === from.path || allowLeave())

function edit(field: 'title' | 'body', value: string) {
  const document = original.value
  const current = tab.value
  if (editable.value && !recoveryBlocked.value && !taxonomyDirty.value && !propertyPending.value
      && current && document && document[field] !== value) {
    const next = { ...document, [field]: value }
    if (registry.updateDraft(current, next)) recovery.persist(next, registry.activeEditSequence)
  }
}

async function restoreDraft(candidate: RecoveryCandidate) {
  const current = tab.value
  const document = original.value
  if (!current || !document || current.risk !== 'clean' || pending.value || recoveryWorking.value ||
      !recoveryItems.value.includes(candidate)) return
  const restored = { ...document, title: candidate.title, body: candidate.body }
  recoveryWorking.value = true
  try {
    if (registry.updateDraft(current, restored)) {
      if (!await recovery.remove(candidate, { draft: restored, edit: registry.activeEditSequence })) {
        recovery.dismissCandidates()
      }
    }
  } finally {
    recoveryWorking.value = false
  }
}

async function submit(action: Action, selection?: TaxonomySelection) {
  const current = tab.value
  const document = original.value
  if (!current || !document || !editable.value || pending.value || recoveryBlocked.value) return
  if (current.retry) {
    if (action !== current.retry) return
  } else if (action === 'assign-taxonomy') {
    if (!selection || current.risk !== 'clean' || taxonomyStale.value || !taxonomyDirty.value) return
  } else if (cannotWrite.value || action === 'publish' && !document.body.trim()) {
    return
  }

  failure.value = ''
  notice.value = ''
  const identity = identityEpoch.value
  const requested = current.retry
    ? registry.retry(current)
    : action === 'save'
      ? registry.save(current)
      : action === 'publish' || action === 'retract'
        ? registry.commit(current, action, send(action))
        : selection && registry.commit(current, action, saveTaxonomy(selection))
  if (!requested) return
  const result = await requested
  if (lifetime.signal.aborted || identity !== identityEpoch.value || id.value !== current.articleId) return
  if (result.kind === 'saved') {
    notice.value = { save: 'Draft saved.', publish: 'Article published.', retract: 'Article withdrawn.', 'assign-taxonomy': 'Classification saved.' }[action]
    if (!document.id) await router.replace({ name: 'edit', params: { id: result.articleId } })
  } else if (result.kind === 'conflict') {
    failure.value = 'The server has a newer revision. Copy your changes before loading it.'
  } else if (result.kind === 'blocked') {
    failure.value = failureByReason[result.reason]
  } else if (result.kind === 'rejected') {
    failure.value = 'The server rejected this change. Check the draft and try again.'
  }
}

async function reloadDraft() {
  if (!await allowLeave()) return
  const current = tab.value
  if (current) registry.requestClose(current)
  reload.value++
}
</script>

<template>
  <main class="editor-page">
    <header class="editor-header">
      <div>
        <RouterLink class="editor-back" to="/">Back</RouterLink>
        <h1>{{ id === 0 ? 'New article' : 'Edit article' }}</h1>
        <span v-if="editable" class="metadata">{{ original?.published ? 'Published' : 'Draft' }}</span>
      </div>
      <div v-if="editable" class="editor-actions">
        <ElButton v-if="retry" type="primary" :disabled="pending" @click="submit(retry)">Try again</ElButton>
        <ElButton v-else native-type="button" :disabled="cannotWrite || !articleDirty" @click="submit('save')">Save draft</ElButton>
        <ElButton
          v-if="!retry" native-type="button" :type="original?.published ? 'default' : 'primary'"
          :disabled="cannotWrite || dirty || id === 0 || !original?.body.trim()"
          @click="submit('publish')"
        >
          {{ original?.published ? 'Publish revision' : 'Publish article' }}
        </ElButton>
        <ElButton v-if="original?.published && !retry" native-type="button" :disabled="cannotWrite || dirty" @click="submit('retract')">Withdraw</ElButton>
      </div>
    </header>
    <p v-if="!authorizationReady || loading" role="status">Opening the editor…</p>
    <template v-else-if="!currentSession?.canAuthor">
      <ElAlert :title="failure || 'Log in with an author account to write an article.'" type="info" :closable="false" />
      <p><RouterLink :to="{ name: 'login' }">Log in</RouterLink></p>
    </template>
    <template v-else-if="!editable">
      <ElAlert :title="failure" type="error" :closable="false" />
      <ElButton class="retry" @click="reload++">Retry</ElButton>
    </template>
    <section v-else class="editor-document" aria-label="Article content">
      <p v-if="notice" class="write-notice" role="status">
        {{ notice }} <RouterLink v-if="publishedPath" :to="publishedPath">Read the published article</RouterLink>
      </p>
      <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
      <ElButton v-if="hasConflict" class="retry" @click="reloadDraft">Load latest revision</ElButton>
      <label for="article-title">Title</label>
      <ElInput id="article-title" :model-value="original?.title" @update:model-value="edit('title', $event)" placeholder="Write the article title" size="large" :disabled="pending || taxonomyDirty || recoveryBlocked" />
      <p v-if="id === 0 || articleDirty" class="metadata">Save the draft before publishing.</p>
      <p class="metadata">{{ titleLength }} / {{ WireLimits.TitleBytes }} bytes</p>
      <label for="article-body">Body</label>
      <ElMarkdownEditor
        v-if="nativeMarkdown" textarea-id="article-body" :locale-text="{ textarea: { source: 'Body', live: 'Body' } }" :model-value="original?.body" @update:model-value="edit('body', $event)" placeholder="Start writing here."
        :disabled="pending || taxonomyDirty || recoveryBlocked" :show-actions="false"
      />
      <template v-else>
        <ElAlert title="Rich editing unavailable. Edit the original Markdown below." type="info" :closable="false" />
        <ElInput id="article-body" :model-value="original?.body" @update:model-value="edit('body', $event)" type="textarea" :autosize="{ minRows: 14 }" placeholder="Start writing here." :disabled="pending || taxonomyDirty || recoveryBlocked" />
      </template>
      <p v-if="recoveryFailure" role="status">Local draft recovery is unavailable. Save to keep your changes on the server.</p>
      <section v-if="recoveryItems.length" aria-labelledby="draft-recovery-title">
        <h2 id="draft-recovery-title">Recover an unsaved draft</h2>
        <p>Unsaved text is stored in this browser for up to seven days. It is not encrypted.</p>
        <div v-for="item in recoveryItems" :key="`${item.writer}-${item.editSequence}`">
          <h3>{{ item.title || 'Untitled draft' }}</h3>
          <p v-if="item.relationship === 'compare'">This recovery copy and the server draft have different revisions.</p>
          <details>
            <summary>Compare drafts</summary>
            <h4>Server draft</h4><pre>{{ original?.body }}</pre>
            <h4>Recovery copy</h4><pre>{{ item.body }}</pre>
          </details>
          <ElButton native-type="button" :disabled="pending || recoveryWorking || articleDirty" @click="restoreDraft(item)">Restore draft</ElButton>
          <ElButton native-type="button" :disabled="pending || recoveryWorking" @click="recovery.remove(item)">Discard recovery copy</ElButton>
        </div>
      </section>
      <p v-if="!validBody" role="alert">The article exceeds the size limit.</p>
      <ArticleTaxonomy
        v-if="original && original.id > 0"
        :article-id="original.id"
        :revision="original.revision"
        :identity="identityEpoch"
        :disabled="articleDirty || pending || recoveryBlocked || !!retry || hasConflict"
        @change="taxonomyDirty = $event"
        @save="submit('assign-taxonomy', $event)"
        @stale="taxonomyStale = true"
      />
      <ArticleProperties
        v-if="original && original.id > 0"
        :article-id="original.id"
        :revision="original.revision"
        :identity="identityEpoch"
        :disabled="articleDirty || taxonomyDirty || articlePending || recoveryBlocked || !!retry || hasConflict"
        @pending="propertyPending = $event"
      />
    </section>
  </main>
</template>
