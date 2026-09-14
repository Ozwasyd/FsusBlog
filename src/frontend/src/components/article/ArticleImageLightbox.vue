<template>
    <Teleport to="body">
        <FsuTransition :name="fsusBlogMotionPresets.mediaOverlay">
            <FsusUiOverlay
                v-if="open && activeImage"
                :z-index="1000"
                mask
                @click="emit('close')"
            >
                <div
                    ref="dialogRef"
                    class="article-image-lightbox"
                    data-article-lightbox="true"
                    data-fsus-material="glass"
                    role="dialog"
                    aria-modal="true"
                    :aria-label="messages.article.actions.viewImage"
                    tabindex="-1"
                    @keydown.esc.prevent="emit('close')"
                >
                    <button
                        type="button"
                        class="article-image-lightbox__close"
                        :aria-label="messages.article.actions.closeImage"
                        @click="emit('close')"
                    >
                        {{ messages.common.actions.close }}
                    </button>

                    <button
                        v-if="images.length > 1"
                        type="button"
                        class="article-image-lightbox__nav article-image-lightbox__nav--prev"
                        :aria-label="messages.article.actions.previousImage"
                        @click.stop="emit('previous')"
                    >
                        {{ messages.article.actions.previousImage }}
                    </button>

                    <figure class="article-image-lightbox__figure">
                        <img
                            :src="activeImage.src"
                            :alt="activeImage.alt"
                        />
                        <figcaption v-if="activeImage.alt">
                            {{ activeImage.alt }}
                        </figcaption>
                    </figure>

                    <button
                        v-if="images.length > 1"
                        type="button"
                        class="article-image-lightbox__nav article-image-lightbox__nav--next"
                        :aria-label="messages.article.actions.nextImage"
                        @click.stop="emit('next')"
                    >
                        {{ messages.article.actions.nextImage }}
                    </button>
                </div>
            </FsusUiOverlay>
        </FsuTransition>
    </Teleport>
</template>

<script setup lang="ts">
import { FsuTransition } from '@ozwasyd/element-plus/motion';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

import type { ArticleLightboxImage } from '@/composables/article/useArticleImageLightbox';
import { useI18nText } from '@/composables/useI18nText';
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion';
import { FsusUiOverlay } from '@/fsusui/overlay';

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
const dialogRef = ref<HTMLElement | null>(null);

watch(() => props.open, (open) =>
{
    if (typeof document === 'undefined')
    {
        return;
    }
    document.body.classList.toggle('article-image-lightbox-open', open);
    if (open)
    {
        void nextTick(() =>
        {
            dialogRef.value?.focus();
        });
    }
}, { immediate: true });

onUnmounted(() =>
{
    if (typeof document === 'undefined')
    {
        return;
    }
    document.body.classList.remove('article-image-lightbox-open');
});
</script>

<style scoped>
.article-image-lightbox
 {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    min-height: var(--fsus-viewport-block-size);
    display: grid;
    place-items: center;
    padding:
        max(1.5rem, var(--fsus-safe-area-inset-top))
        max(1.5rem, var(--fsus-safe-area-inset-right))
        max(1.5rem, var(--fsus-safe-area-inset-bottom))
        max(1.5rem, var(--fsus-safe-area-inset-left));
}

.article-image-lightbox__figure
 {
    display: grid;
    gap: 0.75rem;
    max-width: min(92vw, 72rem);
    max-height: calc(
        var(--fsus-viewport-block-size)
        - max(1.5rem, var(--fsus-safe-area-inset-top))
        - max(1.5rem, var(--fsus-safe-area-inset-bottom))
        - 3rem
    );
    margin: 0;
    color: white;
    text-align: center;
}

.article-image-lightbox__figure img
 {
    max-width: 100%;
    max-height: calc(
        var(--fsus-viewport-block-size)
        - max(1.5rem, var(--fsus-safe-area-inset-top))
        - max(1.5rem, var(--fsus-safe-area-inset-bottom))
        - 5rem
    );
    object-fit: contain;
}

.article-image-lightbox__figure figcaption
 {
    color: var(--fsusblog-overlay-button-fg);
    font-size: 14px;
}

.article-image-lightbox__close,
.article-image-lightbox__nav
 {
    position: absolute;
    z-index: 1;
    min-height: 2.75rem;
    border: 1px solid var(--fsusblog-overlay-button-border);
    background: var(--fsusblog-overlay-button-bg);
    color: var(--fsusblog-overlay-button-fg);
    padding: 0 0.875rem;
    font-size: 12px;
}

.article-image-lightbox__close
 {
    top: max(1rem, var(--fsus-safe-area-inset-top));
    right: max(1rem, var(--fsus-safe-area-inset-right));
}

.article-image-lightbox__nav--prev
 {
    left: max(1rem, var(--fsus-safe-area-inset-left));
    top: 50%;
    margin-top: -1.375rem;
}

.article-image-lightbox__nav--next
 {
    right: max(1rem, var(--fsus-safe-area-inset-right));
    top: 50%;
    margin-top: -1.375rem;
}
</style>

<style>
body.article-image-lightbox-open
 {
    overflow: hidden;
}
</style>
