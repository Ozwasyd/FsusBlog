<template>
  <div class="user-comments-error-state" role="alert" aria-live="assertive">
    <p class="user-comments-error-state__title">公开评论记录加载失败</p>
    <p class="user-comments-error-state__description">
      当前无法获取你的评论历史，请检查网络连接后重试。
    </p>
    <el-button type="primary" @click="$emit('retry')">重试</el-button>
  </div>
</template>

<script setup lang="ts">
defineEmits<{
  (e: 'retry'): void;
}>();
</script>

<style scoped>
.user-comments-error-state {
  display: grid;
  gap: 0.85rem;
  margin-top: 2rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 2rem 0;
}

.user-comments-error-state__title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.5;
}

.user-comments-error-state__description {
  margin: 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.875rem;
  line-height: 1.7;
}
</style>
