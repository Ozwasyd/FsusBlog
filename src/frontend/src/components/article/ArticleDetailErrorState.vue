<template>
    <div class="grow flex flex-col items-center justify-center py-24 sm:py-32">
        <PublicContentState
            :title="view.title"
            description="请稍后重试。"
            tone="error"
            size="page"
            role="alert"
        >
            <ElButton
                type="primary"
                @click="$emit('retry')"
            >{{ view.retryText }}</ElButton>
        </PublicContentState>
    </div>
</template>

<script setup lang="ts">
import PublicContentState from '@/components/public/PublicContentState.vue';
import type { ArticleDetailErrorStateViewContract } from '@/view-contracts/articleDetail';

defineProps<{
    view: ArticleDetailErrorStateViewContract;
}>();

defineEmits<(e: 'retry') => void>();
</script>
