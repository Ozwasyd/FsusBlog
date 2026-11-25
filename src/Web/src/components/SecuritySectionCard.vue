<script setup lang="ts">
import { computed, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  headingId: string; title: string; description?: string; flush?: boolean; hasBody?: boolean; landmark?: boolean
}>(), { flush: false, hasBody: true, landmark: false })

const slots = useSlots()
const showBody = computed(() => props.hasBody && Boolean(slots.default))
</script>

<template>
  <section class="security-card" :aria-labelledby="landmark ? headingId : undefined">
    <header class="security-card-head">
      <div class="security-card-heading">
        <div class="security-card-title-row">
          <h2 :id="headingId" class="security-card-title">{{ title }}</h2>
          <slot name="badge" />
        </div>
        <p v-if="description || $slots.description" class="security-card-description"><slot name="description">{{ description }}</slot></p>
      </div>
      <div v-if="$slots.actions" class="security-card-actions"><slot name="actions" /></div>
    </header>
    <div v-if="showBody" class="security-card-body" :class="{ 'is-flush': flush }"><slot /></div>
  </section>
</template>

<style scoped>
.security-card { display: grid; min-inline-size: 0; border: 1px solid var(--el-border-color-lighter); border-radius: var(--fsus-radius-panel, 12px); background: var(--el-bg-color); overflow: clip; }
.security-card-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--fsus-space-3); align-items: start; padding: var(--fsus-space-4); min-inline-size: 0; }
.security-card-heading { display: grid; gap: var(--fsus-space-1); min-inline-size: 0; }
.security-card-title-row { display: flex; flex-wrap: wrap; align-items: safe center; gap: var(--fsus-space-2); min-inline-size: 0; }
.security-card-title { margin: 0; color: var(--el-text-color-primary); font-size: 16px; font-weight: 700; line-height: 1.35; letter-spacing: 0; }
.security-card-description { margin: 0; color: var(--el-text-color-secondary); font-size: var(--el-font-size-small); line-height: 1.6; max-inline-size: 52rem; overflow-wrap: anywhere; }
.security-card-actions { display: inline-flex; flex-wrap: wrap; align-items: safe center; justify-content: flex-end; gap: var(--fsus-space-2); min-inline-size: 0; }
.security-card-body { display: grid; gap: var(--fsus-space-3); padding: var(--fsus-space-4); border-block-start: 1px solid var(--el-border-color-lighter); min-inline-size: 0; }
.security-card-body.is-flush { padding-block: 0; padding-inline: 2px; gap: 0; }
@media (max-width: 639px) {
  .security-card-head { grid-template-columns: minmax(0, 1fr); gap: var(--fsus-space-3); }
  .security-card-actions { justify-content: flex-start; }
}
</style>
