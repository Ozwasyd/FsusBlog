<template>
  <div class="account-page profile-page w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">系统设置</h1>
      <p class="account-page-description">
        维护站点元信息、预览图与静态页面内容。高权限操作会触发明确确认，并自动同步至 AOT 缓存层。
      </p>
    </header>

    <div
      role="alert"
      class="mb-12 border-l-2 border-[var(--fsusblog-color-warning-border)] bg-[var(--fsusblog-color-warning-bg)] px-6 py-5 rounded-r-[var(--fsus-radius-control)]"
    >
      <div class="flex items-center gap-3 mb-2">
        <span class="text-[var(--fsusblog-color-warning-text)]">
          <el-icon><Warning /></el-icon>
        </span>
        <span class="text-[10px] font-black normal-case tracking-normal text-[var(--fsusblog-color-warning-text)]">高权限管理模式 (Privileged Mode)</span>
      </div>
      <p class="text-[13px] leading-relaxed text-[var(--fsusblog-color-warning-text)] font-medium">
        变更站点全局配置将立即触发物理磁盘 AOT 缓存清理。若同步失败，系统将执行原子化回滚。
      </p>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="SEO 配置" name="site">
        <div class="mt-16 space-y-32">
          <!-- 上传与输出策略 -->
          <section class="profile-section">
            <header class="mb-12">
              <h3 class="section-title">上传与输出策略</h3>
              <p class="section-caption mt-4">控制封面压缩策略、预览图格式与断点续传行为。</p>
            </header>

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
          </section>

          <!-- 站点元信息 -->
          <section class="profile-section">
            <header class="mb-12">
              <h3 class="section-title">站点元信息</h3>
              <p class="section-caption mt-4">维护基础 URL、公开描述、关键词和社交预览图。</p>
            </header>

            <div class="max-w-4xl">
              <el-form :model="siteForm" label-position="top" @submit.prevent novalidate>
                <div class="grid grid-cols-1 gap-x-16 sm:grid-cols-2">
                  <el-form-item label="网站标题" required>
                    <el-input v-model="siteForm.title" name="siteTitle" maxlength="50" show-word-limit placeholder="Fsus's Blog" :disabled="savingSite" />
                  </el-form-item>
                  <el-form-item label="作者名称" required>
                    <el-input v-model="siteForm.author" name="siteAuthor" maxlength="20" placeholder="Fsu" :disabled="savingSite" />
                  </el-form-item>
                </div>

              <el-form-item label="站点基础 URL" required>
                <el-input v-model="siteForm.baseUrl" name="siteBaseUrl" placeholder="https://fsus.blog" :disabled="savingSite">
                  <template #prepend>URL</template>
                </el-input>
                <div class="text-[9px] font-bold text-[var(--fsusblog-text-muted)] mt-4 normal-case tracking-normal">
                  必须以 http/https 开头，禁止末尾斜杠。用于 RSS 与邮件生成。
                </div>
              </el-form-item>

              <el-form-item label="社交媒体预览图 (OgImage)">
                <div class="flex max-w-full flex-col items-stretch gap-12 mt-4 md:flex-row md:items-start">
                  <el-upload
                    class="w-full max-w-xs"
                    action="#"
                    media-field
                    media-aspect-ratio="16 / 9"
                    :http-request="handleImageAction"
                    :show-file-list="false"
                    accept="image/*"
                    :disabled="imageLoading"
                  >
                    <div v-loading="imageLoading" class="group relative min-w-0 overflow-hidden rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border-strong)] bg-[var(--fsusblog-page-bg)] transition-[background-color,border-color,color,opacity,transform] hover:border-[var(--fsusblog-color-primary)]">
                      <img v-if="displayUrl" :src="displayUrl" class="w-full h-full object-cover" />
                      <div v-else class="h-full flex flex-col items-center justify-center text-[var(--fsusblog-text-muted)]">
                        <el-icon size="24"><Plus /></el-icon>
                        <span class="text-[10px] mt-2 font-black normal-case tracking-normal">Upload Cover</span>
                      </div>
                      <div class="image-replace-overlay absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span class="text-[10px] font-black normal-case tracking-normal">点击更换 / REPLACE</span>
                      </div>
                    </div>
                  </el-upload>

                  <div class="flex-1 space-y-6">
                    <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] leading-relaxed italic max-w-sm">
                      建议尺寸 1200x630px。变更将清除物理缓存。
                    </p>
                    <el-button
                      v-if="hasOgImage"
                      link
                      type="danger"
                      :icon="Delete"
                      :disabled="imageLoading"
                      @click="confirmImageRemove"
                    >
                      物理删除并重置
                    </el-button>
                  </div>
                </div>
              </el-form-item>

              <el-form-item label="SEO 描述 (Description)">
                <el-input v-model="siteForm.description" name="siteDescription" type="textarea" :rows="4" maxlength="200" show-word-limit :disabled="savingSite" />
              </el-form-item>

              <el-form-item label="关键词 (Keywords)">
                <el-input v-model="siteForm.keywords" name="siteKeywords" placeholder="英文逗号分隔" :disabled="savingSite" @blur="sanitizeKeywords" />
                <div class="flex gap-3 mt-6 flex-wrap">
                  <el-tag v-for="tag in computedKeywords" :key="tag" size="small">
                    #{{ tag }}
                  </el-tag>
                </div>
              </el-form-item>

              <div class="mt-16 flex justify-end">
                <el-button
                  type="primary"
                  :disabled="savingSite"
                  @click.prevent="saveSiteConfig"
                >
                  {{ siteSubmitText }}
                </el-button>
              </div>
              </el-form>
            </div>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="页面编辑" name="pages">
        <div class="mt-16 space-y-16">
          <section class="profile-section">
            <header class="flex flex-col md:flex-row md:items-end justify-between gap-8 mb-12 pb-8 border-b border-[var(--fsusblog-panel-border)]">
              <div class="min-w-0">
                <h3 class="section-title section-title--inline">页面编辑</h3>
                <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] font-medium">维护 About、Archive 等静态页面的发布内容。</p>
              </div>
              <el-radio-group v-model="currentSlug" size="small" :disabled="pageLoading">
                <el-radio-button v-for="item in pageTargets" :key="item.value" :value="item.value">
                  {{ item.label }}
                </el-radio-button>
              </el-radio-group>
            </header>

            <div class="min-h-[500px]">
              <SettingsPageEditor
                v-if="activeTab === 'pages'"
                v-model="pageContent"
                v-loading="pageLoading"
                :loading="pageLoading"
                :saving="savingPage"
              />
            </div>

            <div class="mt-16 flex justify-end">
              <el-button
                type="primary"
                :disabled="savingPage || pageLoading"
                @click.prevent="confirmPagePublish"
              >
                {{ pageSubmitText }}
              </el-button>
            </div>
          </section>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ElMessageBox } from '@ozwasyd/element-plus'
import { Delete, Plus, Warning } from '@/ui/fsusIcons'
import { isFsusUiOk } from '@/utils/fsusUiResult'
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
  const result = await ElMessageBox.confirm('这会物理删除当前预览图，并立即同步到公开站点。', '重置预览图', {
    type: 'warning',
    confirmButtonText: '确认重置',
    cancelButtonText: '取消'
  })
  if (!isFsusUiOk(result)) {
    return
  }
  await handleImageRemove()
}

const confirmPagePublish = async (): Promise<void> => {
  const result = await ElMessageBox.confirm('确认发布当前页面内容？这会覆盖线上静态页面。', '发布页面', {
    type: 'warning',
    confirmButtonText: '确认发布',
    cancelButtonText: '取消'
  })
  if (!isFsusUiOk(result)) {
    return
  }
  await savePageContent()
}

</script>

<style scoped>
@reference "@/assets/main.css";

.profile-page {
  animation: fade-in var(--fsus-motion-panel) var(--fsus-motion-standard);
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Editorial Blocks */
.section-title {
  @apply text-[11px] font-bold tracking-normal mb-10 pb-4 border-b border-[var(--fsusblog-panel-border)] text-[var(--fsusblog-text-primary)] normal-case;
  position: relative;
}

.section-title::before {
  content: "";
  @apply absolute bottom-[-1px] left-0 h-[2px] w-8 bg-[var(--fsusblog-text-primary)];
}

.section-title--inline {
  @apply mb-2 border-none pb-0;
}

.section-title--inline::before {
  content: none;
}

.section-caption {
  @apply text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)] mb-10;
}

.image-replace-overlay {
  background: var(--fsus-overlay-color, transparent);
  color: var(--fsusblog-page-bg);
}
</style>
