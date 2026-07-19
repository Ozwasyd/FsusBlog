<template>
  <ArticleDetailBody>
    <MarkdownRenderer
      :content="content"
      :initial-html="initialHtml"
      mode="preview"
      :base-url="baseUrl"
    />
  </ArticleDetailBody>
</template>

<script setup lang="ts">
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'

withDefaults(defineProps<{
  content: string
  initialHtml?: string
  baseUrl?: string | null
}>(), {
  initialHtml: '',
  baseUrl: null
})
</script>
