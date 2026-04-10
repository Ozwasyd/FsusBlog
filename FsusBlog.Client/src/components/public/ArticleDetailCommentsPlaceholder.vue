<template>
  <div :class="themeTokens.articleDetail.commentsPlaceholderRoot">
    <p :class="themeTokens.articleDetail.commentsPlaceholderTitle">
      {{ title }}
    </p>
    <p :class="themeTokens.articleDetail.commentsPlaceholderBody">
      {{ body }}
    </p>
    <div class="mt-4 inline-flex items-center gap-2 text-zinc-400" aria-hidden="true">
      <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse"></span>
      <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:120ms]"></span>
      <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:240ms]"></span>
    </div>
    <p :class="themeTokens.articleDetail.commentsPlaceholderHint">
      {{ hint }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  title: string;
  body: string;
  hint: string;
}>();
</script>
