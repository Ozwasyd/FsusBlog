<template>
  <div class="user-comments-empty-state" role="status" aria-live="polite">
    <p class="user-comments-empty-state__title">{{ title }}</p>
    <p v-if="description" class="user-comments-empty-state__description">{{ description }}</p>
    <div v-if="$slots.actions" class="user-comments-empty-state__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<style scoped>
.user-comments-empty-state {
  margin-top: 2rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 2rem 0;
}

.user-comments-empty-state__title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.5;
}

.user-comments-empty-state__description {
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.user-comments-empty-state__actions {
  margin-top: 1rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
</style>
