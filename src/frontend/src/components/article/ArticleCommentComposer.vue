<template>
  <div v-if="isLoggedIn" ref="composerShell" :class="commentDetailTokens.composer.loggedInShell">
    <div v-if="replyTarget" class="mb-3 flex items-center justify-between border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-3 py-2 text-xs text-[var(--fsusblog-text-tertiary)]">
      <span>正在回复 @{{ replyTarget.author.displayName }}</span>
      <el-button
        link
        @click="$emit('cancel-reply')"
      >
        取消
      </el-button>
    </div>

    <div class="mb-3 space-y-2 border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-3 py-3">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="space-y-1">
          <span class="text-xs font-semibold text-[var(--fsusblog-text-secondary)]">评论身份</span>
          <div class="flex flex-wrap items-center gap-2">
            <el-tag v-if="effectiveAnonymousCommentsEnabled" size="small" type="info">{{ anonymousStatusText }}</el-tag>
            <el-tag v-else size="small" type="warning">匿名发布暂不可用</el-tag>
          </div>
        </div>
        <el-checkbox
          v-model="publicIdentityModel"
          :disabled="publicIdentityDisabled"
        >
          公开显示我的名称
        </el-checkbox>
      </div>

      <p v-if="anonymousUnavailableMessage" class="text-xs text-[var(--fsusblog-text-muted)]">
        匿名发布暂不可用，可选择公开署名发布。
      </p>
      <p v-if="publicIdentityModel" class="text-xs text-[var(--fsusblog-text-muted)]">
        公开发布后，其他人会看到你的公开名称。
      </p>
    </div>

    <el-input
      v-model="contentModel"
      type="textarea"
      :rows="3"
      resize="none"
      aria-label="发表评论"
      :placeholder="placeholderText"
      :disabled="composerUi.disabled"
      @focus="notifyPrivacyIntent"
      @keydown.ctrl.enter="requestSubmit"
      @keydown.meta.enter="requestSubmit"
    />
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
  </div>

  <div v-else :class="commentDetailTokens.composer.guestShell">
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CommentAuthorMode, CommentAuthorView, CommentDisplayLanguage } from '@/api/comment'
import type { CommentPrivacyUiState } from '@/privacy/commentPrivacyTypes'
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
  privacyState: CommentPrivacyUiState;
  displayLanguage: CommentDisplayLanguage;
  anonymousScope: string;
}>(), {
  authorMode: 'anonymous',
  publicSendConfirmed: false,
  anonymousCommentsEnabled: true,
  publicCommentsEnabled: true,
  zkAnonymousEnabled: false,
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
let privacyObserver: IntersectionObserver | null = null

const contentModel = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const effectiveAnonymousCommentsEnabled = computed(() =>
  props.anonymousCommentsEnabled && props.privacyState !== 'unavailable'
)

const anonymousStatusText = computed(() =>
  props.privacyState === 'preparing'
    ? '匿名发布准备中'
    : '匿名发布'
)

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

const anonymousTicketPreparing = computed(() =>
  authorModeModel.value === 'anonymous' && props.privacyState === 'preparing'
)

const submitDisabled = computed(() => composerUi.value.disabled || anonymousTicketPreparing.value)

const requestSubmit = (): void => {
  if (!submitDisabled.value) {
    emit('submit')
  }
}

const notifyPrivacyIntent = (): void => {
  if (props.isLoggedIn && effectiveAnonymousCommentsEnabled.value) {
    emit('privacy-intent')
  }
}

onMounted(() => {
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
  privacyObserver?.disconnect()
  privacyObserver = null
})

const placeholderText = computed(() =>
  props.replyTarget
    ? `回复 @${props.replyTarget.author.displayName} (Ctrl + Enter 发送)`
    : composerUi.value.placeholder
)
</script>
