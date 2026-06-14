<template>
  <el-empty description="文章列表没取回来">
    <el-button type="primary" @click="$emit('retry')">重试一次</el-button>
  </el-empty>
</template>

<script setup lang="ts">
defineEmits<{
  (e: 'retry'): void;
}>();
</script>
