<template>
  <div class="blog-markdown-renderer markdown-body">
    <el-markdown-renderer
      ref="rendererRef"
      :content="props.content"
      :initial-html="props.initialHtml"
      :allow-html="props.allowHtml"
      :allow-latex="props.allowLatex"
      :allow-mermaid="props.allowMermaid"
      :mode="props.mode"
      :base-url="props.baseUrl"
      @features-activated="emit('features-activated', $event)"
      @render-complete="emit('render-complete', $event)"
      @render-error="emit('render-error', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MarkdownFeatureActivationResult, MarkdownRenderResult } from '@/fsusui/markdown'

type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor'
type MarkdownRendererExpose = {
  rootEl?: HTMLElement | null
}
type FsusMarkdownError = {
  code?: string
  message?: string
}

const props = withDefaults(defineProps<{
  content: string
  initialHtml?: string
  allowHtml?: boolean
  allowLatex?: boolean
  allowMermaid?: boolean
  mode?: MarkdownRenderMode
  baseUrl?: string | null
}>(), {
  initialHtml: '',
  allowHtml: false,
  allowLatex: true,
  allowMermaid: true,
  mode: 'article',
  baseUrl: null
})
const emit = defineEmits<{
  (e: 'features-activated', result?: MarkdownFeatureActivationResult): void
  (e: 'render-complete', result?: MarkdownRenderResult): void
  (e: 'render-error', error: FsusMarkdownError): void
}>()

const rendererRef = ref<MarkdownRendererExpose | null>(null)
const rootEl = computed(() => rendererRef.value?.rootEl ?? null)

defineExpose({ rootEl })
</script>
