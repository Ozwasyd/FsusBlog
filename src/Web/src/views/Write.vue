<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter, type RouteLocationNormalized } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElMarkdownEditor, ElMessageBox } from '@ozwasyd/element-plus'
import { api, ApiError, type Draft } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import { assignTaxonomy, type TaxonomySelection } from '../../../Contracts/taxonomy-client'
import { rollbackDraft } from '../../../Contracts/revision-history'
import { setArticleSchedule } from '../../../Contracts/article-schedule'
import ArticleTaxonomy from './ArticleTaxonomy.vue'
import ArticleProperties from './ArticleProperties.vue'
import WorkspaceTabs from '../authoring/WorkspaceTabs.vue'
import EditorInspector from '../authoring/EditorInspector.vue'
import RevisionHistory from '../authoring/RevisionHistory.vue'
import ArticleSchedule from '../authoring/ArticleSchedule.vue'
import MarkdownExportControl from '../authoring/MarkdownExportControl.vue'
import { editorRecovery } from '../authoring/editorRecovery'
import type { RecoveryCandidate } from '../authoring/draftJournal'
import { currentSession, identityEpoch, invalidateSession, refreshSession } from '../session'
import {
  WorkspaceRegistry,
  type DraftSave,
  type Activation,
  type RecentlyClosed,
  type WorkspaceBlock,
  type WorkspaceTab,
} from '../authoring/workspaceRegistry'

type ArticleAction = 'save' | 'publish' | 'retract'
type Action = ArticleAction | 'assign-taxonomy' | 'rollback-history' | 'schedule-publication'
type RestoreSelection = { sourceRevision: bigint; reason: string }
const route = useRoute()
const router = useRouter()
const nativeMarkdown = import.meta.env.FSUS_MARKDOWN_NATIVE
function articleRoute(location: Pick<RouteLocationNormalized, 'name' | 'params'>) {
  if (location.name === 'write') return 0
  if (location.name === 'edit') return Number(location.params.id)
  return undefined
}
const id = computed(() => articleRoute(route))
const workspaceTabs = shallowRef<readonly WorkspaceTab[]>([])
const recentlyClosed = shallowRef<readonly RecentlyClosed[]>([])
const tabsControl = ref<InstanceType<typeof WorkspaceTabs>>()
const articleInput = ref<InstanceType<typeof ElInput>>()
const openInput = ref('')
const navigationNotice = ref('')
const opening = ref(false)
let navigation = 0
let recoveryGroup: { group: string; mode: WorkspaceTab['mode']; path: string } | undefined
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
const selectedPanelTitle = computed(() => tab.value?.title ? `Article content – ${tab.value.title}` : 'Article content')
const articleDirty = computed(() => tab.value?.risk === 'dirty' || tab.value?.risk === 'conflict')
const dirty = computed(() => articleDirty.value || taxonomyDirty.value)
const hasConflict = computed(() => taxonomyStale.value || tab.value?.risk === 'conflict')
const articlePending = computed(() => tab.value?.risk === 'saving')
const pending = computed(() => articlePending.value || propertyPending.value)
const canSwitch = computed(() => !propertyPending.value && !taxonomyDirty.value && !recoveryWorking.value &&
  !(articlePending.value && tab.value?.articleId === 0))
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
const documentIdentity = computed(() => tab.value
  ? { id: `blog-editor-${tab.value.sessionId}-${tab.value.articleId}`, epoch: tab.value.sessionId } : undefined)

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

const restoreRevision = (selection: RestoreSelection) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(() => rollbackDraft({
    id: draft.id, expectedRevision: draft.revision, idempotencyKey, ...selection,
  }, signal), signal)

const updateSchedule = (dueUnixMs: bigint) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(async () => {
    const result = await setArticleSchedule({
      id: draft.id, expectedRevision: draft.revision, idempotencyKey, dueUnixMs,
    }, signal)
    return { ...draft, revision: result.revision, published: result.publishedRevision !== 0n }
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
  workspaceTabs.value = registry.tabs
  recentlyClosed.value = registry.recentlyClosed
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
watch(identityEpoch, () => {
  ++navigation
  opening.value = false
  navigationNotice.value = ''
})

watch([id, identityEpoch, authorizationReady, reload], async ([articleId, identity], _, cleanup) => {
  let valid = true
  cleanup(() => { valid = false })
  if (!authorizationReady.value || !currentSession.value?.canAuthor) {
    opening.value = false
    loading.value = false
    return
  }
  if (articleId === undefined) {
    registry.idle()
    loading.value = false
    return
  }
  if (original.value?.id === articleId) {
    loading.value = false
    return
  }
  loading.value = true
  failure.value = ''
  notice.value = ''
  const result = await activateArticle(articleId)
  if (!valid || identity !== identityEpoch.value) return
  loading.value = false
  if (result.kind !== 'ready') failure.value = activationFailure(result)
}, { immediate: true })

function activateArticle(articleId: number, restore?: { group: string; mode: WorkspaceTab['mode'] }, ready?: () => boolean) {
  return articleId === 0
    ? registry.startDraft({ id: 0, revision: 0n, title: '', body: '', published: false })
    : registry.openOrActivate(articleId, restore?.group, restore?.mode, ready)
}

function activationFailure(receipt: Activation): string {
  if (receipt.kind === 'blocked') return failureByReason[receipt.reason]
  if (receipt.kind === 'capacity') return 'This workspace has 100 open articles. Close a tab before opening another.'
  return ''
}

onBeforeRouteUpdate(async (to, from) => {
  if (to.path === from.path || !authorizationReady.value || !currentSession.value?.canAuthor) return true
  const intent = ++navigation
  registry.cancelOpening()
  opening.value = false
  if (!canSwitch.value) {
    navigationNotice.value = 'Apply or cancel the pending changes before switching articles.'
    return false
  }
  const articleId = articleRoute(to)
  navigationNotice.value = ''
  if (articleId === undefined) return true
  // A successful creation already has a verified persisted revision in the same session.
  if (articleId === tab.value?.articleId) return true
  const epoch = identityEpoch.value
  opening.value = true
  const restore = recoveryGroup?.path === to.path ? recoveryGroup : undefined
  const result = await activateArticle(articleId, restore,
    () => intent === navigation && epoch === identityEpoch.value && canSwitch.value && !lifetime.signal.aborted)
  if (intent !== navigation || epoch !== identityEpoch.value || lifetime.signal.aborted) return false
  opening.value = false
  navigationNotice.value = result.kind === 'superseded' && !canSwitch.value
    ? 'Apply or cancel the pending changes before switching articles.' : activationFailure(result)
  if (result.kind === 'ready') {
    notice.value = ''
    failure.value = result.tab.risk === 'conflict' ? 'The server has a newer revision. Copy your changes before loading it.' : ''
  }
  return result.kind === 'ready'
})

function address(articleId: number) {
  return articleId === 0 ? { name: 'write' } : { name: 'edit', params: { id: articleId } }
}

async function navigateTo(articleId: number, restore?: RecentlyClosed) {
  if (!canSwitch.value) return
  const destination = address(articleId)
  const intent = restore && { group: restore.group, mode: restore.mode, path: router.resolve(destination).path }
  recoveryGroup = intent
  try { await router.push(destination) }
  finally { if (recoveryGroup === intent) recoveryGroup = undefined }
}

function openArticle() {
  const articleId = inputArticle.value
  if (articleId === undefined) {
    navigationNotice.value = 'Enter a valid article ID.'
    return
  }
  void navigateTo(articleId)
}

const openAddress = computed(() => {
  const articleId = inputArticle.value
  return articleId === undefined ? undefined : address(articleId)
})
const inputArticle = computed(() => {
  const input = openInput.value.trim()
  const articleId = Number(input)
  return /^[1-9][0-9]{0,9}$/.test(input) && articleId <= 2_147_483_647
    ? articleId : undefined
})

function togglePin(target: WorkspaceTab) {
  if (target.mode === 'preview') registry.pin(target)
  else if (!registry.unpin(target)) navigationNotice.value = 'Save changes and close the current preview before unpinning this tab.'
}

async function closeTab(target: WorkspaceTab) {
  if (target.active && !canSwitch.value) {
    navigationNotice.value = 'Apply or cancel the pending changes before closing this tab.'
    return
  }
  const focused = document.activeElement
  const before = registry.revision
  const edit = registry.editSequence(target)
  navigationNotice.value = ''
  const ready = registry.requestClose(target)
  if (ready.kind === 'stale') return
  if (ready.kind === 'protected') {
    if (target.retry || target.risk === 'saving' || target.risk === 'pending' || target.risk === 'recovery') {
      navigationNotice.value = 'Resolve the pending changes before closing this tab.'
      return
    }
    try {
      const result = await ElMessageBox.confirm(`Discard changes to ${target.title} and close its tab?`, 'Close article tab?', {
        type: 'warning', confirmButtonText: 'Discard changes', cancelButtonText: 'Keep writing', closeOnClickModal: false,
      })
      if (!result.ok || registry.discard(target, before).kind !== 'closed') {
        if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
        return
      }
      if (edit !== undefined) await recovery.discardArticle(target.articleId, target.sessionId, edit)
    } catch {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
      return
    }
  }
  if (target.active) {
    const next = workspaceTabs.value.find(candidate => candidate.risk !== 'blocked' && candidate.risk !== 'saving')
    const rejected = await router.replace(next ? address(next.articleId) : { name: 'article-workspace' })
    if (rejected && !registry.activeTab) await router.replace({ name: 'article-workspace' })
  }
  await nextTick()
  if (registry.activeTab) tabsControl.value?.focusActive()
  else articleInput.value?.focus()
}

function onUnload(event: BeforeUnloadEvent) {
  if (dirty.value || pending.value || retry.value || workspaceTabs.value.some(item => item.risk !== 'clean' && item.risk !== 'blocked')) event.preventDefault()
}

async function allowLeave(allTabs = false) {
  if (propertyPending.value) return false
  const candidates = (allTabs ? workspaceTabs.value : tab.value ? [tab.value] : [])
    .filter(item => item.risk !== 'clean' || item.active && taxonomyDirty.value)
  if (!candidates.length) return true
  if (candidates.some(item => item.risk === 'saving' || item.risk === 'pending' || item.retry)) return false
  const plan = registry.planClose(candidates)
  if (!plan) return false
  const edits = candidates.map(item => ({ item, sequence: registry.editSequence(item) }))
  try {
    const message = candidates.length === 1
      ? 'Your changes will be lost if you leave this page.'
      : `Unsaved changes in ${candidates.map(item => item.title).join(', ')} will be discarded.`
    const outcome = await ElMessageBox.confirm(message, 'Discard unsaved changes?', {
      type: 'warning',
      confirmButtonText: 'Discard changes',
      cancelButtonText: 'Keep writing',
      closeOnClickModal: false,
    })
    if (!outcome.ok || registry.discardMany(plan).kind !== 'closed') return false
    await Promise.all(edits.map(({ item, sequence }) => sequence === undefined ? undefined
      : recovery.discardArticle(item.articleId, item.sessionId, sequence)))
    return true
  } catch {
    return false
  }
}
onBeforeRouteLeave(() => {
  ++navigation
  registry.cancelOpening()
  opening.value = false
  return allowLeave(true)
})

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

async function submit(action: Action, selection?: TaxonomySelection, restore?: RestoreSelection, due?: bigint) {
  const current = tab.value
  const document = original.value
  if (!current || !document || !editable.value || pending.value || recoveryBlocked.value) return
  if (current.retry) {
    if (action !== current.retry) return
  } else if (action === 'assign-taxonomy') {
    if (!selection || current.risk !== 'clean' || taxonomyStale.value || !taxonomyDirty.value) return
  } else if (action === 'rollback-history') {
    if (!restore || current.risk !== 'clean' || cannotWrite.value) return
  } else if (action === 'schedule-publication') {
    if (due === undefined || current.risk !== 'clean' || cannotWrite.value) return
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
        : action === 'assign-taxonomy' && selection
          ? registry.commit(current, action, saveTaxonomy(selection))
          : action === 'rollback-history' && restore
            ? registry.commit(current, action, restoreRevision(restore))
            : action === 'schedule-publication' && due !== undefined
              ? registry.commit(current, action, updateSchedule(due)) : undefined
  if (!requested) return
  const result = await requested
  if (lifetime.signal.aborted || identity !== identityEpoch.value || id.value !== current.articleId) return
  if (result.kind === 'saved') {
    notice.value = {
      save: 'Draft saved.', publish: 'Article published.', retract: 'Article withdrawn.',
      'assign-taxonomy': 'Classification saved.', 'rollback-history': 'Revision restored to a new draft.',
      'schedule-publication': 'Publication schedule updated.',
    }[action]
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
        <RouterLink v-if="currentSession?.canAuthor" class="canvas-entry" to="/user/manage/canvas">Canvases</RouterLink>
        <h1>{{ id === undefined ? 'Article workspace' : id === 0 ? 'New article' : 'Edit article' }}</h1>
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
    <section v-if="authorizationReady && currentSession?.canAuthor" class="workspace-actions" aria-label="Article workspace">
      <WorkspaceTabs ref="tabsControl" :tabs="workspaceTabs" :disabled="!canSwitch"
        @activate="navigateTo($event.articleId)" @pin="togglePin" @close="closeTab" />
      <form class="workspace-open" @submit.prevent="openArticle">
        <label for="workspace-article-id">Article ID</label>
        <ElInput id="workspace-article-id" ref="articleInput" v-model="openInput" class="workspace-open-field"
          :disabled="!canSwitch" />
        <ElButton native-type="submit" :disabled="!canSwitch">Open article</ElButton>
        <RouterLink v-if="openAddress" :to="openAddress" target="_blank" rel="noopener">Open in browser tab</RouterLink>
        <RouterLink :to="{ name: 'write' }">New draft</RouterLink>
      </form>
      <details v-if="recentlyClosed.length">
        <summary>Recently closed</summary>
        <ul>
          <li v-for="item in recentlyClosed" :key="item.articleId">
            <ElButton text native-type="button" :disabled="!canSwitch" @click="navigateTo(item.articleId, item)">
              Reopen {{ item.title }}
            </ElButton>
          </li>
        </ul>
      </details>
      <p v-if="opening" role="status">Opening article…</p>
      <p v-if="navigationNotice" role="alert">{{ navigationNotice }}</p>
    </section>
    <p v-if="!authorizationReady || loading" role="status">Opening the editor…</p>
    <template v-else-if="!currentSession?.canAuthor">
      <ElAlert :title="failure || 'Log in with an author account to write an article.'" type="info" :closable="false" />
      <p><RouterLink :to="{ name: 'login' }">Log in</RouterLink></p>
    </template>
    <p v-else-if="id === undefined" role="status">Open an article or start a new draft.</p>
    <template v-else-if="!editable">
      <ElAlert :title="failure" type="error" :closable="false" />
      <ElButton class="retry" @click="reload++">Retry</ElButton>
    </template>
    <section v-else id="workspace-editor" class="editor-document" role="tabpanel" :aria-label="selectedPanelTitle">
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
        :document-identity="documentIdentity"
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
      <EditorInspector v-if="original && original.id > 0">
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" />
        <ArticleTaxonomy
          :article-id="original.id"
          :revision="original.revision"
          :identity="identityEpoch"
          :disabled="articleDirty || pending || recoveryBlocked || !!retry || hasConflict"
          @change="taxonomyDirty = $event"
          @save="submit('assign-taxonomy', $event)"
          @stale="taxonomyStale = true"
        />
        <ArticleProperties
          :article-id="original.id"
          :revision="original.revision"
          :identity="identityEpoch"
          :disabled="articleDirty || taxonomyDirty || articlePending || recoveryBlocked || !!retry || hasConflict"
          @pending="propertyPending = $event"
        />
        <RevisionHistory
          :key="identityEpoch"
          :article-id="original.id"
          :revision="original.revision"
          :can-rollback="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @restore="submit('rollback-history', undefined, $event)"
        />
        <ArticleSchedule
          :key="`schedule-${identityEpoch}`"
          :article-id="original.id"
          :revision="original.revision"
          :can-change="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @schedule="submit('schedule-publication', undefined, undefined, $event)"
        />
      </EditorInspector>
    </section>
  </main>
</template>

<style scoped>
.canvas-entry { margin-inline-start: .75rem; }
.workspace-actions {
  margin-block: .75rem 1rem;
}
.workspace-open {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  margin-block: .5rem;
}
.workspace-open-field {
  max-inline-size: min(100%, 12rem);
}
.workspace-actions summary {
  cursor: pointer;
}
</style>
