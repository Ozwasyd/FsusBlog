<template>
  <UiEmptyState :contract="{ title: '没有找到文章。' }" />
</template>

<script setup lang="ts">
import UiEmptyState from '@/ui-adapters/element-plus/UiEmptyState.vue';
</script>
