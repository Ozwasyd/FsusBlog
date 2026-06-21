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
      <header class="write-command-bar border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-4 py-3 mb-6" aria-label="文章编辑操作">
        <el-button text @click="requestLeave" :disabled="submitting">
          返回
        </el-button>
        <div class="min-w-0">
          <h1 id="article-write-title" class="write-command-title">{{ pageTitle }}</h1>
          <p id="article-editor-status" class="write-command-status" aria-live="polite">
            {{ editorStatusText }}
          </p>
        </div>
        <div class="shrink-0 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          <div class="write-layout-control">
            <el-dropdown trigger="click" @command="setEditorLayoutMode">
              <el-button aria-label="切换编辑视图">
                视图：{{ editorLayoutModeLabel }}
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="standard">编写</el-dropdown-item>
                  <el-dropdown-item command="focus">专注写作</el-dropdown-item>
                  <el-dropdown-item command="fullscreen">全屏写作</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <el-button @click="openPreviewInspector" :disabled="submitting">
            预览
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
        class="write-validation-form blog-motion-task-region"
        :class="{
          'blog-motion-task-region--pending': taskFeedbackBusy,
          'blog-motion-task-region--settled': isTaskHighlighted('article-submit')
            || isTaskHighlighted('article-prepublish')
            || isTaskHighlighted('article-revision')
            || isTaskHighlighted('article-assets')
        }"
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
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-color-warning-text)] mb-1">{{ pendingDraftSourceLabel }}</div>
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
            <span id="article-title-label" class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">标题</span>
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
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">正文</div>
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

        <aside v-if="editorLayoutMode === 'standard'" class="write-side-panel" aria-label="文章检查器">
          <div class="write-inspector">
            <ArticleWriteSidebar
              :form="articleForm"
              :categories="categories"
              :tags="tags"
              :submitting="submitting"
              :quick-creating-category="quickCreatingCategory"
              :quick-creating-tag="quickCreatingTag"
              @open-create-category="openQuickCreateCategory"
              @open-create-tag="openQuickCreateTag"
              @open-cover-upload="triggerCoverInput"
              @clear-cover="articleForm.coverImageUrl = ''"
            />

            <details
              class="write-inspector-section"
              :open="checkInspectorOpen || seoIssues.length > 0 || Boolean(aiAssist)"
              @toggle="onCheckInspectorToggle"
            >
              <summary class="write-inspector-summary">
                <span>内容检查</span>
                <span>摘要、标题、标签和结构建议</span>
              </summary>
              <ArticleSeoPreviewPanel
                :preview="seoPreview"
                :issues="seoIssues"
                :loading="seoChecking"
                :status-text="seoStatusText"
                @refresh="refreshPrepublishCheck"
              />
              <section
                class="write-content-check-panel border-t border-[var(--fsusblog-panel-border)]"
                data-author-content-check-panel="true"
                aria-label="内容检查"
              >
                <header class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)]">
                  <div class="text-[13px] font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">内容检查</div>
                </header>
                <div class="p-6 space-y-5">
                  <p class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]" aria-live="polite">
                    {{ aiAssistStatusText || '生成可选摘要建议、标题备选和标签匹配。建议仅供参考，应用前可继续编辑。' }}
                  </p>
                  <div class="grid grid-cols-2 gap-3">
                    <el-button :disabled="submitting" @click="autoGenerateSummary">
                      生成摘要建议
                    </el-button>
                    <el-button type="primary" :loading="aiAssistLoading" :disabled="submitting || aiAssistLoading" @click="requestAiAssist">
                      检查内容
                    </el-button>
                  </div>
                  <div v-if="aiAssist" class="space-y-4 border-t border-[var(--fsusblog-panel-border)] pt-5">
                    <p v-if="aiAssist.suggestedSummary" class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]">
                      {{ aiAssist.suggestedSummary }}
                    </p>
                    <el-button v-if="aiAssist.suggestedSummary" size="small" :disabled="submitting" @click="applyAiSummary">
                      应用摘要
                    </el-button>
                    <div v-if="aiAssist.suggestedTags.length > 0" class="flex flex-wrap gap-2">
                      <el-tag v-for="tag in aiAssist.suggestedTags" :key="tag" size="small">{{ tag }}</el-tag>
                    </div>
                    <el-button v-if="aiAssist.suggestedTags.length > 0" size="small" :disabled="submitting" @click="applyAiSuggestedTags">
                      应用标签
                    </el-button>
                    <div v-if="aiAssist.titleCandidates.length > 0" class="grid gap-2">
                      <el-button
                        v-for="title in aiAssist.titleCandidates"
                        :key="title"
                        :disabled="submitting"
                        @click="applyAiTitleCandidate(title)"
                      >
                        <span class="min-w-0 whitespace-normal text-left leading-5">应用标题：{{ title }}</span>
                      </el-button>
                    </div>
                    <el-button v-if="aiAssist.translationDraft" size="small" :disabled="submitting" @click="applyAiTranslationDraft">
                      应用翻译建议
                    </el-button>
                  </div>
                </div>
              </section>
            </details>

            <details
              class="write-inspector-section"
              :open="previewInspectorOpen"
              @toggle="onPreviewInspectorToggle"
            >
              <summary class="write-inspector-summary">
                <span>阅读预览</span>
                <span>按需生成私有预览</span>
              </summary>
              <ArticlePrivatePreviewPanel
                :html="privatePreview?.html ?? ''"
                :issues="privatePreview?.issues ?? []"
                :loading="privatePreviewLoading"
                :status-text="privatePreviewStatusText"
                :can-preview="canGeneratePrivatePreview"
                @preview="generatePrivatePreview"
              />
            </details>

            <details
              class="write-inspector-section"
              :open="versionsInspectorOpen"
              @toggle="onVersionsInspectorToggle"
            >
              <summary class="write-inspector-summary">
                <span>版本</span>
                <span>查看修订和回滚</span>
              </summary>
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
            </details>

            <details
              class="write-inspector-section"
              :open="resourcesInspectorOpen"
              @toggle="onResourcesInspectorToggle"
            >
              <summary class="write-inspector-summary">
                <span>资源</span>
                <span>图片资源和上传策略</span>
              </summary>
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
              <details class="write-upload-disclosure border-t border-[var(--fsusblog-panel-border)]">
                <summary class="write-disclosure-summary px-4 py-3 border-b border-[var(--fsusblog-panel-border)] cursor-pointer outline-none">
                  <div class="flex items-center justify-between">
                    <span class="text-[13px] font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">图片上传策略</span>
                    <span class="text-[12px] font-medium text-[var(--fsusblog-text-muted)]" aria-live="polite">{{ imageUploadRuntime.statusText }}</span>
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
            </details>
          </div>

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
      <ul class="mt-5 space-y-2" aria-label="发布前 checklist">
        <li
          v-for="item in submitChecklist"
          :key="item.label"
          class="submit-checklist-item"
          :class="`submit-checklist-item--${item.state}`"
        >
          <span class="submit-checklist-status">{{ item.state === 'pass' ? '通过' : '注意' }}</span>
          <span class="min-w-0">
            <span class="font-bold">{{ item.label }}</span>
            <span v-if="item.detail" class="ml-1 text-[var(--fsusblog-text-muted)]">{{ item.detail }}</span>
          </span>
        </li>
      </ul>
      <div v-if="prepublishWarningsNeedOverride" class="mt-5 space-y-3" aria-label="发布前警告跳过确认">
        <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">发布警告处理</div>
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
            {{ submitButtonText }}
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
            离开编辑器
          </el-button>
        </div>
      </template>
    </el-dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ArticleAssetLibraryPanel from '@/components/admin/article/ArticleAssetLibraryPanel.vue'
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue'
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue'
import ArticleSeoPreviewPanel from '@/components/admin/article/ArticleSeoPreviewPanel.vue'
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'
import { ArticlePublishStatus } from '@/api/article'
import type { AssetLibraryItemResponse } from '@/api/authoring'
import { showErrorToast } from '@/utils/errorPresentation'

type EditorLayoutMode = 'standard' | 'focus' | 'fullscreen'
type SubmitChecklistState = 'pass' | 'warning'

const route = useRoute()

const {
  formRef,
  taskFeedback,
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
const {
  busy: taskFeedbackBusy,
  isHighlighted: isTaskHighlighted
} = taskFeedback

const pageTitle = computed(() => submitButtonText.value.includes('更新') ? '编辑文章' : '撰写文章')
const quickCreateCategoryDialog = ref(false)
const quickCreateTagDialog = ref(false)
const quickCategoryName = ref('')
const quickTagName = ref('')
const coverInputRef = ref<HTMLInputElement | null>(null)
const articleEditorRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean } | null>(null)
const submitConfirmDialog = ref(false)
const leaveConfirmDialog = ref(false)
const editorLayoutMode = ref<EditorLayoutMode>('standard')
const checkInspectorOpen = ref(false)
const previewInspectorOpen = ref(route.query.preview === 'private')
const resourcesInspectorOpen = ref(false)
const versionsInspectorOpen = ref(false)
const assetLibraryLoaded = ref(false)
const revisionsLoaded = ref(false)

const editorLayoutModeLabel = computed(() => {
  if (editorLayoutMode.value === 'focus') {
    return '专注写作'
  }

  if (editorLayoutMode.value === 'fullscreen') {
    return '全屏写作'
  }

  return '编写'
})

const triggerCoverInput = (): void => {
  coverInputRef.value?.click()
}

const setEditorLayoutMode = (command: string | number | object): void => {
  if (command === 'standard' || command === 'focus' || command === 'fullscreen') {
    editorLayoutMode.value = command
  }
}

const isDetailsOpen = (event: Event): boolean => (event.currentTarget as HTMLDetailsElement | null)?.open === true

const onCheckInspectorToggle = (event: Event): void => {
  checkInspectorOpen.value = isDetailsOpen(event)
}

const openPreviewInspector = (): void => {
  previewInspectorOpen.value = true
}

const onPreviewInspectorToggle = (event: Event): void => {
  previewInspectorOpen.value = isDetailsOpen(event)
}

const openResourcesInspector = (): void => {
  resourcesInspectorOpen.value = true
  if (!assetLibraryLoaded.value) {
    assetLibraryLoaded.value = true
    refreshAssetLibrary().catch((error: unknown) => showErrorToast(error, '资产库刷新失败'))
  }
}

const onResourcesInspectorToggle = (event: Event): void => {
  resourcesInspectorOpen.value = isDetailsOpen(event)
  if (resourcesInspectorOpen.value) {
    openResourcesInspector()
  }
}

const openVersionsInspector = (): void => {
  versionsInspectorOpen.value = true
  if (!revisionsLoaded.value) {
    revisionsLoaded.value = true
    refreshArticleRevisions().catch((error: unknown) => showErrorToast(error, '历史版本刷新失败'))
  }
}

const onVersionsInspectorToggle = (event: Event): void => {
  versionsInspectorOpen.value = isDetailsOpen(event)
  if (versionsInspectorOpen.value) {
    openVersionsInspector()
  }
}

const submitChecklist = computed<ReadonlyArray<{ label: string; state: SubmitChecklistState; detail?: string }>>(() => {
  const summaryLength = articleForm.summary.trim().length
  const seoWarning = prepublishWarningIssues.value[0]
  return [
    {
      label: '标题已填写',
      state: articleForm.title.trim().length > 0 ? 'pass' : 'warning',
      detail: articleForm.title.trim().length > 0 ? undefined : '发布前需要补齐标题'
    },
    {
      label: '已选择分类',
      state: typeof articleForm.categoryId === 'number' ? 'pass' : 'warning',
      detail: typeof articleForm.categoryId === 'number' ? undefined : '未选择分类会降低归档可发现性'
    },
    {
      label: '已设置摘要',
      state: summaryLength > 0 ? 'pass' : 'warning',
      detail: summaryLength > 0 ? `${summaryLength}/250` : '未设置摘要时会使用正文开头'
    },
    {
      label: 'SEO 描述长度',
      state: summaryLength >= 50 || articleForm.status === ArticlePublishStatus.Draft ? 'pass' : 'warning',
      detail: summaryLength >= 50 || articleForm.status === ArticlePublishStatus.Draft ? undefined : '建议至少 50 字'
    },
    {
      label: '已设置封面',
      state: articleForm.coverImageUrl.trim().length > 0 ? 'pass' : 'warning',
      detail: articleForm.coverImageUrl.trim().length > 0 ? undefined : '未设置封面时分享预览会使用默认图'
    },
    {
      label: '预发布检查',
      state: seoWarning ? 'warning' : 'pass',
      detail: seoWarning?.message
    }
  ]
})

const handleEditorEscape = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && editorLayoutMode.value === 'fullscreen') {
    editorLayoutMode.value = 'standard'
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleEditorEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleEditorEscape)
})

const onCoverFileChange = (event: Event): void => {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    const files = Array.from(input.files)
    handleCoverUpload(files).catch((error: unknown) => showErrorToast(error, '头图上传失败'))
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
  gap: 1rem;
}

.write-command-title {
  color: var(--fsusblog-text-primary);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.25;
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

.write-layout-control {
  display: grid;
  gap: 0.35rem;
}

.submit-checklist-item {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 0.75rem;
  font-size: 0.75rem;
  line-height: 1.5;
}

.submit-checklist-status {
  flex: 0 0 auto;
  color: var(--fsusblog-text-muted);
  font-size: 0.6875rem;
  font-weight: 800;
}

.submit-checklist-item--pass .submit-checklist-status {
  color: var(--fsusblog-color-success);
}

.submit-checklist-item--warning .submit-checklist-status {
  color: var(--fsusblog-color-warning);
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

.write-inspector {
  display: grid;
  border-top: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.write-inspector-section {
  border-bottom: 1px solid var(--fsusblog-panel-border);
}

.write-inspector-summary {
  display: flex;
  cursor: pointer;
  list-style: none;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  color: var(--fsusblog-text-primary);
  font-size: 0.82rem;
  font-weight: 650;
}

.write-inspector-summary::-webkit-details-marker {
  display: none;
}

.write-inspector-summary span + span {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.72rem;
  font-weight: 500;
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
