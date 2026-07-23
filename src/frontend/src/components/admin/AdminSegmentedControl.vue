<template>
    <div
        class="inline-flex max-w-full flex-wrap items-center gap-1 rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] p-1"
        role="group"
        :aria-label="ariaLabel"
    >
        <button
            v-for="item in items"
            :key="String(item.value)"
            type="button"
            class="min-h-10 rounded-[var(--fsus-radius-control-small)] px-2 text-[12px] font-bold transition-colors"
            :class="[item.value === modelValue ? 'bg-[var(--fsusblog-text-primary)] text-[var(--fsusblog-page-bg)]' : 'text-[var(--fsusblog-text-muted)] hover:bg-[var(--fsusblog-page-bg-soft)] hover:text-[var(--fsusblog-text-secondary)]', disabled ? 'cursor-not-allowed opacity-55' : '']"
            :disabled="disabled"
            :aria-pressed="item.value === modelValue"
            @click="emit('update:modelValue', item.value)"
        >{{ item.label }}</button>
    </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'AdminSegmentedControl' });
type ControlValue = string | number | boolean | undefined;
defineProps<{
    modelValue?: ControlValue;
    items: readonly Readonly<{ label: string; value: ControlValue; }>[];
    disabled?: boolean;
    ariaLabel: string;
}>();
const emit = defineEmits<{
    'update:modelValue': [value: ControlValue];
}>();
</script>
