<template>
  <div :class="themeTokens.primitives.emptyRoot">
    <p :class="themeTokens.primitives.emptyTitle">数据加载异常</p>
    <UiButton
      class="mt-4"
      :contract="{ label: '重试', variant: 'plain' }"
      @click="$emit('retry')"
    />
  </div>
</template>

<script setup lang="ts">
import UiButton from '@/ui-adapters/element-plus/UiButton.vue';
import { themeTokens } from '@/ui-tokens/themeTokens';

defineEmits<{
  (e: 'retry'): void;
}>();
</script>
