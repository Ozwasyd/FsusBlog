<template>
    <PublicContentState
        title="文章列表暂时无法加载"
        description="请稍后重试。"
        tone="error"
        role="alert"
    >
        <ElButton
            type="primary"
            @click="$emit('retry')"
        >重试</ElButton>
    </PublicContentState>
</template>

<script setup lang="ts">
import PublicContentState from '@/components/public/PublicContentState.vue';

defineEmits<(e: 'retry') => void>();
</script>
