<template>
  <div :class="themeTokens.articleDetail.commentsPlaceholderRoot" aria-hidden="true" />
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  title: string;
  body: string;
  hint: string;
}>();
</script>
