<template>
  <main
    class="account-page write-article-wrapper account-motion-enter w-full"
    aria-labelledby="article-write-title"
    :aria-busy="pageLoading || submitting"
  >
    <div
      class="write-workspace"
      :class="`write-workspace--${editorLayoutMode}`"
      v-loading="pageLoading"
      element-loading-text="正在载入数据资源..."
    >
      <header class="write-command-bar border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] py-6 px-4 mb-8" aria-label="文章编辑操作">
        <div class="min-w-0">
          <div class="account-page-eyebrow mb-2">管理 / CONTENT EDITING</div>
          <h1 id="article-write-title" class="write-command-title">{{ pageTitle }}</h1>
          <p id="article-editor-status" class="write-command-status" aria-live="polite">
            {{ editorStatusText }}
          </p>
        </div>
        <div class="shrink-0 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          <el-radio-group
            v-model="editorLayoutMode"
            size="small"
            aria-label="编辑器布局模式"
          >
            <el-radio-button value="standard">标准</el-radio-button>
            <el-radio-button value="focus">专注</el-radio-button>
            <el-radio-button value="fullscreen">全屏</el-radio-button>
          </el-radio-group>
          <el-button @click="requestLeave" :disabled="submitting">
            返回列表
          </el-button>
          <div class="write-submit-button">
            <el-button
              type="primary"
              :loading="submitting"
              @click="requestSubmit"
              aria-describedby="article-editor-status"
            >
              {{ submitButtonText }}
            </el-button>
          </div>
        </div>
      </header>

      <el-form
        ref="formRef"
        :model="articleForm"
        :rules="rules"
        class="write-validation-form"
        label-position="top"
        @submit.prevent="requestSubmit"
      >
      <section class="write-title-panel px-4 mb-12" aria-labelledby="article-title-label">
        <div
          v-if="pendingDraft"
          class="write-draft-banner border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] py-4 px-6 mb-8 flex items-center justify-between"
          role="status"
          aria-live="polite"
        >
          <div class="min-w-0">
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-color-warning-text)] mb-1">{{ pendingDraftSourceLabel }} / DRAFT</div>
            <p class="text-[11px] text-[var(--fsusblog-text-tertiary)]">
              {{ draftStatusText }}。{{ pendingDraftDescription }}
            </p>
          </div>
          <div class="write-draft-actions flex gap-4">
            <el-button type="primary" @click="restoreLocalDraft">
              {{ draftRestoreButtonText }}
            </el-button>
            <el-button @click="discardLocalDraft">
              {{ draftDiscardButtonText }}
            </el-button>
          </div>
        </div>

        <el-form-item prop="title">
          <template #label>
            <span id="article-title-label" class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">文章标题 / TITLE</span>
          </template>
          <div class="mt-4">
            <el-input
              v-model="articleForm.title"
              aria-label="文章标题"
              name="articleTitle"
              placeholder="在此键入博文标题..."
              size="large"
              maxlength="100"
              show-word-limit
              :disabled="submitting"
            />
          </div>
        </el-form-item>
      </section>

      <div class="write-grid" :class="{ 'write-grid--wide': editorLayoutMode !== 'standard' }">
        <section class="write-editor-panel border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-content-label">
          <header class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">正文编辑器 / EDITOR</div>
          </header>
          <div class="overflow-hidden">
            <el-form-item prop="content">
              <ArticleWriteEditor
                ref="articleEditorRef"
                v-model="articleForm.content"
                :loading="pageLoading"
                :saving="submitting"
                :layout-mode="editorLayoutMode"
                @save="saveDraftNow"
                @draft-save="saveDraftNow"
                @submit="requestSubmit"
                @upload-img="handleUploadImg"
              />
            </el-form-item>
          </div>
        </section>

        <aside v-if="editorLayoutMode === 'standard'" class="write-side-panel" aria-label="发布与上传设置">
          <el-tabs v-model="sidePanelTab" class="write-side-tabs" stretch>
            <el-tab-pane label="发布" name="publish" lazy>
              <ArticleWriteSidebar
                :form="articleForm"
                :categories="categories"
                :tags="tags"
                :submitting="submitting"
                :quick-creating-category="quickCreatingCategory"
                :quick-creating-tag="quickCreatingTag"
                :ai-assist="aiAssist"
                :ai-assist-loading="aiAssistLoading"
                :ai-assist-status-text="aiAssistStatusText"
                @auto-summary="autoGenerateSummary"
                @ai-assist="requestAiAssist"
                @apply-ai-summary="applyAiSummary"
                @apply-ai-title="applyAiTitleCandidate"
                @apply-ai-tags="applyAiSuggestedTags"
                @apply-ai-translation="applyAiTranslationDraft"
                @open-create-category="openQuickCreateCategory"
                @open-create-tag="openQuickCreateTag"
                @open-cover-upload="triggerCoverInput"
                @clear-cover="articleForm.coverImageUrl = ''"
              />
            </el-tab-pane>

            <el-tab-pane label="SEO" name="seo" lazy>
              <ArticleSeoPreviewPanel
                :preview="seoPreview"
                :issues="seoIssues"
                :loading="seoChecking"
                :status-text="seoStatusText"
                @refresh="refreshPrepublishCheck"
              />
            </el-tab-pane>

            <el-tab-pane label="资产" name="assets" lazy>
              <ArticleAssetLibraryPanel
                :assets="assetLibrary"
                :loading="assetLibraryLoading"
                :status-text="assetLibraryStatusText"
                :can-reindex="isEdit"
                @refresh="() => refreshAssetLibrary()"
                @reindex="reindexCurrentArticleAssets"
                @cleanup-orphans="cleanupAssetOrphans"
                @insert="insertAssetIntoEditor"
              />
            </el-tab-pane>

            <el-tab-pane label="版本" name="versions" lazy>
              <ArticleRevisionPanel
                :is-edit="isEdit"
                :revisions="articleRevisions"
                :selected-revision="selectedRevision"
                :selected-label="selectedRevisionLabel"
                :loading="revisionLoading"
                :rollbacking="revisionRollbacking"
                :status-text="revisionStatusText"
                :compare-text="revisionCompareText"
                @refresh="() => refreshArticleRevisions()"
                @select-revision="selectArticleRevision"
                @rollback="rollbackSelectedRevision"
              />
            </el-tab-pane>

            <el-tab-pane label="预览" name="preview" lazy>
              <ArticlePrivatePreviewPanel
                :html="privatePreview?.html ?? ''"
                :issues="privatePreview?.issues ?? []"
                :loading="privatePreviewLoading"
                :status-text="privatePreviewStatusText"
                :can-preview="canGeneratePrivatePreview"
                @preview="generatePrivatePreview"
              />
            </el-tab-pane>

            <el-tab-pane label="AI" name="ai" lazy>
              <section class="write-ai-panel border-t border-[var(--fsusblog-panel-border)]" aria-label="作者 AI 辅助">
                <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
                  <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">作者辅助 / AI</div>
                </header>
                <div class="p-6 space-y-5">
                  <p class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]" aria-live="polite">
                    {{ aiAssistStatusText || '按当前标题与正文生成摘要、标题候选、标签和结构建议。' }}
                  </p>
                  <div class="grid grid-cols-2 gap-3">
                    <el-button :disabled="submitting" @click="autoGenerateSummary">
                      生成摘要
                    </el-button>
                    <el-button type="primary" :loading="aiAssistLoading" :disabled="submitting || aiAssistLoading" @click="requestAiAssist">
                      AI 辅助
                    </el-button>
                  </div>
                  <div v-if="aiAssist" class="space-y-4 border-t border-[var(--fsusblog-panel-border)] pt-5">
                    <p v-if="aiAssist.suggestedSummary" class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]">
                      {{ aiAssist.suggestedSummary }}
                    </p>
                    <el-button v-if="aiAssist.suggestedSummary" size="small" :disabled="submitting" @click="applyAiSummary">
                      采用摘要
                    </el-button>
                    <div v-if="aiAssist.suggestedTags.length > 0" class="flex flex-wrap gap-2">
                      <el-tag v-for="tag in aiAssist.suggestedTags" :key="tag" size="small">{{ tag }}</el-tag>
                    </div>
                    <el-button v-if="aiAssist.suggestedTags.length > 0" size="small" :disabled="submitting" @click="applyAiSuggestedTags">
                      关联已有标签
                    </el-button>
                    <div v-if="aiAssist.titleCandidates.length > 0" class="grid gap-2">
                      <el-button
                        v-for="title in aiAssist.titleCandidates"
                        :key="title"
                        :disabled="submitting"
                        @click="applyAiTitleCandidate(title)"
                      >
                        <span class="min-w-0 whitespace-normal text-left leading-5">{{ title }}</span>
                      </el-button>
                    </div>
                    <el-button v-if="aiAssist.translationDraft" size="small" :disabled="submitting" @click="applyAiTranslationDraft">
                      采用翻译草稿
                    </el-button>
                  </div>
                </div>
              </section>
            </el-tab-pane>

            <el-tab-pane label="上传" name="upload" lazy>
              <details class="write-upload-disclosure border-t border-[var(--fsusblog-panel-border)]" open>
                <summary class="write-disclosure-summary px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)] cursor-pointer outline-none">
                  <div class="flex items-center justify-between">
                    <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">图片上传策略 / IMAGE POLICY</span>
                    <span class="text-[11px] font-bold text-[var(--fsusblog-text-muted)]" aria-live="polite">{{ imageUploadRuntime.statusText }}</span>
                  </div>
                </summary>
                <div class="p-6 bg-[var(--fsusblog-page-bg)]">
                  <ImageUploadOptionsPanel
                    :options="imageUploadOptions"
                    :status-text="imageUploadRuntime.statusText"
                    :can-abort="Boolean(imageUploadRuntime.activeSession.uploadId)"
                    :can-resume="imageUploadRuntime.canResume"
                    :preview="imageUploadRuntime.preview"
                    :wasm-only="imageUploadWasmOnlyMode"
                    :wasm-supported-formats="imageUploadRuntime.wasmSupportedFormats"
                    @update:options="setImageUploadOptions"
                    @update:wasm-only="setImageUploadWasmOnlyMode"
                    @reset="setImageUploadOptions({ format: 'webp', quality: 82, scaleRatio: 1, maxEdge: 1920, preserveAlpha: true })"
                    @resume="resumeImageUpload"
                    @abandon="imageUploadRuntime.abandon"
                  />
                </div>
              </details>
            </el-tab-pane>
          </el-tabs>

          <input
            ref="coverInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onCoverFileChange"
          />
        </aside>
      </div>
      </el-form>
    </div>

    <el-dialog
      v-model="quickCreateCategoryDialog"
      title="新建分类"
      width="min(92vw, 420px)"
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form label-position="top" @submit.prevent="submitQuickCreateCategory">
        <el-form-item label="分类名称">
          <el-input
            v-model="quickCategoryName"
            name="quickCategoryName"
            aria-label="分类名称"
            placeholder="请输入 2-20 个字符的名称"
            maxlength="20"
            show-word-limit
            :disabled="quickCreatingCategory"
            @keyup.enter="submitQuickCreateCategory"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="grid grid-cols-2 gap-4 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <el-button :disabled="quickCreatingCategory" @click="quickCreateCategoryDialog = false">
            取消
          </el-button>
          <el-button type="primary" :loading="quickCreatingCategory" @click="submitQuickCreateCategory">
            创建并选中
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="quickCreateTagDialog"
      title="新建标签"
      width="min(92vw, 420px)"
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form label-position="top" @submit.prevent="submitQuickCreateTag">
        <el-form-item label="标签名称">
          <el-input
            v-model="quickTagName"
            name="quickTagName"
            aria-label="标签名称"
            placeholder="标签名称（如：Vue3）"
            maxlength="20"
            show-word-limit
            :disabled="quickCreatingTag"
            @keyup.enter="submitQuickCreateTag"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="grid grid-cols-2 gap-4 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <el-button :disabled="quickCreatingTag" @click="quickCreateTagDialog = false">
            取消
          </el-button>
          <el-button type="primary" :loading="quickCreatingTag" @click="submitQuickCreateTag">
            创建并关联
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="submitConfirmDialog"
      :title="pageTitle === '编辑文章' ? '更新确认' : '发布确认'"
      width="min(92vw, 420px)"
      :close-on-click-modal="false"
    >
      <p class="text-sm text-[var(--fsusblog-text-secondary)]">{{ submitConfirmContent }}</p>
      <div v-if="prepublishWarningsNeedOverride" class="mt-5 space-y-3" aria-label="发布前警告跳过确认">
        <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">发布前警告 / WARNING OVERRIDE</div>
        <ul class="space-y-2">
          <li
            v-for="issue in prepublishWarningIssues"
            :key="`${issue.code}:${issue.message}`"
            class="text-xs leading-5 text-[var(--fsusblog-text-secondary)]"
          >
            {{ issue.message }}
          </li>
        </ul>
        <el-input
          v-model="prepublishWarningOverrideReason"
          type="textarea"
          :rows="3"
          maxlength="180"
          show-word-limit
          aria-label="发布警告跳过理由"
          placeholder="说明本次接受这些 warning 的原因，提交前会写入审计。"
          :disabled="submitting || seoChecking"
        />
      </div>
      <template #footer>
        <div class="grid grid-cols-2 gap-4 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <el-button :disabled="submitting" @click="submitConfirmDialog = false">
            继续编辑
          </el-button>
          <el-button type="primary" :loading="submitting || seoChecking" @click="confirmSubmit">
            {{ pageTitle === '编辑文章' ? '确认更新' : '确认发布' }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="leaveConfirmDialog"
      title="离开编辑器"
      width="min(92vw, 460px)"
      :close-on-click-modal="false"
    >
      <p class="text-sm text-[var(--fsusblog-text-secondary)]">当前内容已写入浏览器本地缓存。离开后未发布的改动不会提交到服务器，但回到编辑页可选择恢复本地缓存。</p>
      <template #footer>
        <div class="grid grid-cols-2 gap-4 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <el-button @click="leaveConfirmDialog = false">
            继续编辑
          </el-button>
          <el-button type="primary" @click="confirmLeave">
            确认离开
          </el-button>
        </div>
      </template>
    </el-dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ArticleAssetLibraryPanel from '@/components/admin/article/ArticleAssetLibraryPanel.vue'
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue'
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue'
import ArticleSeoPreviewPanel from '@/components/admin/article/ArticleSeoPreviewPanel.vue'
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'
import type { AssetLibraryItemResponse } from '@/api/authoring'

type EditorLayoutMode = 'standard' | 'focus' | 'fullscreen'

const route = useRoute()

const {
  formRef,
  pageLoading,
  submitting,
  categories,
  tags,
  assetLibrary,
  assetLibraryLoading,
  assetLibraryStatusText,
  isEdit,
  submitButtonText,
  submitConfirmContent,
  requiresLeaveConfirm,
  pendingDraft,
  draftStatusText,
  pendingDraftSourceLabel,
  pendingDraftDescription,
  draftRestoreButtonText,
  draftDiscardButtonText,
  articleRevisions,
  selectedRevision,
  selectedRevisionLabel,
  revisionLoading,
  revisionRollbacking,
  revisionStatusText,
  revisionCompareText,
  privatePreview,
  privatePreviewLoading,
  privatePreviewStatusText,
  canGeneratePrivatePreview,
  aiAssist,
  aiAssistLoading,
  aiAssistStatusText,
  seoPreview,
  seoIssues,
  prepublishWarningIssues,
  prepublishWarningsNeedOverride,
  prepublishWarningOverrideReason,
  seoChecking,
  seoStatusText,
  articleForm,
  rules,
  validateBeforeSubmit,
  saveDraftNow,
  handleUploadImg,
  handleCoverUpload,
  submitForm,
  restoreLocalDraft,
  discardLocalDraft,
  refreshArticleRevisions,
  selectArticleRevision,
  rollbackSelectedRevision,
  generatePrivatePreview,
  requestAiAssist,
  applyAiSummary,
  applyAiTitleCandidate,
  applyAiSuggestedTags,
  applyAiTranslationDraft,
  refreshPrepublishCheck,
  confirmPrepublishWarningOverride,
  refreshAssetLibrary,
  reindexCurrentArticleAssets,
  cleanupAssetOrphans,
  insertAssetIntoContent,
  quickCreateCategory,
  quickCreateTag,
  quickCreatingCategory,
  quickCreatingTag,
  autoGenerateSummary,
  imageUploadOptions,
  imageUploadWasmOnlyMode,
  setImageUploadWasmOnlyMode,
  setImageUploadOptions,
  imageUploadRuntime,
  resumeImageUpload,
  leaveEditor
} = useAdminArticleWrite()

void formRef

const pageTitle = computed(() => submitButtonText.value.includes('更新') ? '编辑文章' : '撰写文章')
const quickCreateCategoryDialog = ref(false)
const quickCreateTagDialog = ref(false)
const quickCategoryName = ref('')
const quickTagName = ref('')
const coverInputRef = ref<HTMLInputElement | null>(null)
const articleEditorRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean } | null>(null)
const submitConfirmDialog = ref(false)
const leaveConfirmDialog = ref(false)
const sidePanelTab = ref(route.query.preview === 'private' ? 'preview' : 'publish')
const editorLayoutMode = ref<EditorLayoutMode>('standard')
const assetLibraryLoaded = ref(false)
const revisionsLoaded = ref(false)

const triggerCoverInput = (): void => {
  coverInputRef.value?.click()
}

watch(sidePanelTab, (tab) => {
  if (tab === 'assets' && !assetLibraryLoaded.value) {
    assetLibraryLoaded.value = true
    void refreshAssetLibrary()
  }

  if (tab === 'versions' && !revisionsLoaded.value) {
    revisionsLoaded.value = true
    void refreshArticleRevisions()
  }
}, { immediate: true })

const onCoverFileChange = (event: Event): void => {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    const files = Array.from(input.files)
    const previousCoverUrl = articleForm.coverImageUrl
    void (async () => {
      await handleCoverUpload(files)
      if (articleForm.coverImageUrl && articleForm.coverImageUrl !== previousCoverUrl) {
        sidePanelTab.value = 'publish'
      }
    })()
    // 重置 input 以允许再次选择同一文件
    input.value = ''
  }
}

const editorStatusText = computed(() => {
  if (pageLoading.value) {
    return '正在载入文章、分类与标签资源'
  }

  if (submitting.value) {
    return '正在提交文章内容，请保持页面打开'
  }

  return `正文 ${articleForm.content.length} 字符，标题 ${articleForm.title.length}/100`
})

const requestSubmit = async (): Promise<void> => {
  const isValid = await validateBeforeSubmit()
  if (isValid) {
    submitConfirmDialog.value = true
  }
}

const insertAssetIntoEditor = (asset: AssetLibraryItemResponse): void => {
  insertAssetIntoContent(asset, (markdown) => articleEditorRef.value?.insertMarkdownAtCursor?.(markdown) === true)
}

const confirmSubmit = async (): Promise<void> => {
  const warningOverrideReady = await confirmPrepublishWarningOverride()
  if (!warningOverrideReady) {
    return
  }

  submitConfirmDialog.value = false
  await submitForm()
}

const requestLeave = (): void => {
  if (requiresLeaveConfirm.value) {
    leaveConfirmDialog.value = true
    return
  }

  leaveEditor()
}

const confirmLeave = (): void => {
  leaveConfirmDialog.value = false
  leaveEditor()
}

const openQuickCreateCategory = (): void => {
  quickCategoryName.value = ''
  quickCreateCategoryDialog.value = true
}

const openQuickCreateTag = (): void => {
  quickTagName.value = ''
  quickCreateTagDialog.value = true
}

const submitQuickCreateCategory = async (): Promise<void> => {
  const created = await quickCreateCategory(quickCategoryName.value)
  if (created) {
    quickCreateCategoryDialog.value = false
  }
}

const submitQuickCreateTag = async (): Promise<void> => {
  const created = await quickCreateTag(quickTagName.value)
  if (created) {
    quickCreateTagDialog.value = false
  }
}
</script>

<style scoped>
.write-workspace {
  display: flex;
  flex-direction: column;
}

.write-command-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
}

.write-command-title {
  color: var(--fsusblog-text-primary);
  font-size: 2rem;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: 0;
}

.write-command-status {
  margin-top: 0.5rem;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.78rem;
  line-height: 1.5;
}

.write-submit-button {
  display: grid;
  min-width: 8rem;
}

.write-grid {
  display: grid;
  align-items: start;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, 24rem);
  gap: 2rem;
  padding: 0 1rem;
}

.write-grid--wide {
  grid-template-columns: minmax(0, 1fr);
}

.write-editor-panel {
  min-width: 0;
}

.write-side-panel {
  position: sticky;
  top: 6rem;
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.write-side-tabs {
  min-width: 0;
  border-top: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.write-workspace--focus .write-command-bar,
.write-workspace--fullscreen .write-command-bar {
  margin-bottom: 1.5rem;
}

.write-workspace--fullscreen .write-title-panel {
  margin-bottom: 1.5rem;
}

.write-disclosure-summary::-webkit-details-marker {
  display: none;
}

@media (max-width: 1024px) {
  .write-command-bar,
  .write-grid,
  .write-side-panel {
    position: static;
  }

  .write-command-bar {
    align-items: stretch;
    flex-direction: column;
  }

  .write-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
}
</style>
