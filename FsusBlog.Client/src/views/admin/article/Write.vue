<template>
  <main
    class="account-page write-article-wrapper w-full"
    aria-labelledby="article-write-title"
    :aria-busy="String(pageLoading || submitting)"
  >
    <el-form
      ref="formRef"
      :model="articleForm"
      :rules="rules"
      label-position="top"
      v-loading="pageLoading"
      element-loading-text="正在载入数据资源..."
      class="write-workspace"
      @submit.prevent="requestSubmit"
    >
      <header class="write-command-bar" aria-label="文章编辑操作">
        <div class="min-w-0">
          <div class="account-page-eyebrow mb-2">管理 / 内容编辑</div>
          <h1 id="article-write-title" class="write-command-title">{{ pageTitle }}</h1>
          <p class="write-command-status" aria-live="polite">
            {{ editorStatusText }}
          </p>
        </div>
        <div class="admin-action-row shrink-0">
          <el-button type="default" @click="requestLeave" :disabled="submitting" plain>
            返回列表
          </el-button>
          <el-button
            type="primary"
            :loading="submitting"
            native-type="button"
            @click="requestSubmit"
            class="write-submit-button"
            :aria-describedby="'article-editor-status'"
          >
            {{ submitButtonText }}
          </el-button>
        </div>
      </header>

      <section class="write-title-panel admin-form-panel" aria-labelledby="article-title-label">
        <div
          v-if="pendingDraft"
          class="write-draft-banner"
          role="status"
          aria-live="polite"
        >
          <div class="min-w-0">
            <div class="write-draft-title">发现本地缓存</div>
            <p class="write-draft-text">
              {{ draftStatusText }}。恢复会覆盖当前表单，丢弃只清除浏览器内缓存。
            </p>
          </div>
          <div class="write-draft-actions">
            <el-button type="primary" plain @click="restoreLocalDraft">
              恢复本地缓存
            </el-button>
            <el-button type="default" @click="discardLocalDraft">
              丢弃缓存
            </el-button>
          </div>
        </div>

        <el-form-item prop="title" class="mb-0!">
          <template #label>
            <span id="article-title-label">文章标题</span>
          </template>
          <el-input
            v-model="articleForm.title"
            aria-label="文章标题"
            name="articleTitle"
            placeholder="在此键入博文标题..."
            size="large"
            maxlength="100"
            show-word-limit
            class="title-input-remaster"
            :disabled="submitting"
          />
        </el-form-item>
      </section>

      <div class="write-grid">
        <section class="write-editor-panel admin-table-panel" aria-labelledby="article-content-label">
          <header class="write-panel-header">
            <div>
              <h2 id="article-content-label" class="write-panel-title">正文编辑器</h2>
              <p id="article-editor-status" class="admin-visually-muted" aria-live="polite">
                编辑正文、插入图片，并在同一工作区预览文章内容。
              </p>
            </div>
          </header>
          <div class="editor-container-card overflow-hidden">
            <el-form-item prop="content" class="mb-0!">
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
            @auto-summary="autoGenerateSummary"
            @open-create-category="openQuickCreateCategory"
            @open-create-tag="openQuickCreateTag"
          />

          <details class="write-upload-disclosure admin-form-panel">
            <summary class="write-disclosure-summary">
              图片上传策略
              <span class="admin-visually-muted" aria-live="polite">{{ imageUploadRuntime.statusText }}</span>
            </summary>
            <ImageUploadOptionsPanel
              class="mt-5"
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
          </details>
        </aside>
      </div>
    </el-form>

    <el-dialog
      v-model="quickCreateCategoryDialog"
      title="新建分类"
      width="min(92vw, 420px)"
      append-to-body
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
        <div class="write-dialog-footer">
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
      append-to-body
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
        <div class="write-dialog-footer">
          <el-button :disabled="quickCreatingTag" @click="quickCreateTagDialog = false">
            取消
          </el-button>
          <el-button type="primary" :loading="quickCreatingTag" @click="submitQuickCreateTag">
            创建并关联
          </el-button>
        </div>
      </template>
    </el-dialog>
  </main>

</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessageBox } from '@ozwasyd/element-plus'
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
  submitButtonText,
  submitConfirmContent,
  requiresLeaveConfirm,
  pendingDraft,
  draftStatusText,
  articleForm,
  rules,
  validateBeforeSubmit,
  handleUploadImg,
  submitForm,
  restoreLocalDraft,
  discardLocalDraft,
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

const pageTitle = computed(() => submitButtonText.value.includes('更新') ? '编辑文章' : '撰写文章')
const quickCreateCategoryDialog = ref(false)
const quickCreateTagDialog = ref(false)
const quickCategoryName = ref('')
const quickTagName = ref('')

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
    ElMessageBox.confirm(submitConfirmContent.value, pageTitle.value === '编辑文章' ? '更新确认' : '发布确认', {
      confirmButtonText: pageTitle.value === '编辑文章' ? '确认更新' : '确认发布',
      cancelButtonText: '继续编辑',
      type: 'warning'
    })
      .then(() => submitForm())
      .catch(() => {})
  }
}

const requestLeave = (): void => {
  if (requiresLeaveConfirm.value) {
    ElMessageBox.confirm('当前内容已写入浏览器本地缓存。离开后未发布的改动不会提交到服务器，但回到编辑页可选择恢复本地缓存。', '离开编辑器', { confirmButtonText: '确认离开', cancelButtonText: '继续编辑', type: 'warning' })
      .then(() => leaveEditor())
      .catch(() => {})
    return
  }

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
.write-article-wrapper {
  animation: fade-in-slide 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes fade-in-slide {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.write-workspace {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.write-command-bar {
  position: sticky;
  top: 5.5rem;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--fsus-panel-border);
  border-radius: var(--fsus-radius-lg);
  background: rgba(252, 252, 252, 0.86);
  box-shadow: 0 24px 54px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(32px) saturate(112%);
}

.write-command-title {
  color: var(--fsus-text-primary);
  font-size: 1.35rem;
  font-weight: 800;
  line-height: 1.1;
}

.write-command-status {
  margin-top: 0.35rem;
  color: var(--fsus-text-tertiary);
  font-size: 0.78rem;
  line-height: 1.5;
}

.write-submit-button {
  min-width: 8rem;
  font-weight: 700;
  box-shadow: 0 22px 44px rgba(15, 23, 42, 0.12);
}

.write-title-panel {
  padding: 1.25rem 1.5rem;
}

.write-draft-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
  padding: 1rem;
  border: 1px solid rgba(42, 89, 156, 0.22);
  border-radius: var(--fsus-radius-md);
  background: rgba(42, 89, 156, 0.06);
}

.write-draft-title {
  color: var(--fsus-text-primary);
  font-size: 0.85rem;
  font-weight: 800;
}

.write-draft-text {
  margin-top: 0.25rem;
  color: var(--fsus-text-tertiary);
  font-size: 0.78rem;
  line-height: 1.6;
}

.write-draft-actions,
.write-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.write-grid {
  display: grid;
  align-items: start;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, 24rem);
  gap: 1.25rem;
}

.write-editor-panel {
  min-width: 0;
}

.write-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.25rem 0.25rem 1rem;
}

.write-panel-title {
  color: var(--fsus-text-primary);
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.write-side-panel {
  position: sticky;
  top: 11.25rem;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1rem;
}

.write-upload-disclosure {
  padding: 1.25rem;
}

.write-disclosure-summary {
  display: flex;
  cursor: pointer;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: var(--fsus-text-primary);
  font-size: 0.82rem;
  font-weight: 800;
  list-style: none;
}

.write-disclosure-summary::-webkit-details-marker {
  display: none;
}

.title-input-remaster :deep(.el-input__wrapper) {
  box-shadow: none !important;
  background: transparent;
  padding: 0;
  border-bottom: 2px solid #E4E4E7;
  border-radius: 0;
  transition: border-bottom-color 0.3s;
}

.title-input-remaster :deep(.el-input__wrapper.is-focus) {
  border-bottom-color: #2A599C;
}

.title-input-remaster :deep(.el-input__inner) {
  font-size: 26px;
  font-weight: 900;
  color: #0F0F11;
  height: 64px;
}

.editor-container-card :deep(.el-card__body) {
  padding: 0;
}

@media (max-width: 1024px) {
  .write-command-bar,
  .write-draft-banner,
  .write-grid,
  .write-side-panel {
    position: static;
  }

  .write-command-bar {
    align-items: stretch;
    flex-direction: column;
  }

  .write-draft-banner {
    align-items: stretch;
    flex-direction: column;
  }

  .write-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .write-command-bar,
  .write-title-panel,
  .write-upload-disclosure {
    padding: 1rem;
  }

  .title-input-remaster :deep(.el-input__inner) {
    font-size: 21px;
    height: 54px;
  }

  .write-draft-actions,
  .write-dialog-footer {
    flex-direction: column;
  }

  .write-draft-actions .el-button,
  .write-dialog-footer .el-button {
    width: 100%;
    margin-left: 0 !important;
    min-height: 44px;
  }
}

.el-button:active {
  transform: scale(0.96);
}
</style>
