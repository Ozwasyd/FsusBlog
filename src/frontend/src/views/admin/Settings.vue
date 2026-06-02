<template>
  <div class="account-page profile-page account-motion-enter w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">系统设置</h1>
      <p class="account-page-description">
        维护站点元信息、预览图与静态页面内容。高权限操作会触发明确确认，并自动同步至 AOT 缓存层。
      </p>
    </header>

    <section
      role="status"
      aria-labelledby="settings-privileged-mode-title"
      class="mb-12 border-l-2 border-[var(--fsusblog-color-warning-border)] bg-[var(--fsusblog-color-warning-bg)] px-6 py-5 rounded-r-[var(--fsus-radius-control)]"
    >
      <div class="flex items-center gap-3 mb-2">
        <span class="text-[var(--fsusblog-color-warning-text)]">
          <el-icon><Warning /></el-icon>
        </span>
        <span id="settings-privileged-mode-title" class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-color-warning-text)]">高权限管理模式 (Privileged Mode)</span>
      </div>
      <p class="text-[13px] leading-relaxed text-[var(--fsusblog-color-warning-text)] font-medium">
        变更站点全局配置将立即触发物理磁盘 AOT 缓存清理。若同步失败，系统将执行原子化回滚。
      </p>
    </section>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="站点信息" name="site">
        <div class="mt-10 space-y-14 md:space-y-16">
          <!-- 站点元信息 -->
          <section class="profile-section">
            <header class="mb-12">
              <h3 class="section-title">站点元信息</h3>
              <p class="section-caption mt-4">维护基础 URL、公开描述、关键词和社交预览图。</p>
            </header>

            <div class="max-w-4xl">
              <div v-if="siteLoadFailed" class="mb-8 border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] p-5 text-[12px] text-[var(--fsusblog-color-error)]">
                <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <span class="font-bold">站点配置加载失败，已暂停保存以避免覆盖线上配置。</span>
                  <el-button size="small" :disabled="loadingSite" @click="loadSiteConfig">重试</el-button>
                </div>
              </div>
              <el-form v-loading="loadingSite" :model="siteForm" label-position="top" @submit.prevent novalidate>
                <div class="grid grid-cols-1 gap-x-16 sm:grid-cols-2">
                  <el-form-item label="网站标题" required>
                    <el-input v-model="siteForm.title" name="siteTitle" maxlength="50" show-word-limit placeholder="Fsus's Blog" :disabled="siteFormDisabled" />
                  </el-form-item>
                  <el-form-item label="作者名称" required>
                    <el-input v-model="siteForm.author" name="siteAuthor" maxlength="20" placeholder="Fsu" :disabled="siteFormDisabled" />
                  </el-form-item>
                </div>

              <el-form-item label="站点基础 URL" required>
                <el-input v-model="siteForm.baseUrl" name="siteBaseUrl" placeholder="https://fsus.blog" :disabled="siteFormDisabled">
                  <template #prepend>URL</template>
                </el-input>
                <div class="text-[11px] font-bold text-[var(--fsusblog-text-muted)] mt-4 normal-case tracking-normal">
                  必须以 http/https 开头；保存时会自动移除末尾斜杠。用于 RSS、邮件与 canonical URL。
                </div>
                <div v-if="normalizedBaseUrl" class="text-[11px] font-bold text-[var(--fsusblog-text-muted)] mt-2 normal-case tracking-normal">
                  将保存为：{{ normalizedBaseUrl }}
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
                    :disabled="imageLoading || siteFormDisabled"
                  >
                    <div v-loading="imageLoading" class="group relative min-w-0 overflow-hidden rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border-strong)] bg-[var(--fsusblog-page-bg)] transition-[background-color,border-color,color,opacity,transform] hover:border-[var(--fsusblog-color-primary)]">
                      <img v-if="displayUrl" :src="displayUrl" alt="当前社交媒体预览图" class="w-full h-full object-cover" />
                      <div v-else class="h-full flex flex-col items-center justify-center text-[var(--fsusblog-text-muted)]">
                        <el-icon size="24"><Plus /></el-icon>
                        <span class="text-[11px] mt-2 font-black normal-case tracking-normal">上传预览图</span>
                      </div>
                      <div class="image-replace-overlay absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span class="text-[11px] font-black normal-case tracking-normal">点击更换 / REPLACE</span>
                      </div>
                    </div>
                  </el-upload>

                  <div class="flex-1 space-y-6">
                    <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] leading-relaxed italic max-w-sm">
                      建议尺寸 1200x630px。上传只更新待保存配置，点击保存同步后才会清理公开缓存。
                    </p>
                    <el-button
                      v-if="hasOgImage"
                      link
                      type="danger"
                      :icon="Delete"
                      :disabled="imageLoading || siteFormDisabled"
                      @click="confirmImageRemove"
                    >
                      从配置移除
                    </el-button>
                  </div>
                </div>
              </el-form-item>

              <el-form-item label="SEO 描述 (Description)">
                <el-input v-model="siteForm.description" name="siteDescription" type="textarea" :rows="4" maxlength="200" show-word-limit :disabled="siteFormDisabled" />
              </el-form-item>

              <el-form-item label="关键词 (Keywords)">
                <el-input v-model="siteForm.keywords" name="siteKeywords" placeholder="英文逗号分隔" :disabled="siteFormDisabled" @blur="sanitizeKeywords" />
                <div class="flex gap-3 mt-6 flex-wrap">
                  <el-tag v-for="tag in computedKeywords" :key="tag" size="small">
                    #{{ tag }}
                  </el-tag>
                </div>
              </el-form-item>

              <section class="mt-12 border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5" aria-label="SEO 与社交分享预览">
                <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">预览 / PREVIEW</div>
                <div class="space-y-2">
                  <p class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ siteSearchPreview.title }}</p>
                  <p class="text-[12px] text-[var(--fsusblog-color-success)] break-all">{{ siteSearchPreview.url }}</p>
                  <p class="text-[12px] text-[var(--fsusblog-text-tertiary)] leading-relaxed">{{ siteSearchPreview.description }}</p>
                </div>
                <div v-if="siteForm.description.length > 160" class="mt-4 text-[11px] font-bold text-[var(--fsusblog-color-warning-text)]">
                  描述较长，搜索结果中可能被截断。
                </div>
              </section>

              <div class="mt-16 flex justify-end">
                <el-button
                  type="primary"
                  :disabled="siteFormDisabled || !isSiteDirty"
                  @click.prevent="confirmSiteSave"
                >
                  {{ siteSubmitText }}
                </el-button>
              </div>
              </el-form>
            </div>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="媒体策略" name="media">
        <div class="mt-10 space-y-14 md:space-y-16">
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
        </div>
      </el-tab-pane>

      <el-tab-pane label="页面编辑" name="pages">
        <div class="mt-16 space-y-16">
          <section class="profile-section">
            <header class="flex flex-col md:flex-row md:items-end justify-between gap-8 mb-12 pb-8 border-b border-[var(--fsusblog-panel-border)]">
              <div class="min-w-0">
                <h3 class="section-title section-title--inline">页面编辑</h3>
                <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] font-medium">维护 About、Archive 等静态页面的发布内容。</p>
                <p class="mt-3 text-[11px] font-bold normal-case tracking-normal" :class="isPageDirty ? 'text-[var(--fsusblog-color-warning-text)]' : 'text-[var(--fsusblog-text-muted)]'">
                  {{ currentPageTarget.label }} · {{ pageContentLength }} 字 · {{ isPageDirty ? '有未发布修改' : '已同步' }}
                </p>
              </div>
              <el-radio-group :model-value="currentSlug" size="small" :disabled="pageLoading || savingPage" @update:model-value="requestPageSwitch">
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

    <el-dialog
      :model-value="Boolean(pendingPageSwitchSlug)"
      title="当前页面有未发布修改"
      width="min(92vw, 460px)"
      @update:model-value="cancelPageSwitch"
    >
      <div class="space-y-5 text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
        <p>
          当前「{{ currentPageTarget.label }}」页面有未发布修改。切换页面前请选择保留方式。
        </p>
        <div class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-4 text-[12px] text-[var(--fsusblog-text-tertiary)]">
          未发布内容：{{ pageContentLength }} 字。保存并切换会先发布当前页面，然后加载目标页面。
        </div>
      </div>
      <template #footer>
        <div class="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <el-button :disabled="savingPage || pageLoading" @click="cancelPageSwitch">取消</el-button>
          <el-button :disabled="savingPage || pageLoading" @click="discardPageChangesAndSwitch">放弃修改</el-button>
          <el-button type="primary" :loading="savingPage || pageLoading" @click="savePageAndSwitch">保存并切换</el-button>
        </div>
      </template>
    </el-dialog>
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
  loadingSite,
  siteFormDisabled,
  siteLoadFailed,
  pageLoading,
  imageLoading,
  siteForm,
  currentSlug,
  pageContent,
  pageTargets,
  displayUrl,
  hasOgImage,
  computedKeywords,
  normalizedBaseUrl,
  isSiteDirty,
  siteChangeSummary,
  siteSearchPreview,
  siteSubmitText,
  pageSubmitText,
  isPageDirty,
  currentPageTarget,
  pageContentLength,
  pendingPageSwitchSlug,
  imageUploadOptions,
  imageUploadWasmOnlyMode,
  setImageUploadWasmOnlyMode,
  setImageUploadOptions,
  imageUploadRuntime,
  resumeImageUpload,
  sanitizeKeywords,
  handleImageAction,
  handleImageRemove,
  loadSiteConfig,
  saveSiteConfig,
  savePageContent,
  requestPageSwitch,
  cancelPageSwitch,
  discardPageChangesAndSwitch,
  savePageAndSwitch
} = useAdminSettingsPage()

const confirmImageRemove = async (): Promise<void> => {
  const result = await ElMessageBox.confirm('这只会从待保存配置中移除当前预览图，点击保存同步后才会影响公开站点。', '移除预览图', {
    type: 'warning',
    confirmButtonText: '确认移除',
    cancelButtonText: '取消'
  })
  if (!isFsusUiOk(result)) {
    return
  }
  await handleImageRemove()
}

const confirmSiteSave = async (): Promise<void> => {
  const changed = siteChangeSummary.value.length > 0 ? siteChangeSummary.value.join('、') : '站点配置'
  const result = await ElMessageBox.confirm(`本次将修改：${changed}。保存后将清理 AOT 缓存。`, '保存站点信息', {
    type: 'warning',
    confirmButtonText: '保存同步',
    cancelButtonText: '取消'
  })
  if (!isFsusUiOk(result)) {
    return
  }
  await saveSiteConfig()
}

const confirmPagePublish = async (): Promise<void> => {
  const result = await ElMessageBox.confirm(`确认发布「${currentPageTarget.value.label}」页面？当前内容 ${pageContentLength.value} 字，这会覆盖线上静态页面。`, '发布页面', {
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
