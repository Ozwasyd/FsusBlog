<template>
  <main
    class="account-page write-article-wrapper account-motion-enter w-full"
    aria-labelledby="article-write-title"
    :aria-busy="pageLoading || submitting"
  >
    <el-form
      ref="formRef"
      :model="articleForm"
      :rules="rules"
      label-position="top"
      v-loading="pageLoading"
      element-loading-text="正在载入数据资源..."
      @submit.prevent="requestSubmit"
    >
      <div class="write-workspace">
      <header class="write-command-bar border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] py-6 px-4 mb-8" aria-label="文章编辑操作">
        <div class="min-w-0">
          <div class="account-page-eyebrow mb-2">管理 / CONTENT EDITING</div>
          <h1 id="article-write-title" class="write-command-title">{{ pageTitle }}</h1>
          <p id="article-editor-status" class="write-command-status" aria-live="polite">
            {{ editorStatusText }}
          </p>
        </div>
        <div class="shrink-0 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
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

      <div class="write-grid">
        <section class="write-editor-panel border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-content-label">
          <header class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">正文编辑器 / EDITOR</div>
          </header>
          <div class="overflow-hidden">
            <el-form-item prop="content">
              <ArticleWriteEditor
                v-model="articleForm.content"
                :loading="pageLoading"
                :saving="submitting"
                @save="requestSubmit"
                @upload-img="handleUploadImg"
              />
            </el-form-item>
          </div>
        </section>

        <aside class="write-side-panel" aria-label="发布与上传设置">
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
            class="mb-8"
          />

          <ArticleRevisionPanel
            :is-edit="isEdit"
            :revisions="articleRevisions"
            :selected-revision="selectedRevision"
            :selected-label="selectedRevisionLabel"
            :loading="revisionLoading"
            :rollbacking="revisionRollbacking"
            :status-text="revisionStatusText"
            :compare-text="revisionCompareText"
            class="mb-8"
            @refresh="() => refreshArticleRevisions()"
            @select-revision="selectArticleRevision"
            @rollback="rollbackSelectedRevision"
          />

          <ArticleSeoPreviewPanel
            :preview="seoPreview"
            :issues="seoIssues"
            :loading="seoChecking"
            :status-text="seoStatusText"
            class="mb-8"
            @refresh="refreshPrepublishCheck"
          />

          <ArticlePrivatePreviewPanel
            :html="privatePreview?.html ?? ''"
            :issues="privatePreview?.issues ?? []"
            :loading="privatePreviewLoading"
            :status-text="privatePreviewStatusText"
            :can-preview="canGeneratePrivatePreview"
            class="mb-8"
            @preview="generatePrivatePreview"
          />

          <ArticleAssetLibraryPanel
            :assets="assetLibrary"
            :loading="assetLibraryLoading"
            :status-text="assetLibraryStatusText"
            :can-reindex="isEdit"
            class="mb-8"
            @refresh="() => refreshAssetLibrary()"
            @reindex="reindexCurrentArticleAssets"
            @cleanup-orphans="cleanupAssetOrphans"
            @insert="insertAssetIntoContent"
          />

          <input
            ref="coverInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onCoverFileChange"
          />

          <details class="write-upload-disclosure border-t border-[var(--fsusblog-panel-border)]">
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
        </aside>
      </div>
      </div>
    </el-form>

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
import { computed, ref } from 'vue'
import ArticleAssetLibraryPanel from '@/components/admin/article/ArticleAssetLibraryPanel.vue'
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue'
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue'
import ArticleSeoPreviewPanel from '@/components/admin/article/ArticleSeoPreviewPanel.vue'
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'

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
const submitConfirmDialog = ref(false)
const leaveConfirmDialog = ref(false)

const triggerCoverInput = (): void => {
  coverInputRef.value?.click()
}

const onCoverFileChange = (event: Event): void => {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    void handleCoverUpload(Array.from(input.files))
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
