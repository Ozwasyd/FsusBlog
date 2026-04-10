<template>
  <div class="write-article-wrapper">
    <!-- [修复 2026-02-24] 逻辑自洽：增加数据契约校验与全局 Loading 状态管理 -->
    <el-form 
      ref="formRef" 
      :model="articleForm" 
      :rules="rules" 
      label-position="top"
      v-loading="pageLoading"
      element-loading-text="正在载入数据资源..."
    >
      <!-- 头部动作栏 -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <el-form-item prop="title" class="grow w-full mb-0!">
          <el-input 
            v-model="articleForm.title" 
            placeholder="在此键入博文标题..." 
            size="large"
            maxlength="100"
            show-word-limit
            class="title-input-remaster"
            :disabled="submitting"
          />
        </el-form-item>
        <div class="flex items-center gap-3 shrink-0">
          <el-button @click="handleBack" :disabled="submitting" plain>返回列表</el-button>
          <el-button 
            type="primary" 
            :loading="submitting" 
            @click="submitForm"
            class="px-8 font-bold shadow-md shadow-blue-100 transition-all active:scale-95"
          >
            {{ submitButtonText }}
          </el-button>
        </div>
      </div>

      <el-row :gutter="24">
        <!-- 左侧：编辑器区域 -->
        <el-col :xs="24" :lg="18">
          <el-card shadow="never" class="editor-container-card border-zinc-100 rounded-xl overflow-hidden">
            <el-form-item prop="content" class="mb-0!">
              <!-- 
                [修复 2026-02-24] 架构演进：
                通过 #preview 插槽注入 MarkdownRenderer 物理内核，确保预览与主站渲染 100% 同源
              -->
              <md-editor 
                v-model="articleForm.content" 
                @on-save="submitForm"
                @on-upload-img="handleUploadImg"
                placeholder="支持 Markdown 实时预览，Shift+Alt+F 自动格式化..."
                class="modern-md-editor"
                :toolbarsExclude="['github', 'save', 'htmlPreview', 'catalog']"
                :preview="true"
              >
                <template #preview>
                  <!-- 逻辑自洽：丢弃编辑器内置渲染，强制同步全站统一渲染引擎 -->
                  <div class="custom-preview-wrapper h-full overflow-y-auto px-6 py-10 bg-white">
                    <MarkdownRenderer :content="articleForm.content" />
                  </div>
                </template>
              </md-editor>
            </el-form-item>
          </el-card>
        </el-col>

        <!-- 右侧：配置侧边栏 -->
        <el-col :xs="24" :lg="6">
          <ArticleWriteSidebar
            :form="articleForm"
            :categories="categories"
            :tags="tags"
            :submitting="submitting"
            @auto-summary="autoGenerateSummary"
          />
        </el-col>
      </el-row>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { AsyncMdEditor as MdEditor } from '@/components/ui/AsyncMdEditor'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'

const {
  formRef,
  pageLoading,
  submitting,
  categories,
  tags,
  submitButtonText,
  articleForm,
  rules,
  handleUploadImg,
  submitForm,
  autoGenerateSummary,
  handleBack
} = useAdminArticleWrite()
</script>

<style scoped>
.write-article-wrapper {
  animation: fade-in-slide 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes fade-in-slide {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.title-input-remaster :deep(.el-input__wrapper) {
  box-shadow: none !important;
  background: transparent;
  padding: 0;
  border-bottom: 2px solid #f1f5f9;
  border-radius: 0;
  transition: border-bottom-color 0.3s;
}

.title-input-remaster :deep(.el-input__wrapper.is-focus) {
  border-bottom-color: var(--el-color-primary);
}

.title-input-remaster :deep(.el-input__inner) {
  font-size: 26px;
  font-weight: 900;
  color: #1e293b;
  height: 64px;
}

.modern-md-editor {
  height: calc(100vh - 220px);
  border: none !important;
}

.custom-preview-wrapper {
  scrollbar-width: thin;
  scrollbar-color: #e2e8f0 transparent;
}

.editor-container-card :deep(.el-card__body) {
  padding: 0;
}

.sticky-sidebar {
  position: sticky;
  top: 1.5rem;
}

@media (max-width: 1024px) {
  .modern-md-editor { height: 600px; }
  .sticky-sidebar { position: static; margin-top: 1.5rem; }
}

.el-button:active {
  transform: scale(0.96);
}
</style>
