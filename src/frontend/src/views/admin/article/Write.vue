<template>
  <main
    class="account-page write-article-wrapper account-motion-enter w-full"
    aria-labelledby="article-write-title"
    :aria-busy="pageLoading || submitting"
  >
    <div
      class="write-workspace"
      v-loading="pageLoading"
      element-loading-text="正在载入数据资源..."
    >
      <header class="write-command-bar border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-4 py-3 mb-6" aria-label="文章编辑操作">
        <div class="write-command-heading">
          <el-button class="write-command-back" text @click="requestLeave" :disabled="submitting">
            返回
          </el-button>
          <div class="min-w-0">
            <h1 id="article-write-title" class="write-command-title">{{ pageTitle }}</h1>
            <p id="article-editor-status" class="write-command-status" aria-live="polite">
              {{ editorStatusText }}
            </p>
          </div>
        </div>
        <div class="write-command-actions shrink-0">
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
      <section class="write-title-panel px-4 mb-12" aria-label="文章标题">
        <div
          v-if="pendingDraft"
          class="write-draft-banner border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] py-4 px-6 mb-8"
          role="status"
          aria-live="polite"
        >
          <div class="write-draft-copy min-w-0">
            <div class="write-draft-title">{{ pendingDraftSourceLabel }}</div>
            <p class="write-draft-description">
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

        <el-form-item class="write-title-item" prop="title">
          <div class="write-title-field">
            <el-input
              v-model="articleForm.title"
              class="write-title-input"
              label="文章标题"
              name="articleTitle"
              placeholder="写下文章标题"
              size="large"
              maxlength="100"
              show-word-limit
              :disabled="submitting"
            />
          </div>
        </el-form-item>
      </section>

      <div
        class="write-grid"
        :class="{ 'write-grid--wide': editorLayoutMode === 'wide' }"
        aria-label="写作工作区"
        :data-editor-layout-mode="editorLayoutMode"
      >
        <section class="write-editor-panel" aria-label="正文编辑器">
          <div class="overflow-hidden">
            <el-form-item prop="content">
              <ArticleWriteEditor
                ref="articleEditorRef"
                v-model="articleForm.content"
                :loading="pageLoading"
                :saving="submitting"
                @save="saveDraftNow"
                @draft-save="saveDraftNow"
                @submit="requestSubmit"
                @upload-img="handleUploadImg"
              />
            </el-form-item>
          </div>
        </section>

        <aside class="write-side-panel" aria-label="文章检查器">
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

            <section class="write-inspector-section" :class="{ 'is-open': rightsInspectorOpen }">
              <button
                type="button"
                class="write-inspector-summary"
                :aria-expanded="rightsInspectorOpen"
                aria-controls="write-inspector-rights"
                @click="rightsInspectorOpen = !rightsInspectorOpen"
              >
                <span class="write-inspector-summary__copy">
                  <span>版权保护</span>
                  <span>版权与转载设置</span>
                </span>
                <span class="write-inspector-summary__action" aria-hidden="true">
                  <span class="write-inspector-summary__state write-inspector-summary__state--closed">展开</span>
                  <span class="write-inspector-summary__state write-inspector-summary__state--open">收起</span>
                  <span class="write-inspector-summary__chevron"></span>
                </span>
              </button>
              <ElCollapseTransition>
                <div v-show="rightsInspectorOpen" id="write-inspector-rights" class="write-inspector-section__body">
                  <section class="write-rights-panel border-t border-[var(--fsusblog-panel-border)]" aria-label="版权保护">
                    <div class="p-4 space-y-4">
                  <p class="text-[11px] leading-5 text-[var(--fsusblog-text-tertiary)]">
                    默认使用站点版权设置；需要单篇不同规则时切换为自定义。
                  </p>
                  <el-form-item label="版权来源">
                    <el-radio-group
                      :model-value="articleForm.rights.mode"
                      aria-label="版权来源"
                      :disabled="submitting"
                      @change="(value) => setArticleRightsMode(value === 'custom' ? 'custom' : 'site')"
                    >
                      <el-radio-button label="site">继承站点设置</el-radio-button>
                      <el-radio-button label="custom">自定义本文版权</el-radio-button>
                    </el-radio-group>
                    <p class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-tertiary)]">
                      {{ articleRightsInheritanceText }}
                    </p>
                  </el-form-item>

                  <el-form-item prop="rights.enabled" label="启用策略">
                    <el-switch
                      v-model="articleForm.rights.enabled"
                      aria-label="启用版权策略"
                      :disabled="submitting || articleRightsUsingSiteDefaults"
                    />
                  </el-form-item>

                  <el-form-item prop="rights.licenseType" label="许可类型">
                    <el-select
                      v-model="articleForm.rights.licenseType"
                      name="articleRightsLicenseType"
                      aria-label="版权许可类型"
                      :disabled="submitting || articleRightsUsingSiteDefaults"
                    >
                      <el-option
                        v-for="item in articleRightsLicenseOptions"
                        :key="item.value"
                        :label="item.label"
                        :value="item.value"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item prop="rights.copyrightHolder" label="权利人">
                    <el-input
                      v-model="articleForm.rights.copyrightHolder"
                      name="articleRightsCopyrightHolder"
                      aria-label="版权权利人"
                      maxlength="256"
                      show-word-limit
                      :disabled="submitting || articleRightsUsingSiteDefaults"
                    />
                  </el-form-item>

                  <el-form-item prop="rights.copyrightYear" label="版权年份">
                    <el-input-number
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
                  </el-form-item>

                  <el-form-item prop="rights.rightsStatement" label="权利声明">
                    <el-input
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
                  </el-form-item>

                  <el-form-item prop="rights.attributionTemplate" label="署名模板">
                    <el-input
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
                  </el-form-item>

                  <el-form-item prop="rights.copyPolicy" label="复制策略">
                    <el-select
                      v-model="articleForm.rights.copyPolicy"
                      name="articleRightsCopyPolicy"
                      aria-label="版权复制策略"
                      :disabled="submitting || articleRightsUsingSiteDefaults"
                    >
                      <el-option
                        v-for="item in articleRightsCopyPolicyOptions"
                        :key="item.value"
                        :label="item.label"
                        :value="item.value"
                      />
                    </el-select>
                  </el-form-item>

                  <el-form-item prop="rights.maxExcerptChars" label="摘录长度">
                    <el-input-number
                      v-model="articleForm.rights.maxExcerptChars"
                      name="articleRightsMaxExcerptChars"
                      aria-label="最大摘录字符数"
                      :min="0"
                      :max="articleRightsExcerptMax"
                      :step="10"
                      :disabled="submitting || articleRightsUsingSiteDefaults"
                      controls-position="right"
                    />
                  </el-form-item>

                  <div class="grid gap-3">
                    <el-checkbox v-model="articleForm.rights.allowCodeCopy" :disabled="submitting || articleRightsUsingSiteDefaults">
                      允许代码块复制
                    </el-checkbox>
                    <el-checkbox v-model="articleForm.rights.showPublicBadge" :disabled="submitting || articleRightsUsingSiteDefaults">
                      公开页显示版权标识
                    </el-checkbox>
                    <el-checkbox v-model="articleForm.rights.proofBindingEnabled" :disabled="submitting || articleRightsUsingSiteDefaults">
                      启用 proof 绑定
                    </el-checkbox>
                  </div>
                    </div>
                  </section>
                </div>
              </ElCollapseTransition>
            </section>

            <section class="write-inspector-section" :class="{ 'is-open': checkInspectorVisible }">
              <button
                type="button"
                class="write-inspector-summary"
                :aria-expanded="checkInspectorVisible"
                aria-controls="write-inspector-check"
                @click="toggleCheckInspector"
              >
                <span class="write-inspector-summary__copy">
                  <span>内容检查</span>
                  <span>摘要、标题、标签和结构建议</span>
                </span>
                <span class="write-inspector-summary__action" aria-hidden="true">
                  <span class="write-inspector-summary__state write-inspector-summary__state--closed">展开</span>
                  <span class="write-inspector-summary__state write-inspector-summary__state--open">收起</span>
                  <span class="write-inspector-summary__chevron"></span>
                </span>
              </button>
              <ElCollapseTransition>
                <div v-if="checkInspectorVisible" id="write-inspector-check" class="write-inspector-section__body">
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
                </div>
              </ElCollapseTransition>
            </section>

            <section class="write-inspector-section" :class="{ 'is-open': previewInspectorOpen }">
              <button
                type="button"
                class="write-inspector-summary"
                :aria-expanded="previewInspectorOpen"
                aria-controls="write-inspector-preview"
                @click="togglePreviewInspector"
              >
                <span class="write-inspector-summary__copy">
                  <span>阅读预览</span>
                  <span>按需生成私有预览</span>
                </span>
                <span class="write-inspector-summary__action" aria-hidden="true">
                  <span class="write-inspector-summary__state write-inspector-summary__state--closed">展开</span>
                  <span class="write-inspector-summary__state write-inspector-summary__state--open">收起</span>
                  <span class="write-inspector-summary__chevron"></span>
                </span>
              </button>
              <ElCollapseTransition>
                <div v-if="previewInspectorOpen" id="write-inspector-preview" class="write-inspector-section__body">
                  <ArticlePrivatePreviewPanel
                    :html="privatePreview?.html ?? ''"
                    :issues="privatePreview?.issues ?? []"
                    :loading="privatePreviewLoading"
                    :status-text="privatePreviewStatusText"
                    :can-preview="canGeneratePrivatePreview"
                    @preview="generatePrivatePreview"
                  />
                </div>
              </ElCollapseTransition>
            </section>

            <section class="write-inspector-section" :class="{ 'is-open': versionsInspectorOpen }">
              <button
                type="button"
                class="write-inspector-summary"
                :aria-expanded="versionsInspectorOpen"
                aria-controls="write-inspector-versions"
                @click="toggleVersionsInspector"
              >
                <span class="write-inspector-summary__copy">
                  <span>版本</span>
                  <span>查看修订和回滚</span>
                </span>
                <span class="write-inspector-summary__action" aria-hidden="true">
                  <span class="write-inspector-summary__state write-inspector-summary__state--closed">展开</span>
                  <span class="write-inspector-summary__state write-inspector-summary__state--open">收起</span>
                  <span class="write-inspector-summary__chevron"></span>
                </span>
              </button>
              <ElCollapseTransition>
                <div v-if="versionsInspectorOpen" id="write-inspector-versions" class="write-inspector-section__body">
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
                </div>
              </ElCollapseTransition>
            </section>

            <section class="write-inspector-section" :class="{ 'is-open': resourcesInspectorOpen }">
              <button
                type="button"
                class="write-inspector-summary"
                :aria-expanded="resourcesInspectorOpen"
                aria-controls="write-inspector-resources"
                @click="toggleResourcesInspector"
              >
                <span class="write-inspector-summary__copy">
                  <span>资源</span>
                  <span>图片资源和上传策略</span>
                </span>
                <span class="write-inspector-summary__action" aria-hidden="true">
                  <span class="write-inspector-summary__state write-inspector-summary__state--closed">展开</span>
                  <span class="write-inspector-summary__state write-inspector-summary__state--open">收起</span>
                  <span class="write-inspector-summary__chevron"></span>
                </span>
              </button>
              <ElCollapseTransition>
                <div v-if="resourcesInspectorOpen" id="write-inspector-resources" class="write-inspector-section__body">
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
                </div>
              </ElCollapseTransition>
            </section>
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

    <FsusDialog
      v-model="quickCreateCategoryDialog"
      title="新建分类"
      width="min(92vw, 28rem)"
      destroy-on-close
      :close-on-click-modal="false"
      @opened="focusQuickCategoryInput"
    >
      <el-form label-position="top" @submit.prevent="submitQuickCreateCategory">
        <el-form-item label="分类名称">
          <el-input
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
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="grid grid-cols-2 gap-4">
          <el-button :disabled="quickCreatingCategory" @click="quickCreateCategoryDialog = false">
            取消
          </el-button>
          <el-button type="primary" :loading="quickCreatingCategory" @click="submitQuickCreateCategory">
            创建并选中
          </el-button>
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
      <el-form label-position="top" @submit.prevent="submitQuickCreateTag">
        <el-form-item label="标签名称">
          <el-input
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
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="grid grid-cols-2 gap-4">
          <el-button :disabled="quickCreatingTag" @click="quickCreateTagDialog = false">
            取消
          </el-button>
          <el-button type="primary" :loading="quickCreatingTag" @click="submitQuickCreateTag">
            创建并关联
          </el-button>
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
          <el-button :disabled="submitting" @click="submitConfirmDialog = false">
            继续编辑
          </el-button>
          <el-button type="primary" :loading="submitting || seoChecking" @click="confirmSubmit">
            {{ submitButtonText }}
          </el-button>
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
        尚未同步的更改只保留在当前页面，离开后可能丢失。返回编辑页后只能恢复已同步的服务端草稿；浏览器只保留保存时间等不可恢复正文的记录。
      </p>
      <template #footer>
        <div class="grid grid-cols-2 gap-4">
          <el-button @click="leaveConfirmDialog = false">
            继续编辑
          </el-button>
          <el-button type="primary" @click="confirmLeave">
            离开编辑器
          </el-button>
        </div>
      </template>
    </FsusDialog>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ArticleAssetLibraryPanel from '@/components/admin/article/ArticleAssetLibraryPanel.vue'
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue'
import ArticleRevisionPanel from '@/components/admin/article/ArticleRevisionPanel.vue'
import ArticleSeoPreviewPanel from '@/components/admin/article/ArticleSeoPreviewPanel.vue'
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import FsusDialog from '@/components/ui/FsusDialog.vue'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'
import { ArticlePublishStatus } from '@/api/article'
import { ElCollapseTransition } from '@/fsusui/motion'
import type { AssetLibraryItemResponse } from '@/api/authoring'
import { showErrorToast } from '@/utils/errorPresentation'

type SubmitChecklistState = 'pass' | 'warning'

const route = useRoute()

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
  articleRightsUsingSiteDefaults,
  articleRightsInheritanceText,
  articleRightsLicenseOptions,
  articleRightsCopyPolicyOptions,
  articleRightsExcerptMax,
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
const quickCategoryInputRef = ref<{ focus?: () => void } | null>(null)
const quickTagInputRef = ref<{ focus?: () => void } | null>(null)
const coverInputRef = ref<HTMLInputElement | null>(null)
const articleEditorRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean } | null>(null)
const submitConfirmDialog = ref(false)
const leaveConfirmDialog = ref(false)
const checkInspectorOpen = ref(false)
const checkInspectorUserToggled = ref(false)
const rightsInspectorOpen = ref(false)
const previewInspectorOpen = ref(route.query.preview === 'private')
const resourcesInspectorOpen = ref(false)
const versionsInspectorOpen = ref(false)
const assetLibraryLoaded = ref(false)
const revisionsLoaded = ref(false)

const triggerCoverInput = (): void => {
  coverInputRef.value?.click()
}

const updateCopyrightYear = (value: number | undefined): void => {
  articleForm.rights.copyrightYear = typeof value === 'number' ? value : null
}

watch(
  () => [seoIssues.value.length, Boolean(aiAssist.value)] as const,
  ([issueCount, hasAssist]) => {
    if (!checkInspectorUserToggled.value && (issueCount > 0 || hasAssist)) {
      checkInspectorOpen.value = true
    }
  },
  { immediate: true }
)

const checkInspectorVisible = computed(() => checkInspectorOpen.value)
const editorLayoutMode = computed(() =>
  rightsInspectorOpen.value ||
  checkInspectorVisible.value ||
  previewInspectorOpen.value ||
  resourcesInspectorOpen.value ||
  versionsInspectorOpen.value
    ? 'with-inspector'
    : 'wide'
)

const toggleCheckInspector = (): void => {
  checkInspectorUserToggled.value = true
  checkInspectorOpen.value = !checkInspectorVisible.value
}

const togglePreviewInspector = (): void => {
  previewInspectorOpen.value = !previewInspectorOpen.value
}

const openResourcesInspector = (): void => {
  resourcesInspectorOpen.value = true
  if (!assetLibraryLoaded.value) {
    assetLibraryLoaded.value = true
    refreshAssetLibrary().catch((error: unknown) => showErrorToast(error, '资产库刷新失败'))
  }
}

const toggleResourcesInspector = (): void => {
  if (resourcesInspectorOpen.value) {
    resourcesInspectorOpen.value = false
    return
  }

  openResourcesInspector()
}

const openVersionsInspector = (): void => {
  versionsInspectorOpen.value = true
  if (!revisionsLoaded.value) {
    revisionsLoaded.value = true
    refreshArticleRevisions().catch((error: unknown) => showErrorToast(error, '历史版本刷新失败'))
  }
}

const toggleVersionsInspector = (): void => {
  if (versionsInspectorOpen.value) {
    versionsInspectorOpen.value = false
    return
  }

  openVersionsInspector()
}

const submitChecklist = computed<Array<{ label: string; state: SubmitChecklistState; detail?: string }>>(() => {
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

const onCoverFileChange = (event: Event): void => {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    const files = Array.from(input.files)
    handleCoverUpload(files).catch((error: unknown) => showErrorToast(error, '头图上传失败'))
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

const focusQuickCategoryInput = async (): Promise<void> => {
  await nextTick()
  quickCategoryInputRef.value?.focus?.()
}

const focusQuickTagInput = async (): Promise<void> => {
  await nextTick()
  quickTagInputRef.value?.focus?.()
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

.write-command-heading {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.write-command-back {
  min-width: 36px;
  min-height: 36px;
  align-self: flex-start;
  padding: 0 0.5rem;
  color: var(--fsusblog-text-muted);
  font-size: 14px;
  font-weight: 700;
}

.write-command-back:hover,
.write-command-back:focus-visible {
  color: var(--fsusblog-text-primary);
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
  font-size: 14px;
  line-height: 1.5;
}

.write-command-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  margin-left: auto;
}

.write-submit-button {
  display: grid;
  min-width: 8rem;
}

.write-draft-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}

.write-draft-copy {
  flex: 1 1 20rem;
}

.write-draft-title {
  margin-bottom: 0.375rem;
  color: var(--fsusblog-color-warning-text);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0;
}

.write-draft-description {
  margin: 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.55;
}

.write-draft-actions {
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.write-draft-actions :deep(.el-button) {
  min-width: 7.25rem;
  min-height: 2.75rem;
  padding-inline: 1.25rem;
  font-size: 14px;
  font-weight: 700;
}

.submit-checklist-item {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 0.75rem;
  font-size: 12px;
  line-height: 1.5;
}

.submit-checklist-status {
  flex: 0 0 auto;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
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
  grid-template-columns: minmax(0, 1fr) minmax(16rem, min(22rem, 38%));
  gap: 2rem;
  padding: 0 1rem;
}

.write-grid--wide {
  grid-template-columns: minmax(0, 1fr);
}

.write-editor-panel {
  min-width: 0;
}

.write-editor-panel :deep(.el-form-item),
.write-editor-panel :deep(.el-form-item__content) {
  width: 100%;
  min-width: 0;
}

.write-title-item,
.write-title-item :deep(.el-form-item__content),
.write-title-field,
.write-title-input {
  --write-title-inline-inset: clamp(1rem, 3vw, 1.5rem);

  width: 100%;
  min-width: 0;
}

.write-title-input :deep(.el-input__wrapper) {
  min-height: clamp(4.5rem, 8vw, 6.5rem);
  border: 0;
  box-shadow: none;
  background: transparent;
  padding: 0 var(--write-title-inline-inset);
}

.write-title-input :deep(.el-input__wrapper.is-focus),
.write-title-input :deep(.el-input__wrapper:hover) {
  box-shadow: inset 0 -2px 0 var(--fsusblog-panel-border);
}

.write-title-input :deep(.el-input__inner) {
  height: auto;
  min-height: 2.25rem;
  color: var(--fsusblog-text-primary);
  font-size: clamp(2.25rem, 5vw, 4rem);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: 0;
}

.write-title-input :deep(.el-input__inner::placeholder) {
  color: color-mix(in srgb, var(--fsusblog-text-muted) 72%, transparent);
  font-weight: 700;
}

.write-title-input :deep(.el-input__count) {
  bottom: 0.35rem;
  background: transparent;
  color: var(--fsusblog-text-tertiary);
  font-size: 14px;
  font-weight: 700;
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
  width: 100%;
  border: 0;
  list-style: none;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 3.75rem;
  padding: 0.75rem 1rem;
  background: transparent;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 700;
  text-align: left;
  transition:
    background-color var(--blog-motion-fast) var(--blog-motion-ease),
    color var(--blog-motion-fast) var(--blog-motion-ease);
}

.write-inspector-summary:hover {
  background: color-mix(in srgb, var(--fsusblog-text-primary) 4%, transparent);
}

.write-inspector-summary:focus-visible {
  outline: 2px solid var(--fsusblog-color-focus-ring);
  outline-offset: -2px;
}

.write-inspector-summary::-webkit-details-marker {
  display: none;
}

.write-inspector-summary__copy {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}

.write-inspector-summary__copy > span + span {
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
  font-weight: 500;
}

.write-inspector-summary__action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.45rem;
  border: 1px solid var(--fsusblog-panel-border);
  padding: 0.28rem 0.48rem;
  color: var(--fsusblog-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.write-inspector-summary__state--open {
  display: none;
}

.write-inspector-section.is-open > .write-inspector-summary .write-inspector-summary__state--closed {
  display: none;
}

.write-inspector-section.is-open > .write-inspector-summary .write-inspector-summary__state--open {
  display: inline;
}

.write-inspector-summary__chevron {
  width: 0.42rem;
  height: 0.42rem;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: translateY(-0.1rem) rotate(45deg);
  transition: transform var(--blog-motion-fast) var(--blog-motion-ease);
}

.write-inspector-section.is-open > .write-inspector-summary .write-inspector-summary__chevron {
  transform: translateY(0.08rem) rotate(225deg);
}

.write-inspector-section__body {
  min-height: 0;
  overflow: hidden;
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

  .write-command-heading {
    align-items: flex-start;
  }

  .write-draft-banner {
    align-items: flex-start;
    flex-direction: column;
  }

  .write-draft-copy {
    width: 100%;
    flex: 0 1 auto;
  }

  .write-draft-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .write-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .write-title-input :deep(.el-input__wrapper) {
    padding-inline: 0.5rem;
  }

  .write-title-input :deep(.el-input__count) {
    display: none;
  }

  .write-title-input :deep(.el-input__inner) {
    font-size: clamp(1.5rem, 10vw, 2.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .write-inspector-summary__chevron {
    transition: none;
  }
}
</style>
