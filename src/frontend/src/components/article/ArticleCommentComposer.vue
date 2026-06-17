<template>
  <div v-if="isLoggedIn" :class="commentDetailTokens.composer.loggedInShell">
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
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span class="text-xs font-semibold text-[var(--fsusblog-text-secondary)]">评论身份</span>
        <el-radio-group
          v-model="authorModeModel"
          aria-label="选择评论身份"
          size="small"
        >
          <el-radio-button label="anonymous" :disabled="anonymousControlsDisabled">匿名优先</el-radio-button>
          <el-radio-button label="public" :disabled="!publicCommentsEnabled">公开发送</el-radio-button>
          <el-radio-button v-if="zkAnonymousEnabled" label="zk_anonymous">强匿名</el-radio-button>
        </el-radio-group>
      </div>

      <p v-if="anonymousControlsDisabled" class="text-xs text-[var(--fsusblog-text-muted)]">
        匿名评论已被管理员关闭，当前只能公开发送。
      </p>

      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <el-checkbox
          v-if="authorModeModel === 'public'"
          v-model="publicSendConfirmedModel"
          :disabled="!publicCommentsEnabled"
        >
          我确认公开发送此评论
        </el-checkbox>

        <el-radio-group
          v-model="displayLanguageModel"
          aria-label="匿名展示语言"
          size="small"
        >
          <el-radio-button label="zh-CN">中文</el-radio-button>
          <el-radio-button label="en">English</el-radio-button>
        </el-radio-group>
      </div>

      <p v-if="authorModeModel === 'zk_anonymous'" class="text-xs text-[var(--fsusblog-text-muted)]">
        强匿名证明按站点策略启用后可用。
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
import { computed } from 'vue'
import type { CommentAuthorMode, CommentAuthorView, CommentDisplayLanguage } from '@/api/comment'
import {
  commentDetailTokens,
  createCommentComposerUiContract
} from '@/view-contracts/commentDetail'

type ReplyTargetView = {
  id: string
  rootId: string
  author: CommentAuthorView
  userName: string
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
  displayLanguage: CommentDisplayLanguage;
  anonymousScope: string;
}>(), {
  authorMode: 'anonymous',
  publicSendConfirmed: false,
  anonymousCommentsEnabled: true,
  publicCommentsEnabled: true,
  zkAnonymousEnabled: false,
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
}>()

const contentModel = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const anonymousControlsDisabled = computed(() => !props.anonymousCommentsEnabled)

const authorModeModel = computed<CommentAuthorMode>({
  get: () => {
    if (props.authorMode === 'anonymous' && !anonymousControlsDisabled.value) {
      return 'anonymous'
    }
    if (props.authorMode === 'zk_anonymous' && props.zkAnonymousEnabled) {
      return 'zk_anonymous'
    }
    return 'public'
  },
  set: (value: CommentAuthorMode) => {
    emit('update:authorMode', value)
    if (value !== 'public') {
      emit('update:publicSendConfirmed', false)
    }
  }
})

const publicSendConfirmedModel = computed({
  get: () => props.publicSendConfirmed,
  set: (value: boolean) => emit('update:publicSendConfirmed', value)
})

const displayLanguageModel = computed<CommentDisplayLanguage>({
  get: () => props.displayLanguage,
  set: (value: CommentDisplayLanguage) => emit('update:displayLanguage', value)
})

const composerUi = computed(() =>
  createCommentComposerUiContract(props.redirectPath, {
    isBanned: props.isBanned,
    isPowCalculating: props.isPowCalculating,
    isSubmitting: props.isSubmitting,
    hasContent: Boolean(contentModel.value.trim()),
    authorMode: authorModeModel.value,
    publicSendConfirmed: publicSendConfirmedModel.value,
    anonymousCommentsEnabled: props.anonymousCommentsEnabled,
    publicCommentsEnabled: props.publicCommentsEnabled,
    zkAnonymousEnabled: props.zkAnonymousEnabled
  })
)

const submitDisabled = computed(() => composerUi.value.disabled)

const requestSubmit = (): void => {
  if (!submitDisabled.value) {
    emit('submit')
  }
}

const placeholderText = computed(() =>
  props.replyTarget
    ? `回复 @${props.replyTarget.author.displayName} (Ctrl + Enter 发送)`
    : composerUi.value.placeholder
)
</script>
