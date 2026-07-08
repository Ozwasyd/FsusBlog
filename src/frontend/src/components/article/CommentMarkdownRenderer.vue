<template>
  <div
    ref="rootEl"
    class="comment-markdown-renderer"
    :class="{ 'comment-markdown-renderer--collapsed': isCollapsed }"
    :style="{ '--comment-markdown-collapsed-lines': String(collapsedLines) }"
  >
    <MarkdownRenderer
      :content="content"
      mode="preview"
      :allow-html="false"
      :allow-latex="false"
      :allow-mermaid="false"
      @render-complete="measureOverflow"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'

const props = withDefaults(defineProps<{
  content: string
  expanded?: boolean
  collapsible?: boolean
  collapsedLines?: number
}>(), {
  expanded: false,
  collapsible: true,
  collapsedLines: 8
})

const emit = defineEmits<{
  (e: 'overflow-change', value: boolean): void
}>()

const rootEl = ref<HTMLElement | null>(null)
const isCollapsed = computed(() => props.collapsible && !props.expanded)

const measureOverflow = async (): Promise<void> => {
  await nextTick()
  const element = rootEl.value
  if (!element || !props.collapsible) {
    emit('overflow-change', false)
    return
  }

  emit('overflow-change', element.scrollHeight > element.clientHeight + 1)
}

watch(() => [props.content, props.expanded, props.collapsible, props.collapsedLines], () => {
  void measureOverflow()
})

onMounted(() => {
  void measureOverflow()
})
</script>

<style scoped>
.comment-markdown-renderer {
  --comment-markdown-line-height: 1.65em;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.875rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.comment-markdown-renderer--collapsed {
  max-height: calc(var(--comment-markdown-line-height) * var(--comment-markdown-collapsed-lines));
  overflow: hidden;
  position: relative;
}

.comment-markdown-renderer--collapsed::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2.5em;
  pointer-events: none;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--fsusblog-panel-bg) 0%, transparent),
    var(--fsusblog-page-bg)
  );
}

.comment-markdown-renderer :deep(.blog-markdown-renderer) {
  color: inherit;
  font: inherit;
}

.comment-markdown-renderer :deep(.markdown-body) {
  color: inherit;
  font: inherit;
}

.comment-markdown-renderer :deep(.markdown-body > :first-child) {
  margin-top: 0;
}

.comment-markdown-renderer :deep(.markdown-body > :last-child) {
  margin-bottom: 0;
}

.comment-markdown-renderer :deep(h1),
.comment-markdown-renderer :deep(h2),
.comment-markdown-renderer :deep(h3) {
  margin: 0.35rem 0;
  color: var(--fsusblog-text-primary);
  font-size: 0.9375rem;
  font-weight: 750;
  line-height: 1.45;
}

.comment-markdown-renderer :deep(h4),
.comment-markdown-renderer :deep(h5),
.comment-markdown-renderer :deep(h6) {
  margin: 0.35rem 0;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.45;
}

.comment-markdown-renderer :deep(p),
.comment-markdown-renderer :deep(ul),
.comment-markdown-renderer :deep(ol),
.comment-markdown-renderer :deep(blockquote),
.comment-markdown-renderer :deep(pre) {
  margin: 0.45rem 0;
}

.comment-markdown-renderer :deep(blockquote) {
  border-left: 2px solid color-mix(in srgb, var(--fsusblog-text-muted) 32%, transparent);
  padding-left: 0.75rem;
  color: var(--fsusblog-text-muted);
}

.comment-markdown-renderer :deep(pre),
.comment-markdown-renderer :deep(code) {
  border-radius: 0.375rem;
  font-size: 0.8125rem;
}

.comment-markdown-renderer :deep(img),
.comment-markdown-renderer :deep(svg),
.comment-markdown-renderer :deep(iframe) {
  display: none !important;
}
</style>
