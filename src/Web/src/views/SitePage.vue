<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { consumeInitialSitePage, isSitePageSlug, readSitePage, updateSitePageRobots } from '../sitePageEntry'

const route = useRoute()
const slug = computed(() => isSitePageSlug(route.name) ? route.name : undefined)
const title = computed(() => slug.value ? t(`policy.${slug.value}`) : '')
const page = shallowRef<Awaited<ReturnType<typeof readSitePage>>>()
const state = ref<'loading' | 'failed' | 'ready'>('loading')
const retry = ref(0)

watch([slug, retry], async ([value], _, cleanup) => {
  if (!value) {
    page.value = undefined
    state.value = 'loading'
    updateSitePageRobots(false)
    return
  }
  const cached = consumeInitialSitePage(value)
  if (cached) {
    page.value = cached
    state.value = 'ready'
    updateSitePageRobots(cached.configured)
    return
  }
  page.value = undefined
  state.value = 'loading'
  updateSitePageRobots(false)
  const request = new AbortController()
  const timeout = window.setTimeout(() => request.abort('timeout'), 4_000)
  let current = true
  cleanup(() => {
    current = false
    window.clearTimeout(timeout)
    request.abort()
  })
  try {
    const next = await readSitePage(value, request.signal)
    if (request.signal.aborted) return
    page.value = next
    state.value = 'ready'
    updateSitePageRobots(next.configured)
  } catch {
    if (current) state.value = 'failed'
  } finally {
    window.clearTimeout(timeout)
  }
}, { immediate: true })
</script>

<template>
  <article class="reading-column editorial-page article-body" v-bind="{ 'data-fsus-surface': 'reading' }" :aria-busy="state === 'loading'">
    <header class="editorial-rule">
      <h1>{{ title }}</h1>
    </header>
    <p v-if="state === 'loading'" role="status">{{ t('reading.loadingPage') }}</p>
    <section v-else-if="state === 'failed'">
      <ElAlert :title="t('reading.pageFailed')" type="error" :closable="false" />
      <ElButton @click="retry++">{{ t('reading.retry') }}</ElButton>
      <RouterLink to="/">{{ t('reading.returnHome') }}</RouterLink>
    </section>
    <div v-else-if="page" v-bind="{ class: 'blog-markdown', 'data-site-page-body': '', 'data-state': page.configured ? 'published' : 'unconfigured' }" :lang="page.bodyLanguage" v-html="page.body" />
  </article>
</template>
