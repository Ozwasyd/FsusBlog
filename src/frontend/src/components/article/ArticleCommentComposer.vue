<template>
  <div v-if="isLoggedIn" :class="commentDetailTokens.composer.loggedInShell">
    <div v-if="replyTarget" class="mb-3 flex items-center justify-between border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-3 py-2 text-xs text-[var(--fsusblog-text-tertiary)]">
      <span>正在回复 @{{ replyTarget.userName }}</span>
      <el-button
        link
        @click="$emit('cancel-reply')"
      >
        取消
      </el-button>
    </div>
    <el-input
      v-model="contentModel"
      type="textarea"
      :rows="3"
      resize="none"
      aria-label="发表评论"
      :placeholder="placeholderText"
      :disabled="composerUi.disabled"
      @keydown.ctrl.enter="$emit('submit')"
      @keydown.meta.enter="$emit('submit')"
    />
    <div :class="commentDetailTokens.composer.submitWrap">
      <el-button
        type="primary"
        @click="$emit('submit')"
        :disabled="composerUi.disabled"
        :aria-disabled="composerUi.disabled"
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
import {
  commentDetailTokens,
  createCommentComposerUiContract
} from '@/view-contracts/commentDetail'

const props = defineProps<{
  modelValue: string;
  isLoggedIn: boolean;
  isBanned: boolean;
  isPowCalculating: boolean;
  isSubmitting: boolean;
  redirectPath: string;
  replyTarget: { id: string; rootId: string; userName: string; depth: number } | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'submit'): void;
  (e: 'cancel-reply'): void;
}>()

const contentModel = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const composerUi = computed(() =>
  createCommentComposerUiContract(props.redirectPath, {
    isBanned: props.isBanned,
    isPowCalculating: props.isPowCalculating,
    isSubmitting: props.isSubmitting,
    hasContent: Boolean(contentModel.value.trim())
  })
)

const placeholderText = computed(() =>
  props.replyTarget
    ? `回复 @${props.replyTarget.userName} (Ctrl + Enter 发送)`
    : composerUi.value.placeholder
)
</script>
