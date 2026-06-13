<template>
  <el-empty description="内容暂时无法载入">
    <el-button type="primary" @click="$emit('retry')">重试</el-button>
  </el-empty>
</template>

<script setup lang="ts">
defineEmits<{
  (e: 'retry'): void;
}>();
</script>
