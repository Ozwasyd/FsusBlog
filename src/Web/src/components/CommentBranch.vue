<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { comments, type CommentNode } from '../../../Contracts/comment-read'

const props = defineProps<{ articleId: number; node: CommentNode; preview?: CommentNode[]; target?: string; contextOnly?: boolean }>()
const children = shallowRef(props.preview ?? [])
const expanded = ref(children.value.length > 0)
const next = ref<string | null>(props.node.moreChildren ? children.value.at(-1)?.id ?? null : null)
const done = ref(!props.node.moreChildren)
const loading = ref(false)
const failed = ref(false)
let request: AbortController | undefined
const createdAt = new Date(props.node.createdAt).toISOString()
const displayTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(props.node.createdAt)

onBeforeUnmount(() => request?.abort())

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
      </header>
      <p class="comment-text" :lang="node.author.language">{{ node.content }}</p>
      <ElButton v-if="!contextOnly && node.childCount > 0" text size="small"
        v-bind="{ 'aria-expanded': expanded, 'aria-controls': `comment-replies-${node.id}` }" @click="toggle()">
        {{ expanded ? 'Hide replies' : `Show replies (${node.childCount})` }}
      </ElButton>
      <div v-if="!contextOnly && node.childCount > 0" v-show="expanded" :id="`comment-replies-${node.id}`">
        <ol v-if="children.length > 0" class="comment-children">
          <CommentBranch v-for="child in children" :key="child.id" :article-id="articleId" :node="child" :target="target" />
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
