<template>
  <Teleport to="body">
    <FsuTransition :name="fsusBlogMotionPresets.mediaOverlay">
      <div
        v-if="open && activeImage"
        ref="dialogRef"
        class="article-image-lightbox"
        data-article-lightbox="true"
        data-fsus-material="glass"
        role="dialog"
        aria-modal="true"
        aria-label="查看大图"
        tabindex="-1"
        @click.self="emit('close')"
        @keydown.esc.prevent="emit('close')"
      >
        <button
          type="button"
          class="article-image-lightbox__close"
          aria-label="关闭大图"
          @click="emit('close')"
        >
          关闭
        </button>

        <button
          v-if="images.length > 1"
          type="button"
          class="article-image-lightbox__nav article-image-lightbox__nav--prev"
          aria-label="上一张图片"
          @click.stop="emit('previous')"
        >
          上一张
        </button>

        <figure class="article-image-lightbox__figure">
          <img :src="activeImage.src" :alt="activeImage.alt" />
          <figcaption v-if="activeImage.alt">
            {{ activeImage.alt }}
          </figcaption>
        </figure>

        <button
          v-if="images.length > 1"
          type="button"
          class="article-image-lightbox__nav article-image-lightbox__nav--next"
          aria-label="下一张图片"
          @click.stop="emit('next')"
        >
          下一张
        </button>
      </div>
    </FsuTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { ArticleLightboxImage } from '@/composables/article/useArticleImageLightbox'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'
import { FsuTransition } from '@ozwasyd/element-plus/motion'

const props = defineProps<{
  open: boolean
  images: ArticleLightboxImage[]
  activeIndex: number
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'next'): void
  (event: 'previous'): void
}>()

const activeImage = computed(() => props.images[props.activeIndex] ?? null)
const dialogRef = ref<HTMLElement | null>(null)

watch(() => props.open, (open) => {
  if (typeof document === 'undefined') {
    return
  }
  document.body.classList.toggle('article-image-lightbox-open', open)
  if (open) {
    void nextTick(() => {
      dialogRef.value?.focus()
    })
  }
}, { immediate: true })

onUnmounted(() => {
  if (typeof document === 'undefined') {
    return
  }
  document.body.classList.remove('article-image-lightbox-open')
})
</script>

<style scoped>
.article-image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: var(--fsusblog-overlay-scrim);
  padding: 1.5rem;
}

.article-image-lightbox__figure {
  display: grid;
  gap: 0.75rem;
  max-width: min(92vw, 72rem);
  max-height: 88vh;
  margin: 0;
  color: white;
  text-align: center;
}

.article-image-lightbox__figure img {
  max-width: 100%;
  max-height: 80vh;
  object-fit: contain;
}

.article-image-lightbox__figure figcaption {
  color: var(--fsusblog-overlay-button-fg);
  font-size: 0.8125rem;
}

.article-image-lightbox__close,
.article-image-lightbox__nav {
  position: fixed;
  min-height: 2.5rem;
  border: 1px solid var(--fsusblog-overlay-button-border);
  background: var(--fsusblog-overlay-button-bg);
  color: var(--fsusblog-overlay-button-fg);
  padding: 0 0.875rem;
  font-size: 0.75rem;
}

.article-image-lightbox__close {
  top: 1rem;
  right: 1rem;
}

.article-image-lightbox__nav--prev {
  left: 1rem;
}

.article-image-lightbox__nav--next {
  right: 1rem;
}

</style>

<style>
body.article-image-lightbox-open {
  overflow: hidden;
}
</style>
