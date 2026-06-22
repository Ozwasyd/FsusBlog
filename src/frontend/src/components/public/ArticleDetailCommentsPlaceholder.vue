<template>
  <p
    :class="themeTokens.articleDetail.commentsPlaceholderRoot"
    role="status"
    aria-live="polite"
    data-fsus-surface="reading"
  >
    <span
      :class="themeTokens.articleDetail.commentsPlaceholderDot"
      aria-hidden="true"
    ></span>
    <span>{{ text }}</span>
  </p>
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens';

defineProps<{ text: string }>();
</script>
