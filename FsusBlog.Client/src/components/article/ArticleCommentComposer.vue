<template>
  <div v-if="isLoggedIn" :class="commentDetailTokens.composer.loggedInShell">
    <div v-if="replyTarget" class="mb-3 flex items-center justify-between border border-[#E4E4E7] bg-[#FCFCFC] px-3 py-2 text-xs text-[#71717A]">
      <span>正在回复 @{{ replyTarget.userName }}</span>
      <button
        type="button"
        class="rounded-[8px] font-bold text-[#8E8E93] hover:text-[#2A599C] uppercase outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
        @click="$emit('cancel-reply')"
      >
        取消
      </button>
    </div>
    <textarea
      v-model="contentModel"
      rows="3"
      aria-label="发表评论"
      :placeholder="placeholderText"
      :class="[commentDetailTokens.composer.textarea, composerUi.disabledClass]"
      :disabled="composerUi.disabled"
      @keydown.ctrl.enter="$emit('submit')"
      @keydown.meta.enter="$emit('submit')"
    ></textarea>
    <div :class="commentDetailTokens.composer.submitWrap">
      <button
        type="button"
        @click="$emit('submit')"
        :disabled="composerUi.disabled"
        :aria-disabled="composerUi.disabled"
        :class="commentDetailTokens.composer.submitButton"
      >
        {{ composerUi.submitBusyText }}
      </button>
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
