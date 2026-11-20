<script setup lang="ts">
import { siteLocale, t, type MessageKey } from '../siteLocale'
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElDialog } from '@ozwasyd/element-plus'
import { comments, type CommentNode } from '../../../Contracts/comment-read'
import { deleteOwnComment } from '../../../Contracts/comment-author'
import { ApiError } from '../../../Contracts/client'
import { currentSession, identityEpoch } from '../session'
import { commentAuthorDelete, commentAuthorEdit, commentReply, commentReport, useCommentAuthorEligibility } from './commentAuthorActions'

const props = defineProps<{
  articleId: number; node: CommentNode; preview?: CommentNode[]; target?: string; contextOnly?: boolean
  canDelete?: boolean; previewDeletions?: ReadonlySet<string>; canEdit?: boolean; previewEdits?: ReadonlySet<string>; threadOpen: boolean
}>()
const children = shallowRef(props.preview ?? [])
const expanded = ref(children.value.length > 0)
const next = ref<string | null>(props.node.moreChildren ? children.value.at(-1)?.id ?? null : null)
const done = ref(!props.node.moreChildren)
const loading = ref(false)
const failed = ref(false)
const removing = ref(false)
const confirmRemoval = ref(false)
const removalError = ref<MessageKey | ''>('')
const notifyDeleted = inject(commentAuthorDelete)
const openEditor = inject(commentAuthorEdit)
const reply = inject(commentReply)
const report = inject(commentReport)
const previewIds = new Set(props.preview?.map(node => node.id))
const authorActions = useCommentAuthorEligibility(() => props.articleId,
  computed(() => expanded.value ? children.value.filter(node => !previewIds.has(node.id)) : []))
let request: AbortController | undefined
let removal: AbortController | undefined
const createdAt = new Date(props.node.createdAt).toISOString()
const displayTime = computed(() => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(props.node.createdAt))
const showReplyToggle = computed(() => !props.contextOnly && props.node.childCount > 0)
const showReplyAction = computed(() => Boolean(reply?.available.value && props.threadOpen && !props.node.deleted && props.node.depth < 32))
const showEditAction = computed(() => Boolean(props.canEdit && !props.node.deleted && openEditor))
const showDeleteAction = computed(() => Boolean(props.canDelete && !props.node.deleted))
const showReportAction = computed(() => Boolean(report?.available.value && !props.node.deleted))
const hasActions = computed(() => showReplyToggle.value || showReplyAction.value || showEditAction.value || showDeleteAction.value || showReportAction.value)

onBeforeUnmount(() => {
  request?.abort()
  removal?.abort()
})

watch([identityEpoch, () => currentSession.value?.siteSessionId, () => props.articleId, () => props.node.id], () => {
  removal?.abort()
  removal = undefined
  removing.value = false
  confirmRemoval.value = false
  removalError.value = ''
}, { flush: 'sync' })

async function removeOwn() {
  const session = currentSession.value
  const id = props.node.id
  if (!props.canDelete || !session?.siteSessionId || session.expiresAt <= Date.now() || removing.value) return
  const controller = new AbortController()
  removal = controller
  const epoch = identityEpoch.value
  removing.value = true
  removalError.value = ''
  try {
    confirmRemoval.value = false
    await deleteOwnComment(id, session.siteSessionId, controller.signal)
    if (!controller.signal.aborted && identityEpoch.value === epoch && currentSession.value?.siteSessionId === session.siteSessionId)
      notifyDeleted?.(id)
  } catch (error) {
    if (!controller.signal.aborted && identityEpoch.value === epoch && currentSession.value?.siteSessionId === session.siteSessionId)
      removalError.value = error instanceof ApiError && error.status === 409
        ? 'comment.deleteChanged' : 'comment.deleteUnconfirmed'
  } finally {
    if (removal === controller) {
      removal = undefined
      removing.value = false
    }
  }
}

async function more() {
  if (done.value || loading.value || children.value.length >= 300) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  failed.value = false
  try {
    const page = await comments.children(props.articleId, props.node, next.value, controller.signal)
    if (controller.signal.aborted) return
    const existing = new Set(children.value.map(node => node.id))
    children.value = [...children.value, ...page.items.filter(node => !existing.has(node.id))].slice(0, 300)
    next.value = page.cursor
    done.value = page.cursor === null
  } catch {
    if (!controller.signal.aborted) failed.value = true
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}

function toggle(show = !expanded.value) {
  if (props.contextOnly || props.node.childCount === 0) return
  expanded.value = show
  if (show && children.value.length === 0) void more()
}
</script>

<template>
  <li class="comment-node">
    <article :id="`comment-${node.id}`" class="comment-article"
      :class="{ 'is-target': node.id === target, 'is-deleted': node.deleted }"
      :tabindex="node.id === target ? -1 : undefined"
      @keydown.right.self.prevent="toggle(true)" @keydown.left.self.prevent="toggle(false)">
      <header class="comment-byline">
        <div class="comment-identity">
          <strong class="comment-author" :class="{ 'is-muted': node.author.mode !== 'public' || node.deleted }">{{ node.author.displayName }}</strong>
          <span v-if="node.author.mode !== 'public' && !node.deleted" class="comment-badge">{{ t('comment.anonymous') }}</span>
          <span v-if="node.replyToAuthor" class="comment-reply-target">{{ t('comment.replyTo', { name: node.replyToAuthor.displayName }) }}</span>
          <span v-if="node.edited" class="comment-meta-note">{{ t('comment.edited') }}</span>
        </div>
        <RouterLink class="comment-time-link" :to="{ hash: `#comment-${node.id}` }" :aria-label="t('comment.permalink')">
          <time :datetime="createdAt">{{ displayTime }}</time>
        </RouterLink>
      </header>
      <p class="comment-text" :lang="node.author.language">{{ node.content }}</p>
      <p v-if="removalError" class="comment-error" role="alert">{{ t(removalError) }}</p>
      <footer v-if="hasActions" class="comment-actions">
        <ElButton v-if="showReplyAction" class="comment-action" text size="small" @click="reply?.start(node)">{{ t('comment.reply') }}</ElButton>
        <ElButton v-if="showReplyToggle" class="comment-action" text size="small"
          v-bind="{ 'aria-expanded': expanded, 'aria-controls': `comment-replies-${node.id}` }" @click="toggle()">
          {{ expanded ? t('comment.hideReplies') : t('comment.showReplies', { count: node.childCount }) }}
        </ElButton>
        <ElButton v-if="showEditAction" class="comment-action" text size="small" @click="openEditor?.(node)">{{ t('comment.editMine') }}</ElButton>
        <ElButton v-if="showDeleteAction" class="comment-action comment-action--danger" text size="small" :loading="removing" @click="confirmRemoval = true">
          {{ t('comment.deleteMine') }}
        </ElButton>
        <ElButton v-if="showReportAction" class="comment-action" text size="small" @click="report?.start(node)">{{ t('comment.report') }}</ElButton>
      </footer>
      <ElDialog v-if="showDeleteAction" v-model="confirmRemoval" :title="t('comment.deleteTitle')"
        append-to-body :close-on-click-modal="false" width="min(calc(100vw - 2rem), 28rem)">
        <p>{{ t('comment.deleteNotice') }}</p>
        <template #footer>
          <ElButton native-type="button" @click="confirmRemoval = false">{{ t('comment.keep') }}</ElButton>
          <ElButton native-type="button" type="danger" @click="removeOwn">{{ t('comment.delete') }}</ElButton>
        </template>
      </ElDialog>
      <div v-if="showReplyToggle" v-show="expanded" :id="`comment-replies-${node.id}`" class="comment-replies">
        <ol v-if="children.length > 0" class="comment-children" :class="{ 'is-deep': node.depth >= 3 }" role="list">
          <CommentBranch v-for="child in children" :key="child.id" :article-id="articleId" :node="child" :target="target"
            :can-delete="previewDeletions?.has(child.id) || authorActions.deletable.has(child.id)"
            :can-edit="previewEdits?.has(child.id) || authorActions.editable.has(child.id)" :thread-open="threadOpen" />
        </ol>
        <ElAlert v-if="failed" class="comment-replies-alert" type="error" :title="t('comment.repliesFailed')" :closable="false" />
        <ElButton v-if="!done && children.length < 300" class="comment-action comment-replies-more" text size="small" :loading="loading" @click="more">
          {{ failed ? t('comment.retryReplies') : t('comment.moreReplies') }}
        </ElButton>
        <p v-if="!done && children.length >= 300" class="comment-limit-note" role="status">{{ t('comment.branchLimit') }}</p>
      </div>
    </article>
  </li>
</template>

<style scoped>
.comment-node {
  padding-block: 1.25rem;
  border-block-end: 1px solid var(--el-border-color-lighter);
}
.comment-node:last-child { border-block-end-color: var(--fsus-border); }
.comment-article { min-inline-size: 0; scroll-margin-block-start: 6.5rem; }
.comment-article.is-target {
  padding-inline-start: .875rem;
  border-inline-start: 2px solid var(--fsus-scholarly-blue);
}
.comment-article:focus-visible {
  outline: 2px solid var(--fsus-scholarly-blue);
  outline-offset: 4px;
  border-radius: var(--fsus-radius-control-small);
}
.comment-byline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: .25rem 1rem;
}
.comment-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: .25rem .5rem;
  min-inline-size: 0;
}
.comment-author {
  color: var(--fsus-ink);
  font-size: .9375rem;
  font-weight: 700;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.comment-author.is-muted {
  color: var(--fsus-color-text-quiet);
  font-weight: 500;
}
.comment-badge {
  padding: 0 .45rem;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-pill);
  color: var(--fsus-color-text-quiet);
  font-size: .75rem;
  line-height: 1.6;
}
.comment-reply-target,
.comment-meta-note {
  color: var(--fsus-color-text-quiet);
  font-size: .8125rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.comment-time-link {
  color: var(--fsus-color-text-quiet);
  font-size: .8125rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  text-decoration: none;
  white-space: nowrap;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}
.comment-time-link:hover,
.comment-time-link:focus-visible {
  color: var(--fsus-scholarly-blue);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: .25em;
}
.comment-text {
  margin: .625rem 0 0;
  color: var(--fsus-ink);
  font-size: .9375rem;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.comment-article.is-deleted .comment-text { color: var(--fsus-color-text-quiet); }
.comment-error { margin: .5rem 0 0; color: var(--el-color-danger); font-size: .875rem; }
.comment-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .125rem .25rem;
  margin-block-start: .5rem;
  margin-inline-start: -8px;
}
.comment-action {
  color: var(--fsus-color-text-quiet);
  font-size: .8125rem;
  font-weight: 500;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}
.comment-action + .comment-action { margin-inline-start: 0; }
.comment-action:hover,
.comment-action:focus-visible { color: var(--fsus-scholarly-blue); }
.comment-action--danger:hover,
.comment-action--danger:focus-visible { color: var(--el-color-danger); }
.comment-replies { margin-block-start: .75rem; }
.comment-children {
  margin: 0;
  padding: 0 0 0 1.25rem;
  list-style: none;
  border-inline-start: 2px solid var(--fsus-border);
}
.comment-children.is-deep { border-inline-start-style: dotted; }
.comment-children .comment-node { padding-block: .875rem; }
.comment-children .comment-node:first-child { padding-block-start: .375rem; }
.comment-children .comment-node:last-child { padding-block-end: .25rem; border-block-end: 0; }
.comment-replies-alert { margin-block-start: .75rem; }
.comment-replies-more { margin-block-start: .5rem; margin-inline-start: -8px; }
.comment-limit-note { margin: .5rem 0 0; color: var(--fsus-color-text-quiet); font-size: .8125rem; }
@media (max-width: 37.99rem) {
  .comment-node { padding-block: 1rem; }
  .comment-children { padding-inline-start: .875rem; }
  .comment-children.is-deep { padding-inline-start: .625rem; }
  .comment-article.is-target { padding-inline-start: .625rem; }
}
@media (pointer: coarse) {
  .comment-action { min-block-size: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .comment-time-link,
  .comment-action { transition-duration: 1ms; }
}
</style>
