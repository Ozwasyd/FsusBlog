<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onMounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInlineActions, ElResourceList, ElResourceListItem, ElSettingsSection, ElTag } from '@ozwasyd/element-plus'
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

async function read(slug?: SitePageSlug, force = true) {
  if (props.sessionSignal.aborted || (!force && busy.value)) return
  active?.abort()
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
    else if (force || !(cause instanceof ApiError && cause.status === 403)) error.value = 'admin.sitePageLoadFailed'
  } finally {
    if (active === request) { active = undefined; busy.value = false }
  }
}

watchAdminSessionClear(() => props.sessionSignal, clear)
onMounted(() => { void read(undefined, false) })
</script>

<template>
  <ElSettingsSection ariaLabelledby="admin-site-pages-heading" density="compact">
    <template #title>
      <span id="admin-site-pages-heading">{{ t('admin.sitePages') }}</span>
    </template>
    <template #actions>
      <ElButton native-type="button" :loading="busy" @click="read(undefined, true)">{{ t('admin.checkSitePages') }}</ElButton>
    </template>
    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" />
    <ElResourceList v-if="pages" class="site-pages-list" density="compact">
      <ElResourceListItem v-for="page in pages.pages" :key="page.slug" :title="page.title">
        <template #badge>
          <ElTag size="small" :type="page.configured ? 'success' : 'info'">
            {{ page.configured ? t('admin.configured') : t('admin.unconfigured') }}
          </ElTag>
        </template>
        <template #meta>
          <code>/{{ page.slug }}</code>
        </template>
        <template #actions>
          <ElInlineActions>
            <ElButton v-if="page.configured" :disabled="busy" native-type="button" text
              @click="read(page.slug)">{{ t('admin.viewPageContent', { slug: page.slug }) }}</ElButton>
            <ElButton v-if="pages.editor && page.configured" :disabled="busy" native-type="button" text
              @click="selected = undefined; editor = page.slug">{{ t('admin.editPageContent', { slug: page.slug }) }}</ElButton>
          </ElInlineActions>
        </template>
        <pre
          v-if="selected?.slug === page.slug"
          class="site-page-preview"
          tabindex="0"
          :aria-label="t('admin.pageMarkdown', { slug: page.slug })"
        >{{ selected.markdown }}</pre>
        <AdminSitePageEditor
          v-if="editor === page.slug"
          :key="page.slug"
          :slug="page.slug"
          :session-signal="sessionSignal"
          @session-lost="emit('session-lost', $event)"
          @close="editor = undefined"
        />
      </ElResourceListItem>
    </ElResourceList>
  </ElSettingsSection>
</template>

<style scoped>
.site-page-preview {
  margin: 8px 0 0;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
  color: var(--el-text-color-primary);
  font-size: var(--el-font-size-small);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 20rem;
  overflow: auto;
}
</style>
