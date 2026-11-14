<script setup lang="ts">
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminSitePage, readAdminSitePages } from '../../../Contracts/admin-site-pages'
import type { SitePageSlug } from '../../../Contracts/site-pages'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const pages = shallowRef<Awaited<ReturnType<typeof readAdminSitePages>>>()
const selected = shallowRef<Awaited<ReturnType<typeof readAdminSitePage>>>()
const busy = ref(false)
const error = ref('')
let active: AbortController | undefined

function clear() {
  active?.abort()
  active = undefined
  pages.value = undefined
  selected.value = undefined
  busy.value = false
  error.value = ''
}

async function read(slug?: SitePageSlug) {
  if (props.sessionSignal.aborted || busy.value) return
  const request = active = new AbortController()
  const signal = AbortSignal.any([request.signal, props.sessionSignal])
  selected.value = undefined
  if (!slug) pages.value = undefined
  error.value = ''
  busy.value = true
  try {
    if (slug) {
      const page = await readAdminSitePage(slug, signal)
      if (!signal.aborted) selected.value = page
    } else {
      const overview = await readAdminSitePages(signal)
      if (!signal.aborted) pages.value = overview
    }
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 403) error.value = 'The system.config permission is required.'
    else error.value = 'Could not load site page content. Try again.'
  } finally {
    if (active === request) { active = undefined; busy.value = false }
  }
}

watch(() => props.sessionSignal, (signal, _, cleanup) => {
  clear()
  signal.addEventListener('abort', clear, { once: true })
  cleanup(() => signal.removeEventListener('abort', clear))
}, { flush: 'sync', immediate: true })
onScopeDispose(clear)
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-site-pages-heading">
    <h2 id="admin-site-pages-heading">Site pages</h2>
    <ElButton native-type="button" :loading="busy" @click="read()">Check site pages</ElButton>
    <ElAlert v-if="error" :title="error" :closable="false" type="error" />
    <ul v-if="pages" class="site-pages-list">
      <li v-for="page in pages" :key="page.slug">
        <strong>{{ page.title }}</strong> <code>/{{ page.slug }}</code>
        <span>{{ page.configured ? 'Configured' : 'Unconfigured' }}</span>
        <ElButton v-if="page.configured" :disabled="busy" native-type="button" text
          @click="read(page.slug)">View {{ page.slug }} content</ElButton>
        <pre v-if="selected?.slug === page.slug" tabindex="0" :aria-label="`${page.slug} Markdown`">{{ selected.markdown }}</pre>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.site-pages-list { margin: 0; padding-inline-start: 1.25rem; }
.site-pages-list li { margin-block: .5rem; }
.site-pages-list code { margin-inline: .3rem; }
.site-pages-list pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 20rem; overflow: auto; }
</style>
