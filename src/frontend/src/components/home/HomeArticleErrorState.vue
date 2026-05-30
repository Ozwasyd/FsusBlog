<template>
  <el-empty description="数据加载异常">
    <el-button type="primary" @click="$emit('retry')">重试</el-button>
  </el-empty>
</template>

<script setup lang="ts">
defineEmits<{
  (e: 'retry'): void;
}>();
</script>
