<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { comments, type CommentContext, type CommentRoot } from '../../../Contracts/comment-read'
import CommentBranch from './CommentBranch.vue'

const props = defineProps<{ articleId: number }>()
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
let request: AbortController | undefined

onBeforeUnmount(() => request?.abort())

async function load(follow: boolean, hash?: string) {
  if (follow && request) return
  if (!follow) {
    request?.abort()
    roots.value = []
    linked.value = undefined
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
      linked.value = permalink
      if (permalink) {
        await nextTick()
        if (!controller.signal.aborted) document.getElementById(`comment-${permalink.target.id}`)?.focus()
        return
      }
    }
    const page = await comments.roots(props.articleId, follow ? next.value : null, controller.signal)
    if (!controller.signal.aborted) {
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

watch([() => props.articleId, () => route.hash, restart], ([, hash]) => void load(false, hash), { immediate: true })
</script>

<template>
  <section class="article-comments" aria-labelledby="article-comments-title">
    <h2 id="article-comments-title">Comments</h2>
    <p v-if="linked === null" role="status">This comment is unavailable.</p>
    <p v-if="loading" role="status">Loading comments…</p>
    <template v-if="linked">
      <ol class="comment-roots">
        <CommentBranch v-for="node in permalinkNodes"
          :key="node.id" :article-id="articleId" :node="node" :target="target" context-only />
      </ol>
      <RouterLink :to="{ hash: '#article-comments-title' }">All comments</RouterLink>
    </template>
    <ol v-else-if="roots.length" class="comment-roots">
      <CommentBranch v-for="root in roots" :key="root.node.id" :article-id="articleId" :node="root.node" :preview="root.preview" />
    </ol>
    <p v-else-if="!loading && !failed" class="muted">No comments yet.</p>
    <ElAlert v-if="failed" type="error" title="Could not load comments." :closable="false" />
    <ElButton v-if="failed" text @click="roots.length && next ? load(true) : restart++">Retry comments</ElButton>
    <ElButton v-else-if="next && !loading" text @click="load(true)">Load more comments</ElButton>
  </section>
</template>

<style scoped>
.article-comments { border-block-start: 1px solid var(--el-border-color-light); margin-block-start: 2rem; padding-block-start: 1rem; }
.comment-roots { list-style: none; padding: 0; margin: 0; }
</style>
