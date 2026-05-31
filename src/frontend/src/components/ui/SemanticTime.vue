<template>
  <time :datetime="datetime" :title="titleText">
    <slot>{{ displayText }}</slot>
  </time>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  value?: string | number | Date | null
  text?: string
  format?: 'date' | 'datetime'
}>(), {
  value: null,
  text: '',
  format: 'datetime'
})

const parsedDate = computed(() => {
  if (!props.value) {
    return null
  }

  const date = props.value instanceof Date ? props.value : new Date(props.value)
  return Number.isNaN(date.getTime()) ? null : date
})

const datetime = computed(() => parsedDate.value?.toISOString() ?? '')
const titleText = computed(() => parsedDate.value?.toLocaleString() ?? props.text)
const displayText = computed(() => {
  if (props.text) {
    return props.text
  }

  if (!parsedDate.value) {
    return '-'
  }

  return props.format === 'date'
    ? parsedDate.value.toLocaleDateString()
    : parsedDate.value.toLocaleString()
})
</script>
