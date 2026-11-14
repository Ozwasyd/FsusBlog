<template>
    <div class="account-page profile-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="系统设置"
            class="account-task-page-header"
        />

        <section
            role="status"
            aria-labelledby="settings-privileged-mode-title"
            class="admin-muted-alert admin-muted-alert--warning mb-8 px-5 py-4"
        >
            <div class="flex items-center gap-3 mb-2">
                <span class="text-[var(--fsusblog-color-warning)]">
                    <ElIcon aria-hidden="true"><Warning /></ElIcon>
                </span>
                <span
                    id="settings-privileged-mode-title"
                    class="admin-muted-alert__title text-xs font-medium normal-case tracking-normal"
                >高权限管理模式</span>
            </div>
            <p class="text-[13px] leading-relaxed font-medium">
                变更站点全局配置将立即触发物理磁盘 AOT 缓存清理。若同步失败，系统将执行原子化回滚。
            </p>
        </section>

        <ElTabs
            v-model="activeTab"
            stretch
            class="blog-motion-task-region settings-tabs blog-scroll-x-safe"
            :class="{
                'blog-motion-task-region--pending': savingSite || savingCompliance || savingPage || refreshingPage,
                'blog-motion-task-region--settled': isTaskHighlighted('settings-site')
                    || isTaskHighlighted('settings-compliance')
                    || isTaskHighlighted('settings-page')
            }"
        >
            <ElTabPane
                label="站点信息"
                name="site"
            >
                <div class="mt-10 space-y-14 md:space-y-16">
                    <section class="profile-section">
                        <header class="mb-8">
                            <h3 class="section-title">基础信息</h3>
                            <p class="section-caption mt-2">维护基础 URL、公开描述和社交预览图。</p>
                        </header>

                        <div class="max-w-4xl">
                            <div
                                v-if="siteLoadFailed"
                                class="admin-muted-alert admin-muted-alert--danger mb-8 p-5 text-[12px]"
                            >
                                <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                    <span class="font-bold">站点配置加载失败，已暂停保存以避免覆盖线上配置。</span>
                                    <ElButton
                                        size="small"
                                        :disabled="loadingSite"
                                        @click="loadSiteConfig"
                                    >重试</ElButton>
                                </div>
                            </div>
                            <ElForm
                                v-loading="loadingSite"
                                :model="siteForm"
                                label-position="top"
                                @submit.prevent
                                novalidate
                            >
                                <div class="grid grid-cols-1 gap-x-16 sm:grid-cols-2">
                                    <ElFormItem
                                        label="网站标题"
                                        required
                                    >
                                        <ElInput
                                            v-model="siteForm.title"
                                            name="siteTitle"
                                            maxlength="50"
                                            show-word-limit
                                            placeholder="Fsu's Blog"
                                            :disabled="siteFormDisabled"
                                        />
                                    </ElFormItem>
                                    <ElFormItem
                                        label="作者名称"
                                        required
                                    >
                                        <ElInput
                                            v-model="siteForm.author"
                                            name="siteAuthor"
                                            maxlength="20"
                                            placeholder="Fsu"
                                            :disabled="siteFormDisabled"
                                        />
                                    </ElFormItem>
                                </div>

                                <ElFormItem
                                    label="站点基础 URL"
                                    required
                                >
                                    <ElInput
                                        v-model="siteForm.baseUrl"
                                        name="siteBaseUrl"
                                        placeholder="https://fsus.blog"
                                        :disabled="siteFormDisabled"
                                    >
                                        <template #prepend>URL</template>
                                    </ElInput>
                                    <div class="text-[11px] font-bold text-[var(--fsusblog-text-muted)] mt-4 normal-case tracking-normal">
                                        必须以 http/https 开头；保存时会自动移除末尾斜杠。用于 RSS、邮件与 canonical URL。
                                    </div>
                                    <div
                                        v-if="normalizedBaseUrl"
                                        class="text-[11px] font-bold text-[var(--fsusblog-text-muted)] mt-2 normal-case tracking-normal"
                                    >
                                        将保存为：{{ normalizedBaseUrl }}
                                    </div>
                                </ElFormItem>

                                <ElFormItem label="社交分享预览图">
                                    <div class="flex max-w-full flex-col items-stretch gap-12 mt-4 md:flex-row md:items-start">
                                        <ElUpload
                                            class="settings-og-image-upload w-full max-w-xs"
                                            action="#"
                                            media-field
                                            media-aspect-ratio="16 / 9"
                                            :http-request="handleImageAction"
                                            :show-file-list="false"
                                            accept="image/*"
                                            :disabled="imageLoading || siteFormDisabled"
                                            data-settings-upload-surface="og-image"
                                            :data-upload-state="ogImageUploadState"
                                        >
                                            <div
                                                v-loading="imageLoading"
                                                class="group relative min-w-0 overflow-hidden rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border-strong)] bg-[var(--fsusblog-page-bg)] transition-[background-color,border-color,color,opacity,transform] hover:border-[var(--fsusblog-color-primary)]"
                                            >
                                                <img
                                                    v-if="displayUrl"
                                                    :src="displayUrl"
                                                    :alt="ogImagePreviewAlt"
                                                    class="w-full h-full object-cover"
                                                />
                                                <div
                                                    v-else
                                                    class="h-full min-h-12 w-full flex flex-col items-center justify-center text-[var(--fsusblog-text-muted)]"
                                                >
                                                    <ElIcon
                                                        :size="24"
                                                        aria-hidden="true"
                                                    ><Plus /></ElIcon>
                                                    <span class="text-[11px] mt-2 font-medium normal-case tracking-normal">上传预览图</span>
                                                </div>
                                                <div
                                                    v-if="displayUrl"
                                                    class="image-replace-overlay absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                                                >
                                                    <span class="text-xs font-medium normal-case tracking-normal">点击更换</span>
                                                </div>
                                            </div>
                                        </ElUpload>

                                        <div class="flex-1 space-y-6">
                                            <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] leading-relaxed italic max-w-sm">
                                                建议尺寸 1200x630px。上传只更新待保存配置，点击保存同步后才会清理公开缓存。
                                            </p>
                                            <ElButton
                                                v-if="hasOgImage"
                                                class="settings-image-action"
                                                link
                                                type="danger"
                                                :icon="Delete"
                                                :disabled="imageLoading || siteFormDisabled"
                                                @click="confirmImageRemove"
                                            >
                                                从配置移除
                                            </ElButton>
                                            <ElButton
                                                v-if="hasOgImage"
                                                class="settings-image-action"
                                                link
                                                type="danger"
                                                :icon="Delete"
                                                :disabled="imageLoading || siteFormDisabled"
                                                @click="confirmImageDelete"
                                            >
                                                删除服务器文件
                                            </ElButton>
                                        </div>
                                    </div>
                                </ElFormItem>

                                <ElFormItem label="SEO 描述 (Description)">
                                    <ElInput
                                        v-model="siteForm.description"
                                        name="siteDescription"
                                        :csp-safe="true"
                                        type="textarea"
                                        :rows="4"
                                        maxlength="200"
                                        show-word-limit
                                        :disabled="siteFormDisabled"
                                    />
                                </ElFormItem>

                                <section
                                    class="mt-10 border-t border-[var(--fsusblog-panel-border)] pt-8"
                                    aria-label="浏览器与 PWA 资产"
                                >
                                    <header class="mb-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                                        <div>
                                            <h4 class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-primary)]">浏览器与 PWA</h4>
                                            <p class="mt-3 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">这些字段会写入 favicon、Apple Touch Icon 与 manifest.webmanifest。</p>
                                        </div>
                                        <ElUpload
                                            class="settings-icon-set-upload"
                                            action="#"
                                            :http-request="handleFaviconSetGeneration"
                                            :show-file-list="false"
                                            accept="image/png,image/jpeg,image/webp"
                                            :disabled="siteFormDisabled || iconSetGenerating"
                                            data-settings-upload-surface="icon-set"
                                            :data-upload-state="iconSetUploadState"
                                        >
                                            <span class="settings-icon-set-trigger">{{ iconSetTriggerText }}</span>
                                        </ElUpload>
                                    </header>
                                    <div class="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                                        <ElFormItem
                                            label="SVG favicon"
                                            class="sm:col-span-2"
                                        >
                                            <ElInput
                                                v-model="siteForm.faviconSvgUrl"
                                                maxlength="256"
                                                :disabled="siteFormDisabled"
                                                placeholder="/favicon/favicon.svg"
                                            />
                                            <div class="mt-3 text-[11px] font-medium leading-relaxed text-[var(--fsusblog-text-muted)]">
                                                SVG 仅支持填写已清洗的安全 URL；上传入口不会接收 SVG 原文。
                                            </div>
                                        </ElFormItem>
                                    </div>
                                    <div class="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                                        <BrandAssetUploadField
                                            v-model="siteForm.faviconIcoUrl"
                                            label="ICO favicon"
                                            target-field="faviconIcoUrl"
                                            :disabled="siteFormDisabled"
                                            :uploading="brandAssetUploadingField === 'faviconIcoUrl'"
                                            :preview-url="resolveBrandAssetPreviewUrl('faviconIcoUrl')"
                                            preview-variant="icon"
                                            placeholder="/favicon/favicon.ico"
                                            accept="image/x-icon,image/vnd.microsoft.icon,.ico"
                                            @upload="handleBrandAssetUpload"
                                        />
                                        <BrandAssetUploadField
                                            v-model="siteForm.faviconPngUrl"
                                            label="PNG favicon"
                                            target-field="faviconPngUrl"
                                            :disabled="siteFormDisabled"
                                            :uploading="brandAssetUploadingField === 'faviconPngUrl'"
                                            :preview-url="resolveBrandAssetPreviewUrl('faviconPngUrl')"
                                            preview-variant="icon"
                                            placeholder="/favicon/favicon-32x32.png"
                                            @upload="handleBrandAssetUpload"
                                        />
                                        <BrandAssetUploadField
                                            v-model="siteForm.appleTouchIconUrl"
                                            label="Apple Touch Icon"
                                            target-field="appleTouchIconUrl"
                                            :disabled="siteFormDisabled"
                                            :uploading="brandAssetUploadingField === 'appleTouchIconUrl'"
                                            :preview-url="resolveBrandAssetPreviewUrl('appleTouchIconUrl')"
                                            preview-variant="icon"
                                            placeholder="/favicon/apple-touch-icon.png"
                                            @upload="handleBrandAssetUpload"
                                        />
                                        <BrandAssetUploadField
                                            v-model="siteForm.pwaIcon192Url"
                                            label="PWA 192 图标"
                                            target-field="pwaIcon192Url"
                                            :disabled="siteFormDisabled"
                                            :uploading="brandAssetUploadingField === 'pwaIcon192Url'"
                                            :preview-url="resolveBrandAssetPreviewUrl('pwaIcon192Url')"
                                            preview-variant="icon"
                                            placeholder="/favicon/pwa-192x192.png"
                                            @upload="handleBrandAssetUpload"
                                        />
                                        <BrandAssetUploadField
                                            v-model="siteForm.pwaIcon512Url"
                                            label="PWA 512 图标"
                                            target-field="pwaIcon512Url"
                                            :disabled="siteFormDisabled"
                                            :uploading="brandAssetUploadingField === 'pwaIcon512Url'"
                                            :preview-url="resolveBrandAssetPreviewUrl('pwaIcon512Url')"
                                            preview-variant="icon"
                                            placeholder="/favicon/pwa-512x512.png"
                                            @upload="handleBrandAssetUpload"
                                        />
                                        <BrandAssetUploadField
                                            v-model="siteForm.pwaMaskableIconUrl"
                                            label="PWA maskable 图标"
                                            target-field="pwaMaskableIconUrl"
                                            :disabled="siteFormDisabled"
                                            :uploading="brandAssetUploadingField === 'pwaMaskableIconUrl'"
                                            :preview-url="resolveBrandAssetPreviewUrl('pwaMaskableIconUrl')"
                                            preview-variant="icon"
                                            placeholder="/favicon/maskable-icon-512x512.png"
                                            @upload="handleBrandAssetUpload"
                                        />
                                    </div>
                                    <div class="mt-8 grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                                        <ElFormItem label="PWA 名称">
                                            <ElInput
                                                v-model="siteForm.manifestName"
                                                maxlength="128"
                                                show-word-limit
                                                :disabled="siteFormDisabled"
                                                placeholder="FsusBlog"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="PWA 短名称">
                                            <ElInput
                                                v-model="siteForm.manifestShortName"
                                                maxlength="128"
                                                show-word-limit
                                                :disabled="siteFormDisabled"
                                                placeholder="FsusBlog"
                                            />
                                        </ElFormItem>
                                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                            <ElFormItem label="主题色">
                                                <ElInput
                                                    v-model="siteForm.themeColor"
                                                    maxlength="7"
                                                    :disabled="siteFormDisabled"
                                                    placeholder="#0B4F7A"
                                                >
                                                    <template #prepend>
                                                        <span
                                                            v-csp-style="{ backgroundColor: siteForm.themeColor }"
                                                            class="inline-block h-4 w-4 border border-[var(--fsusblog-panel-border)]"
                                                        />
                                                    </template>
                                                </ElInput>
                                            </ElFormItem>
                                            <ElFormItem label="启动背景">
                                                <ElInput
                                                    v-model="siteForm.backgroundColor"
                                                    maxlength="7"
                                                    :disabled="siteFormDisabled"
                                                    placeholder="#FFFFFF"
                                                >
                                                    <template #prepend>
                                                        <span
                                                            v-csp-style="{ backgroundColor: siteForm.backgroundColor }"
                                                            class="inline-block h-4 w-4 border border-[var(--fsusblog-panel-border)]"
                                                        />
                                                    </template>
                                                </ElInput>
                                            </ElFormItem>
                                        </div>
                                    </div>
                                </section>

                                <section
                                    class="mt-10 border-t border-[var(--fsusblog-panel-border)] pt-8"
                                    aria-label="品牌资产"
                                >
                                    <header class="mb-8">
                                        <h4 class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-primary)]">品牌资产</h4>
                                        <p class="mt-3 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">公开页、管理后台与登录页会优先使用这些图片；留空时回退为文字站名。</p>
                                    </header>
                                    <div class="grid grid-cols-1 gap-8 lg:grid-cols-3">
                                        <section class="space-y-5 border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5">
                                            <h5 class="text-sm font-bold text-[var(--fsusblog-text-primary)]">公开站点</h5>
                                            <BrandAssetUploadField
                                                v-model="siteForm.siteLogoUrl"
                                                label="站点 Logo"
                                                target-field="siteLogoUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'siteLogoUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('siteLogoUrl')"
                                                preview-variant="logo"
                                                placeholder="/uploads/logo.svg"
                                                @upload="handleBrandAssetUpload"
                                            />
                                            <BrandAssetUploadField
                                                v-model="siteForm.siteLogoDarkUrl"
                                                label="深色站点 Logo"
                                                target-field="siteLogoDarkUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'siteLogoDarkUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('siteLogoDarkUrl')"
                                                preview-variant="logo"
                                                placeholder="可留空"
                                                @upload="handleBrandAssetUpload"
                                            />
                                            <BrandAssetUploadField
                                                v-model="siteForm.siteWordmarkUrl"
                                                label="站点字标"
                                                target-field="siteWordmarkUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'siteWordmarkUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('siteWordmarkUrl')"
                                                preview-variant="wide"
                                                placeholder="可留空"
                                                @upload="handleBrandAssetUpload"
                                            />
                                        </section>

                                        <section class="space-y-5 border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5">
                                            <h5 class="text-sm font-bold text-[var(--fsusblog-text-primary)]">后台管理</h5>
                                            <BrandAssetUploadField
                                                v-model="siteForm.adminLogoUrl"
                                                label="后台 Logo"
                                                target-field="adminLogoUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'adminLogoUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('adminLogoUrl')"
                                                preview-variant="logo"
                                                placeholder="可留空"
                                                @upload="handleBrandAssetUpload"
                                            />
                                            <BrandAssetUploadField
                                                v-model="siteForm.adminCollapsedIconUrl"
                                                label="后台折叠图标"
                                                target-field="adminCollapsedIconUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'adminCollapsedIconUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('adminCollapsedIconUrl')"
                                                preview-variant="icon"
                                                placeholder="可留空"
                                                @upload="handleBrandAssetUpload"
                                            />
                                        </section>

                                        <section class="space-y-5 border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5">
                                            <h5 class="text-sm font-bold text-[var(--fsusblog-text-primary)]">登录页</h5>
                                            <BrandAssetUploadField
                                                v-model="siteForm.loginLogoUrl"
                                                label="登录 Logo"
                                                target-field="loginLogoUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'loginLogoUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('loginLogoUrl')"
                                                preview-variant="logo"
                                                placeholder="可留空"
                                                @upload="handleBrandAssetUpload"
                                            />
                                            <BrandAssetUploadField
                                                v-model="siteForm.loginIconUrl"
                                                label="登录图标"
                                                target-field="loginIconUrl"
                                                :disabled="siteFormDisabled"
                                                :uploading="brandAssetUploadingField === 'loginIconUrl'"
                                                :preview-url="resolveBrandAssetPreviewUrl('loginIconUrl')"
                                                preview-variant="icon"
                                                placeholder="可留空"
                                                @upload="handleBrandAssetUpload"
                                            />
                                        </section>
                                    </div>
                                </section>

                                <section
                                    class="mt-10 rounded-[var(--fsus-radius-panel)] border border-l-4 border-[var(--fsusblog-panel-border)] border-l-[var(--fsusblog-color-primary)] bg-[var(--fsusblog-page-bg-soft)] p-6"
                                    aria-label="SEO 与社交分享预览"
                                >
                                    <h3 class="mb-4 text-xs font-bold uppercase tracking-wider text-[var(--fsusblog-text-muted)]">搜索结果预览</h3>
                                    <div class="space-y-2">
                                        <p class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ siteSearchPreview.title }}</p>
                                        <p class="text-[12px] text-[var(--fsusblog-color-success)] break-all">{{ siteSearchPreview.url }}</p>
                                        <p class="text-[12px] text-[var(--fsusblog-text-tertiary)] leading-relaxed">{{ siteSearchPreview.description }}</p>
                                    </div>
                                    <div
                                        v-if="siteForm.description.length > 160"
                                        class="mt-4 text-[11px] font-bold text-[var(--fsusblog-color-warning-text)]"
                                    >
                                        描述较长，搜索结果中可能被截断。
                                    </div>
                                </section>

                                <div class="mt-16 flex justify-end">
                                    <ElButton
                                        type="primary"
                                        :disabled="siteFormDisabled || !isSiteDirty"
                                        @click.prevent="confirmSiteSave"
                                    >
                                        {{ siteSubmitText }}
                                    </ElButton>
                                </div>
                            </ElForm>
                        </div>
                    </section>
                </div>
            </ElTabPane>

            <ElTabPane
                label="大陆合规"
                name="compliance"
            >
                <div class="mt-10 space-y-14 md:space-y-16">
                    <section class="profile-section">
                        <header class="mb-8">
                            <h3 class="section-title">大陆合规信息</h3>
                            <p class="section-caption mt-2">维护公开 footer、RSS 版权和大陆部署检查清单。备案信息只负责展示，请以工信部和公安备案平台审核结果为准。</p>
                        </header>

                        <div
                            v-if="complianceLoadFailed"
                            class="admin-muted-alert admin-muted-alert--danger mb-8 p-5 text-[12px]"
                        >
                            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <span class="font-bold">合规配置加载失败，已暂停保存以避免覆盖线上配置。</span>
                                <ElButton
                                    size="small"
                                    :disabled="loadingCompliance"
                                    @click="loadComplianceConfig"
                                >重试</ElButton>
                            </div>
                        </div>

                        <ElForm
                            v-loading="loadingCompliance"
                            :model="complianceForm"
                            label-position="top"
                            @submit.prevent
                            novalidate
                        >
                            <div class="grid grid-cols-1 gap-x-16 xl:grid-cols-[minmax(0,1fr)_22rem]">
                                <div class="min-w-0">
                                    <ElFormItem label="启用公开合规展示">
                                        <div class="settings-compliance-toggle-row flex min-w-0 items-center gap-3">
                                            <ElSwitch
                                                v-model="complianceForm.enabled"
                                                :disabled="complianceFormDisabled"
                                            />
                                            <span class="min-w-0 text-[11px] font-bold leading-5 text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
                                                关闭时不展示备案号和许可说明；基础版权与页脚导航仍会保留。
                                            </span>
                                        </div>
                                    </ElFormItem>

                                    <div class="settings-compliance-record-grid grid grid-cols-1 gap-x-10">
                                        <ElFormItem label="ICP 备案号">
                                            <ElInput
                                                v-model="complianceForm.icpRecordNumber"
                                                maxlength="64"
                                                show-word-limit
                                                :disabled="complianceFormDisabled"
                                                placeholder="京ICP备2026000000号-1"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="ICP 链接">
                                            <ElInput
                                                v-model="complianceForm.icpRecordUrl"
                                                :disabled="complianceFormDisabled"
                                                placeholder="https://beian.miit.gov.cn/"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="公安备案号">
                                            <ElInput
                                                v-model="complianceForm.policeRecordNumber"
                                                maxlength="64"
                                                show-word-limit
                                                :disabled="complianceFormDisabled"
                                                placeholder="京公网安备11000002000000号"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="公安备案链接">
                                            <ElInput
                                                v-model="complianceForm.policeRecordUrl"
                                                :disabled="complianceFormDisabled"
                                                placeholder="https://beian.mps.gov.cn/"
                                            />
                                        </ElFormItem>
                                    </div>

                                    <ElFormItem label="公安备案图标">
                                        <ElInput
                                            v-model="complianceForm.policeBadgeIconUrl"
                                            :disabled="complianceFormDisabled"
                                            placeholder="可留空，或填写公安备案图标 URL"
                                        />
                                    </ElFormItem>

                                    <div class="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                                        <ElFormItem label="版权主体">
                                            <ElInput
                                                v-model="complianceForm.copyrightOwner"
                                                maxlength="128"
                                                show-word-limit
                                                :disabled="complianceFormDisabled"
                                                placeholder="Fsu's Blog"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="版权起始年份">
                                            <ElInputNumber
                                                :model-value="complianceForm.copyrightStartYear ?? undefined"
                                                @update:model-value="updateCopyrightStartYear"
                                                :min="1990"
                                                :max="new Date().getFullYear()"
                                                :disabled="complianceFormDisabled"
                                                controls-position="right"
                                            />
                                        </ElFormItem>
                                    </div>

                                    <ElFormItem label="版权说明">
                                        <ElInput
                                            v-model="complianceForm.copyrightText"
                                            :csp-safe="true"
                                            type="textarea"
                                            :rows="3"
                                            maxlength="512"
                                            show-word-limit
                                            :disabled="complianceFormDisabled"
                                            placeholder="保留所有权利。"
                                        />
                                    </ElFormItem>

                                    <div class="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                                        <ElFormItem label="内容许可名称">
                                            <ElInput
                                                v-model="complianceForm.contentLicenseName"
                                                maxlength="128"
                                                show-word-limit
                                                :disabled="complianceFormDisabled"
                                                placeholder="CC BY-NC-SA 4.0"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="内容许可链接">
                                            <ElInput
                                                v-model="complianceForm.contentLicenseUrl"
                                                :disabled="complianceFormDisabled"
                                                placeholder="https://creativecommons.org/licenses/by-nc-sa/4.0/"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="运营主体">
                                            <ElInput
                                                v-model="complianceForm.operatorName"
                                                maxlength="128"
                                                show-word-limit
                                                :disabled="complianceFormDisabled"
                                                placeholder="可留空"
                                            />
                                        </ElFormItem>
                                        <ElFormItem label="联系邮箱">
                                            <ElInput
                                                v-model="complianceForm.contactEmail"
                                                maxlength="128"
                                                show-word-limit
                                                :disabled="complianceFormDisabled"
                                                placeholder="name@example.com"
                                            />
                                        </ElFormItem>
                                    </div>
                                </div>

                                <aside class="mt-10 space-y-8 lg:mt-0">
                                    <section
                                        class="rounded-[var(--fsus-radius-panel)] border border-l-4 border-[var(--fsusblog-panel-border)] border-l-[var(--fsusblog-color-primary)] bg-[var(--fsusblog-page-bg-soft)] p-6"
                                        aria-label="页脚合规预览"
                                    >
                                        <h3 class="mb-4 text-xs font-bold uppercase tracking-wider text-[var(--fsusblog-text-muted)]">页脚预览</h3>
                                        <div class="space-y-3 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
                                            <p class="font-bold text-[var(--fsusblog-text-primary)]">{{ compliancePreview.copyright }}</p>
                                            <p v-if="compliancePreview.license">许可：{{ compliancePreview.license }}</p>
                                            <p v-if="compliancePreview.icp">ICP：{{ compliancePreview.icp }}</p>
                                            <p v-if="compliancePreview.police">公安备案：{{ compliancePreview.police }}</p>
                                            <p v-if="!compliancePreview.icp && !compliancePreview.police">未配置备案号时，公开页不会展示备案占位。</p>
                                        </div>
                                    </section>

                                    <section
                                        class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-5"
                                        aria-label="大陆上线检查清单"
                                    >
                                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">大陆上线检查清单</div>
                                        <ul class="space-y-3 text-[12px] leading-relaxed">
                                            <li
                                                v-for="item in mainlandLaunchChecklist"
                                                :key="item.label"
                                                class="flex items-start gap-3"
                                            >
                                                <span
                                                    class="mt-1 h-2 w-2 shrink-0 rounded-[var(--fsus-radius-pill)]"
                                                    :class="item.done ? 'bg-[var(--fsusblog-color-success)]' : 'bg-[var(--fsusblog-text-muted)]'"
                                                />
                                                <span :class="item.done ? 'text-[var(--fsusblog-text-primary)]' : 'text-[var(--fsusblog-text-muted)]'">{{ item.label }}</span>
                                            </li>
                                        </ul>
                                    </section>
                                </aside>
                            </div>

                            <div class="mt-16 flex justify-end">
                                <ElButton
                                    type="primary"
                                    :disabled="complianceFormDisabled || !isComplianceDirty"
                                    @click.prevent="confirmComplianceSave"
                                >
                                    {{ complianceSubmitText }}
                                </ElButton>
                            </div>
                        </ElForm>
                    </section>
                </div>
            </ElTabPane>

            <ElTabPane
                label="媒体策略"
                name="media"
            >
                <div class="mt-10 space-y-14 md:space-y-16">
                    <section class="profile-section">
                        <header class="mb-8">
                            <h3 class="section-title">上传与输出策略</h3>
                            <p class="section-caption mt-2">控制封面压缩策略、预览图格式与断点续传行为。</p>
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
            </ElTabPane>

            <ElTabPane
                label="页面编辑"
                name="pages"
            >
                <div class="mt-16 space-y-16">
                    <section class="profile-section">
                        <header class="flex flex-col md:flex-row md:items-end justify-between gap-8 mb-12 pb-8 border-b border-[var(--fsusblog-panel-border)]">
                            <div class="min-w-0">
                                <h3 class="section-title section-title--inline">页面编辑</h3>
                                <p class="text-[13px] text-[var(--fsusblog-text-tertiary)] font-medium">维护关于、隐私政策、用户守则与版权声明页面的发布内容。</p>
                                <p
                                    class="mt-3 text-[11px] font-bold normal-case tracking-normal"
                                    :class="isPageDirty ? 'text-[var(--fsusblog-color-warning-text)]' : 'text-[var(--fsusblog-text-muted)]'"
                                >
                                    {{ currentPageTarget.label }} · {{ pageContentLength }} 字 · {{ isPageDirty ? '有未发布修改' : '已同步' }}
                                </p>
                            </div>
                            <ElRadioGroup
                                :model-value="currentSlug"
                                size="small"
                                :disabled="pageLoading || savingPage"
                                @update:model-value="requestPageSwitch"
                            >
                                <ElRadioButton
                                    v-for="item in pageTargets"
                                    :key="item.value"
                                    :value="item.value"
                                >
                                    {{ item.label }}
                                </ElRadioButton>
                            </ElRadioGroup>
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
                            <ElButton
                                :disabled="savingPage || refreshingPage || pageLoading"
                                :loading="refreshingPage"
                                @click.prevent="confirmPageRefresh"
                            >
                                强制刷新缓存
                            </ElButton>
                            <ElButton
                                type="primary"
                                :disabled="savingPage || refreshingPage || pageLoading"
                                @click.prevent="confirmPagePublish"
                            >
                                {{ pageSubmitText }}
                            </ElButton>
                        </div>
                    </section>
                </div>
            </ElTabPane>
        </ElTabs>

        <FsusDialog
            :model-value="Boolean(pendingPageSwitchSlug)"
            title="当前页面有未发布修改"
            width="min(92vw, 28rem)"
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
                    <ElButton
                        :disabled="savingPage || pageLoading"
                        @click="cancelPageSwitch"
                    >取消</ElButton>
                    <ElButton
                        :disabled="savingPage || pageLoading"
                        @click="discardPageChangesAndSwitch"
                    >放弃修改</ElButton>
                    <ElButton
                        type="primary"
                        :loading="savingPage || pageLoading"
                        @click="savePageAndSwitch"
                    >保存并切换</ElButton>
                </div>
            </template>
        </FsusDialog>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import BrandAssetUploadField from '@/components/admin/settings/BrandAssetUploadField.vue';
import SettingsPageEditor from '@/components/admin/settings/SettingsPageEditor.vue';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue';
import { useAdminSettingsPage } from '@/composables/useAdminSettingsPage';
import { FsusUiTaskPageHeader } from '@/fsusui';
import { confirmWarning, toast } from '@/fsusui/feedback';
import { Delete, Plus, Warning } from '@/fsusui/icons';
import { cspStyleDirective } from '@/services/cspStyleRuntime';

const vCspStyle = cspStyleDirective;

const {
    activeTab,
    taskFeedback,
    savingSite,
    savingCompliance,
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
    brandAssetUploadingField,
    iconSetGenerating,
    siteForm,
    complianceForm,
    currentSlug,
    pageContent,
    pageTargets,
    displayUrl,
    resolveBrandAssetPreviewUrl,
    hasOgImage,
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
    handleImageAction,
    handleBrandAssetUpload,
    handleFaviconSetGeneration,
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
} = useAdminSettingsPage();
const {
    isHighlighted: isTaskHighlighted
} = taskFeedback;

// InputNumber's clear payload is absence, not a replacement copyright year.
const updateCopyrightStartYear = (value: number | null | undefined): void =>
{
    complianceForm.copyrightStartYear = value ?? null;
};

const ogImageUploadState = computed(() =>
{
    if (siteFormDisabled.value)
    {
        return 'disabled';
    }
    if (imageLoading.value)
    {
        return 'uploading';
    }
    return displayUrl.value ? 'preview' : 'empty';
});
const ogImagePreviewAlt = computed(() => (
    displayUrl.value ? '当前社交媒体预览图，点击更换' : '当前社交媒体预览图'
));
const iconSetUploadState = computed(() =>
{
    if (siteFormDisabled.value)
    {
        return 'disabled';
    }
    if (iconSetGenerating.value)
    {
        return 'uploading';
    }
    return 'empty';
});
const iconSetTriggerText = computed(() => (
    iconSetGenerating.value ? '正在生成图标组' : '从图片生成图标组'
));

const showMessageBoxError = (error: unknown): void =>
{
    toast.error({
        message: '确认对话框打开失败',
        detail: error instanceof Error ? error.message : undefined
    });
};

const confirmImageRemove = async (): Promise<void> =>
{
    const result = await confirmWarning('这只会从待保存配置中移除当前预览图，点击保存同步后才会影响公开站点。', '移除预览图', {
        confirmButtonText: '确认移除',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            await handleImageRemove();
            return;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
    }
};

const confirmImageDelete = async (): Promise<void> =>
{
    const result = await confirmWarning('这会从待保存配置中移除当前预览图，并立即请求后端删除服务器文件。删除失败不会清空配置。', '删除服务器文件', {
        confirmButtonText: '移除并删除',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            await handleImageDelete();
            return;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
    }
};

const confirmSiteSave = async (): Promise<void> =>
{
    const changed = siteChangeSummary.value.length > 0 ? siteChangeSummary.value.join('、') : '站点配置';
    const result = await confirmWarning(`本次将修改：${changed}。保存后将清理 AOT 缓存。`, '保存站点信息', {
        confirmButtonText: '保存同步',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            await saveSiteConfig();
            return;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
    }
};

const confirmComplianceSave = async (): Promise<void> =>
{
    const result = await confirmWarning('保存后将刷新公开 footer、RSS 版权和 AOT 缓存。备案信息仅用于展示，请确认已通过官方平台审核。', '保存大陆合规信息', {
        confirmButtonText: '保存合规信息',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            await saveComplianceConfig();
            return;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
    }
};

const confirmPagePublish = async (): Promise<void> =>
{
    const result = await confirmWarning(`确认发布「${currentPageTarget.value.label}」页面？当前内容 ${pageContentLength.value} 字，这会覆盖线上静态页面。`, '发布页面', {
        confirmButtonText: '确认发布',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            await savePageContent();
            return;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
    }
};

const confirmPageRefresh = async (): Promise<void> =>
{
    const result = await confirmWarning(`确认强制刷新「${currentPageTarget.value.label}」页面缓存？`, '刷新页面缓存', {
        confirmButtonText: '确认刷新',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            await refreshPageCache();
            return;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
    }
};

</script>

<style scoped>
@reference "@/assets/main.css";

.section-title
 {
    @apply m-0 text-xl font-bold leading-tight tracking-normal text-[var(--fsusblog-text-primary)] normal-case;
}

.section-title::before
 {
    content: none;
}

.section-title--inline
 {
    @apply mb-2;
}

.section-title--inline::before
 {
    content: none;
}

.section-caption
 {
    @apply m-0 text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)];
}

.image-replace-overlay
 {
    background: var(--fsus-overlay-color, transparent);
    color: var(--fsusblog-page-bg);
}

.settings-og-image-upload:focus-within .image-replace-overlay
 {
    opacity: 1;
}

.settings-icon-set-trigger
 {
    display: inline-flex;
    min-height: 2rem;
    align-items: center;
    justify-content: center;
    padding-inline: 0.75rem;
    border: 1px solid var(--fsusblog-panel-border-strong);
    border-radius: var(--fsus-radius-popover);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
}

.settings-icon-set-upload:has([aria-disabled='true']) .settings-icon-set-trigger
 {
    opacity: 0.55;
}

.settings-image-action
 {
    min-height: 2.5rem;
    padding-inline: var(--fsus-space-1);
}

.settings-tabs
 {
    max-width: var(--fsusblog-container-settings);
    margin-inline: auto;
    overflow-x: hidden;
}

.settings-tabs > *
 {
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
}

.settings-tabs ::-webkit-scrollbar
 {
    display: none;
}
</style>
