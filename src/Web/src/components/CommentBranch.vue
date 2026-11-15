<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElDialog } from '@ozwasyd/element-plus'
import { comments, type CommentNode } from '../../../Contracts/comment-read'
import { deleteOwnComment } from '../../../Contracts/comment-author'
import { ApiError } from '../../../Contracts/client'
import { currentSession, identityEpoch } from '../session'
import { commentAuthorDelete, commentAuthorEdit, commentReply, useCommentAuthorEligibility } from './commentAuthorActions'

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
const removalError = ref('')
const notifyDeleted = inject(commentAuthorDelete)
const openEditor = inject(commentAuthorEdit)
const reply = inject(commentReply)
const previewIds = new Set(props.preview?.map(node => node.id))
const authorActions = useCommentAuthorEligibility(() => props.articleId,
  computed(() => expanded.value ? children.value.filter(node => !previewIds.has(node.id)) : []))
let request: AbortController | undefined
let removal: AbortController | undefined
const createdAt = new Date(props.node.createdAt).toISOString()
const displayTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(props.node.createdAt)

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
        ? 'The comment changed. Reload the article before deleting it.' : 'Could not confirm comment deletion. Reload the article to check.'
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
    <article :id="`comment-${node.id}`" :tabindex="node.id === target ? -1 : undefined"
      @keydown.right.self.prevent="toggle(true)" @keydown.left.self.prevent="toggle(false)">
      <header class="comment-byline">
        <strong>{{ node.author.displayName }}</strong>
        <span v-if="node.author.mode !== 'public' && !node.deleted">Anonymous</span>
        <span v-if="node.replyToAuthor">Reply to {{ node.replyToAuthor.displayName }}</span>
        <RouterLink :to="{ hash: `#comment-${node.id}` }" aria-label="Comment permalink">
          <time :datetime="createdAt">{{ displayTime }}</time>
        </RouterLink>
        <span v-if="node.edited">Edited</span>
        <ElButton v-if="canEdit && !node.deleted && openEditor" text size="small" @click="openEditor?.(node)">Edit my comment</ElButton>
        <ElButton v-if="canDelete && !node.deleted" text size="small" :loading="removing" @click="confirmRemoval = true">Delete my comment</ElButton>
        <ElButton v-if="reply?.available.value && threadOpen && !node.deleted && node.depth < 32" text size="small"
          @click="reply.start(node)">Reply</ElButton>
      </header>
      <p class="comment-text" :lang="node.author.language">{{ node.content }}</p>
      <p v-if="removalError" role="alert">{{ removalError }}</p>
      <ElDialog v-if="canDelete && !node.deleted" v-model="confirmRemoval" title="Delete your comment?"
        append-to-body :close-on-click-modal="false" width="min(calc(100vw - 2rem), 28rem)">
        <p>Your comment will be removed. Published replies will remain visible.</p>
        <template #footer>
          <ElButton native-type="button" @click="confirmRemoval = false">Keep comment</ElButton>
          <ElButton native-type="button" type="danger" @click="removeOwn">Delete comment</ElButton>
        </template>
      </ElDialog>
      <ElButton v-if="!contextOnly && node.childCount > 0" text size="small"
        v-bind="{ 'aria-expanded': expanded, 'aria-controls': `comment-replies-${node.id}` }" @click="toggle()">
        {{ expanded ? 'Hide replies' : `Show replies (${node.childCount})` }}
      </ElButton>
      <div v-if="!contextOnly && node.childCount > 0" v-show="expanded" :id="`comment-replies-${node.id}`">
        <ol v-if="children.length > 0" class="comment-children">
          <CommentBranch v-for="child in children" :key="child.id" :article-id="articleId" :node="child" :target="target"
            :can-delete="previewDeletions?.has(child.id) || authorActions.deletable.has(child.id)"
            :can-edit="previewEdits?.has(child.id) || authorActions.editable.has(child.id)" :thread-open="threadOpen" />
        </ol>
        <ElAlert v-if="failed" type="error" title="Could not load replies." :closable="false" />
        <ElButton v-if="!done && children.length < 300" text size="small" :loading="loading" @click="more">
          {{ failed ? 'Retry replies' : 'Load more replies' }}
        </ElButton>
        <p v-if="!done && children.length >= 300" role="status">This branch shows its first 300 direct replies.</p>
      </div>
    </article>
  </li>
</template>

<style scoped>
.comment-node { border-block-start: 1px solid var(--el-border-color-light); padding-block: 0.85rem; }
.comment-byline { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; color: var(--el-text-color-secondary); font-size: 0.85rem; }
.comment-byline strong { color: var(--el-text-color-primary); }
.comment-text { white-space: pre-wrap; overflow-wrap: anywhere; margin-block: 0.6rem; }
.comment-children { border-inline-start: 1px solid var(--el-border-color-light); list-style: none; padding-inline-start: min(1rem, 2vw); }
.comment-node article:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
</style>
