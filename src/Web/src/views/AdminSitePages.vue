<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  ElAlert,
  ElButton,
  ElInlineActions,
  ElMarkdownRenderer,
  ElRadioButton,
  ElRadioGroup,
  ElResourceList,
  ElResourceListItem,
  ElSettingsSection,
  ElSkeleton,
  ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminSitePage, readAdminSitePages } from '../../../Contracts/admin-site-pages'
import type { SitePageSlug } from '../../../Contracts/site-pages'
import AdminSitePageEditor from './AdminSitePageEditor.vue'
import { useDelayedBusy } from '../delayedBusy'
import { watchAdminSessionClear } from './adminSessionClear'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const nativeMarkdown = Boolean(import.meta.env.FSUS_MARKDOWN_NATIVE)
const configuredPublicOrigin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''

const pages = shallowRef<Awaited<ReturnType<typeof readAdminSitePages>>>()
const selected = shallowRef<Awaited<ReturnType<typeof readAdminSitePage>>>()
const readOnlyMode = ref<'source' | 'preview'>('source')
const editor = ref<SitePageSlug>()
const busy = ref(false)
const refreshLoading = useDelayedBusy(() => busy.value)
const readingSlug = ref<SitePageSlug>()
const error = ref<MessageKey | ''>('')
let active: AbortController | undefined

const sectionDescription = computed(() => {
  if (!pages.value) return ''
  return pages.value.editor ? t('admin.sitePages.editorDesc') : t('admin.sitePages.readOnlyDesc')
})

function publicHref(slug: SitePageSlug): string {
  const origin = configuredPublicOrigin.replace(/\/+$/, '')
  return origin ? `${origin}/${slug}` : `/${slug}`
}

function pageTitle(slug: SitePageSlug): string {
  return t(`policy.${slug}` as MessageKey)
}

function clear() {
  active?.abort()
  active = undefined
  pages.value = undefined
  selected.value = undefined
  editor.value = undefined
  busy.value = false
  readingSlug.value = undefined
  error.value = ''
}

async function readOverview(force = true) {
  if (props.sessionSignal.aborted || (!force && busy.value)) return
  active?.abort()
  const request = active = new AbortController()
  const signal = AbortSignal.any([request.signal, props.sessionSignal])
  error.value = ''
  busy.value = true
  try {
    const overview = await readAdminSitePages(signal)
    if (signal.aborted) return
    pages.value = overview
    if (!overview.editor) editor.value = undefined
    if (selected.value && !overview.pages.some(item => item.slug === selected.value?.slug && item.configured)) {
      selected.value = undefined
    }
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (force || !(cause instanceof ApiError && cause.status === 403)) error.value = 'admin.sitePageLoadFailed'
  } finally {
    if (active === request) { active = undefined; busy.value = false }
  }
}

async function toggleReadOnlyView(slug: SitePageSlug) {
  if (selected.value?.slug === slug) {
    selected.value = undefined
    return
  }
  if (props.sessionSignal.aborted) return
  active?.abort()
  const request = active = new AbortController()
  const signal = AbortSignal.any([request.signal, props.sessionSignal])
  error.value = ''
  readingSlug.value = slug
  try {
    const page = await readAdminSitePage(slug, signal)
    if (!signal.aborted) {
      selected.value = page
      readOnlyMode.value = 'source'
    }
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else error.value = 'admin.sitePageLoadFailed'
  } finally {
    if (active === request) { active = undefined; readingSlug.value = undefined }
  }
}

function toggleEditor(slug: SitePageSlug) {
  selected.value = undefined
  editor.value = editor.value === slug ? undefined : slug
}

function markPublished(slug: SitePageSlug) {
  const current = pages.value
  if (!current) return
  pages.value = {
    ...current,
    pages: current.pages.map(item => item.slug === slug ? { ...item, configured: true } : item),
  }
}

watchAdminSessionClear(() => props.sessionSignal, clear)
onMounted(() => { void readOverview(false) })
</script>

<template>
  <ElSettingsSection
    class="admin-site-pages"
    ariaLabelledby="admin-site-pages-heading"
    :description="sectionDescription || undefined"
    density="compact"
  >
    <template #title>
      <span id="admin-site-pages-heading">{{ t('admin.sitePages') }}</span>
    </template>
    <template #actions>
      <ElButton :loading="refreshLoading" @click="readOverview(true)">{{ t('admin.sitePages.refresh') }}</ElButton>
    </template>

    <ElAlert v-if="error" :title="t(error)" :closable="false" type="error" show-icon />

    <div v-if="busy && !pages" class="site-pages-loading" role="status">
      <p>{{ t('admin.sitePages.loading') }}</p>
      <ElSkeleton :rows="4" />
    </div>

    <ElResourceList v-else-if="pages" class="site-pages-list" density="compact">
      <ElResourceListItem v-for="page in pages.pages" :key="page.slug" :title="pageTitle(page.slug)">
        <template #badge>
          <ElTag size="small" :type="page.configured ? 'success' : 'info'">
            {{ page.configured ? t('admin.configured') : t('admin.unconfigured') }}
          </ElTag>
        </template>
        <template #meta>
          <span class="site-page-meta">
            <code>/{{ page.slug }}</code>
            <a
              v-if="page.configured"
              class="site-page-public-link"
              :href="publicHref(page.slug)"
              target="_blank"
              rel="noopener noreferrer"
            >{{ t('admin.sitePages.openPublic') }} ↗</a>
          </span>
        </template>
        <template #actions>
          <ElInlineActions>
            <template v-if="pages.editor">
              <ElButton
                :type="!page.configured && editor !== page.slug ? 'primary' : undefined"
                :disabled="busy"
                text
                v-bind="{
                  'aria-label': editor === page.slug ? t('admin.closeEditor') : t('admin.editPageContent', { slug: page.slug }),
                  'aria-expanded': editor === page.slug,
                }"
                @click="toggleEditor(page.slug)"
              >
                {{ editor === page.slug ? t('admin.sitePages.close') : page.configured ? t('admin.sitePages.edit') : t('admin.sitePages.create') }}
              </ElButton>
            </template>
            <template v-else-if="page.configured">
              <ElButton
                :loading="readingSlug === page.slug"
                :disabled="busy"
                text
                v-bind="{
                  'aria-label': selected?.slug === page.slug ? t('admin.sitePages.close') : t('admin.viewPageContent', { slug: page.slug }),
                  'aria-expanded': selected?.slug === page.slug,
                }"
                @click="toggleReadOnlyView(page.slug)"
              >
                {{ selected?.slug === page.slug ? t('admin.sitePages.close') : t('admin.sitePages.view') }}
              </ElButton>
            </template>
            <span v-else class="site-page-readonly-note">{{ t('admin.sitePages.readOnlyUnconfigured') }}</span>
          </ElInlineActions>
        </template>
      </ElResourceListItem>
    </ElResourceList>

    <div v-if="pages && !pages.editor && selected" class="site-page-readonly-panel">
      <div class="site-page-readonly-bar">
        <div class="site-page-readonly-heading">
          <strong>{{ pageTitle(selected.slug) }}</strong>
          <code>/{{ selected.slug }}</code>
        </div>
        <div class="site-page-readonly-controls">
          <ElRadioGroup
            v-if="nativeMarkdown"
            :model-value="readOnlyMode"
            size="small"
            :label="t('admin.sitePages.viewMode')"
            @update:model-value="readOnlyMode = $event === 'preview' ? 'preview' : 'source'"
          >
            <ElRadioButton value="source">{{ t('admin.sitePages.modeSource') }}</ElRadioButton>
            <ElRadioButton value="preview">{{ t('admin.sitePages.modePreview') }}</ElRadioButton>
          </ElRadioGroup>
          <ElButton text size="small" @click="selected = undefined">{{ t('admin.sitePages.close') }}</ElButton>
        </div>
      </div>
      <div v-if="nativeMarkdown && readOnlyMode === 'preview'" class="site-page-readonly-rendered blog-markdown">
        <ElMarkdownRenderer :content="selected.markdown" mode="preview" />
      </div>
      <pre
        v-else
        class="site-page-preview"
        tabindex="0"
        :aria-label="t('admin.pageMarkdown', { slug: selected.slug })"
      >{{ selected.markdown }}</pre>
    </div>

    <AdminSitePageEditor
      v-if="pages?.editor && editor"
      :key="editor"
      :slug="editor"
      :title="pageTitle(editor)"
      :configured="pages.pages.some(item => item.slug === editor && item.configured)"
      :public-href="publicHref(editor)"
      :session-signal="sessionSignal"
      @session-lost="emit('session-lost', $event)"
      @published="markPublished(editor)"
      @close="editor = undefined"
    />
  </ElSettingsSection>
</template>

<style scoped>
.site-pages-loading {
  display: grid;
  gap: 10px;
}

.site-pages-loading p {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.site-page-meta {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
}

.site-page-public-link {
  font-size: var(--el-font-size-extra-small);
  color: var(--el-text-color-secondary);
  text-decoration: none;
}

.site-page-public-link:hover,
.site-page-public-link:focus-visible {
  color: var(--el-color-primary);
  text-decoration: underline;
}

.site-page-readonly-note {
  font-size: var(--el-font-size-extra-small);
  color: var(--el-text-color-placeholder);
}

.site-page-readonly-panel {
  display: grid;
  gap: 10px;
  margin-block: 10px 4px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 10px);
  background: var(--el-bg-color);
}

.site-page-readonly-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.site-page-readonly-heading,
.site-page-readonly-controls {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.site-page-readonly-heading code {
  font-size: var(--el-font-size-extra-small);
  color: var(--el-text-color-secondary);
}

.site-page-readonly-rendered {
  padding: 4px 2px;
  max-block-size: 24rem;
  overflow: auto;
}

.site-page-preview {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: var(--el-font-size-small);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-block-size: 22rem;
  overflow: auto;
}
</style>
