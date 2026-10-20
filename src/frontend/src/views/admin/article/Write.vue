<template>
    <main
        ref="workspaceWriteElement"
        class="account-page write-article-wrapper account-motion-enter w-full"
        aria-labelledby="article-write-title"
        :aria-busy="pageLoading || submitting || workspacePrimaryMountOnly"
        :inert="workspacePrimaryMountOnly"
    >
        <div
            class="write-workspace"
            v-loading="pageLoading"
            element-loading-text="正在载入数据资源..."
        >
            <ArticleWriteCommandBar
                :page-title="pageTitle"
                :article-state-text="articleStateText"
                :status-text="editorSaveStatusText"
                :status-tone="editorSaveStatusTone"
                :primary-action-text="submitButtonText"
                :show-save-draft="submitButtonText !== '保存草稿'"
                :submitting="submitting"
                :critical-status-text="criticalInspectorSummary?.text"
                :critical-status-target="criticalInspectorSummary?.target"
                @back="requestLeave"
                @save-draft="saveDraftNow"
                @submit="requestSubmit"
                @open-inspector="openInspector"
            />

            <ElForm
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
                <section
                    class="write-document-canvas"
                    aria-label="文章文档"
                    data-editor-document-column="stable"
                >
                    <div
                        v-if="hasLocalDraft"
                        class="write-draft-banner border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] py-4 px-6 mb-8"
                        aria-live="polite"
                        aria-labelledby="article-recovery-title"
                        :aria-busy="articleRecoveryOperationPending"
                        data-article-recovery-prompt="true"
                    >
                        <div class="write-draft-copy min-w-0">
                            <h2
                                id="article-recovery-title"
                                class="write-draft-title"
                            >{{ pendingDraftSourceLabel }}</h2>
                            <p class="write-draft-description">
                                {{ draftStatusText ? `${draftStatusText}。` : '' }}{{ pendingDraftDescription }}
                            </p>
                            <p
                                v-if="hasArticleRecoveryCandidates"
                                class="write-recovery-privacy"
                            >
                                {{ articleRecoveryPrivacyNotice }}
                            </p>
                            <fieldset
                                v-if="hasArticleRecoveryCandidates"
                                class="write-recovery-candidates"
                                aria-label="选择要恢复的未同步正文版本"
                            >
                                <label
                                    v-for="candidate in articleRecoveryCandidateViews"
                                    :key="candidate.id"
                                    class="write-recovery-candidate"
                                    :data-recovery-divergence="candidate.divergence"
                                >
                                    <input
                                        v-model="selectedArticleRecoveryId"
                                        type="radio"
                                        name="article-recovery-candidate"
                                        :value="candidate.id"
                                    >
                                    <span class="write-recovery-candidate-copy">
                                        <span class="write-recovery-candidate-label">{{ candidate.label }}</span>
                                        <span class="write-recovery-candidate-detail">{{ candidate.detail }}</span>
                                        <span class="write-recovery-candidate-excerpt">{{ candidate.excerpt }}</span>
                                    </span>
                                </label>
                            </fieldset>
                            <p
                                v-if="articleRecoveryComparison"
                                class="write-recovery-comparison"
                                data-article-recovery-comparison="true"
                                aria-live="polite"
                            >
                                {{ articleRecoveryComparison }}
                            </p>
                            <p
                                v-if="articleRecoveryOperationStatusText"
                                class="write-recovery-operation-status"
                                role="status"
                            >
                                {{ articleRecoveryOperationStatusText }}
                            </p>
                            <p
                                v-if="articleRecoveryOperationError"
                                class="write-recovery-operation-error"
                                role="alert"
                            >
                                {{ articleRecoveryOperationError }}
                            </p>
                        </div>
                        <div class="write-draft-actions flex gap-4">
                            <ElButton
                                v-if="hasArticleRecoveryCandidates"
                                :disabled="articleRecoveryOperationPending"
                                :loading="articleRecoveryOperationKind === 'compare'"
                                @click="compareSelectedArticleRecovery"
                            >
                                比较所选正文
                            </ElButton>
                            <ElButton
                                type="primary"
                                :disabled="articleRecoveryOperationPending || articleRecoveryComparisonRequired"
                                :loading="articleRecoveryOperationKind === 'recover'"
                                @click="restoreLocalDraft"
                            >
                                {{ draftRestoreButtonText }}
                            </ElButton>
                            <ElButton
                                :disabled="articleRecoveryOperationPending"
                                :loading="articleRecoveryOperationKind === 'discard'"
                                @click="discardLocalDraft"
                            >
                                {{ draftDiscardButtonText }}
                            </ElButton>
                        </div>
                    </div>

                    <ArticleWriteTitleField
                        data-article-form-property="title"
                        v-model="articleForm.title"
                        :disabled="submitting"
                    />

                    <h2
                        id="article-body-heading"
                        class="sr-only"
                    >
                        正文
                    </h2>
                    <div
                        class="write-editor-panel"
                        data-editor-panel="true"
                    >
                        <AuthoringWorkspaceLayout
                            ref="workspaceLayoutRef"
                            :source="workspaceLayoutSource"
                            primary-region-id="article-write-leading-group"
                            secondary-region-id="article-write-trailing-group"
                            :primary-label="translate('admin.workspaceLayout.leading')"
                            :secondary-label="translate('admin.workspaceLayout.trailing')"
                            :separator-label="translate('admin.workspaceLayout.resize')"
                        >
                            <template #retained="{ expectation, placementRoot, leadingRegion, trailingRegion, ownsRegion, containsPlacementNode, revokePlacement }">
                                <AuthoringWorkspaceSessionOutlet
                                    :expectation="expectation"
                                    :placement-root="placementRoot"
                                    :leading-region="leadingRegion"
                                    :trailing-region="trailingRegion"
                                    :owns-region="ownsRegion"
                                    :contains-placement-node="containsPlacementNode"
                                    :revoke-placement="revokePlacement"
                                    :read-entry="readPrimaryWorkspaceEntry"
                                    :primary="true"
                                >
                                    <ElFormItem
                                        prop="content"
                                        data-article-form-property="content"
                                    >
                                        <div
                                            ref="workspaceNativeMountElement"
                                            class="write-native-editor-mount w-full min-w-0"
                                        >
                                            <ArticleWriteEditor
                                                ref="articleEditorRef"
                                                v-model="articleForm.content"
                                                textarea-id="article-content"
                                                labelled-by="article-body-heading"
                                                outline-panel-id="article-write-outline-panel"
                                                outline-title-id="article-write-outline-title"
                                                :command-surfaces="authoringCommandSurfaces"
                                                :article-identity="authoringDocumentIdentity.id"
                                                :document-identity="authoringDocumentIdentity"
                                                :document-context="authoringDocumentContext"
                                                :loading="pageLoading"
                                                :saving="submitting"
                                                @save="saveDraftNow"
                                                @draft-save="saveDraftNow"
                                                @submit="requestSubmit"
                                                @upload-img="handleUploadImg"
                                                @attachment-capture="consumeAcceptedAttachmentCapture"
                                                @transaction="consumeAuthoringTransaction"
                                                @selection-change="consumeAuthoringSelection"
                                                @source-navigation-gesture="consumeSourceNavigationGesture"
                                                @editor-focus="consumeAuthoringFocus"
                                            />
                                        </div>
                                    </ElFormItem>
                                </AuthoringWorkspaceSessionOutlet>
                            </template>
                        </AuthoringWorkspaceLayout>
                    </div>
                    <div
                        ref="workspacePanelRegionElement"
                        :data-authoring-workspace-extension-region="authoringWorkspacePanelSlotId"
                        class="min-w-0"
                    />
                </section>

                <ArticleWriteInspectorShell
                    :active-inspector="activeInspector"
                    :register-trigger-element="registerInspectorTrigger"
                    :register-scroll-element="registerInspectorScrollContainer"
                    @activate="openInspector"
                    @switch="switchInspector"
                    @close="closeInspector"
                    @closed="restoreInspectorFocus"
                    @scroll="updateInspectorScroll"
                >
                    <template #publish>
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
                    </template>

                    <template #rights>
                        <section
                            class="write-rights-panel border-t border-[var(--fsusblog-panel-border)]"
                            aria-label="版权保护"
                        >
                            <div class="p-4 space-y-4">
                                <p class="text-[11px] leading-5 text-[var(--fsusblog-text-tertiary)]">
                                    默认使用站点版权设置；需要单篇不同规则时切换为自定义。
                                </p>
                                <ElFormItem label="版权来源">
                                    <ElRadioGroup
                                        :model-value="articleForm.rights.mode"
                                        aria-label="版权来源"
                                        :disabled="submitting"
                                        @change="(value) => setArticleRightsMode(value === 'custom' ? 'custom' : 'site')"
                                    >
                                        <ElRadioButton label="site">继承站点设置</ElRadioButton>
                                        <ElRadioButton label="custom">自定义本文版权</ElRadioButton>
                                    </ElRadioGroup>
                                    <p class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-tertiary)]">
                                        {{ articleRightsInheritanceText }}
                                    </p>
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.enabled"
                                    data-article-form-property="rights.enabled"
                                    label="启用策略"
                                >
                                    <ElSwitch
                                        v-model="articleForm.rights.enabled"
                                        aria-label="启用版权策略"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    />
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.licenseType"
                                    data-article-form-property="rights.licenseType"
                                    label="许可类型"
                                >
                                    <ElSelect
                                        v-model="articleForm.rights.licenseType"
                                        name="articleRightsLicenseType"
                                        aria-label="版权许可类型"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    >
                                        <ElOption
                                            v-for="item in articleRightsLicenseOptions"
                                            :key="item.value"
                                            :label="item.label"
                                            :value="item.value"
                                        />
                                    </ElSelect>
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.copyrightHolder"
                                    data-article-form-property="rights.copyrightHolder"
                                    label="权利人"
                                >
                                    <ElInput
                                        v-model="articleForm.rights.copyrightHolder"
                                        name="articleRightsCopyrightHolder"
                                        aria-label="版权权利人"
                                        maxlength="256"
                                        show-word-limit
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    />
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.copyrightYear"
                                    data-article-form-property="rights.copyrightYear"
                                    label="版权年份"
                                >
                                    <ElInputNumber
                                        :model-value="articleForm.rights.copyrightYear ?? undefined"
                                        @update:model-value="updateCopyrightYear"
                                        name="articleRightsCopyrightYear"
                                        aria-label="版权年份"
                                        :min="1900"
                                        :max="new Date().getFullYear() + 1"
                                        :step="1"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                        controls-position="right"
                                    />
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.rightsStatement"
                                    data-article-form-property="rights.rightsStatement"
                                    label="权利声明"
                                >
                                    <ElInput
                                        v-model="articleForm.rights.rightsStatement"
                                        :csp-safe="true"
                                        name="articleRightsStatement"
                                        type="textarea"
                                        :rows="3"
                                        maxlength="4000"
                                        show-word-limit
                                        aria-label="版权权利声明"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    />
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.attributionTemplate"
                                    data-article-form-property="rights.attributionTemplate"
                                    label="署名模板"
                                >
                                    <ElInput
                                        v-model="articleForm.rights.attributionTemplate"
                                        :csp-safe="true"
                                        name="articleRightsAttributionTemplate"
                                        type="textarea"
                                        :rows="2"
                                        maxlength="4000"
                                        show-word-limit
                                        aria-label="版权署名模板"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    />
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.copyPolicy"
                                    data-article-form-property="rights.copyPolicy"
                                    label="复制策略"
                                >
                                    <ElSelect
                                        v-model="articleForm.rights.copyPolicy"
                                        name="articleRightsCopyPolicy"
                                        aria-label="版权复制策略"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    >
                                        <ElOption
                                            v-for="item in articleRightsCopyPolicyOptions"
                                            :key="item.value"
                                            :label="item.label"
                                            :value="item.value"
                                        />
                                    </ElSelect>
                                </ElFormItem>

                                <ElFormItem
                                    prop="rights.maxExcerptChars"
                                    data-article-form-property="rights.maxExcerptChars"
                                    label="摘录长度"
                                >
                                    <ElInputNumber
                                        v-model="articleForm.rights.maxExcerptChars"
                                        name="articleRightsMaxExcerptChars"
                                        aria-label="最大摘录字符数"
                                        :min="0"
                                        :max="articleRightsExcerptMax"
                                        :step="10"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                        controls-position="right"
                                    />
                                </ElFormItem>

                                <div class="grid gap-3">
                                    <ElCheckbox
                                        v-model="articleForm.rights.allowCodeCopy"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    >
                                        允许代码块复制
                                    </ElCheckbox>
                                    <ElCheckbox
                                        v-model="articleForm.rights.showPublicBadge"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    >
                                        公开页显示版权标识
                                    </ElCheckbox>
                                    <ElCheckbox
                                        v-model="articleForm.rights.proofBindingEnabled"
                                        :disabled="submitting || articleRightsUsingSiteDefaults"
                                    >
                                        启用 proof 绑定
                                    </ElCheckbox>
                                </div>
                            </div>
                        </section>
                    </template>

                    <template #check>
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
                                <div class="text-[13px] font-medium normal-case tracking-normal text-[var(--fsusblog-text-primary)]">内容检查</div>
                            </header>
                            <div class="p-6 space-y-5">
                                <p
                                    class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]"
                                    aria-live="polite"
                                >
                                    {{ aiAssistStatusText || '生成可选摘要建议、标题备选和标签匹配。建议仅供参考，应用前可继续编辑。' }}
                                </p>
                                <div class="grid grid-cols-2 gap-3">
                                    <ElButton
                                        :disabled="submitting"
                                        @click="autoGenerateSummary"
                                    >
                                        生成摘要建议
                                    </ElButton>
                                    <ElButton
                                        type="primary"
                                        :loading="aiAssistLoading"
                                        :disabled="submitting || aiAssistLoading"
                                        @click="requestAiAssist"
                                    >
                                        检查内容
                                    </ElButton>
                                </div>
                                <div
                                    v-if="aiAssist"
                                    class="space-y-4 border-t border-[var(--fsusblog-panel-border)] pt-5"
                                >
                                    <p
                                        v-if="aiAssist.suggestedSummary"
                                        class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]"
                                    >
                                        {{ aiAssist.suggestedSummary }}
                                    </p>
                                    <ElButton
                                        v-if="aiAssist.suggestedSummary"
                                        size="small"
                                        :disabled="submitting"
                                        @click="applyAiSummary"
                                    >
                                        应用摘要
                                    </ElButton>
                                    <div
                                        v-if="aiAssist.suggestedTags.length > 0"
                                        class="flex flex-wrap gap-2"
                                    >
                                        <ElTag
                                            v-for="tag in aiAssist.suggestedTags"
                                            :key="tag"
                                            size="small"
                                        >{{ tag }}</ElTag>
                                    </div>
                                    <ElButton
                                        v-if="aiAssist.suggestedTags.length > 0"
                                        size="small"
                                        :disabled="submitting"
                                        @click="applyAiSuggestedTags"
                                    >
                                        应用标签
                                    </ElButton>
                                    <div
                                        v-if="aiAssist.titleCandidates.length > 0"
                                        class="grid gap-2"
                                    >
                                        <ElButton
                                            v-for="title in aiAssist.titleCandidates"
                                            :key="title"
                                            :disabled="submitting"
                                            @click="applyAiTitleCandidate(title)"
                                        >
                                            <span class="min-w-0 whitespace-normal text-left leading-5">应用标题：{{ title }}</span>
                                        </ElButton>
                                    </div>
                                    <ElButton
                                        v-if="aiAssist.translationDraft"
                                        size="small"
                                        :disabled="submitting"
                                        @click="applyAiTranslationDraft"
                                    >
                                        应用翻译建议
                                    </ElButton>
                                </div>
                            </div>
                        </section>
                    </template>

                    <template #preview>
                        <ArticlePrivatePreviewPanel
                            :preview="privatePreview"
                            :loading="privatePreviewLoading"
                            :status-text="privatePreviewStatusText"
                            :can-preview="canGeneratePrivatePreview"
                            @preview="generatePrivatePreview"
                        />
                    </template>

                    <template #versions>
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
                    </template>

                    <template #resources>
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
                                    <span class="text-[13px] font-medium normal-case tracking-normal text-[var(--fsusblog-text-primary)]">图片上传策略</span>
                                    <span
                                        class="text-[12px] font-medium text-[var(--fsusblog-text-muted)]"
                                        aria-live="polite"
                                    >{{ imageUploadRuntime.statusText }}</span>
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
                    </template>
                </ArticleWriteInspectorShell>

                <input
                    ref="coverInputRef"
                    type="file"
                    accept="image/*"
                    class="hidden"
                    @change="onCoverFileChange"
                />
            </ElForm>
        </div>

        <FsusDialog
            v-model="quickCreateCategoryDialog"
            title="新建分类"
            width="min(92vw, 28rem)"
            destroy-on-close
            :close-on-click-modal="false"
            @opened="focusQuickCategoryInput"
        >
            <ElForm
                label-position="top"
                @submit.prevent="submitQuickCreateCategory"
            >
                <ElFormItem label="分类名称">
                    <ElInput
                        ref="quickCategoryInputRef"
                        v-model="quickCategoryName"
                        name="quickCategoryName"
                        aria-label="分类名称"
                        placeholder="请输入 2-20 个字符的名称"
                        maxlength="20"
                        show-word-limit
                        :disabled="quickCreatingCategory"
                        @keyup.enter="submitQuickCreateCategory"
                    />
                </ElFormItem>
            </ElForm>
            <template #footer>
                <div class="grid grid-cols-2 gap-4">
                    <ElButton
                        :disabled="quickCreatingCategory"
                        @click="quickCreateCategoryDialog = false"
                    >
                        取消
                    </ElButton>
                    <ElButton
                        type="primary"
                        :loading="quickCreatingCategory"
                        @click="submitQuickCreateCategory"
                    >
                        创建并选中
                    </ElButton>
                </div>
            </template>
        </FsusDialog>

        <FsusDialog
            v-model="quickCreateTagDialog"
            title="新建标签"
            width="min(92vw, 28rem)"
            destroy-on-close
            :close-on-click-modal="false"
            @opened="focusQuickTagInput"
        >
            <ElForm
                label-position="top"
                @submit.prevent="submitQuickCreateTag"
            >
                <ElFormItem label="标签名称">
                    <ElInput
                        ref="quickTagInputRef"
                        v-model="quickTagName"
                        name="quickTagName"
                        aria-label="标签名称"
                        placeholder="标签名称（如：Vue3）"
                        maxlength="20"
                        show-word-limit
                        :disabled="quickCreatingTag"
                        @keyup.enter="submitQuickCreateTag"
                    />
                </ElFormItem>
            </ElForm>
            <template #footer>
                <div class="grid grid-cols-2 gap-4">
                    <ElButton
                        :disabled="quickCreatingTag"
                        @click="quickCreateTagDialog = false"
                    >
                        取消
                    </ElButton>
                    <ElButton
                        type="primary"
                        :loading="quickCreatingTag"
                        @click="submitQuickCreateTag"
                    >
                        创建并关联
                    </ElButton>
                </div>
            </template>
        </FsusDialog>

        <FsusDialog
            v-model="submitConfirmDialog"
            :title="pageTitle === '编辑文章' ? '更新确认' : '发布确认'"
            width="min(92vw, 28rem)"
            :close-on-click-modal="false"
        >
            <p class="text-sm text-[var(--fsusblog-text-secondary)]">{{ submitConfirmContent }}</p>
            <ul
                class="mt-5 space-y-2"
                aria-label="发布前 checklist"
            >
                <li
                    v-for="item in submitChecklist"
                    :key="item.label"
                    class="submit-checklist-item"
                    :class="`submit-checklist-item--${item.state}`"
                >
                    <span class="submit-checklist-status">{{ item.state === 'pass' ? '通过' : '注意' }}</span>
                    <span class="min-w-0">
                        <span class="font-bold">{{ item.label }}</span>
                        <span
                            v-if="item.detail"
                            class="ml-1 text-[var(--fsusblog-text-muted)]"
                        >{{ item.detail }}</span>
                    </span>
                </li>
            </ul>
            <div
                v-if="prepublishWarningsNeedOverride"
                class="mt-5 space-y-3"
                aria-label="发布前警告跳过确认"
            >
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
                <ElInput
                    v-model="prepublishWarningOverrideReason"
                    :csp-safe="true"
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
                <div class="grid grid-cols-2 gap-4">
                    <ElButton
                        :disabled="submitting"
                        @click="submitConfirmDialog = false"
                    >
                        继续编辑
                    </ElButton>
                    <ElButton
                        type="primary"
                        :loading="submitting || seoChecking"
                        @click="confirmSubmit"
                    >
                        {{ submitButtonText }}
                    </ElButton>
                </div>
            </template>
        </FsusDialog>

        <FsusDialog
            v-model="leaveConfirmDialog"
            title="离开编辑器"
            width="min(92vw, 28rem)"
            :close-on-click-modal="false"
        >
            <p class="text-sm text-[var(--fsusblog-text-secondary)]">
                服务端草稿仍是长期权威。未确认正文以明文暂存在本机浏览器，未加密，最长 7 天，服务端确认后即删除；返回编辑页后如存在额外内容，会要求你明确恢复或丢弃。
            </p>
            <template #footer>
                <div class="grid grid-cols-2 gap-4">
                    <ElButton @click="leaveConfirmDialog = false">
                        继续编辑
                    </ElButton>
                    <ElButton
                        type="primary"
                        @click="confirmLeave"
                    >
                        离开编辑器
                    </ElButton>
                </div>
            </template>
        </FsusDialog>
    </main>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onUnmounted, provide, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';

import { ArticlePublishStatus } from '@/api/article';
import type { AssetLibraryItemResponse } from '@/api/authoring';
import ArticleAssetLibraryPanel from '@/components/admin/article/ArticleAssetLibraryPanel.vue';
import { focusFirstArticleValidationError } from '@/components/admin/article/articleEditorAccessibility';
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue';
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue';
import ArticleSeoPreviewPanel from '@/components/admin/article/ArticleSeoPreviewPanel.vue';
import ArticleWriteCommandBar from '@/components/admin/article/ArticleWriteCommandBar.vue';
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import ArticleWriteInspectorShell from '@/components/admin/article/ArticleWriteInspectorShell.vue';
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue';
import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue';
import AuthoringWorkspaceLayout from '@/components/admin/article/AuthoringWorkspaceLayout.vue';
import AuthoringWorkspaceSessionOutlet from '@/components/admin/article/AuthoringWorkspaceSessionOutlet.vue';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue';
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import {
    useArticleWriteInspector,
    type ArticleWriteInspectorView
} from '@/composables/useArticleWriteInspector';
import type { MarkdownAttachmentBatchIntent, MarkdownAttachmentCaptureObservation } from '@/fsusui/articleAttachments';
import type { MarkdownEditorDispatchResult, MarkdownEditorResolvedSelection } from '@/fsusui/articlePositionMaps';
import type { FsusUiAuthoringSurfaceOptions } from '@/fsusui/authoringCommands';
import { activeLocale, translate } from '@/locales';
import { ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE } from '@/services/articleRecoveryJournal';
import type { ArticleAnchorCaptureOptions } from '@/services/authoring/articleAnchorContext';
import { articleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import type { ArticleEditorContinuityPort, ArticleEditorMountedSessionPort } from '@/services/authoring/articleEditorContinuity';
import type { ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import { createArticleWorkspaceRetainedRecoveryPort } from '@/services/authoring/articleWorkspaceEditorSessionComposition';
import type { ArticleWorkspaceMountedEditorSource } from '@/services/authoring/articleWorkspaceMountedEditorResolver';
import type { ArticleWorkspaceRetainedRecoveryPort } from '@/services/authoring/articleWorkspaceRetainedRecoverySnapshot';
import {
    articleWorkspaceTabRouter,
    createArticleWorkspaceOpenInput,
    type ArticleWorkspaceStatusSummary
} from '@/services/authoring/articleWorkspaceTabRouter';
import { projectArticleWriterWorkspaceDocument } from '@/services/authoring/articleWriterMountedEditorSource';
import { authoringWorkspaceLayoutSourceKey, authoringWorkspacePrimaryMountOnlyKey, authoringWorkspaceMountedAuthoritySourcesKey, authoringWorkspaceMountedAuthorityBeforeReadKey, type AuthoringWorkspaceMountedAuthorityReservation, type AuthoringWorkspaceRootMountedSeal, type AuthoringWorkspaceLayoutPort, type AuthoringWorkspaceOutletExpectation, type AuthoringWorkspacePrimaryMountPort } from '@/services/authoring/authoringWorkspaceLayoutContext';
import type { AuthoringWorkspaceNavigationHost } from '@/services/authoring/authoringWorkspaceNavigationHost';
import { createAuthoringWorkspaceNavigationHost } from '@/services/authoring/authoringWorkspaceNavigationHost';
import type { AuthoringWorkspaceNavigationViewPort } from '@/services/authoring/authoringWorkspaceNavigationView';
import { authoringWorkspacePanelSlotId, createAuthoringWorkspacePanelHost, type AuthoringWorkspacePanelHost } from '@/services/authoring/authoringWorkspacePanelHost';
import {
    calculateOpenArticleDocumentDigest,
    type ArticleDocumentContextRef,
    type ArticleDocumentIdentity,
    type OpenArticleDocumentEntry
} from '@/services/authoring/openArticleDocumentRegistry';
import { useThemeRuntime } from '@/services/themeRuntime';
import { showErrorToast } from '@/utils/errorPresentation';

import type { MarkdownEditorSourceNavigationGesture } from '@ozwasyd/element-plus';

defineOptions({ name: 'ArticleWriteView' });

const workspaceLayoutContext = inject(authoringWorkspaceLayoutSourceKey, null);
const workspaceLayoutSource = computed(() => workspaceLayoutContext?.value ?? null);
const workspacePrimaryMountOnly = inject(authoringWorkspacePrimaryMountOnlyKey, computed(() => false));
const mountedAuthoritySources = inject(authoringWorkspaceMountedAuthoritySourcesKey, null);

const articleRecoveryPrivacyNotice = ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE;

type SubmitChecklistState = 'pass' | 'warning';

const route = useRoute();

const {
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
    draftStatusText,
    pendingDraftSourceLabel,
    pendingDraftDescription,
    draftRestoreButtonText,
    draftDiscardButtonText,
    articleRecoveryComparison,
    articleRecoveryComparisonRequired,
    articleRecoveryOperationError,
    articleRecoveryOperationKind,
    articleRecoveryOperationPending,
    articleRecoveryOperationStatusText,
    hasLocalDraft,
    articleRecoveryCandidateViews,
    selectedArticleRecoveryId,
    hasArticleRecoveryCandidates,
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
    authoringDocumentIdentity,
    authoringDocumentContext,
    authoringDocumentContextAdapter,
    authoringAttachmentRuntime,
    authoringEditorRuntime,
    firstInvalidFormProperty,
    articleRightsUsingSiteDefaults,
    articleRightsInheritanceText,
    articleRightsLicenseOptions,
    articleRightsCopyPolicyOptions,
    articleRightsExcerptMax,
    rules,
    validateBeforeSubmit,
    formRef,
    saveDraftNow,
    handleUploadImg,
    handleCoverUpload,
    submitForm,
    compareSelectedArticleRecovery,
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
    setArticleRightsMode,
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
} = useAdminArticleWrite();
const authoringCommandSurfaces: FsusUiAuthoringSurfaceOptions = Object.freeze({
    toolbar: true,
    selectionToolbar: true,
    slashMenu: true,
    commandPalette: true
});
const {
    busy: taskFeedbackBusy,
    isHighlighted: isTaskHighlighted
} = taskFeedback;

const pageTitle = computed(() => isEdit.value ? '编辑文章' : '新建文章');
const articleStateText = computed(() =>
{
    switch (articleForm.status)
    {
        case ArticlePublishStatus.Draft:
            return '草稿';
        case ArticlePublishStatus.Scheduled:
            return '定时发布';
        case ArticlePublishStatus.Archived:
            return '已归档';
        default:
            return isEdit.value ? '已发布' : '待发布';
    }
});

const workspaceArticleId = computed<number | null>(() =>
{
    const raw = route.params.id;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
});
const workspaceDocument = computed(() => projectArticleWriterWorkspaceDocument(authoringDocumentContext.value));
const workspaceIdentity = computed<ArticleDocumentIdentity>(() => workspaceDocument.value.identity);
const workspaceDocumentContext = computed<ArticleDocumentContextRef>(() => workspaceDocument.value.documentContext);
const workspaceMountedSource = shallowRef<ArticleWorkspaceMountedEditorSource | null>(null);
const workspaceLayoutRef = shallowRef<AuthoringWorkspaceLayoutPort | null>(null);
const workspaceWriteElement = shallowRef<HTMLElement | null>(null);
const workspaceNativeMountElement = shallowRef<HTMLElement | null>(null);
const workspacePanelRegionElement = shallowRef<HTMLElement | null>(null);
let workspacePanelHost: AuthoringWorkspacePanelHost | null = null;
let workspacePanelLifetime: AbortController | null = null;
let workspaceNavigationHost: AuthoringWorkspaceNavigationHost | null = null;
let workspaceNavigationLifetime: AbortController | null = null;
defineExpose({ getArticleWorkspaceMountedEditorSource: () => workspaceMountedSource.value,
               getAuthoringWorkspaceLayoutPort: () => workspaceLayoutRef.value,
               getAuthoringWorkspacePanelHost: () => workspacePanelHost,
               getArticleWorkspaceNavigationHost: () => workspaceNavigationHost,
               getArticleWorkspaceRecoveryCheckpoint,
               getArticleWorkspaceRetainedRecoveryPort,
               getArticleWorkspacePrimaryMountPort: () => primaryMountDisposed ? null : primaryMountPort });
const workspaceStatus = computed<ArticleWorkspaceStatusSummary>(() => ({
    dirty: requiresLeaveConfirm.value && !pageLoading.value,
    saving: submitting.value,
    conflict: /冲突|未提交|较新的|比较/u.test(draftStatusText.value),
    recovery: hasLocalDraft.value,
    pendingAttachments: !['idle', 'completed'].includes(imageUploadRuntime.phase),
    permission: 'allowed',
    lifecycle: articleForm.status === ArticlePublishStatus.Deleted
        ? 'deleted'
        : articleForm.status === ArticlePublishStatus.Archived
            ? 'archived'
            : 'current',
    statusRef: `workspace-status:${workspaceIdentity.value.documentId}`
}));
const workspaceTabId = shallowRef<string | null>(null);
/** Read only the original entry associated with this actual bound primary native editor. */
function readPrimaryWorkspaceEntry(expected: AuthoringWorkspaceOutletExpectation): OpenArticleDocumentEntry | null
{
    const tabId = workspaceTabId.value;
    const source = workspaceMountedSource.value;
    if (!tabId || !source)
    {
        return null;
    }
    const registry = articleWorkspaceTabRouter.getRegistry();
    const groups = workspaceLayoutSource.value?.groups;
    const isCurrentExpectation = (): boolean =>
    {
        if (!groups || registry !== expected.registry || groups !== expected.groups
            || articleWorkspaceTabRouter.getRegistry() !== registry || workspaceLayoutSource.value?.groups !== groups
            || !groups.verifyBinding(registry) || registry.getRevision() !== expected.projection.state.articleRegistryRevision)
        {
            return false;
        }
        const current = groups.exportProjection();
        return current.ratioScope === expected.projection.ratioScope && current.splitRatioRef === expected.projection.splitRatioRef
            && current.state.revision === expected.projection.state.revision
            && current.state.articleRegistryRevision === expected.projection.state.articleRegistryRevision
            && current.state.contentDigest === expected.projection.state.contentDigest;
    };
    if (!isCurrentExpectation())
    {
        return null;
    }
    const entry = registry.getEntry(tabId);
    if (!entry)
    {
        return null;
    }
    const identity = workspaceIdentity.value;
    const context = workspaceDocumentContext.value;
    const owner = source.readDocumentBinding(entry.editorSessionRef);
    if (workspaceMountedSource.value !== source || workspaceTabId.value !== tabId
        || workspaceIdentity.value !== identity || workspaceDocumentContext.value !== context || !isCurrentExpectation()
        || owner?.identity.articleId !== identity.articleId || owner.identity.draftId !== identity.draftId
        || owner.identity.documentId !== identity.documentId || owner.documentContext.documentEpoch !== context.documentEpoch
        || owner.documentContext.sourceRevision !== context.sourceRevision || owner.documentContext.draftRevision !== context.draftRevision)
    {
        return null;
    }
    if (owner.identity.articleId !== entry.identity.articleId || owner.identity.draftId !== entry.identity.draftId
        || owner.identity.documentId !== entry.identity.documentId
        || owner.documentContext.documentEpoch !== entry.documentContext.documentEpoch
        || owner.documentContext.sourceRevision !== entry.documentContext.sourceRevision
        || owner.documentContext.draftRevision !== entry.documentContext.draftRevision)
    {
        return null;
    }
    return entry;
}

let workspaceSyncToken = 0;
let lastWorkspaceStatusDigest = '';

const workspaceCanRegister = computed(() => (
    !workspacePrimaryMountOnly.value
    && !pageLoading.value
    && !(isEdit.value && workspaceArticleId.value === null)
    && (!isEdit.value || articleForm.title.trim().length > 0 || articleForm.content.trim().length > 0)
));

const syncWorkspaceTab = async (): Promise<void> =>
{
    if (!workspaceCanRegister.value)
    {
        return;
    }

    const token = ++workspaceSyncToken;
    const identity = workspaceIdentity.value;
    const receipt = await articleWorkspaceTabRouter.openOrActivate(createArticleWorkspaceOpenInput(
        identity,
        workspaceDocumentContext.value,
        articleForm.title.trim() || pageTitle.value,
        workspaceStatus.value,
        {
            tabKind: 'pinned',
            entrypoint: 'direct-route',
            route: route.fullPath
        }
    ));
    if (token !== workspaceSyncToken || workspacePrimaryMountOnly.value || workspaceIdentity.value.documentId !== identity.documentId)
    {
        return;
    }

    workspaceTabId.value = receipt.tabId;
    if (!workspaceTabId.value)
    {
        return;
    }

    articleWorkspaceTabRouter.updatePresentation(workspaceTabId.value, {
        title: articleForm.title.trim() || pageTitle.value
    });
    lastWorkspaceStatusDigest = JSON.stringify(workspaceStatus.value);
};

watch(
    [workspaceCanRegister, workspaceIdentity],
    () =>
    {
        void syncWorkspaceTab();
    },
    { immediate: true, deep: true }
);
watch(
    [() => articleForm.title, workspaceStatus],
    ([title, status]) =>
    {
        if (workspacePrimaryMountOnly.value || !workspaceTabId.value)
        {
            return;
        }

        articleWorkspaceTabRouter.updatePresentation(workspaceTabId.value, {
            title: title.trim() || pageTitle.value
        });
        const statusDigest = JSON.stringify(status);
        if (statusDigest !== lastWorkspaceStatusDigest)
        {
            articleWorkspaceTabRouter.markStatus(workspaceTabId.value, status);
            lastWorkspaceStatusDigest = statusDigest;
        }
    },
    { deep: true }
);
onUnmounted(() =>
{
    workspaceSyncToken += 1;
    workspaceTabId.value = null;
});
const quickCreateCategoryDialog = ref(false);
const quickCreateTagDialog = ref(false);
const quickCategoryName = ref('');
const quickTagName = ref('');
const quickCategoryInputRef = ref<{ focus?: () => void; } | null>(null);
const quickTagInputRef = ref<{ focus?: () => void; } | null>(null);
const coverInputRef = ref<HTMLInputElement | null>(null);
const articleEditorRef = ref<{
    getAuthoringEditorPort: () => ArticleEditorContinuityPort | null;
    getAuthoringSessionPort?: () => ArticleEditorMountedSessionPort | null;
    readSourceNavigationView: AuthoringWorkspaceNavigationViewPort['readSourceNavigationView'];
    isCurrentSourceNavigationView: AuthoringWorkspaceNavigationViewPort['isCurrentSourceNavigationView'];
    insertMarkdownAtCursor?: (markdown: string) => boolean;
} | null>(null);
const authoringTheme = useThemeRuntime();
const editorRuntimeBinding = shallowRef<ArticleEditorRuntimeBinding | null>(null);
type MountedWriterBinding = ReturnType<typeof authoringEditorRuntime.bindEditor>;
type WriterRecoveryCheckpoint = ReturnType<MountedWriterBinding['bindRecoveryCheckpoint']>;
let mountedWriterBinding: MountedWriterBinding | null = null;
let recoveryCheckpoint: WriterRecoveryCheckpoint | null = null;
let recoveryCheckpointSessionRef: string | null = null;
let boundEditorPort: ArticleEditorContinuityPort | null = null;
let releaseEditorRuntime: (() => void) | null = null;
let editorBindingGeneration = 0;

function releaseRecoveryCheckpoint(): void
{
    revokeMountedAuthorityBeforeRead();
    const checkpoint = recoveryCheckpoint;
    recoveryCheckpoint = null;
    recoveryCheckpointSessionRef = null;
    checkpoint?.release();
}

/** This returns original journal custody; a nullable host port is not snapshot readiness. */
function getArticleWorkspaceRecoveryCheckpoint(): WriterRecoveryCheckpoint | null
{
    revokeMountedAuthorityBeforeRead();
    const checkpoint = recoveryCheckpoint;
    const source = workspaceMountedSource.value;
    const bound = mountedWriterBinding;
    const tabId = workspaceTabId.value;
    if (!checkpoint || !source || bound?.mountedSource !== source || !tabId)
    {
        return null;
    }
    const registry = articleWorkspaceTabRouter.getRegistry();
    const revision = registry.getRevision();
    const entry = registry.getEntry(tabId);
    if (entry?.editorSessionRef !== recoveryCheckpointSessionRef)
    {
        return null;
    }
    const observed = source.readDocumentBinding(entry.editorSessionRef);
    if (recoveryCheckpoint !== checkpoint || mountedWriterBinding !== bound || workspaceMountedSource.value !== source
        || workspaceTabId.value !== tabId || articleWorkspaceTabRouter.getRegistry() !== registry || registry.getRevision() !== revision
        || observed?.identity.articleId !== entry.identity.articleId || observed.identity.draftId !== entry.identity.draftId
        || observed.identity.documentId !== entry.identity.documentId
        || observed.documentContext.documentEpoch !== entry.documentContext.documentEpoch
        || observed.documentContext.sourceRevision !== entry.documentContext.sourceRevision
        || observed.documentContext.draftRevision !== entry.documentContext.draftRevision)
    {
        return null;
    }
    return checkpoint;
}

function bindWorkspaceRecoveryCheckpoint(): void
{
    revokeMountedAuthorityBeforeRead();
    const bound = mountedWriterBinding;
    const source = workspaceMountedSource.value;
    const tabId = workspaceTabId.value;
    const generation = editorBindingGeneration;
    const registry = articleWorkspaceTabRouter.getRegistry();
    const registryRevision = registry.getRevision();
    const entry = tabId ? registry.getEntry(tabId) : null;
    if (!bound || !source || bound.mountedSource !== source || !entry)
    {
        releaseRecoveryCheckpoint();
        return;
    }
    // Registry public reads clone values; object equality would always reject a genuine entry.
    const entryDigest = calculateOpenArticleDocumentDigest(entry);
    const isCurrentBinding = (): boolean => mountedWriterBinding === bound && workspaceMountedSource.value === source
        && workspaceTabId.value === tabId && editorBindingGeneration === generation
        && articleWorkspaceTabRouter.getRegistry() === registry && registry.getRevision() === registryRevision
        && calculateOpenArticleDocumentDigest(registry.getEntry(entry.tabId)) === entryDigest;
    const observed = source.readDocumentBinding(entry.editorSessionRef);
    if (!isCurrentBinding() || observed?.identity.articleId !== entry.identity.articleId
        || observed.identity.draftId !== entry.identity.draftId || observed.identity.documentId !== entry.identity.documentId
        || observed.documentContext.documentEpoch !== entry.documentContext.documentEpoch
        || observed.documentContext.sourceRevision !== entry.documentContext.sourceRevision
        || observed.documentContext.draftRevision !== entry.documentContext.draftRevision)
    {
        releaseRecoveryCheckpoint();
        return;
    }
    if (recoveryCheckpoint && recoveryCheckpointSessionRef === entry.editorSessionRef)
    {
        return;
    }
    releaseRecoveryCheckpoint();
    let checkpoint: WriterRecoveryCheckpoint;
    try
    {
        checkpoint = bound.bindRecoveryCheckpoint(entry.editorSessionRef);
    }
    catch
    {
        // The original owner refuses unloaded draft/auth/native custody. Keep the port unavailable.
        return;
    }
    if (!isCurrentBinding())
    {
        checkpoint.release();
        return;
    }
    recoveryCheckpoint = checkpoint;
    recoveryCheckpointSessionRef = entry.editorSessionRef;
}

/** Borrow the existing original journal host; do not rebind or prepare on mount/geometry updates. */
const retainedRecoveryPort = createArticleWorkspaceRetainedRecoveryPort({
    readCurrent: () =>
    {
        const checkpoint = getArticleWorkspaceRecoveryCheckpoint();
        const tabId = workspaceTabId.value;
        if (!checkpoint || !tabId)
        {
            return null;
        }
        const registry = articleWorkspaceTabRouter.getRegistry();
        const revision = registry.getRevision();
        const entry = registry.getEntry(tabId);
        if (!entry || checkpoint !== getArticleWorkspaceRecoveryCheckpoint()
            || workspaceTabId.value !== tabId || articleWorkspaceTabRouter.getRegistry() !== registry
            || registry.getRevision() !== revision)
        {
            return null;
        }
        return { entry, checkpoint };
    }
});

/** Original Rail may borrow this partial port after SAME composition installation; null is unavailable. */
function getArticleWorkspaceRetainedRecoveryPort(): ArticleWorkspaceRetainedRecoveryPort | null
{
    revokeMountedAuthorityBeforeRead();
    return getArticleWorkspaceRecoveryCheckpoint() ? retainedRecoveryPort : null;
}

let primaryMountDisposed = false;
let primaryMountGeneration = 0n;
let cancelPrimaryMount: (() => void) | null = null;
type PrimaryPhysicalMount = Readonly<{
    editorSessionRef: string;
    root: HTMLElement;
    element: HTMLElement;
    component: NonNullable<typeof articleEditorRef.value>;
    native: ArticleEditorMountedSessionPort;
    bound: MountedWriterBinding;
    context: typeof authoringDocumentContext.value;
}>;
let completedPrimaryMount: PrimaryPhysicalMount | null = null;
let mountedAuthorityEpoch = 0n;
let sealingMountedAuthority = false;
let mountedAuthorityCancellationFailed = false;
let mountedAuthorityRetired = false;
let mountedAuthorityCustody: { seal: AuthoringWorkspaceRootMountedSeal; epoch: bigint;
                               physical: PrimaryPhysicalMount; reservation: AuthoringWorkspaceMountedAuthorityReservation; } | null = null;

function cancelOriginalMountedReservation(reservation: AuthoringWorkspaceMountedAuthorityReservation | null): void
{
    try
    {
        reservation?.cancel();
    }
    catch
    {
        mountedAuthorityCancellationFailed = true;
        completedPrimaryMount = null;
    }
}

function revokeMountedAuthorityBeforeRead(): void
{
    const previous = mountedAuthorityCustody;
    mountedAuthorityCustody = null;
    mountedAuthorityEpoch += 1n;
    // Retire private custody BEFORE the original producer cancellation callback.
    const wasSealing = sealingMountedAuthority;
    sealingMountedAuthority = true;
    try
    {
        cancelOriginalMountedReservation(previous?.reservation ?? null);
    }
    finally
    {
        sealingMountedAuthority = wasSealing;
    }
}
function revokeMountedAuthorityBeforeChange(): void
{
    completedPrimaryMount = null;
    revokeMountedAuthorityBeforeRead();
}
function hasMountedAuthorityCustody(seal: AuthoringWorkspaceRootMountedSeal): boolean
{
    // Only this issuer's private state; no DOM/ref/source/clock/read/clone/allocation/callback.
    return !primaryMountDisposed && !mountedAuthorityRetired && !sealingMountedAuthority && !mountedAuthorityCancellationFailed && mountedAuthorityCustody !== null
        && mountedAuthorityCustody.seal === seal && mountedAuthorityCustody.epoch === mountedAuthorityEpoch
        && mountedAuthorityCustody.physical === completedPrimaryMount;
}
function cancelMountedAuthority(seal: AuthoringWorkspaceRootMountedSeal): boolean
{
    if (mountedAuthorityCustody?.seal !== seal)
    {
        return false;
    }
    revokeMountedAuthorityBeforeRead();
    return true;
}
function sealMountedAuthority(editorSessionRef: string): AuthoringWorkspaceRootMountedSeal | null
{
    if (sealingMountedAuthority || primaryMountDisposed || mountedAuthorityRetired || mountedAuthorityCancellationFailed)
    {
        return null;
    }
    revokeMountedAuthorityBeforeRead();
    const physical = completedPrimaryMount;
    const source = mountedAuthoritySources?.value;
    // Physical completion or a principal-id watch is not original joint producer authority.
    if (physical?.editorSessionRef !== editorSessionRef || !source)
    {
        return null;
    }
    sealingMountedAuthority = true;
    let reservation: AuthoringWorkspaceMountedAuthorityReservation | null = null;
    try
    {
        const epoch = mountedAuthorityEpoch;
        reservation = source.reserve(editorSessionRef, physical.bound, physical.native, revokeMountedAuthorityBeforeChange);
        const seal = Object.freeze({ scope: 'root-mounted' }) as AuthoringWorkspaceRootMountedSeal;
        if (reservation?.nativeEditor !== physical.native || !reservation.retainedIdentity
            || typeof reservation.retainedIdentity !== 'object' || !reservation.hasCustody()
            || primaryMountDisposed || completedPrimaryMount !== physical || mountedAuthorityEpoch !== epoch
            || mountedAuthoritySources?.value !== source || workspaceWriteElement.value !== physical.root
            || workspaceNativeMountElement.value !== physical.element || articleEditorRef.value !== physical.component
            || mountedWriterBinding !== physical.bound || boundEditorPort !== physical.native
            || authoringDocumentContext.value !== physical.context || !physical.root.isConnected || !physical.element.isConnected
            || physical.root.ownerDocument !== physical.element.ownerDocument || !physical.root.contains(physical.element))
        {
            cancelOriginalMountedReservation(reservation);
            return null;
        }
        mountedAuthorityCustody = { seal, epoch, physical, reservation };
        return seal;
    }
    catch
    {
        cancelOriginalMountedReservation(reservation);
        return null;
    }
    finally
    {
        sealingMountedAuthority = false;
    }
}
provide(authoringWorkspaceMountedAuthorityBeforeReadKey, revokeMountedAuthorityBeforeRead);
function retireMountedAuthority(): void
{
    retireWorkspaceNavigationHost();
    mountedAuthorityRetired = true;
    revokeMountedAuthorityBeforeChange();
    cancelPrimaryMount?.();
}
watch([workspaceWriteElement, workspaceNativeMountElement, articleEditorRef, workspaceMountedSource, authoringDocumentContext,
       workspacePrimaryMountOnly, () => route.fullPath, () => mountedAuthoritySources?.value], revokeMountedAuthorityBeforeChange, { flush: 'sync' });
let mountedSubtreeObserver: MutationObserver | null = null;
watch(workspaceWriteElement, root =>
{
    revokeMountedAuthorityBeforeChange();
    mountedSubtreeObserver?.disconnect();
    mountedSubtreeObserver = root ? new MutationObserver(() => revokeMountedAuthorityBeforeChange()) : null;
    if (root)
    {
        // The document sees removal/reparenting of the root itself; inspect no outside content.
        mountedSubtreeObserver?.observe(root.ownerDocument, { childList: true, subtree: true, attributes: true });
    }
}, { flush: 'post' });

/** Await the existing real subtree; this cannot adopt a different restored document/body owner. */
function preparePrimaryMountedEditor(entry: Readonly<OpenArticleDocumentEntry>, signal: AbortSignal): Promise<void>
{
    if (primaryMountDisposed || mountedAuthorityRetired || sealingMountedAuthority || cancelPrimaryMount)
    {
        return Promise.reject(new Error('article-workspace-primary-mount-owner-unavailable'));
    }
    const generation = ++primaryMountGeneration;
    return new Promise<void>((resolve, reject) =>
    {
        let settled = false;
        let stopWatching: (() => void) | null = null;
        const cancel = (): void => finish(false, new Error('article-workspace-primary-mount-cancelled'));
        const finish = (completed: boolean, error?: unknown): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            if (!completed)
            {
                revokeMountedAuthorityBeforeChange();
            }
            stopWatching?.();
            signal.removeEventListener('abort', cancel);
            if (cancelPrimaryMount === cancel)
            {
                cancelPrimaryMount = null;
            }
            if (!completed)
            {
                reject(error instanceof Error ? error : new Error('article-workspace-primary-mount-failed'));
            }
            else
            {
                resolve();
            }
        };
        // Reserve before any caller-held entry/native read can synchronously reenter.
        cancelPrimaryMount = cancel;
        // Producer cancellation may synchronously reenter preparation: the slot is already owned.
        revokeMountedAuthorityBeforeChange();
        let registry: ReturnType<typeof articleWorkspaceTabRouter.getRegistry>;
        let registryRevision: number;
        let context: typeof authoringDocumentContext.value;
        let identity: ArticleDocumentIdentity;
        let documentContext: ArticleDocumentContextRef;
        let mountOnly: boolean;
        let expectedDigest: string;
        const assertCurrent = (): void =>
        {
            signal.throwIfAborted();
            if (settled || primaryMountDisposed || primaryMountGeneration !== generation || cancelPrimaryMount !== cancel
                || articleWorkspaceTabRouter.getRegistry() !== registry || registry.getRevision() !== registryRevision
                || authoringDocumentContext.value !== context || workspaceIdentity.value !== identity
                || workspaceDocumentContext.value !== documentContext
                || workspacePrimaryMountOnly.value !== mountOnly
                || mountedAuthorityRetired
                || calculateOpenArticleDocumentDigest(registry.getEntry(entry.tabId)) !== expectedDigest
                || calculateOpenArticleDocumentDigest(entry) !== expectedDigest)
            {
                throw new Error('article-workspace-primary-mount-association-stale');
            }
        };
        const attempt = (): void =>
        {
            if (settled)
            {
                return;
            }
            try
            {
                assertCurrent();
                const root = workspaceWriteElement.value;
                const element = workspaceNativeMountElement.value;
                const component = articleEditorRef.value;
                const source = workspaceMountedSource.value;
                const bound = mountedWriterBinding;
                if (pageLoading.value || !root?.isConnected || !element?.isConnected || !component || !source || !bound)
                {
                    return;
                }
                if (element.ownerDocument !== root.ownerDocument || !root.contains(element) || bound.mountedSource !== source)
                {
                    throw new Error('article-workspace-primary-physical-mount-owner-mismatch');
                }
                const bindingGeneration = editorBindingGeneration;
                const ownerDocument = root.ownerDocument;
                revokeMountedAuthorityBeforeRead();
                const native = component.getAuthoringSessionPort?.();
                revokeMountedAuthorityBeforeRead();
                const mounted = source.readMountedEditor(entry.editorSessionRef);
                revokeMountedAuthorityBeforeRead();
                const observed = source.readDocumentBinding(entry.editorSessionRef);
                assertCurrent();
                if (!native || mounted !== native || native !== boundEditorPort
                    || articleEditorRef.value !== component || workspaceMountedSource.value !== source || mountedWriterBinding !== bound
                    || editorBindingGeneration !== bindingGeneration || workspaceWriteElement.value !== root
                    || workspaceNativeMountElement.value !== element || !root.isConnected || !element.isConnected || !root.contains(element)
                    || root.ownerDocument !== ownerDocument || element.ownerDocument !== ownerDocument
                    || observed?.identity.articleId !== identity.articleId || observed.identity.draftId !== identity.draftId
                    || observed.identity.documentId !== identity.documentId
                    || observed.documentContext.documentEpoch !== documentContext.documentEpoch
                    || observed.documentContext.sourceRevision !== documentContext.sourceRevision
                    || observed.documentContext.draftRevision !== documentContext.draftRevision)
                {
                    throw new Error('article-workspace-primary-native-document-owner-unavailable');
                }
                // Only physical completion. The original composition/factory still checks resources/admission.
                completedPrimaryMount = Object.freeze({ editorSessionRef: entry.editorSessionRef, root, element, component,
                                                        native, bound, context });
                finish(true);
            }
            catch (error)
            {
                finish(false, error);
            }
        };
        try
        {
            registry = articleWorkspaceTabRouter.getRegistry();
            registryRevision = registry.getRevision();
            context = authoringDocumentContext.value;
            identity = workspaceIdentity.value;
            documentContext = workspaceDocumentContext.value;
            mountOnly = workspacePrimaryMountOnly.value;
            const expected = registry.getEntry(entry.tabId);
            expectedDigest = calculateOpenArticleDocumentDigest(expected);
            if (!expected || calculateOpenArticleDocumentDigest(entry) !== expectedDigest
                || expected.identity.articleId !== identity.articleId || expected.identity.draftId !== identity.draftId
                || expected.identity.documentId !== identity.documentId
                || expected.documentContext.documentEpoch !== documentContext.documentEpoch
                || expected.documentContext.sourceRevision !== documentContext.sourceRevision
                || expected.documentContext.draftRevision !== documentContext.draftRevision
                || expected.status.permission !== 'allowed' || expected.status.lifecycle !== 'current')
            {
                throw new Error('article-workspace-primary-retained-document-adoption-owner-required');
            }
            assertCurrent();
            signal.addEventListener('abort', cancel, { once: true });
            stopWatching = watch([workspaceWriteElement, workspaceNativeMountElement, articleEditorRef, workspaceMountedSource,
                                  authoringDocumentContext, workspaceDocument, pageLoading, workspacePrimaryMountOnly], attempt, { flush: 'post' });
            if (settled)
            {
                stopWatching();
            }
            else
            {
                void nextTick().then(attempt, error => finish(false, error));
            }
        }
        catch (error)
        {
            finish(false, error);
        }
    });
}

const primaryMountPort = Object.freeze({ prepareMountedEditor: preparePrimaryMountedEditor, sealMountedAuthority,
                                         hasMountedAuthorityCustody, cancelMountedAuthority, revokeBeforeChange: revokeMountedAuthorityBeforeChange,
                                         revokeBeforeExternalRead: revokeMountedAuthorityBeforeRead, retireMountedAuthority }) satisfies AuthoringWorkspacePrimaryMountPort;
onBeforeUnmount(() =>
{
    retireWorkspaceNavigationHost();
    primaryMountDisposed = true;
    primaryMountGeneration += 1n;
    revokeMountedAuthorityBeforeChange();
    mountedSubtreeObserver?.disconnect();
    cancelPrimaryMount?.();
});

watch([workspaceMountedSource, workspaceTabId, workspaceDocumentContext], bindWorkspaceRecoveryCheckpoint, { flush: 'post' });

function retireWorkspaceNavigationHost(): void
{
    const previous = workspaceNavigationHost;
    workspaceNavigationHost = null;
    workspaceNavigationLifetime?.abort();
    workspaceNavigationLifetime = null;
    previous?.dispose();
}

function refreshWorkspaceNavigationHost(): void
{
    retireWorkspaceNavigationHost();
    const bound = mountedWriterBinding;
    const source = workspaceMountedSource.value;
    const port = boundEditorPort;
    const generation = editorBindingGeneration;
    const tabId = workspaceTabId.value;
    if (!bound || !source || bound.mountedSource !== source || !port || !tabId || workspacePrimaryMountOnly.value)
    {
        return;
    }
    workspaceNavigationLifetime = new AbortController();
    workspaceNavigationHost = createAuthoringWorkspaceNavigationHost({
        authority: articleDocumentContextAuthority,
        document: authoringDocumentContextAdapter, anchors: bound.binding.anchors,
        registry: articleWorkspaceTabRouter.getRegistry(), mountedSource: source,
        scope: authoringEditorRuntime.retainedScope, signal: workspaceNavigationLifetime.signal,
        isCurrent: () => !primaryMountDisposed && !mountedAuthorityRetired && !workspacePrimaryMountOnly.value
            && generation === editorBindingGeneration && mountedWriterBinding === bound && boundEditorPort === port
            && workspaceMountedSource.value === source && workspaceTabId.value === tabId
            && articleDocumentContextAuthority.context === authoringDocumentContextAdapter.context
            && authoringDocumentContext.value === authoringDocumentContextAdapter.context,
        readNative: () => articleEditorRef.value?.getAuthoringSessionPort?.() ?? null,
        refreshNativeIdentity: async () =>
        {
            authoringEditorRuntime.refreshDocumentIdentity();
            await nextTick();
        },
        viewOwner: {
            readSourceNavigationView: options => articleEditorRef.value?.readSourceNavigationView(options) ?? null,
            isCurrentSourceNavigationView: view => articleEditorRef.value?.isCurrentSourceNavigationView(view) === true
        }
    });
}
// Physical DOM observations revoke the original Root seal independently. A
// canonical retained publication may refresh its Vue identity while this same
// writer lifetime remains mounted; the retained owner checks that publication.
watch([workspaceWriteElement, workspaceNativeMountElement, workspaceMountedSource, workspacePrimaryMountOnly,
       () => route.fullPath], retireWorkspaceNavigationHost, { flush: 'sync' });
watch([workspaceMountedSource, workspaceTabId], refreshWorkspaceNavigationHost, { flush: 'post' });

watch(articleEditorRef, () =>
{
    retireWorkspaceNavigationHost();
    revokeMountedAuthorityBeforeChange();
    const generation = ++editorBindingGeneration;
    releaseRecoveryCheckpoint();
    mountedWriterBinding = null;
    releaseEditorRuntime?.();
    releaseEditorRuntime = null;
    editorRuntimeBinding.value = null;
    workspaceMountedSource.value = null;
    boundEditorPort = null;
    void nextTick().then(() =>
    {
        if (generation !== editorBindingGeneration)
        {
            return;
        }
        const port = articleEditorRef.value?.getAuthoringEditorPort();
        if (!port)
        {
            return;
        }
        // Consumer retention bounds; automatic-render eligibility remains owned by the refresh policy.
        const bound = authoringEditorRuntime.bindEditor(port, {
            surface: 'source',
            configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
            identity: { themeDigest: calculateOpenArticleDocumentDigest({ theme: authoringTheme.resolvedTheme.value }),
                        locale: activeLocale.value },
            cachePolicy: { maxEntryBytes: 4 * 1024 * 1024, maxAgeMs: 60_000, maxReceipts: 64 }
        }, () => generation === editorBindingGeneration && boundEditorPort === port
            ? articleEditorRef.value?.getAuthoringSessionPort?.() ?? null : null);
        boundEditorPort = port;
        editorRuntimeBinding.value = bound.binding;
        mountedWriterBinding = bound;
        workspaceMountedSource.value = bound.mountedSource;
        releaseEditorRuntime = bound.release;
        // Observe actual editor events; initialization dispatch would steal initial title focus.
    });
}, { flush: 'post' });
onUnmounted(() =>
{
    retireWorkspaceNavigationHost();
    editorBindingGeneration += 1;
    releaseRecoveryCheckpoint();
    mountedWriterBinding = null;
    releaseEditorRuntime?.();
    editorRuntimeBinding.value = null;
    workspaceMountedSource.value = null;
    boundEditorPort = null;
});

// This is the actual document-flow region and original physical owner join.
// Its empty natural-size DOM cannot produce available space until content exists.
// Panel persistence/selection and command execution are not implemented here.
function refreshWorkspacePanelHost(): void
{
    workspacePanelHost?.dispose();
    workspacePanelLifetime?.abort();
    workspacePanelHost = null;
    const root = workspaceWriteElement.value;
    const region = workspacePanelRegionElement.value;
    if (!root || !region || workspacePrimaryMountOnly.value)
    {
        return;
    }
    workspacePanelLifetime = new AbortController();
    workspacePanelHost = createAuthoringWorkspacePanelHost({
        root, region, signal: workspacePanelLifetime.signal,
        readBinding: () =>
        {
            const editorElement = workspaceNativeMountElement.value;
            const layoutSource = workspaceLayoutSource.value;
            const layoutPort = workspaceLayoutRef.value;
            const mountedSource = workspaceMountedSource.value;
            const tabId = workspaceTabId.value;
            const nativeEditor = articleEditorRef.value?.getAuthoringSessionPort?.() ?? null;
            return root === workspaceWriteElement.value && region === workspacePanelRegionElement.value
                && !workspacePrimaryMountOnly.value && !primaryMountDisposed && !mountedAuthorityRetired
                && mountedWriterBinding?.mountedSource === mountedSource
                && authoringDocumentContextAdapter.context === authoringDocumentContext.value
                && editorElement && layoutSource && layoutPort && mountedSource && tabId && nativeEditor && nativeEditor === boundEditorPort
                ? { root, editorElement, adapter: authoringDocumentContextAdapter, registry: articleWorkspaceTabRouter.getRegistry(),
                    tabId, layoutSource, layoutPort, mountedSource, nativeEditor,
                    readNativeEditor: () => articleEditorRef.value?.getAuthoringSessionPort?.() ?? null }
                : null;
        }
    });
    void workspacePanelHost.refreshAuthority();
}
watch([workspaceWriteElement, workspacePanelRegionElement, workspaceNativeMountElement, workspaceLayoutRef,
       workspaceMountedSource, workspaceTabId, workspaceLayoutSource, workspacePrimaryMountOnly,
       () => authoringDocumentContext.value.documentId, () => authoringDocumentContext.value.documentEpoch],
      refreshWorkspacePanelHost, { flush: 'post' });
onBeforeUnmount(() =>
{
    workspacePanelHost?.dispose();
    workspacePanelLifetime?.abort();
    workspacePanelHost = null;
});

async function consumeAcceptedAttachmentCapture(batch: MarkdownAttachmentBatchIntent,
                                                capture: MarkdownAttachmentCaptureObservation | undefined, anchorOptions: ArticleAnchorCaptureOptions): Promise<void>
{
    const admitted = authoringAttachmentRuntime.admitAcceptedCapture({ batch, capture, anchorOptions });
    if (admitted.status !== 'admitted')
    {
        showErrorToast(admitted.reason, admitted.reason);
        return;
    }
    for (const item of admitted.items)
    {
        try
        {
            const observation = await authoringAttachmentRuntime.observeUpload(item.handle, item.file, item.handle.signal);
            if (observation.status !== 'committed')
            {
                const message = observation.status === 'pending' ? '附件上传尚未确认完成' : observation.reason;
                showErrorToast(message, message);
                // The original Writer retains the observation; no retry or cleanup authority is inferred.
                return;
            }
        }
        catch (error)
        {
            const message = error instanceof Error ? error.message : 'article-attachment-upload-failed';
            showErrorToast(message, message);
            return;
        }
    }
}

function consumeSourceNavigationGesture(event: MarkdownEditorSourceNavigationGesture): void
{
    workspaceNavigationHost?.manual(event);
}

function consumeAuthoringTransaction(event: MarkdownEditorDispatchResult): void
{
    editorRuntimeBinding.value?.consumeTransaction(event);
}

function consumeAuthoringSelection(event: {
    documentIdentity?: { id: string; epoch: number; };
    revision: number;
    selection: MarkdownEditorResolvedSelection;
}): void
{
    if (event.documentIdentity)
    {
        editorRuntimeBinding.value?.consumeSelection({ ...event, documentIdentity: event.documentIdentity });
    }
}

function consumeAuthoringFocus(event: 'focusin' | 'focusout'): void
{
    editorRuntimeBinding.value?.consumeFocus(event);
}


const submitConfirmDialog = ref(false);
const leaveConfirmDialog = ref(false);
const {
    activeInspector,
    open: openInspector,
    switchTo: switchInspector,
    close: closeInspector,
    registerTrigger: registerInspectorTrigger,
    registerScrollContainer: registerInspectorScrollContainer,
    updateScroll: updateInspectorScroll,
    restoreFocus: restoreInspectorFocus
} = useArticleWriteInspector({
    initialInspector: route.query.preview === 'private' ? 'preview' : null,
    loadView: {
        resources: () => refreshAssetLibrary()
            .catch((error: unknown) =>
            {
                showErrorToast(error, '资产库刷新失败');
            }),
        versions: () => refreshArticleRevisions()
            .catch((error: unknown) =>
            {
                showErrorToast(error, '历史版本刷新失败');
            })
    }
});

const triggerCoverInput = (): void =>
{
    coverInputRef.value?.click();
};

const updateCopyrightYear = (value: number | undefined): void =>
{
    articleForm.rights.copyrightYear = typeof value === 'number' ? value : null;
};

const submitChecklist = computed<{ label: string; state: SubmitChecklistState; detail?: string; }[]>(() =>
{
    const summaryLength = articleForm.summary.trim().length;
    const seoWarning = prepublishWarningIssues.value[0];
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
    ];
});

const onCoverFileChange = (event: Event): void =>
{
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0)
    {
        const files = Array.from(input.files);
        handleCoverUpload(files).catch((error: unknown) => showErrorToast(error, '头图上传失败'));
        input.value = '';
    }
};

const editorSaveStatusText = computed(() =>
{
    if (pageLoading.value)
    {
        return '正在载入';
    }

    if (submitting.value)
    {
        return '正在保存';
    }

    return draftStatusText.value.trim() || '自动保存已就绪';
});

const editorSaveStatusTone = computed<'quiet' | 'danger'>(() =>
    /失败|不可用|暂停|未同步|冲突|勿关闭/u.test(editorSaveStatusText.value)
        ? 'danger'
        : 'quiet'
);

const criticalInspectorSummary = computed<{
    text: string;
    target: ArticleWriteInspectorView;
} | null>(() =>
{
    if (editorSaveStatusTone.value === 'danger')
    {
        return {
            text: editorSaveStatusText.value,
            target: 'publish'
        };
    }

    const blockingIssueCount = seoIssues.value
        .filter((issue) => issue.severity.toLowerCase() === 'error')
        .length;
    if (blockingIssueCount > 0)
    {
        return {
            text: `${blockingIssueCount} 项发布检查需处理`,
            target: 'check'
        };
    }

    return null;
});

const requestSubmit = async (): Promise<void> =>
{
    const isValid = await validateBeforeSubmit();
    if (isValid)
    {
        submitConfirmDialog.value = true;
        return;
    }

    await nextTick();
    const invalidProperty = firstInvalidFormProperty.value;
    if (invalidProperty !== null)
    {
        formRef.value?.scrollToField(invalidProperty);
    }
    const invalidFieldRoot = invalidProperty === null ? null
        : document.querySelector<HTMLElement>(`[data-article-form-property="${CSS.escape(invalidProperty)}"]`);
    focusFirstArticleValidationError(invalidFieldRoot);
};

const insertAssetIntoEditor = (asset: AssetLibraryItemResponse): void =>
{
    insertAssetIntoContent(asset, (markdown) => articleEditorRef.value?.insertMarkdownAtCursor?.(markdown) === true);
};

const confirmSubmit = async (): Promise<void> =>
{
    const warningOverrideReady = await confirmPrepublishWarningOverride();
    if (!warningOverrideReady)
    {
        return;
    }

    submitConfirmDialog.value = false;
    await submitForm();
};

const requestLeave = (): void =>
{
    if (requiresLeaveConfirm.value)
    {
        leaveConfirmDialog.value = true;
        return;
    }

    leaveEditor();
};

const confirmLeave = (): void =>
{
    leaveConfirmDialog.value = false;
    leaveEditor();
};

const openQuickCreateCategory = (): void =>
{
    quickCategoryName.value = '';
    quickCreateCategoryDialog.value = true;
};

const openQuickCreateTag = (): void =>
{
    quickTagName.value = '';
    quickCreateTagDialog.value = true;
};

const focusQuickCategoryInput = async (): Promise<void> =>
{
    await nextTick();
    quickCategoryInputRef.value?.focus?.();
};

const focusQuickTagInput = async (): Promise<void> =>
{
    await nextTick();
    quickTagInputRef.value?.focus?.();
};

const submitQuickCreateCategory = async (): Promise<void> =>
{
    const created = await quickCreateCategory(quickCategoryName.value);
    if (created)
    {
        quickCreateCategoryDialog.value = false;
    }
};

const submitQuickCreateTag = async (): Promise<void> =>
{
    const created = await quickCreateTag(quickTagName.value);
    if (created)
    {
        quickCreateTagDialog.value = false;
    }
};
</script>

<style scoped>
.write-workspace
 {
    --fsusblog-article-document-inline-size: 70rem;

    position: relative;
    display: flex;
    flex-direction: column;
}

.write-document-canvas
 {
    box-sizing: border-box;
    width: min(100%, var(--fsusblog-article-document-inline-size));
    margin-inline: auto;
    padding: 0 1rem;
}

.write-draft-banner
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
}

.write-draft-copy
 {
    flex: 1 1 20rem;
}

.write-draft-title
 {
    margin: 0 0 0.375rem;
    color: var(--fsusblog-color-warning-text);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: 0;
}

.write-draft-description
 {
    margin: 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.55;
}

.write-recovery-privacy
 {
    margin: 0.5rem 0 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.55;
}

.write-recovery-candidates
 {
    display: grid;
    max-height: 20rem;
    padding: 0;
    margin: 1rem 0 0;
    overflow-y: auto;
    border: 0;
    border-block: 1px solid var(--fsusblog-panel-border);
}

.write-recovery-candidate
 {
    display: grid;
    min-height: 2.75rem;
    align-items: start;
    padding: 0.75rem 0;
    cursor: pointer;
    gap: 0.75rem;
    grid-template-columns: auto minmax(0, 1fr);
}

.write-recovery-candidate + .write-recovery-candidate
 {
    border-top: 1px solid var(--fsusblog-panel-border);
}

.write-recovery-candidate > input
 {
    width: 1rem;
    height: 1rem;
    margin: 0.2rem 0 0;
    accent-color: var(--fsus-scholarly-blue);
}

.write-recovery-candidate-copy
 {
    display: grid;
    min-width: 0;
    gap: 0.2rem;
}

.write-recovery-candidate-label
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.4;
}

.write-recovery-candidate-detail,
.write-recovery-candidate-excerpt
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
}

.write-recovery-comparison,
.write-recovery-operation-status,
.write-recovery-operation-error
 {
    margin: 0.75rem 0 0;
    font-size: 12px;
    line-height: 1.55;
    overflow-wrap: anywhere;
}

.write-recovery-comparison,
.write-recovery-operation-status
 {
    color: var(--fsusblog-text-tertiary);
}

.write-recovery-operation-error
 {
    color: var(--fsusblog-color-error);
}

.write-draft-actions
 {
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.write-draft-actions > *
 {
    min-width: 7.25rem;
    min-height: 2.75rem;
    padding-inline: 1.25rem;
    font-size: 14px;
    font-weight: 700;
}

.submit-checklist-item
 {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 0.75rem;
    font-size: 12px;
    line-height: 1.5;
}

.submit-checklist-status
 {
    flex: 0 0 auto;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.submit-checklist-item--pass .submit-checklist-status
 {
    color: var(--fsusblog-color-success);
}

.submit-checklist-item--warning .submit-checklist-status
 {
    color: var(--fsusblog-color-warning);
}

.write-editor-panel
 {
    min-width: 0;
}

.write-editor-panel > *
 {
    width: 100%;
    min-width: 0;
}

@media (width >= 1024px)
 {
    .write-document-canvas
 {
        padding-right: calc(
            var(--fsus-control-height-spacious) + var(--fsus-space-8)
        );
    }
}

.write-disclosure-summary::-webkit-details-marker
 {
    display: none;
}

@media (width <= 767px)
 {
    .write-workspace
 {
        padding-bottom: 5rem;
    }
}

@media (width <= 1023px)
 {
    .write-draft-banner
 {
        align-items: flex-start;
        flex-direction: column;
    }

    .write-draft-copy
 {
        width: 100%;
        flex: 0 1 auto;
    }

    .write-draft-actions
 {
        width: 100%;
        justify-content: flex-start;
    }

}
</style>
