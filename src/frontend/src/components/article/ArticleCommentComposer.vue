<template>
  <div v-if="isLoggedIn" ref="composerShell" :class="commentDetailTokens.composer.loggedInShell" data-fsus-surface="reading">
    <div v-if="replyTarget" class="mb-3 flex items-center justify-between border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-3 py-2 text-xs text-[var(--fsusblog-text-tertiary)]">
      <span>正在回复 @{{ replyTarget.author.displayName }}</span>
      <el-button
        link
        @click="$emit('cancel-reply')"
      >
        取消
      </el-button>
    </div>

    <div class="comment-identity-panel">
      <div class="comment-identity-summary">
        <div class="comment-identity-copy">
          <div class="comment-identity-heading">
            <span class="comment-identity-label">评论身份</span>
            <span
              v-if="effectiveAnonymousCommentsEnabled"
              class="comment-identity-badge comment-identity-badge--ready"
            >
              {{ anonymousStatusText }}
            </span>
            <span
              v-else
              class="comment-identity-badge comment-identity-badge--muted"
            >
              仅署名
            </span>
          </div>
          <p v-if="anonymousUnavailableMessage" class="comment-identity-hint">
            匿名发布暂不可用，可选择公开署名发布。
          </p>
          <p v-if="publicIdentityModel" class="comment-identity-hint">
            公开发布后，其他人会看到你的公开名称。
          </p>
        </div>
        <el-checkbox
          v-model="publicIdentityModel"
          class="comment-identity-toggle"
          :disabled="publicIdentityDisabled"
        >
          公开显示我的名称
        </el-checkbox>
      </div>
    </div>

    <div v-if="restoredDraftVisible && localDraft" class="comment-composer-draft" aria-live="polite">
      <span>已恢复本地草稿{{ draftSavedAtText ? ` ${draftSavedAtText}` : '' }}</span>
      <button type="button" @click="discardCommentDraft">丢弃</button>
    </div>

    <div class="comment-composer-editor">
      <div class="comment-composer-toolbar">
        <div class="comment-composer-mode" role="tablist" aria-label="评论编辑模式">
          <button
            v-for="option in commentComposerModeOptions"
            :key="option.value"
            type="button"
            class="comment-composer-mode__item"
            :class="{ 'is-active': commentComposerMode === option.value }"
            role="tab"
            :aria-selected="commentComposerMode === option.value"
            @click="commentComposerMode = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <el-button
          class="comment-composer-focus"
          text
          :disabled="composerInputDisabled"
          @click="openFocusMode"
        >
          专注写作
        </el-button>
      </div>

      <el-input
        v-show="commentComposerMode === 'write'"
        ref="editorInputRef"
        v-model="contentModel"
        type="textarea"
        :rows="4"
        :autosize="{ minRows: 4, maxRows: 8 }"
        resize="none"
        aria-label="发表评论"
        :placeholder="placeholderText"
        :disabled="composerInputDisabled"
        @focus="notifyPrivacyIntent"
        @keydown.ctrl.enter="requestSubmit"
        @keydown.meta.enter="requestSubmit"
      />

      <div
        v-show="commentComposerMode === 'preview'"
        class="comment-composer-preview"
        :class="{ 'is-empty': !contentModel.trim() }"
      >
        <CommentMarkdownRenderer
          v-if="contentModel.trim()"
          :content="contentModel"
          :collapsible="false"
        />
        <span v-else>暂无内容</span>
      </div>

      <p
        v-if="markdownFeedbackText"
        class="comment-composer-feedback"
        aria-live="polite"
      >
        {{ markdownFeedbackText }}
      </p>
      <div
        class="comment-composer-metrics"
        :class="{ 'is-warning': commentLimitWarning }"
        aria-live="polite"
      >
        <span>{{ commentCharCount }} / {{ commentPolicy.maxChars }} 字</span>
        <span>{{ commentUtf8Bytes }} / {{ commentPolicy.maxUtf8Bytes }} bytes</span>
      </div>
    </div>
    <div :class="commentDetailTokens.composer.submitWrap">
      <el-button
        type="primary"
        @click="requestSubmit"
        :disabled="submitDisabled"
        :aria-disabled="submitDisabled"
      >
        {{ composerUi.submitBusyText }}
      </el-button>
    </div>

    <el-dialog
      v-model="focusModeVisible"
      class="comment-composer-focus-dialog"
      title="专注写作"
      width="min(92vw, 48rem)"
      append-to-body
      @closed="closeFocusMode"
    >
      <div class="comment-composer-focus__body">
        <div class="comment-composer-toolbar">
          <div class="comment-composer-mode" role="tablist" aria-label="专注写作模式">
            <button
              v-for="option in commentComposerModeOptions"
              :key="option.value"
              type="button"
              class="comment-composer-mode__item"
              :class="{ 'is-active': commentComposerMode === option.value }"
              role="tab"
              :aria-selected="commentComposerMode === option.value"
              @click="commentComposerMode = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <el-input
          v-show="commentComposerMode === 'write'"
          ref="focusEditorInputRef"
          v-model="contentModel"
          type="textarea"
          :rows="12"
          resize="none"
          aria-label="专注撰写评论"
          :placeholder="placeholderText"
          :disabled="composerInputDisabled"
          @focus="notifyPrivacyIntent"
          @keydown.ctrl.enter="requestSubmit"
          @keydown.meta.enter="requestSubmit"
        />
        <div
          v-show="commentComposerMode === 'preview'"
          class="comment-composer-preview comment-composer-focus__preview"
          :class="{ 'is-empty': !contentModel.trim() }"
        >
          <CommentMarkdownRenderer
            v-if="contentModel.trim()"
            :content="contentModel"
            :collapsible="false"
          />
          <span v-else>暂无内容</span>
        </div>
      </div>
      <template #footer>
        <div class="comment-composer-focus__footer">
          <div
            class="comment-composer-metrics"
            :class="{ 'is-warning': commentLimitWarning }"
          >
            <span>{{ commentCharCount }} / {{ commentPolicy.maxChars }} 字</span>
            <span>{{ commentUtf8Bytes }} / {{ commentPolicy.maxUtf8Bytes }} bytes</span>
          </div>
          <el-button @click="focusModeVisible = false">返回</el-button>
          <el-button
            type="primary"
            :disabled="submitDisabled"
            @click="requestSubmit"
          >
            {{ composerUi.submitBusyText }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>

  <div v-else :class="commentDetailTokens.composer.guestShell" data-fsus-surface="reading">
    <p :class="commentDetailTokens.composer.guestText">
      {{ composerUi.guestPromptPrefix }}
      <router-link :to="composerUi.guestLoginRoute" :class="commentDetailTokens.composer.guestLink">
        {{ composerUi.guestPromptLoginText }}
      </router-link>
      {{ composerUi.guestPromptSuffix }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommentAuthorMode, CommentAuthorView, CommentDisplayLanguage } from '@/api/comment'
import CommentMarkdownRenderer from '@/components/article/CommentMarkdownRenderer.vue'
import type { CommentPrivacyUiState } from '@/privacy/commentPrivacyTypes'
import {
  getCommentUtf8ByteLength,
  inspectCommentMarkdownContent,
  normalizeCommentContentPolicy,
  validateCommentContent
} from '@/utils/contentFilter'
import {
  commentDetailTokens,
  createCommentComposerUiContract
} from '@/view-contracts/commentDetail'

type ReplyTargetView = {
  id: string
  rootId: string
  author: CommentAuthorView
  depth: number
}

type CommentComposerMode = 'write' | 'preview'
type ElInputExpose = {
  focus?: () => void
}
type CommentDraftSnapshot = {
  content: string
  authorMode: CommentAuthorMode
  publicSendConfirmed: boolean
  savedAt: number
  policyHash: string
}

const props = withDefaults(defineProps<{
  modelValue: string;
  isLoggedIn: boolean;
  isBanned: boolean;
  isPowCalculating: boolean;
  isSubmitting: boolean;
  redirectPath: string;
  replyTarget: ReplyTargetView | null;
  authorMode: CommentAuthorMode;
  publicSendConfirmed: boolean;
  anonymousCommentsEnabled: boolean;
  publicCommentsEnabled: boolean;
  zkAnonymousEnabled: boolean;
  articleId: number | null;
  accountId: number | null;
  commentMaxChars: number;
  commentMaxUtf8Bytes: number;
  policySnapshotHash: string;
  privacyState: CommentPrivacyUiState;
  displayLanguage: CommentDisplayLanguage;
  anonymousScope: string;
}>(), {
  authorMode: 'anonymous',
  publicSendConfirmed: false,
  anonymousCommentsEnabled: true,
  publicCommentsEnabled: true,
  zkAnonymousEnabled: false,
  articleId: null,
  accountId: null,
  commentMaxChars: 1000,
  commentMaxUtf8Bytes: 4096,
  policySnapshotHash: '',
  privacyState: 'publicOnly',
  displayLanguage: 'zh-CN',
  anonymousScope: ''
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'update:authorMode', value: CommentAuthorMode): void;
  (e: 'update:publicSendConfirmed', value: boolean): void;
  (e: 'update:displayLanguage', value: CommentDisplayLanguage): void;
  (e: 'submit'): void;
  (e: 'cancel-reply'): void;
  (e: 'privacy-intent'): void;
}>()

const composerShell = ref<HTMLElement | null>(null)
const editorInputRef = ref<ElInputExpose | null>(null)
const focusEditorInputRef = ref<ElInputExpose | null>(null)
const commentComposerMode = ref<CommentComposerMode>('write')
const focusModeVisible = ref(false)
const localDraft = ref<CommentDraftSnapshot | null>(null)
const restoredDraftVisible = ref(false)
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let privacyObserver: IntersectionObserver | null = null

const commentComposerModeOptions: ReadonlyArray<{ value: CommentComposerMode; label: string }> = [
  { value: 'write', label: '编写' },
  { value: 'preview', label: '预览' }
]

const contentModel = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const commentPolicy = computed(() => normalizeCommentContentPolicy({
  maxChars: props.commentMaxChars,
  maxUtf8Bytes: props.commentMaxUtf8Bytes
}))

const commentCharCount = computed(() => contentModel.value.trim().length)
const commentUtf8Bytes = computed(() => getCommentUtf8ByteLength(contentModel.value.trim()))
const commentLimitWarning = computed(() =>
  commentCharCount.value > commentPolicy.value.maxChars ||
  commentUtf8Bytes.value > commentPolicy.value.maxUtf8Bytes ||
  commentCharCount.value / commentPolicy.value.maxChars >= 0.9 ||
  commentUtf8Bytes.value / commentPolicy.value.maxUtf8Bytes >= 0.9
)

const effectiveAnonymousCommentsEnabled = computed(() => props.anonymousCommentsEnabled)

const anonymousStatusText = computed(() => '匿名发布')

const anonymousUnavailableMessage = computed(() => !effectiveAnonymousCommentsEnabled.value && props.publicCommentsEnabled)

const authorModeModel = computed<CommentAuthorMode>(() => {
  if (props.authorMode === 'public') {
    return 'public'
  }
  if (props.authorMode === 'zk_anonymous' && props.zkAnonymousEnabled) {
    return 'zk_anonymous'
  }
  return effectiveAnonymousCommentsEnabled.value ? 'anonymous' : 'public'
})

const publicIdentityModel = computed({
  get: () => authorModeModel.value === 'public' && props.publicSendConfirmed,
  set: (value: boolean) => {
    if (value && !props.publicCommentsEnabled) {
      return
    }
    emit('update:authorMode', value ? 'public' : 'anonymous')
    emit('update:publicSendConfirmed', value)
  }
})

const publicIdentityDisabled = computed(() =>
  props.isBanned || props.isPowCalculating || props.isSubmitting || !props.publicCommentsEnabled
)

const composerUi = computed(() =>
  createCommentComposerUiContract(props.redirectPath, {
    isBanned: props.isBanned,
    isPowCalculating: props.isPowCalculating,
    isSubmitting: props.isSubmitting,
    hasContent: Boolean(contentModel.value.trim()),
    authorMode: authorModeModel.value,
    publicSendConfirmed: publicIdentityModel.value,
    anonymousCommentsEnabled: effectiveAnonymousCommentsEnabled.value,
    publicCommentsEnabled: props.publicCommentsEnabled,
    zkAnonymousEnabled: props.zkAnonymousEnabled
  })
)

const markdownInspection = computed(() => inspectCommentMarkdownContent(contentModel.value))
const markdownValidation = computed(() => {
  const contentValidation = validateCommentContent(contentModel.value, commentPolicy.value)
  return contentValidation.isValid ? markdownInspection.value : contentValidation
})
const markdownFeedbackText = computed(() =>
  contentModel.value.trim() && !markdownValidation.value.isValid
    ? markdownValidation.value.message
    : ''
)

const composerInputDisabled = computed(() =>
  props.isBanned ||
  props.isPowCalculating ||
  props.isSubmitting ||
  (authorModeModel.value === 'anonymous' && !effectiveAnonymousCommentsEnabled.value) ||
  (authorModeModel.value === 'public' && !props.publicCommentsEnabled) ||
  (authorModeModel.value === 'zk_anonymous' && !props.zkAnonymousEnabled)
)

const submitDisabled = computed(() => composerUi.value.disabled || !markdownValidation.value.isValid)

const requestSubmit = (): void => {
  if (!markdownValidation.value.isValid) {
    commentComposerMode.value = 'write'
    void focusEditorAfterSubmit()
    return
  }
  if (!submitDisabled.value) {
    emit('submit')
  }
}

const focusEditorAfterSubmit = async (): Promise<void> => {
  await nextTick()
  editorInputRef.value?.focus?.()
}

const focusFocusModeEditor = async (): Promise<void> => {
  await nextTick()
  focusEditorInputRef.value?.focus?.()
}

const openFocusMode = (): void => {
  focusModeVisible.value = true
  void focusFocusModeEditor()
}

const closeFocusMode = (): void => {
  focusModeVisible.value = false
  void focusEditorAfterSubmit()
}

const notifyPrivacyIntent = (): void => {
  if (props.isLoggedIn && effectiveAnonymousCommentsEnabled.value) {
    emit('privacy-intent')
  }
}

onMounted(() => {
  restoreCommentDraft()
  if (typeof IntersectionObserver === 'undefined') {
    queueMicrotask(notifyPrivacyIntent)
    return
  }

  privacyObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      notifyPrivacyIntent()
      privacyObserver?.disconnect()
      privacyObserver = null
    }
  })
  if (composerShell.value) {
    privacyObserver.observe(composerShell.value)
  }
})

onBeforeUnmount(() => {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  saveCommentDraft()
  privacyObserver?.disconnect()
  privacyObserver = null
})

watch(() => props.isSubmitting, (isSubmitting, wasSubmitting) => {
  if (wasSubmitting && !isSubmitting) {
    commentComposerMode.value = 'write'
    void focusEditorAfterSubmit()
  }
})

const placeholderText = computed(() =>
  props.replyTarget
    ? `回复 @${props.replyTarget.author.displayName} (Ctrl + Enter 发送)`
    : composerUi.value.placeholder
)

const draftStorageKey = computed(() => {
  if (!props.articleId) {
    return ''
  }
  const accountKey = props.accountId === null ? 'guest' : String(props.accountId)
  const replyKey = props.replyTarget?.id ?? 'root'
  return `fsus:comment-draft:v1:${accountKey}:${props.articleId}:${replyKey}`
})

const draftSavedAtText = computed(() => {
  const savedAt = localDraft.value?.savedAt
  return savedAt ? new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
})

const restoreCommentDraft = (): void => {
  const key = draftStorageKey.value
  if (!key || typeof window === 'undefined') {
    return
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      localDraft.value = null
      restoredDraftVisible.value = false
      return
    }

    const draft = JSON.parse(raw) as CommentDraftSnapshot
    if (!draft?.content?.trim()) {
      return
    }

    localDraft.value = draft
    if (!contentModel.value.trim()) {
      emit('update:modelValue', draft.content)
      emit('update:authorMode', draft.authorMode)
      emit('update:publicSendConfirmed', draft.publicSendConfirmed)
      restoredDraftVisible.value = true
    }
  } catch {
    localDraft.value = null
    restoredDraftVisible.value = false
  }
}

const removeCommentDraft = (): void => {
  const key = draftStorageKey.value
  if (!key || typeof window === 'undefined') {
    localDraft.value = null
    restoredDraftVisible.value = false
    return
  }

  try {
    window.localStorage.removeItem(key)
  } catch {
    // Local draft persistence is best-effort.
  }
  localDraft.value = null
  restoredDraftVisible.value = false
}

const saveCommentDraft = (): void => {
  const key = draftStorageKey.value
  if (!key || typeof window === 'undefined') {
    return
  }

  const content = contentModel.value
  if (!content.trim()) {
    removeCommentDraft()
    return
  }

  const draft: CommentDraftSnapshot = {
    content,
    authorMode: authorModeModel.value,
    publicSendConfirmed: publicIdentityModel.value,
    savedAt: Date.now(),
    policyHash: props.policySnapshotHash
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(draft))
    localDraft.value = draft
  } catch {
    // Local draft persistence is best-effort.
  }
}

const scheduleSaveCommentDraft = (): void => {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer)
  }
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null
    saveCommentDraft()
  }, 700)
}

const discardCommentDraft = (): void => {
  const draftContent = localDraft.value?.content ?? ''
  removeCommentDraft()
  if (contentModel.value === draftContent) {
    emit('update:modelValue', '')
  }
  void focusEditorAfterSubmit()
}

watch(
  () => draftStorageKey.value,
  () => restoreCommentDraft()
)

watch(
  () => [
    contentModel.value,
    authorModeModel.value,
    publicIdentityModel.value,
    props.policySnapshotHash
  ],
  () => scheduleSaveCommentDraft()
)

watch(() => contentModel.value, (value) => {
  if (!value.trim()) {
    removeCommentDraft()
  }
})
</script>

<style scoped>
.comment-identity-panel {
  margin-bottom: 0.875rem;
  border: 1px solid color-mix(in srgb, var(--fsusblog-panel-border) 82%, transparent);
  border-radius: 0.5rem;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--fsusblog-panel-bg) 96%, transparent), var(--fsusblog-panel-bg));
  padding: 0.875rem 1rem;
}

.comment-identity-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.comment-identity-copy {
  min-width: 0;
}

.comment-identity-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.comment-identity-label {
  color: var(--fsusblog-text-primary);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.35;
}

.comment-identity-badge {
  display: inline-flex;
  min-height: 1.5rem;
  align-items: center;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 0.5rem;
  font-size: 0.6875rem;
  font-weight: 650;
  line-height: 1;
}

.comment-identity-badge--ready {
  border-color: color-mix(in srgb, var(--fsusblog-color-primary) 18%, transparent);
  color: var(--fsusblog-color-primary);
  background: color-mix(in srgb, var(--fsusblog-color-primary) 6%, transparent);
}

.comment-identity-badge--muted {
  border-color: color-mix(in srgb, var(--fsusblog-text-muted) 20%, transparent);
  color: var(--fsusblog-text-muted);
  background: color-mix(in srgb, var(--fsusblog-text-muted) 7%, transparent);
}

.comment-identity-hint {
  margin: 0.375rem 0 0;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.comment-identity-toggle {
  min-height: 2rem;
  flex: 0 0 auto;
  margin-right: -0.125rem;
}

.comment-identity-toggle :deep(.el-checkbox__label) {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  font-weight: 650;
  line-height: 1.35;
  padding-left: 0.5rem;
}

.comment-identity-toggle :deep(.el-checkbox__input.is-disabled + .el-checkbox__label) {
  color: color-mix(in srgb, var(--fsusblog-text-muted) 88%, transparent);
}

.comment-composer-editor {
  display: grid;
  gap: 0.625rem;
}

.comment-composer-draft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--fsusblog-color-primary) 18%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--fsusblog-color-primary) 6%, transparent);
  padding: 0.625rem 0.75rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.75rem;
  font-weight: 650;
}

.comment-composer-draft button {
  border: 0;
  background: transparent;
  color: var(--fsusblog-color-primary);
  cursor: pointer;
  font: inherit;
  padding: 0;
}

.comment-composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
}

.comment-composer-mode {
  display: inline-flex;
  width: max-content;
  max-width: 100%;
  align-items: center;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--fsusblog-panel-bg) 92%, transparent);
  padding: 0.1875rem;
}

.comment-composer-mode__item {
  min-height: 2rem;
  border: 0;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--fsusblog-text-muted);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1;
  padding: 0 0.75rem;
}

.comment-composer-mode__item.is-active {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
  box-shadow: 0 1px 4px color-mix(in srgb, #000 8%, transparent);
}

.comment-composer-mode__item:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--fsusblog-color-primary) 62%, transparent);
  outline-offset: 2px;
}

.comment-composer-focus {
  flex: 0 0 auto;
  min-height: 2rem;
  font-size: 0.8125rem;
  font-weight: 700;
}

.comment-composer-preview {
  min-height: 5.875rem;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: 0.5rem;
  background: var(--fsusblog-panel-bg);
  padding: 0.875rem 1rem;
}

.comment-composer-preview.is-empty {
  display: flex;
  align-items: center;
  color: var(--fsusblog-text-muted);
  font-size: 0.875rem;
  font-weight: 650;
}

.comment-composer-feedback {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 0.8125rem;
  font-weight: 650;
  line-height: 1.5;
}

.comment-composer-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem 0.875rem;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  line-height: 1.4;
}

.comment-composer-metrics.is-warning {
  color: var(--el-color-warning);
}

.comment-composer-focus__body {
  display: grid;
  gap: 0.75rem;
}

.comment-composer-focus__body :deep(.el-textarea__inner) {
  min-height: min(52vh, 26rem) !important;
}

.comment-composer-focus__preview {
  min-height: min(52vh, 26rem);
  overflow: auto;
}

.comment-composer-focus__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
}

.comment-composer-focus__footer .comment-composer-metrics {
  margin-right: auto;
}

@media (max-width: 520px) {
  .comment-identity-panel {
    padding: 0.8125rem 0.875rem;
  }

  .comment-identity-summary {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.625rem;
  }

  .comment-identity-toggle {
    margin-right: 0;
  }

  .comment-composer-toolbar,
  .comment-composer-focus__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .comment-composer-focus__footer .comment-composer-metrics {
    margin-right: 0;
  }
}
</style>
