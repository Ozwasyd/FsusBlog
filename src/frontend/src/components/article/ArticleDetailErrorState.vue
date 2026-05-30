<template>
  <div class="grow flex flex-col items-center justify-center py-24 sm:py-32">
    <el-empty
      :description="view.title"
      description-layout="narrow"
      description-width="18rem"
    >
      <el-button type="primary" @click="$emit('retry')">{{ view.retryText }}</el-button>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
import type { ArticleDetailErrorStateViewContract } from '@/view-contracts/articleDetail';

defineProps<{
  view: ArticleDetailErrorStateViewContract;
}>();

defineEmits<{
  (e: 'retry'): void;
}>();
</script>
