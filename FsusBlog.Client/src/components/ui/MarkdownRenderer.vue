<template>
  <div 
    ref="rootEl"
    :class="[markdownSurfaceClasses.root, markdownSurfaceClasses.body]"
    role="article"
    aria-live="polite"
    data-markdown-renderer="wasm"
    v-html="renderedContent"
  ></div>
</template>

<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { renderMarkdownDocument } from '@/services/markdownRenderHost'
import { MARKDOWN_RENDERER_SURFACE_CLASSES as markdownSurfaceClasses } from '@wasm/markdown'

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ (e: 'render-complete'): void }>()

const rootEl = ref<HTMLElement | null>(null)
const renderedContent = shallowRef('')

let currentTaskId = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const renderErrorHtml = [
  `<div class="${markdownSurfaceClasses.root} ${markdownSurfaceClasses.body} ${markdownSurfaceClasses.error}">`,
  '<p>Markdown 渲染失败，已回退为安全文本。</p>',
  '</div>'
].join('')

const performRender = async (rawContent: string) => {
  const taskId = ++currentTaskId;
  try {
    const result = await renderMarkdownDocument(rawContent)
    if (taskId !== currentTaskId) {
      return
    }

    renderedContent.value = typeof result.html === 'string' ? result.html : renderErrorHtml
    emit('render-complete')
  } catch {
    if (taskId !== currentTaskId) {
      return
    }

    renderedContent.value = renderErrorHtml
  }
}

watch(() => props.content, (newVal) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void performRender(newVal)
  }, 16)
}, { immediate: true })

defineExpose({ rootEl })
</script>
