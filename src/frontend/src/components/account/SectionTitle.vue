<template>
  <div class="account-section-title-block">
    <div v-if="props.eyebrow" class="account-section-eyebrow">{{ props.eyebrow }}</div>
    <component :is="headingTag" :id="props.id" class="account-section-heading" :class="props.headingClass">
      <slot name="title">{{ props.title }}</slot>
    </component>
    <p v-if="props.caption || $slots.caption" class="account-section-description" :class="props.captionClass">
      <slot name="caption">{{ props.caption }}</slot>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  id?: string
  eyebrow?: string
  title: string
  caption?: string
  level?: 2 | 3 | 4
  headingClass?: string
  captionClass?: string
}>(), {
  id: undefined,
  eyebrow: '',
  caption: '',
  level: 2,
  headingClass: '',
  captionClass: ''
})

const headingTag = computed(() => `h${props.level}`)
</script>
