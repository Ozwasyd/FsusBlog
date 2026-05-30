<template>
  <div class="border-t border-[var(--fsusblog-panel-border)] mt-8 py-12">
    <el-empty description="无法获取你的评论历史，请检查网络连接。">
      <el-button type="primary" @click="$emit('retry')">重试</el-button>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
defineEmits<{
  (e: 'retry'): void;
}>();
</script>
