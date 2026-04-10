<template>
  <div :class="`${themeTokens.primitives.emptyRoot} grow flex flex-col items-center justify-center py-32`">
    <p :class="`${themeTokens.primitives.emptyTitle} mb-6`">{{ view.title }}</p>
    <button
      type="button"
      :class="themeTokens.primitives.buttonPlain"
      @click="$emit('retry')"
    >
      {{ view.retryText }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ArticleDetailErrorStateViewContract } from '@/view-contracts/articleDetail';
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  view: ArticleDetailErrorStateViewContract;
}>();

defineEmits<{
  (e: 'retry'): void;
}>();
</script>
