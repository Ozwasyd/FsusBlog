<template>
  <div :class="`${themeTokens.primitives.emptyRoot} grow flex flex-col items-center justify-center py-32`">
    <p :class="`${themeTokens.primitives.emptyTitle} mb-6`">{{ view.title }}</p>
    <router-link
      :to="view.actionHref"
      :class="themeTokens.primitives.buttonPlain"
    >
      {{ view.actionText }}
    </router-link>
  </div>
</template>

<script setup lang="ts">
import type { ArticleDetailNotFoundStateViewContract } from '@/view-contracts/articleDetail';
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  view: ArticleDetailNotFoundStateViewContract;
}>();
</script>
