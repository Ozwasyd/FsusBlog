<template>
  <div :class="`${themeTokens.primitives.emptyRoot} grow flex flex-col items-center justify-center py-24 sm:py-32`">
    <p :class="`${themeTokens.primitives.emptyTitle} mb-6`">{{ view.title }}</p>
    <UiButton
      :to="view.actionHref"
      :label="view.actionText"
      variant="plain"
    />
  </div>
</template>

<script setup lang="ts">
import { UiButton } from '@/components/ui';
import type { ArticleDetailNotFoundStateViewContract } from '@/view-contracts/articleDetail';
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  view: ArticleDetailNotFoundStateViewContract;
}>();
</script>
