<template>
  <div class="settings-container max-w-6xl mx-auto p-2 sm:p-4">
    <el-alert
      title="高权限管理模式"
      type="warning"
      show-icon
      :closable="false"
      class="mb-4 sm:mb-6 shadow-sm border-none ring-1 ring-amber-100 bg-amber-50!"
    >
      <p class="text-xs text-amber-700 mt-1 leading-relaxed">
        封面更换将自动触发物理磁盘清理。若同步至持久化层失败，系统将执行原子化回滚以保护 SEO 状态。
      </p>
    </el-alert>

    <el-tabs v-model="activeTab" type="border-card" class="rounded-xl! overflow-hidden shadow-sm">
      <el-tab-pane label="SEO 配置" name="site">
        <div class="p-4 sm:p-8">
          <el-form :model="siteForm" label-position="top" class="max-w-3xl" @submit.prevent novalidate>
            <el-row :gutter="20">
              <el-col :xs="24" :sm="12">
                <el-form-item label="网站标题" required>
                  <el-input v-model="siteForm.title" maxlength="50" show-word-limit placeholder="Fsus's Blog" :disabled="savingSite" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="作者名称" required>
                  <el-input v-model="siteForm.author" maxlength="20" placeholder="Fsu" :disabled="savingSite" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="站点基础 URL" required>
              <el-input v-model="siteForm.baseUrl" placeholder="https://fsus.blog" :disabled="savingSite">
                <template #prepend>URL</template>
              </el-input>
              <div class="text-[11px] text-zinc-400 mt-2 font-medium">
                用于生成 RSS、邮件通知及绝对路径资源。物理规则：必须以 http/https 开头，末尾禁止携带斜杠 /
              </div>
            </el-form-item>

            <el-form-item label="社交媒体预览图 (OgImage)">
              <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6">
                <el-upload action="#" :http-request="handleImageAction" :show-file-list="false" accept="image/*" :disabled="imageLoading" class="w-full sm:w-auto">
                  <div v-loading="imageLoading" class="w-full sm:w-60 aspect-video rounded-lg overflow-hidden border border-zinc-200 shadow-sm bg-zinc-50 transition-all hover:border-blue-400">
                    <img v-if="displayUrl" :src="displayUrl" class="w-full h-full object-cover" />
                    <div v-else class="h-full flex flex-col items-center justify-center text-zinc-400">
                      <el-icon size="24"><Plus /></el-icon>
                      <span class="text-xs mt-2 font-medium uppercase tracking-widest">Upload Cover</span>
                    </div>
                  </div>
                </el-upload>

                <div class="flex-1 flex flex-col items-center sm:items-start text-center sm:text-left">
                  <p class="text-[11px] text-zinc-400 leading-relaxed mb-4 italic">
                    建议尺寸 1200x630px。变更将触发算力防御拦截。
                  </p>
                  <el-button v-if="hasOgImage" type="danger" link :disabled="imageLoading" @click="handleImageRemove">
                    <el-icon class="mr-1"><Delete /></el-icon>物理删除文件并重置
                  </el-button>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="SEO 描述 (Description)">
              <el-input v-model="siteForm.description" type="textarea" :rows="3" maxlength="200" show-word-limit :disabled="savingSite" />
            </el-form-item>

            <el-form-item label="关键词 (Keywords)">
              <el-input v-model="siteForm.keywords" placeholder="英文逗号分隔" :disabled="savingSite" @blur="sanitizeKeywords" />
              <div class="flex gap-2 mt-3 flex-wrap">
                <el-tag v-for="tag in computedKeywords" :key="tag" size="small" type="info" class="rounded-md tabular-nums border-zinc-100">
                  {{ tag }}
                </el-tag>
              </div>
            </el-form-item>

            <div class="mt-8 pt-6 border-t border-zinc-100 flex justify-center sm:justify-end">
              <el-button type="primary" :loading="savingSite" class="w-full sm:w-auto px-10 font-bold shadow-lg shadow-blue-50" @click="saveSiteConfig">
                {{ siteSubmitText }}
              </el-button>
            </div>
          </el-form>
        </div>
      </el-tab-pane>

      <el-tab-pane label="页面编辑" name="pages">
        <div class="p-2 sm:p-6 flex flex-col gap-5">
          <div class="flex flex-col sm:flex-row items-center gap-4 bg-zinc-50 p-4 rounded-lg border border-zinc-100">
            <span class="text-sm font-bold text-zinc-600 select-none">编辑目标:</span>
            <el-radio-group v-model="currentSlug" size="small" class="flex flex-wrap justify-center" :disabled="pageLoading">
              <el-radio-button v-for="item in pageTargets" :key="item.value" :value="item.value">
                {{ item.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
          <div class="editor-container rounded-xl border border-zinc-200 overflow-hidden" v-loading="pageLoading">
            <md-editor v-model="pageContent" class="h-112.5 sm:h-150!">
              <template #preview>
                <div class="settings-preview-wrapper h-full overflow-y-auto px-6 py-10 bg-white">
                  <MarkdownRenderer :content="pageContent" />
                </div>
              </template>
            </md-editor>
          </div>
          <div class="flex justify-center sm:justify-end pt-2">
            <el-button type="primary" size="large" :loading="savingPage" class="w-full sm:w-auto px-12 font-bold shadow-lg shadow-blue-50" @click="savePageContent">
              {{ pageSubmitText }}
            </el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { Delete, Plus } from '@element-plus/icons-vue'
import { useAdminSettingsPage } from '@/composables/useAdminSettingsPage'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { AsyncMdEditor as MdEditor } from '@/components/ui/AsyncMdEditor'

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
  sanitizeKeywords,
  handleImageAction,
  handleImageRemove,
  saveSiteConfig,
  savePageContent
} = useAdminSettingsPage()
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
  border-radius: 12px;
  border: none;
}

.editor-container :deep(.md-editor) {
  border: none !important;
}

.settings-preview-wrapper {
  scrollbar-width: thin;
  scrollbar-color: #e4e4e7 transparent;
}

@media (max-width: 640px) {
  :deep(.el-form-item__label) {
    padding-bottom: 4px;
    font-weight: 600;
  }

  .editor-container :deep(.md-editor) {
    height: 400px !important;
  }
}
</style>
