<template>
  <header class="dashboard-section-header">
    <h2 :id="titleId" class="dashboard-section-title">{{ title }}</h2>
    <p v-if="description" class="dashboard-section-description">{{ description }}</p>
    <p v-if="note" class="dashboard-section-note">{{ note }}</p>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  titleId?: string
  description?: string
  note?: string
}>()
</script>

<style scoped>
.dashboard-section-header {
  margin-bottom: 1rem;
}

.dashboard-section-header--flush {
  margin-bottom: 0;
}

.dashboard-section-title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 1.375rem;
  font-weight: 720;
  letter-spacing: 0;
  line-height: 1.24;
}

.dashboard-section-description {
  max-width: 42rem;
  margin: 0.5rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.9375rem;
  line-height: 1.65;
}

.dashboard-section-note {
  max-width: 42rem;
  margin: 0.5rem 0 0;
  color: var(--fsusblog-text-muted);
  font-size: 0.8125rem;
  line-height: 1.6;
}
</style>
