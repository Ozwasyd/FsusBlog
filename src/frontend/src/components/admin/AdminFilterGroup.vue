<template>
  <div class="grid gap-1.5">
    <span class="text-[11px] font-bold text-[var(--fsusblog-text-muted)]">{{ label }}</span>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'AdminFilterGroup' })

defineProps<{
  label: string
}>()
</script>
