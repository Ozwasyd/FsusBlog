<template>
  <component
    :is="as"
    class="blog-page-shell public-reading-page-frame"
    :class="[
      `public-reading-page-frame--${width}`,
      align === 'center' ? 'public-reading-page-frame--center' : ''
    ]"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  as?: 'article' | 'section' | 'div'
  width?: 'reading' | 'wide'
  align?: 'start' | 'center'
}>(), {
  as: 'section',
  width: 'reading',
  align: 'start'
})
</script>

<style scoped>
.public-reading-page-frame {
  display: flex;
  width: 100%;
  max-width: 48rem;
  min-height: clamp(24rem, 48vh, 34rem);
  margin-inline: auto;
  padding-inline: 0;
  flex-direction: column;
}

.public-reading-page-frame--wide {
  max-width: 64rem;
}

.public-reading-page-frame--center {
  justify-content: center;
}

</style>
