<template>
  <PublicAboutPageContent
    :view="aboutView"
    :loading="loading"
    :error="error"
    @retry="fetchData"
  >
    <template #body>
      <MarkdownRenderer
        :content="rawMarkdown"
        :initial-html="initialBodyHtml"
        mode="about"
      />
    </template>
  </PublicAboutPageContent>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import PublicAboutPageContent from '@/components/public/pages/PublicAboutPageContent.vue'
import { useAboutPage } from '@/composables/useAboutPage'
import { useHumanReadProof } from '@/composables/useHumanReadProof'
import { buildPublicAboutRouteKey } from '@/public-renderers/publicRouteIdentity'

const { aboutView, initialBodyHtml, rawMarkdown, loading, error, fetchData } = useAboutPage()

useHumanReadProof({
  scope: computed(() => 'site'),
  routeKey: computed(() => buildPublicAboutRouteKey()),
  enabled: computed(() => !loading.value && !error.value)
})
</script>

<style scoped>
@reference "@/assets/main.css";
</style>
