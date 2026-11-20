<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElDialog, ElInput } from '@ozwasyd/element-plus'
import { commentAuthorEditDetail, editOwnComment } from '../../../Contracts/comment-author'
import { comments, type CommentContext, type CommentNode, type CommentRoot } from '../../../Contracts/comment-read'
import { ApiError } from '../../../Contracts/client'
import CommentBranch from './CommentBranch.vue'
import CommentReportDialog from './CommentReportDialog.vue'
import PublicCommentComposer from './PublicCommentComposer.vue'
import { currentSession, identityEpoch } from '../session'
import { canOpenCommentEditor, commentAuthorDelete, commentAuthorEdit, commentReply, commentReport, useCommentAuthorEligibility,
  useCommentReportingAvailability } from './commentAuthorActions'

const props = defineProps<{ articleId: number; publication: bigint }>()
const route = useRoute()
const roots = shallowRef<CommentRoot[]>([])
const linked = shallowRef<CommentContext | null>()
const target = ref<string>()
const next = ref<string | null>(null)
const permalinkNodes = computed(() => {
  if (!linked.value) return []
  const window = [...linked.value.siblings, linked.value.target]
  window.sort((left, right) => left.id.length - right.id.length || (left.id > right.id ? 1 : -1))
  return [...linked.value.ancestors, ...window]
})
const loading = ref(false)
const failed = ref(false)
const restart = ref(0)
const commentTitle = ref<HTMLElement>()
const composer = ref<HTMLElement>()
const writeEnabled = ref(false)
const replyAvailable = ref(false)
const replyTarget = shallowRef<{ id: string; name: string }>()
const reportTarget = ref<string>()
const reportingAvailable = useCommentReportingAvailability()
let request: AbortController | undefined
const mutationNotice = ref<MessageKey | ''>('')
const editTarget = shallowRef<{ id: string; session: string }>()
const editDetail = shallowRef<Awaited<ReturnType<typeof commentAuthorEditDetail>>>()
const editBody = ref('')
const editPending = ref(false)
const editProblem = ref<MessageKey | ''>('')
const editContent = computed(() => editBody.value.trim())
const editReady = computed(() => !!editDetail.value && !editPending.value && !editProblem.value &&
  editContent.value.length > 0 && editContent.value.length <= 1000 && editContent.value !== editDetail.value.body)
let editAction: AbortController | undefined
watch([identityEpoch, () => props.articleId, () => props.publication], () => { mutationNotice.value = '' })
watch([identityEpoch, () => props.publication, () => route.hash], () => { replyTarget.value = undefined }, { flush: 'sync' })
watch([identityEpoch, () => currentSession.value?.siteSessionId, () => props.articleId, () => props.publication,
  () => route.fullPath], () => { closeEditor(); reportTarget.value = undefined }, { flush: 'sync' })
const visibleNodes = computed(() => linked.value ? permalinkNodes.value : roots.value.flatMap(root => [root.node, ...root.preview]))
const authorActions = useCommentAuthorEligibility(() => props.articleId, visibleNodes)

provide(commentReply, {
  available: replyAvailable,
  start(node) {
    if (!replyAvailable.value || node.deleted) return
    replyTarget.value = { id: node.id, name: node.author.displayName }
    void nextTick(() => composer.value?.focus())
  },
})

provide(commentAuthorDelete, id => { void refreshAfterMutation(id, 'comment.deleted') })
provide(commentAuthorEdit, node => { void openEditor(node) })
provide(commentReport, {
  available: reportingAvailable,
  start(node) {
    if (reportingAvailable.value && !node.deleted) reportTarget.value = node.id
  },
})

async function refreshAfterMutation(id: string, message: MessageKey) {
  const epoch = identityEpoch.value
  if (replyTarget.value?.id === id) replyTarget.value = undefined
  mutationNotice.value = message
  restart.value++
  await nextTick()
  if (identityEpoch.value === epoch && (route.hash === `#comment-${id}` || document.activeElement === document.body))
    commentTitle.value?.focus()
}

onBeforeUnmount(() => {
  request?.abort()
  closeEditor()
})

function closeEditor() {
  editAction?.abort()
  editAction = undefined
  editTarget.value = undefined
  editDetail.value = undefined
  editBody.value = ''
  editPending.value = false
  editProblem.value = ''
}

function dismissEditor(done: () => void) {
  closeEditor()
  done()
}

async function openEditor(node: CommentNode) {
  const session = currentSession.value
  if (editTarget.value || !canOpenCommentEditor(node) || !session?.siteSessionId || session.expiresAt <= Date.now()) return
  const controller = new AbortController()
  editAction = controller
  const target = { id: node.id, session: session.siteSessionId }
  editTarget.value = target
  editPending.value = true
  try {
    const detail = await commentAuthorEditDetail(target.id, target.session, controller.signal)
    if (controller.signal.aborted) return
    if (detail.articleId !== props.articleId || detail.publication !== props.publication) {
      editProblem.value = 'comment.articleChanged'
      return
    }
    editDetail.value = detail
    editBody.value = detail.body
  } catch {
    if (!controller.signal.aborted) editProblem.value = 'comment.editOpenFailed'
  } finally {
    if (editAction === controller) {
      editAction = undefined
      editPending.value = false
    }
  }
}

async function saveEdit() {
  const target = editTarget.value
  const detail = editDetail.value
  const session = currentSession.value
  if (!editReady.value || !target || !detail || !session || session.siteSessionId !== target.session || session.expiresAt <= Date.now()) return
  const controller = new AbortController()
  editAction = controller
  editPending.value = true
  try {
    await editOwnComment(target.id, detail.currentVersion, editContent.value, target.session, controller.signal)
    if (controller.signal.aborted) return
    closeEditor()
    await refreshAfterMutation(target.id, 'comment.editSubmitted')
  } catch (error) {
    if (!controller.signal.aborted)
      editProblem.value = error instanceof ApiError && error.status === 409
        ? 'comment.editChanged'
        : 'comment.editUnconfirmed'
  } finally {
    if (editAction === controller) {
      editAction = undefined
      editPending.value = false
    }
  }
}

async function load(follow: boolean, hash?: string) {
  if (follow && request) return
  if (!follow) {
    request?.abort()
    roots.value = []
    linked.value = undefined
    writeEnabled.value = false
    target.value = hash?.match(/^#comment-([1-9][0-9]{0,18})$/)?.[1]
    next.value = null
  }
  const controller = new AbortController()
  request = controller
  loading.value = true
  failed.value = false
  try {
    if (!follow && target.value) {
      const permalink = await comments.context(props.articleId, target.value, controller.signal)
      if (controller.signal.aborted) return
      writeEnabled.value = permalink.writeEnabled
      linked.value = permalink.context
      if (permalink.context) {
        await nextTick()
        if (!controller.signal.aborted) document.getElementById(`comment-${permalink.context.target.id}`)?.focus()
        return
      }
    }
    const page = await comments.roots(props.articleId, follow ? next.value : null, controller.signal)
    if (!controller.signal.aborted) {
      writeEnabled.value = page.writeEnabled
      const existing = new Set(roots.value.map(root => root.node.id))
      roots.value = [...roots.value, ...page.items.filter(root => !existing.has(root.node.id))]
      next.value = page.cursor
    }
  } catch {
    if (!controller.signal.aborted) failed.value = true
  } finally {
    if (!controller.signal.aborted) {
      loading.value = false
      request = undefined
    }
  }
}

watch([() => props.articleId, () => props.publication, () => route.hash, restart], ([, , hash]) => void load(false, hash), { immediate: true })
</script>

<template>
  <section class="article-comments" aria-labelledby="article-comments-title">
    <h2 id="article-comments-title" ref="commentTitle" tabindex="-1">{{ t('comment.heading') }}</h2>
    <p v-if="mutationNotice" role="status">{{ t(mutationNotice) }}</p>
    <p v-if="linked === null" role="status">{{ t('comment.unavailable') }}</p>
    <p v-if="loading" role="status">{{ t('comment.loading') }}</p>
    <template v-if="linked">
      <ol class="comment-roots">
        <CommentBranch v-for="node in permalinkNodes"
          :key="node.id" :article-id="articleId" :node="node" :target="target" :can-delete="authorActions.deletable.has(node.id)"
          :can-edit="authorActions.editable.has(node.id)"
          :thread-open="node.depth === 0 || linked.ancestors.some(root => root.id === node.rootId && !root.deleted)" context-only />
      </ol>
      <RouterLink :to="{ hash: '#article-comments-title' }">{{ t('comment.all') }}</RouterLink>
    </template>
    <ol v-else-if="roots.length" class="comment-roots">
      <CommentBranch v-for="root in roots" :key="root.node.id" :article-id="articleId" :node="root.node" :preview="root.preview"
        :can-delete="authorActions.deletable.has(root.node.id)" :preview-deletions="authorActions.deletable"
        :can-edit="authorActions.editable.has(root.node.id)" :preview-edits="authorActions.editable" :thread-open="!root.node.deleted" />
    </ol>
    <p v-else-if="!loading && !failed" class="muted">{{ t('comment.empty') }}</p>
    <ElAlert v-if="failed" type="error" :title="t('comment.loadFailed')" :closable="false" />
    <ElButton v-if="failed" text @click="roots.length && next ? load(true) : restart++">{{ t('comment.retry') }}</ElButton>
    <ElButton v-else-if="next && !loading" text @click="load(true)">{{ t('comment.more') }}</ElButton>
    <ElDialog :model-value="!!editTarget" :title="t('comment.editTitle')" append-to-body destroy-on-close
      :close-on-click-modal="false" :before-close="dismissEditor" width="min(calc(100vw - 2rem), 36rem)">
      <p v-if="editPending" role="status">{{ editDetail ? t('comment.editSaving') : t('comment.loadingOne') }}</p>
      <template v-if="editDetail">
        <p>{{ t('comment.editReviewNotice') }}</p>
        <ElInput v-model="editBody" type="textarea" :label="t('comment.editedInput')" v-bind="{ rows: 5, maxlength: 1000 }"
          :disabled="editPending" :readonly="!!editProblem" />
      </template>
      <ElAlert v-if="editProblem" :title="t(editProblem)" type="error" :closable="false" />
      <template #footer>
        <ElButton native-type="button" @click="closeEditor">{{ editProblem ? t('comment.close') : t('comment.cancel') }}</ElButton>
        <ElButton v-if="editDetail && !editProblem" native-type="button" type="primary" :disabled="!editReady"
          :loading="editPending" @click="saveEdit">{{ t('comment.saveReview') }}</ElButton>
      </template>
    </ElDialog>
    <CommentReportDialog :article-id="articleId" :comment-id="reportTarget" @close="reportTarget = undefined" />
    <div v-if="publication" ref="composer" tabindex="-1">
      <PublicCommentComposer :article-id="articleId" :publication="publication" :write-enabled="writeEnabled" :reply="replyTarget"
        @availability="value => replyAvailable = value" @cancel="replyTarget = undefined" />
    </div>
  </section>
</template>

<style scoped>
.article-comments { border-block-start: 1px solid var(--el-border-color-light); margin-block-start: 2rem; padding-block-start: 1rem; }
.comment-roots { list-style: none; padding: 0; margin: 0; }
</style>
