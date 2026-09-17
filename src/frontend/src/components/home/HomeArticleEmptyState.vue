<template>
    <PublicContentState
        title="暂时还没有文章"
        description="发布后的内容会显示在这里。"
    >
        <a
            href="/archive"
            class="inline-flex min-h-9 items-center px-1 text-sm font-bold text-[var(--fsusblog-text-primary)] hover:text-[var(--fsusblog-color-primary)]"
        >
            查看归档
        </a>
    </PublicContentState>
</template>

<script setup lang="ts">
import PublicContentState from '@/components/public/PublicContentState.vue';
</script>
