<template>
  <div
    ref="rootEl"
    class="comment-markdown-renderer fsus-markdown-body"
    :class="{ 'comment-markdown-renderer--collapsed': isCollapsed }"
    data-fsus-comment-markdown
    data-fsus-surface="reading"
    v-csp-style="{ '--comment-markdown-collapsed-lines': String(collapsedLines) }"
  >
    <MarkdownRenderer
      :content="content"
      mode="preview"
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
  --comment-markdown-line-height: 1.8rem;
  color: var(--fsusblog-text-primary);
  font-size: 16px;
  font-weight: 400;
  line-height: 1.8;
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

</style>

<style>
[data-fsus-comment-markdown] .markdown-body p:last-child {
  margin-bottom: 0;
}

[data-fsus-comment-markdown] .markdown-body pre {
  max-width: 100%;
  overflow-x: auto;
}

[data-fsus-comment-markdown] .markdown-body :is(img, svg, iframe) {
  display: none;
}
</style>
