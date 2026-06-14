<template>
  <PublicContentState
    title="文章列表暂时无法加载"
    description="请稍后重试。"
    tone="error"
    role="alert"
  >
    <el-button type="primary" @click="$emit('retry')">重试</el-button>
  </PublicContentState>
</template>

<script setup lang="ts">
import PublicContentState from '@/components/public/PublicContentState.vue'

defineEmits<{
  (e: 'retry'): void;
}>();
</script>
