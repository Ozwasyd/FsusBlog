<template>
    <ElImageViewer
        v-if="open && activeImage"
        data-article-lightbox="true"
        :url-list="images.map(image => image.src)"
        :alt-list="images.map(image => image.alt)"
        :active-index="activeIndex"
        :initial-index="activeIndex"
        :aria-label="messages.article.actions.viewImage"
        :labels="{
            close: messages.article.actions.closeImage,
            previous: messages.article.actions.previousImage,
            next: messages.article.actions.nextImage
        }"
        :show-toolbar="false"
        csp-safe
        hide-on-click-modal
        @close="emit('close')"
        @next="emit('next')"
        @previous="emit('previous')"
    >
        <template #caption="{ alt }">
            <p
                v-if="alt"
                class="article-image-lightbox-caption"
                data-article-lightbox-caption
            >
                {{ alt }}
            </p>
        </template>
    </ElImageViewer>
</template>

<script setup lang="ts">
import { ElImageViewer } from '@ozwasyd/element-plus';
import { computed } from 'vue';

import type { ArticleLightboxImage } from '@/composables/article/useArticleImageLightbox';
import { useI18nText } from '@/composables/useI18nText';

const props = defineProps<{
    open: boolean;
    images: ArticleLightboxImage[];
    activeIndex: number;
}>();

const { messages } = useI18nText();
const emit = defineEmits<{
    (event: 'close'): void;
    (event: 'next'): void;
    (event: 'previous'): void;
}>();
const activeImage = computed(() => props.images[props.activeIndex] ?? null);
</script>

<style scoped>
.article-image-lightbox-caption
 {
    margin: 0;
    color: var(--fsusblog-overlay-button-fg);
    font-size: 14px;
}
</style>
