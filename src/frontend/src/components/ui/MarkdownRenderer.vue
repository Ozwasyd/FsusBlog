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
      @placeholders-ready="handlePlaceholdersReady"
      @render-complete="handleRenderComplete"
      @render-error="handleRenderError"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { activateMarkdownFeatures, type MarkdownRenderResult } from '@/services/markdownActivationService'

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
  (e: 'render-complete', result?: MarkdownRenderResult): void
  (e: 'render-error', error: FsusMarkdownError): void
}>()

const rendererRef = ref<MarkdownRendererExpose | null>(null)
const rootEl = computed(() => rendererRef.value?.rootEl ?? null)
let activationTaskId = 0

function queueFeatureActivation(result: MarkdownRenderResult): void {
  const taskId = ++activationTaskId
  void nextTick(() => {
    const target = rootEl.value
    if (!target || taskId !== activationTaskId) {
      return
    }
    void activateMarkdownFeatures(target, result)
  })
}

function handlePlaceholdersReady(_placeholders: unknown, result: MarkdownRenderResult): void {
  queueFeatureActivation(result)
}

function handleRenderComplete(result: MarkdownRenderResult): void {
  queueFeatureActivation(result)
  emit('render-complete', result)
}

function handleRenderError(error: FsusMarkdownError): void {
  emit('render-error', error)
}

defineExpose({ rootEl })
</script>
