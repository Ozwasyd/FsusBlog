<template>
  <div :class="themeTokens.primitives.emptyRoot">
    <p :class="themeTokens.primitives.emptyTitle">{{ title }}</p>
    <p v-if="body" :class="themeTokens.primitives.emptyBody">{{ body }}</p>
    <div v-if="$slots.action" class="mt-5">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens/themeTokens';

defineProps<{
  title: string;
  body?: string;
}>();
</script>
