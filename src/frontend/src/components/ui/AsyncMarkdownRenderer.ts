import { defineAsyncComponent } from 'vue'

export const AsyncMarkdownRenderer = defineAsyncComponent(
  () => import('@/components/ui/MarkdownRenderer.vue')
)
