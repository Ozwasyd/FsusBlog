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
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { renderMarkdownDocument } from '@/services/markdownRenderHost'
import { MARKDOWN_RENDERER_SURFACE_CLASSES as markdownSurfaceClasses } from '@wasm/markdown'
import { EMPTY_TRUSTED_HTML, trustStaticHtml, type TrustedHtml } from '@/utils/trustedHtml'

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ (e: 'render-complete'): void }>()

const rootEl = ref<HTMLElement | null>(null)
const renderedContent = shallowRef<TrustedHtml>(EMPTY_TRUSTED_HTML)

let currentTaskId = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const renderErrorHtml = trustStaticHtml([
  `<div class="${markdownSurfaceClasses.root} ${markdownSurfaceClasses.body} ${markdownSurfaceClasses.error}">`,
  '<p>Markdown 渲染失败，已回退为安全文本。</p>',
  '</div>'
].join(''))

const performRender = async (rawContent: string) => {
  const taskId = ++currentTaskId;
  try {
    const result = await renderMarkdownDocument({
      source: rawContent,
      allowHtml: false
    })
    if (taskId !== currentTaskId) {
      return
    }

    renderedContent.value = result.html
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

onBeforeUnmount(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  currentTaskId += 1
})

defineExpose({ rootEl })
</script>
