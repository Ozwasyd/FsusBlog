<template>
  <section
    class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-4 py-4"
    :aria-label="label"
  >
    <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0 flex-1">
        <slot name="filters" />
      </div>
      <div v-if="$slots.actions" class="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 lg:w-auto">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineOptions({ name: 'AdminCollectionToolbar' })

defineProps<{
  label: string
}>()
</script>
