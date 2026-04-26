<template>
  <div :class="`${themeTokens.primitives.emptyRoot} grow flex flex-col items-center justify-center py-24 sm:py-32`">
    <p :class="`${themeTokens.primitives.emptyTitle} mb-6`">{{ view.title }}</p>
    <UiButton
      :label="view.retryText"
      variant="plain"
      @click="$emit('retry')"
    />
  </div>
</template>

<script setup lang="ts">
import { UiButton } from '@/components/ui';
import type { ArticleDetailErrorStateViewContract } from '@/view-contracts/articleDetail';
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  view: ArticleDetailErrorStateViewContract;
}>();

defineEmits<{
  (e: 'retry'): void;
}>();
</script>
