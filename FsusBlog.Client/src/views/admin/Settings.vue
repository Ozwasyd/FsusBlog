<template>
  <div class="account-page settings-container w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">系统设置</h1>
      <p class="account-page-description">
        维护站点元信息、预览图与静态页面内容。高权限操作会触发明确确认。
      </p>
    </header>

    <el-alert
      title="高权限管理模式"
      type="warning"
      show-icon
      :closable="false"
      class="mb-6 sm:mb-6"
    >
      <p class="text-xs text-amber-700 mt-1 leading-relaxed">
        封面更换将自动触发物理磁盘清理。若同步至持久化层失败，系统将执行原子化回滚以保护 SEO 状态。
      </p>
    </el-alert>

    <el-tabs v-model="activeTab" type="border-card" class="settings-tabs overflow-hidden">
      <el-tab-pane label="SEO 配置" name="site">
        <section class="p-6 sm:p-8">
          <div class="admin-form-panel mb-6">
            <div class="account-section border-t-0 pt-0">
              <h2 class="account-section-title">上传与输出策略</h2>
              <p class="account-section-caption">控制封面压缩策略、预览图格式与可恢复上传行为。</p>
            </div>
            <ImageUploadOptionsPanel
              class="mb-0"
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

          <el-form :model="siteForm" label-position="top" class="admin-form-panel max-w-4xl" @submit.prevent novalidate>
            <div class="account-section border-t-0 pt-0">
              <h2 class="account-section-title">站点元信息</h2>
              <p class="account-section-caption">维护基础 URL、公开描述、关键词和社交预览图，确保站点输出保持一致。</p>
            </div>

            <el-row :gutter="20">
              <el-col :xs="24" :sm="12">
                <el-form-item label="网站标题" required>
                  <el-input v-model="siteForm.title" name="siteTitle" aria-label="网站标题" maxlength="50" show-word-limit placeholder="Fsus's Blog" :disabled="savingSite" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="作者名称" required>
                  <el-input v-model="siteForm.author" name="siteAuthor" aria-label="作者名称" maxlength="20" placeholder="Fsu" :disabled="savingSite" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="站点基础 URL" required>
              <el-input v-model="siteForm.baseUrl" name="siteBaseUrl" aria-label="站点基础 URL" placeholder="https://fsus.blog" :disabled="savingSite">
                <template #prepend>URL</template>
              </el-input>
              <div class="text-[11px] text-[#A1A1AA] mt-2 font-medium">
                用于生成 RSS、邮件通知及绝对路径资源。物理规则：必须以 http/https 开头，末尾禁止携带斜杠 /
              </div>
            </el-form-item>

            <el-form-item label="社交媒体预览图 (OgImage)">
              <div class="flex flex-col sm:flex-row items-center sm:items-start gap-6">
                <el-upload action="#" :http-request="handleImageAction" :show-file-list="false" accept="image/*" :disabled="imageLoading" class="w-full sm:w-auto">
                  <div v-loading="imageLoading" class="w-full sm:w-60 aspect-video rounded-[8px] overflow-hidden border border-[#E4E4E7] bg-[#FCFCFC] transition-all hover:border-[#2A599C]">
                    <img v-if="displayUrl" :src="displayUrl" class="w-full h-full object-cover" />
                    <div v-else class="h-full flex flex-col items-center justify-center text-[#A1A1AA]">
                      <el-icon size="24"><Plus /></el-icon>
                      <span class="text-xs mt-2 font-medium uppercase">Upload Cover</span>
                    </div>
                  </div>
                </el-upload>

                <section class="flex-1 flex flex-col items-center sm:items-start sm:text-left">
                  <p class="text-[11px] text-[#A1A1AA] leading-relaxed mb-6 italic">
                    建议尺寸 1200x630px。变更将触发算力防御拦截。
                  </p>
                  <el-button v-if="hasOgImage" type="danger" link :disabled="imageLoading" @click="confirmImageRemove">
                    <el-icon class="mr-1"><Delete /></el-icon>物理删除文件并重置
                  </el-button>
                </section>
              </div>
            </el-form-item>

            <el-form-item label="SEO 描述 (Description)">
              <el-input v-model="siteForm.description" name="siteDescription" aria-label="SEO 描述" type="textarea" :rows="3" maxlength="200" show-word-limit :disabled="savingSite" />
            </el-form-item>

            <el-form-item label="关键词 (Keywords)">
              <el-input v-model="siteForm.keywords" name="siteKeywords" aria-label="关键词" placeholder="英文逗号分隔" :disabled="savingSite" @blur="sanitizeKeywords" />
              <div class="flex gap-2 mt-3 flex-wrap">
                <el-tag v-for="tag in computedKeywords" :key="tag" size="small" type="info" class="rounded-[8px] tabular-nums border-[#E4E4E7] bg-[#FCFCFC] text-[#3F3F46]">
                  {{ tag }}
                </el-tag>
              </div>
            </el-form-item>

            <div class="admin-action-row mt-8 pt-6 border-t border-[#F4F4F5] sm:justify-end">
              <el-button type="primary" :loading="savingSite" class="w-full sm:w-auto px-6 sm:px-10 font-bold shadow-[0_32px_64px_rgba(0,0,0,0.08)]" @click="saveSiteConfig">
                {{ siteSubmitText }}
              </el-button>
            </div>
          </el-form>
        </section>
      </el-tab-pane>

      <el-tab-pane label="页面编辑" name="pages">
        <section class="p-2 sm:p-6 flex flex-col gap-5">
          <header class="admin-page-toolbar flex flex-col items-center gap-6 sm:flex-row">
            <div class="min-w-0">
              <div class="account-section-title mb-2">页面编辑</div>
              <p class="text-sm text-[#71717A]">选择要维护的静态页面，并在同一套编辑器里完成内容发布。</p>
            </div>
            <el-radio-group v-model="currentSlug" size="small" class="flex flex-wrap justify-center" :disabled="pageLoading">
              <el-radio-button v-for="item in pageTargets" :key="item.value" :value="item.value">
                {{ item.label }}
              </el-radio-button>
            </el-radio-group>
          </header>
          <section class="admin-form-panel">
            <div class="account-section border-t-0 pt-0">
              <h2 class="account-section-title">内容编辑器</h2>
              <p class="account-section-caption">编辑静态页面内容并发布到公开站点。</p>
            </div>
            <SettingsPageEditor
              v-if="activeTab === 'pages'"
              v-model="pageContent"
              v-loading="pageLoading"
              :loading="pageLoading"
              :saving="savingPage"
            />
          </section>
          <div class="admin-action-row pt-2 sm:justify-end">
            <el-button type="primary" size="large" :loading="savingPage" class="w-full sm:w-auto px-6 sm:px-12 font-bold shadow-[0_32px_64px_rgba(0,0,0,0.08)]" @click="confirmPagePublish">
              {{ pageSubmitText }}
            </el-button>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>




  </div>
</template>

<script setup lang="ts">
import { ElMessageBox } from '@ozwasyd/element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import SettingsPageEditor from '@/components/admin/settings/SettingsPageEditor.vue'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useAdminSettingsPage } from '@/composables/useAdminSettingsPage'

const {
  activeTab,
  savingSite,
  savingPage,
  pageLoading,
  imageLoading,
  siteForm,
  currentSlug,
  pageContent,
  pageTargets,
  displayUrl,
  hasOgImage,
  computedKeywords,
  siteSubmitText,
  pageSubmitText,
  imageUploadOptions,
  imageUploadWasmOnlyMode,
  setImageUploadWasmOnlyMode,
  setImageUploadOptions,
  imageUploadRuntime,
  resumeImageUpload,
  sanitizeKeywords,
  handleImageAction,
  handleImageRemove,
  saveSiteConfig,
  savePageContent
} = useAdminSettingsPage()

const confirmImageRemove = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm('这会物理删除当前预览图，并立即同步到公开站点。', '重置预览图', {
      type: 'warning',
      confirmButtonText: '确认重置',
      cancelButtonText: '取消'
    })
    await handleImageRemove()
  } catch {
    // User cancelled.
  }
}

const confirmPagePublish = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm('确认发布当前页面内容？这会覆盖线上静态页面。', '发布页面', {
      type: 'warning',
      confirmButtonText: '确认发布',
      cancelButtonText: '取消'
    })
    await savePageContent()
  } catch {
    // User cancelled.
  }
}

</script>

<style scoped>
.settings-container {
  animation: slide-in-top 0.4s ease-out;
}

@keyframes slide-in-top {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

:deep(.el-tabs--border-card) {
  border-radius: var(--fsus-radius-lg);
  border: none;
  background: transparent;
}

:deep(.settings-tabs > .el-tabs__header) {
  margin: 0;
  border-bottom: 1px solid rgba(228, 228, 231, 0.88);
  background: rgba(252, 252, 252, 0.78);
}

:deep(.settings-tabs > .el-tabs__content) {
  background: rgba(252, 252, 252, 0.7);
}

:deep(.settings-tabs.el-tabs--border-card > .el-tabs__header .el-tabs__item.is-active) {
  color: #2A599C;
}

:deep(.settings-container .el-alert) {
  border-radius: var(--fsus-radius-lg);
  border: 1px solid rgba(245, 158, 11, 0.24);
  background: rgba(255, 251, 235, 0.78);
  box-shadow: none;
}

@media (max-width: 640px) {
  :deep(.el-form-item__label) {
    padding-bottom: 4px;
    font-weight: 600;
  }
}
</style>
