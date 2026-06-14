<template>
  <header class="account-page-header" :class="{ 'account-page-header--compact': compact }">
    <div v-if="eyebrow" class="account-page-eyebrow">{{ eyebrow }}</div>
    <h1 class="account-page-title">{{ title }}</h1>
    <p v-if="description || $slots.default" class="account-page-description">
      <slot>{{ description }}</slot>
    </p>
  </header>
</template>

<script setup lang="ts">
// Eyebrow is a rare opt-in context marker, not the default admin page grammar.
withDefaults(defineProps<{
  eyebrow?: string
  title: string
  description?: string
  compact?: boolean
}>(), {
  eyebrow: '',
  description: '',
  compact: false
})
</script>
