<template>
    <div class="grid gap-1">
        <span class="text-[11px] leading-4 font-bold text-[var(--fsusblog-text-muted)]">{{ label }}</span>
        <slot />
    </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'AdminFilterGroup' });

defineProps<{
    label: string;
}>();
</script>
