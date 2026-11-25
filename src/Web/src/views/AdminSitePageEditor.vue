<script setup lang="ts">
import { siteLocale, t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import {
  ElAlert, ElButton, ElCheckbox, ElFormSection, ElInlineActions, ElInput, ElMarkdownRenderer,
  ElRadioButton, ElRadioGroup, ElSkeleton, ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { publishAdminSitePage, readSitePageRevision, validPageMarkdown } from '../../../Contracts/admin-site-pages'
import type { SitePageSlug } from '../../../Contracts/site-pages'
import { WireLimits } from '../../../Contracts/wire.generated'
import { useMediaQuery } from '../delayedBusy'
import { isAdminSessionLost } from './adminSessionClear'

type ViewMode = 'split' | 'edit' | 'preview'

const props = defineProps<{
  slug: SitePageSlug
  title: string
  configured: boolean
  publicHref: string
  sessionSignal: AbortSignal
}>()

const emit = defineEmits<{
  'session-lost': [error: unknown]
  published: []
  close: []
}>()

const nativeMarkdown = Boolean(import.meta.env.FSUS_MARKDOWN_NATIVE)
const utf8 = new TextEncoder()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])

const page = shallowRef<Awaited<ReturnType<typeof readSitePageRevision>>>()
const markdown = ref('')
const confirmed = ref(false)
const busy = ref(false)
const stale = ref(false)
const error = ref<MessageKey | ''>('')
const updated = ref(false)

const narrowViewport = useMediaQuery('(max-width: 860px)')
const selectedMode = ref<ViewMode>(narrowViewport.value ? 'edit' : 'split')
const effectiveMode = computed<ViewMode>(() => (narrowViewport.value && selectedMode.value === 'split' ? 'edit' : selectedMode.value))

const byteLength = computed(() => utf8.encode(markdown.value).length)
const valid = computed(() => validPageMarkdown(markdown.value))
const dirty = computed(() => Boolean(page.value) && markdown.value !== page.value!.markdown)
const canPublish = computed(() => Boolean(page.value) && !busy.value && !stale.value && valid.value && dirty.value && confirmed.value)

const revisionTagType = computed(() => (page.value && page.value.revision > 0n ? 'success' : 'info'))
const revisionLabel = computed(() => {
  if (!page.value) return ''
  if (page.value.revision > 0n) return t('admin.sitePages.publishedRev', { revision: page.value.revision.toString() })
  return props.configured ? t('admin.sitePages.baselineRev') : t('admin.sitePages.newRev')
})

const canInsertTemplate = computed(() =>
  Boolean(page.value) && page.value!.revision === 0n && !props.configured && markdown.value.trim().length === 0)

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

const byteBudgetLabel = computed(() =>
  t('admin.sitePages.bytesBudget', {
    used: formatBytes(byteLength.value),
    limit: `${Math.round(WireLimits.PageContentBytes / 1024)} KB`,
  }))

const starterTemplates: Record<'zh-CN' | 'en', Record<SitePageSlug, string>> = {
  'zh-CN': {
    about: '这里介绍站点的写作主题、作者背景与联系方式。\n\n## 内容方向\n\n- 长期记录技术实践与阅读笔记\n- 坚持原创与可验证发布\n\n## 联系与反馈\n\n欢迎通过站点页脚邮箱或站内信与我们交流。\n',
    privacy: '本站遵循最小化收集原则，不使用第三方广告追踪脚本。\n\n## 我们处理的数据\n\n- **阅读访问**：无需登录即可浏览全部公开文章，站点仅保留匿名聚合指标。\n- **账户与通行密钥**：读者账户仅保存登录与安全校验所需的最小凭据信息。\n- **评论与站内信**：仅用于展示互动内容及必要的反垃圾防护。\n\n## 您的权利\n\n您可以随时联系站点运营方咨询或请求处理您的公开互动记录。\n',
    guidelines: '欢迎理性、友善的交流与讨论。参与评论和互动时请遵守以下约定：\n\n## 社区准则\n\n1. **尊重他人**：就事论事，不进行人身攻击、骚扰或恶意灌水。\n2. **尊重版权**：引用他人作品请注明出处与授权许可。\n3. **安全合规**：不发布违法违规内容、钓鱼链接或未经授权的隐私信息。\n',
    copyright: '除特别注明外，本站原创文章均保留作者署名权，并依据页脚或文末标注的许可协议对外授权。\n\n## 转载与引用\n\n- 合理引用请保留原文标题、作者署名与原始链接。\n- 商业用途或全文转载前，请先通过公开联系邮箱取得授权。\n',
  },
  en: {
    about: 'Introduce the publication, editorial focus, and how readers can reach you.\n\n## Focus\n\n- Long-form notes, engineering essays, and reading journals\n- Verifiable, privacy-respecting publishing\n\n## Contact\n\nReach out via the public contact email listed in the site footer.\n',
    privacy: 'This site follows a data-minimization approach and does not load third-party ad trackers.\n\n## Information We Process\n\n- **Reading**: Public articles require no account; traffic metrics remain aggregate and tracker-free.\n- **Accounts & Passkeys**: Only minimal credentials required for Passkey authentication and session security are stored.\n- **Comments & Messages**: Processed solely to display reader discussions and prevent automated abuse.\n',
    guidelines: 'Thoughtful, constructive discussion is always welcome:\n\n## Community Standards\n\n1. **Be respectful**: Focus on ideas rather than personal attacks or spam.\n2. **Credit sources**: Attribute quoted work and follow stated content licenses.\n3. **Stay safe**: Do not post unlawful material, phishing links, or private personal data.\n',
    copyright: 'Unless explicitly noted otherwise, original articles on this site are licensed under the terms displayed in the site footer or article metadata.\n\n## Attribution & Reuse\n\n- Include the article title, author attribution, and canonical URL when quoting.\n- Contact the site operator before commercial reuse or full republication.\n',
  },
}

function insertStarterTemplate() {
  const locale = siteLocale.value === 'en' ? 'en' : 'zh-CN'
  markdown.value = starterTemplates[locale][props.slug]
  confirmed.value = false
  updated.value = false
}

function discardChanges() {
  if (!page.value) return
  markdown.value = page.value.markdown
  confirmed.value = false
  error.value = ''
}

function setMode(value: string | number | boolean | undefined) {
  if (value === 'split' || value === 'edit' || value === 'preview') selectedMode.value = value
}

async function load() {
  await run(async () => {
    const revision = await readSitePageRevision(props.slug, signal)
    if (signal.aborted) return
    page.value = revision
    markdown.value = revision.markdown
    stale.value = false
    updated.value = false
  })
}

async function publish() {
  if (!canPublish.value || !page.value) return
  const { revision, digest } = page.value
  const content = markdown.value
  await run(async () => {
    await publishAdminSitePage({ slug: props.slug, expectedRevision: revision, expectedDigest: digest, markdown: content }, signal)
    if (signal.aborted) return
    updated.value = true
    emit('published')
    // A new read is needed before the next change. Preserve the text if that read fails.
    stale.value = true
    const next = await readSitePageRevision(props.slug, signal)
    if (signal.aborted) return
    page.value = next
    markdown.value = next.markdown
    stale.value = false
  })
}

async function run(action: () => Promise<void>) {
  if (busy.value || signal.aborted) return
  error.value = ''
  confirmed.value = false
  busy.value = true
  try {
    await action()
  } catch (cause) {
    if (signal.aborted) return
    if (isAdminSessionLost(cause)) {
      emit('session-lost', cause)
    } else if (cause instanceof ApiError && cause.status === 409) {
      stale.value = true
      updated.value = false
      error.value = 'admin.sitePageConflict'
    } else if (cause instanceof Error && cause.name === 'NotAllowedError') {
      error.value = 'admin.passkeyCanceled'
    } else {
      error.value = 'admin.sitePageRequestFailed'
    }
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section class="site-page-editor" :aria-label="t('admin.editPageContent', { slug })" :aria-busy="busy">
    <ElFormSection density="compact">
      <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" show-icon />
      <ElAlert v-if="updated" :title="t('admin.pagePublished', { slug })" type="success" :closable="false" show-icon>
        <a class="site-page-published-link" :href="publicHref" target="_blank" rel="noopener noreferrer">{{ t('admin.sitePages.openPublic') }} /{{ slug }} ↗</a>
      </ElAlert>
      <ElSkeleton v-if="busy && !page" :rows="5" />

      <template v-if="page">
        <div class="site-page-editor-bar">
          <div class="site-page-editor-meta">
            <strong class="site-page-editor-title">{{ title }}</strong>
            <code class="site-page-editor-slug">/{{ slug }}</code>
            <ElTag size="small" :type="revisionTagType">{{ revisionLabel }}</ElTag>
            <span class="site-page-budget" :class="{ 'site-page-budget--over': !valid }">{{ byteBudgetLabel }}</span>
            <ElButton v-if="canInsertTemplate" text size="small" :disabled="busy" @click="insertStarterTemplate">{{ t('admin.sitePages.insertTemplate') }}</ElButton>
          </div>
          <ElRadioGroup :model-value="effectiveMode" size="small" :label="t('admin.sitePages.viewMode')" @update:model-value="setMode">
            <ElRadioButton v-if="!narrowViewport" value="split">{{ t('admin.sitePages.modeSplit') }}</ElRadioButton>
            <ElRadioButton value="edit">{{ t('admin.sitePages.modeEdit') }}</ElRadioButton>
            <ElRadioButton value="preview">{{ t('admin.sitePages.modePreview') }}</ElRadioButton>
          </ElRadioGroup>
        </div>

        <div class="site-page-workspace" :class="{ 'site-page-workspace--split': effectiveMode === 'split' }">
          <div v-show="effectiveMode !== 'preview'" class="site-page-pane">
            <label :for="`site-page-editor-${slug}`" class="site-page-pane-label">{{ t('admin.pageMarkdownEditor', { slug }) }}</label>
            <ElInput :id="`site-page-editor-${slug}`" v-model="markdown" class="site-page-textarea" type="textarea"
              :autosize="{ minRows: 12, maxRows: 24 }" :placeholder="t('admin.sitePages.placeholder')"
              v-bind="{ maxlength: WireLimits.PageContentChars, 'aria-invalid': valid ? 'false' : 'true', 'aria-describedby': !valid ? `site-page-size-error-${slug}` : undefined }"
              :disabled="busy" @input="confirmed = false; updated = false" />
          </div>

          <div v-if="effectiveMode !== 'edit'" class="site-page-pane">
            <span class="site-page-pane-label">{{ t('admin.sitePages.previewLabel') }}</span>
            <div class="site-page-preview-surface blog-markdown">
              <p v-if="markdown.trim().length === 0" class="site-page-preview-empty">{{ t('admin.sitePages.previewEmpty') }}</p>
              <ElMarkdownRenderer v-else-if="nativeMarkdown" :content="markdown" mode="preview" />
              <pre v-else class="site-page-preview-fallback">{{ markdown }}</pre>
            </div>
          </div>
        </div>

        <ElAlert v-if="!valid" v-bind="{ id: `site-page-size-error-${slug}` }" :title="t('admin.markdownTooLarge')" type="warning" :closable="false" show-icon />

        <div class="site-page-commit">
          <div v-if="dirty" class="site-page-dirty-row"><ElTag size="small" type="warning">{{ t('admin.siteConfig.unsaved') }}</ElTag></div>
          <ElCheckbox v-if="!stale" :model-value="confirmed" :disabled="busy" @update:model-value="confirmed = $event === true">
            {{ t('admin.replacePublicPage', { slug }) }}
          </ElCheckbox>
          <ElInlineActions>
            <ElButton v-if="!stale" type="primary" :loading="busy" :disabled="!canPublish" @click="publish">{{ t('admin.publishPasskey') }}</ElButton>
            <ElButton v-if="dirty && !stale" :disabled="busy" @click="discardChanges">{{ t('admin.sitePages.discard') }}</ElButton>
            <ElButton v-if="stale" :loading="busy" @click="load">{{ t('admin.reloadPublished') }}</ElButton>
            <ElButton :disabled="busy" @click="emit('close')">{{ t('admin.closeEditor') }}</ElButton>
          </ElInlineActions>
        </div>
      </template>

      <ElInlineActions v-else-if="!busy">
        <ElButton @click="load">{{ t('admin.reloadPublished') }}</ElButton>
        <ElButton @click="emit('close')">{{ t('admin.closeEditor') }}</ElButton>
      </ElInlineActions>
    </ElFormSection>
  </section>
</template>

<style scoped>
.site-page-editor { margin-block: 12px 4px; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--fsus-radius-panel, 10px); background: var(--el-bg-color); }
.site-page-published-link { display: inline-block; margin-block-start: 4px; font-size: var(--el-font-size-small); color: var(--el-color-primary); text-decoration: none; }
.site-page-published-link:hover, .site-page-published-link:focus-visible { text-decoration: underline; }
.site-page-editor-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.site-page-editor-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.site-page-editor-title { font-size: var(--el-font-size-base); font-weight: 600; color: var(--el-text-color-primary); }
.site-page-editor-slug { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.site-page-budget { font-size: var(--el-font-size-extra-small); font-variant-numeric: tabular-nums; color: var(--el-text-color-secondary); }
.site-page-budget--over { color: var(--el-color-danger); font-weight: 600; }
.site-page-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.site-page-workspace--split { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
.site-page-pane { display: flex; flex-direction: column; gap: 6px; min-inline-size: 0; }
.site-page-pane-label { font-size: var(--el-font-size-extra-small); font-weight: 500; color: var(--el-text-color-secondary); }
.site-page-textarea { flex: 1; }
.site-page-preview-surface { flex: 1; min-block-size: 17.5rem; max-block-size: 34rem; overflow: auto; padding: 12px 14px; border: 1px solid var(--el-border-color); border-radius: var(--el-border-radius-base); background: var(--el-fill-color-blank); }
.site-page-preview-empty { margin: 0; font-size: var(--el-font-size-small); color: var(--el-text-color-placeholder); }
.site-page-preview-fallback { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--el-font-size-small); line-height: 1.55; }
.site-page-commit { display: grid; gap: 10px; padding-block-start: 12px; border-block-start: 1px solid var(--el-border-color-lighter); }
.site-page-dirty-row { display: flex; align-items: center; }
</style>
