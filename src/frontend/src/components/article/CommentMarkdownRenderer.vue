<template>
  <div
    ref="rootEl"
    class="comment-markdown-renderer fsus-markdown-body"
    :class="{ 'comment-markdown-renderer--collapsed': isCollapsed }"
    v-csp-style="{ '--comment-markdown-collapsed-lines': String(collapsedLines) }"
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
import { cspStyleDirective } from '@/services/cspStyleRuntime'

const vCspStyle = cspStyleDirective

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
  color: var(--fsusblog-text-primary);
  font-family: 'Google Sans', 'Noto Sans CJK', sans-serif;
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  word-break: break-word;
  text-align: left;
}

.fsus-markdown-body {
  margin-bottom: 4px;
  text-align: left;
}

.comment-markdown-renderer--collapsed {
  max-height: calc(var(--comment-markdown-line-height) * var(--comment-markdown-collapsed-lines));
  overflow: hidden;
  position: relative;
}

.fsus-markdown-body :deep(.blog-markdown-renderer),
.fsus-markdown-body :deep(.markdown-body) {
  color: var(--fsusblog-text-primary) !important;
  font-family: inherit !important;
  font-size: 14px !important;
  line-height: 1.6 !important;
  letter-spacing: normal !important;
  text-align: left !important;
}

.fsus-markdown-body :deep(.markdown-body p) {
  margin: 0 0 12px 0 !important;
  color: var(--fsusblog-text-primary) !important;
  font-size: 14px !important;
  font-weight: 400 !important;
  line-height: 1.6 !important;
  letter-spacing: normal !important;
  text-align: left !important;
  text-indent: 0 !important;
}

.fsus-markdown-body :deep(.markdown-body p:last-child) {
  margin-bottom: 0 !important;
}

.fsus-markdown-body :deep(.markdown-body code) {
  padding: 2px 4px !important;
  border: none !important;
  border-radius: 4px !important;
  background-color: var(--fsusblog-reading-inline-code-bg) !important;
  color: var(--fsusblog-text-primary) !important;
  font-family: monospace !important;
  font-size: 13px !important;
  font-weight: 400 !important;
  white-space: normal !important;
}

.fsus-markdown-body :deep(.markdown-body pre) {
  margin: 0 0 12px 0;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: 4px;
  background: transparent;
  color: var(--fsusblog-text-primary);
  font-size: 13px;
  line-height: 1.45;
}

.fsus-markdown-body :deep(.markdown-body pre code) {
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  font-family: monospace !important;
  font-size: 13px !important;
}

.fsus-markdown-body :deep(.markdown-body h1),
.fsus-markdown-body :deep(.markdown-body h2),
.fsus-markdown-body :deep(.markdown-body h3),
.fsus-markdown-body :deep(.markdown-body h4),
.fsus-markdown-body :deep(.markdown-body h5),
.fsus-markdown-body :deep(.markdown-body h6) {
  margin: 0 0 12px 0;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.6;
  text-align: left;
}

.fsus-markdown-body :deep(.markdown-body ul),
.fsus-markdown-body :deep(.markdown-body ol),
.fsus-markdown-body :deep(.markdown-body blockquote) {
  margin: 0 0 12px 0;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  line-height: 1.6;
}

.fsus-markdown-body :deep(.markdown-body blockquote) {
  border-left: 1px solid var(--fsusblog-panel-border);
  padding-left: 12px;
}

.comment-markdown-renderer :deep(img),
.comment-markdown-renderer :deep(svg),
.comment-markdown-renderer :deep(iframe) {
  display: none !important;
}
</style>
