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
        <span id="settings-privileged-mode-title" class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-color-warning-text)]">高权限管理模式</span>
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

              <el-form-item label="社交分享预览图">
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
                        <span class="text-[11px] font-black normal-case tracking-normal">点击更换</span>
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
                    <el-button
                      v-if="hasOgImage"
                      link
                      type="danger"
                      :icon="Delete"
                      :disabled="imageLoading || siteFormDisabled"
                      @click="confirmImageDelete"
                    >
                      删除服务器文件
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
                <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">搜索结果预览</div>
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

      <el-tab-pane label="大陆合规" name="compliance">
        <div class="mt-10 space-y-14 md:space-y-16">
          <section class="profile-section">
            <header class="mb-12">
              <h3 class="section-title">大陆合规信息</h3>
              <p class="section-caption mt-4">维护公开 footer、RSS 版权和大陆部署检查清单。备案信息只负责展示，请以工信部和公安备案平台审核结果为准。</p>
            </header>

            <div v-if="complianceLoadFailed" class="mb-8 border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] p-5 text-[12px] text-[var(--fsusblog-color-error)]">
              <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <span class="font-bold">合规配置加载失败，已暂停保存以避免覆盖线上配置。</span>
                <el-button size="small" :disabled="loadingCompliance" @click="loadComplianceConfig">重试</el-button>
              </div>
            </div>

            <el-form v-loading="loadingCompliance" :model="complianceForm" label-position="top" @submit.prevent novalidate>
              <div class="grid grid-cols-1 gap-x-16 lg:grid-cols-[minmax(0,1fr)_22rem]">
                <div class="min-w-0">
                  <el-form-item label="启用公开合规展示">
                    <el-switch
                      v-model="complianceForm.enabled"
                      :disabled="complianceFormDisabled"
                      active-text="启用"
                      inactive-text="关闭"
                    />
                    <div class="text-[11px] font-bold text-[var(--fsusblog-text-muted)] mt-4 normal-case tracking-normal">
                      关闭时不展示备案号和许可说明；基础版权与页脚导航仍会保留。
                    </div>
                  </el-form-item>

                  <el-form-item label="部署区域">
                    <el-radio-group v-model="complianceForm.regionMode" :disabled="complianceFormDisabled">
                      <el-radio-button value="global">通用</el-radio-button>
                      <el-radio-button value="mainland-cn">中国大陆</el-radio-button>
                    </el-radio-group>
                  </el-form-item>

                  <div class="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                    <el-form-item label="ICP 备案号">
                      <el-input v-model="complianceForm.icpRecordNumber" maxlength="64" show-word-limit :disabled="complianceFormDisabled" placeholder="京ICP备2026000000号-1" />
                    </el-form-item>
                    <el-form-item label="ICP 链接">
                      <el-input v-model="complianceForm.icpRecordUrl" :disabled="complianceFormDisabled" placeholder="https://beian.miit.gov.cn/" />
                    </el-form-item>
                    <el-form-item label="公安备案号">
                      <el-input v-model="complianceForm.policeRecordNumber" maxlength="64" show-word-limit :disabled="complianceFormDisabled" placeholder="京公网安备11000002000000号" />
                    </el-form-item>
                    <el-form-item label="公安备案链接">
                      <el-input v-model="complianceForm.policeRecordUrl" :disabled="complianceFormDisabled" placeholder="https://beian.mps.gov.cn/" />
                    </el-form-item>
                  </div>

                  <el-form-item label="公安备案图标">
                    <el-input v-model="complianceForm.policeBadgeIconUrl" :disabled="complianceFormDisabled" placeholder="可留空，或填写公安备案图标 URL" />
                  </el-form-item>

                  <div class="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                    <el-form-item label="版权主体">
                      <el-input v-model="complianceForm.copyrightOwner" maxlength="128" show-word-limit :disabled="complianceFormDisabled" placeholder="Fsu's Blog" />
                    </el-form-item>
                    <el-form-item label="版权起始年份">
                      <el-input-number
                        v-model="complianceForm.copyrightStartYear"
                        :min="1990"
                        :max="new Date().getFullYear()"
                        :disabled="complianceFormDisabled"
                        controls-position="right"
                      />
                    </el-form-item>
                  </div>

                  <el-form-item label="版权说明">
                    <el-input v-model="complianceForm.copyrightText" type="textarea" :rows="3" maxlength="512" show-word-limit :disabled="complianceFormDisabled" placeholder="保留所有权利。" />
                  </el-form-item>

                  <div class="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                    <el-form-item label="内容许可名称">
                      <el-input v-model="complianceForm.contentLicenseName" maxlength="128" show-word-limit :disabled="complianceFormDisabled" placeholder="CC BY-NC-SA 4.0" />
                    </el-form-item>
                    <el-form-item label="内容许可链接">
                      <el-input v-model="complianceForm.contentLicenseUrl" :disabled="complianceFormDisabled" placeholder="https://creativecommons.org/licenses/by-nc-sa/4.0/" />
                    </el-form-item>
                    <el-form-item label="运营主体">
                      <el-input v-model="complianceForm.operatorName" maxlength="128" show-word-limit :disabled="complianceFormDisabled" placeholder="可留空" />
                    </el-form-item>
                    <el-form-item label="联系邮箱">
                      <el-input v-model="complianceForm.contactEmail" maxlength="128" show-word-limit :disabled="complianceFormDisabled" placeholder="name@example.com" />
                    </el-form-item>
                  </div>
                </div>

                <aside class="mt-10 space-y-8 lg:mt-0">
                  <section class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5" aria-label="页脚合规预览">
                    <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">页脚预览</div>
                    <div class="space-y-3 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
                      <p class="font-bold text-[var(--fsusblog-text-primary)]">{{ compliancePreview.copyright }}</p>
                      <p v-if="compliancePreview.license">许可：{{ compliancePreview.license }}</p>
                      <p v-if="compliancePreview.icp">ICP：{{ compliancePreview.icp }}</p>
                      <p v-if="compliancePreview.police">公安备案：{{ compliancePreview.police }}</p>
                      <p v-if="!compliancePreview.icp && !compliancePreview.police">未配置备案号时，公开页不会展示备案占位。</p>
                    </div>
                  </section>

                  <section class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5" aria-label="大陆上线检查清单">
                    <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">大陆上线检查清单</div>
                    <ul class="space-y-3 text-[12px] leading-relaxed">
                      <li v-for="item in mainlandLaunchChecklist" :key="item.label" class="flex items-start gap-3">
                        <span class="mt-0.5 h-2 w-2 shrink-0 rounded-full" :class="item.done ? 'bg-[var(--fsusblog-color-success)]' : 'bg-[var(--fsusblog-text-muted)]'" />
                        <span :class="item.done ? 'text-[var(--fsusblog-text-primary)]' : 'text-[var(--fsusblog-text-muted)]'">{{ item.label }}</span>
                      </li>
                    </ul>
                  </section>
                </aside>
              </div>

              <div class="mt-16 flex justify-end">
                <el-button
                  type="primary"
                  :disabled="complianceFormDisabled || !isComplianceDirty"
                  @click.prevent="confirmComplianceSave"
                >
                  {{ complianceSubmitText }}
                </el-button>
              </div>
            </el-form>
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
                <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] font-medium">维护关于、隐私政策、用户守则与版权声明页面的发布内容。</p>
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

            <div class="mt-16 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <el-button
                :disabled="savingPage || refreshingPage || pageLoading"
                :loading="refreshingPage"
                @click.prevent="confirmPageRefresh"
              >
                强制刷新缓存
              </el-button>
              <el-button
                type="primary"
                :disabled="savingPage || refreshingPage || pageLoading"
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
import { Delete, Plus, Warning } from '@/fsusui/icons'
import { confirmWarning } from '@/fsusui/feedback'
import SettingsPageEditor from '@/components/admin/settings/SettingsPageEditor.vue'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useAdminSettingsPage } from '@/composables/useAdminSettingsPage'

const {
  activeTab,
  savingPage,
  refreshingPage,
  loadingSite,
  loadingCompliance,
  siteFormDisabled,
  complianceFormDisabled,
  siteLoadFailed,
  complianceLoadFailed,
  pageLoading,
  imageLoading,
  siteForm,
  complianceForm,
  currentSlug,
  pageContent,
  pageTargets,
  displayUrl,
  hasOgImage,
  computedKeywords,
  normalizedBaseUrl,
  isSiteDirty,
  isComplianceDirty,
  siteChangeSummary,
  siteSearchPreview,
  compliancePreview,
  mainlandLaunchChecklist,
  siteSubmitText,
  complianceSubmitText,
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
  handleImageDelete,
  loadSiteConfig,
  loadComplianceConfig,
  saveSiteConfig,
  saveComplianceConfig,
  savePageContent,
  refreshPageCache,
  requestPageSwitch,
  cancelPageSwitch,
  discardPageChangesAndSwitch,
  savePageAndSwitch
} = useAdminSettingsPage()

const confirmImageRemove = async (): Promise<void> => {
  const confirmed = await confirmWarning('这只会从待保存配置中移除当前预览图，点击保存同步后才会影响公开站点。', '移除预览图', {
    confirmButtonText: '确认移除',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }
  await handleImageRemove()
}

const confirmImageDelete = async (): Promise<void> => {
  const confirmed = await confirmWarning('这会从待保存配置中移除当前预览图，并立即请求后端删除服务器文件。删除失败不会清空配置。', '删除服务器文件', {
    confirmButtonText: '移除并删除',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }
  await handleImageDelete()
}

const confirmSiteSave = async (): Promise<void> => {
  const changed = siteChangeSummary.value.length > 0 ? siteChangeSummary.value.join('、') : '站点配置'
  const confirmed = await confirmWarning(`本次将修改：${changed}。保存后将清理 AOT 缓存。`, '保存站点信息', {
    confirmButtonText: '保存同步',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }
  await saveSiteConfig()
}

const confirmComplianceSave = async (): Promise<void> => {
  const confirmed = await confirmWarning('保存后将刷新公开 footer、RSS 版权和 AOT 缓存。备案信息仅用于展示，请确认已通过官方平台审核。', '保存大陆合规信息', {
    confirmButtonText: '保存合规信息',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }
  await saveComplianceConfig()
}

const confirmPagePublish = async (): Promise<void> => {
  const confirmed = await confirmWarning(`确认发布「${currentPageTarget.value.label}」页面？当前内容 ${pageContentLength.value} 字，这会覆盖线上静态页面。`, '发布页面', {
    confirmButtonText: '确认发布',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }
  await savePageContent()
}

const confirmPageRefresh = async (): Promise<void> => {
  const confirmed = await confirmWarning(`确认强制刷新「${currentPageTarget.value.label}」页面缓存？`, '刷新页面缓存', {
    confirmButtonText: '确认刷新',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }
  await refreshPageCache()
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
