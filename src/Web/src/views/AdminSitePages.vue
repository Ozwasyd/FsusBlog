<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { ref, shallowRef } from 'vue'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminSitePage, readAdminSitePages } from '../../../Contracts/admin-site-pages'
import type { SitePageSlug } from '../../../Contracts/site-pages'
import AdminSitePageEditor from './AdminSitePageEditor.vue'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const pages = shallowRef<Awaited<ReturnType<typeof readAdminSitePages>>>()
const selected = shallowRef<Awaited<ReturnType<typeof readAdminSitePage>>>()
const editor = ref<SitePageSlug>()
const busy = ref(false)
const error = ref<MessageKey | ''>('')
let active: AbortController | undefined

function clear() {
  active?.abort()
  active = undefined
  pages.value = undefined
  selected.value = undefined
  editor.value = undefined
  busy.value = false
  error.value = ''
}

async function read(slug?: SitePageSlug) {
  if (props.sessionSignal.aborted || busy.value) return
  const request = active = new AbortController()
  const signal = AbortSignal.any([request.signal, props.sessionSignal])
  selected.value = undefined
  editor.value = undefined
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
    else if (cause instanceof ApiError && cause.status === 403) error.value = 'admin.systemPermission'
    else error.value = 'admin.sitePageLoadFailed'
  } finally {
    if (active === request) { active = undefined; busy.value = false }
  }
}

watchAdminSessionClear(() => props.sessionSignal, clear)
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-site-pages-heading">
    <h2 id="admin-site-pages-heading">{{ t('admin.sitePages') }}</h2>
    <ElButton native-type="button" :loading="busy" @click="read()">{{ t('admin.checkSitePages') }}</ElButton>
    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" />
    <ul v-if="pages" class="site-pages-list">
      <li v-for="page in pages.pages" :key="page.slug">
        <strong>{{ page.title }}</strong> <code>/{{ page.slug }}</code>
        <span>{{ page.configured ? t('admin.configured') : t('admin.unconfigured') }}</span>
        <ElButton v-if="page.configured" :disabled="busy" native-type="button" text
          @click="read(page.slug)">{{ t('admin.viewPageContent', { slug: page.slug }) }}</ElButton>
        <ElButton v-if="pages.editor && page.configured" :disabled="busy" native-type="button" text
          @click="selected = undefined; editor = page.slug">{{ t('admin.editPageContent', { slug: page.slug }) }}</ElButton>
        <pre v-if="selected?.slug === page.slug" tabindex="0" :aria-label="t('admin.pageMarkdown', { slug: page.slug })">{{ selected.markdown }}</pre>
        <AdminSitePageEditor v-if="editor === page.slug" :key="page.slug" :slug="page.slug" :session-signal="sessionSignal"
          @session-lost="emit('session-lost', $event)" @close="editor = undefined" />
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
