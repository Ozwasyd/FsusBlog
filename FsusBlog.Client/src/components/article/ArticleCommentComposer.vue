<template>
  <div v-if="isLoggedIn" :class="commentDetailTokens.composer.loggedInShell">
    <textarea
      v-model="contentModel"
      rows="3"
      aria-label="发表评论"
      :placeholder="composerUi.placeholder"
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
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'submit'): void;
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
</script>
