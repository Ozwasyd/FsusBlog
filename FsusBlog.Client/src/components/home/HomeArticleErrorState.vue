<template>
  <div :class="themeTokens.primitives.emptyRoot">
    <p :class="themeTokens.primitives.emptyTitle">数据加载异常</p>
    <UiButton
      class="mt-4"
      label="重试"
      variant="plain"
      @click="$emit('retry')"
    />
  </div>
</template>

<script setup lang="ts">
import { UiButton } from '@/components/ui';
import { themeTokens } from '@/ui-tokens/themeTokens';

defineEmits<{
  (e: 'retry'): void;
}>();
</script>
