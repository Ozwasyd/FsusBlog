<template>
  <div
    class="inline-flex max-w-full flex-wrap items-center gap-1 rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] p-1"
    role="group"
    :aria-label="props.ariaLabel"
  >
    <button
      v-for="item in props.items"
      :key="String(item.value)"
      type="button"
      class="min-h-10 rounded-[var(--fsus-radius-control-small)] px-2 text-[12px] font-bold transition-colors"
      :class="[
        item.value === props.modelValue
          ? 'bg-[var(--fsusblog-text-primary)] text-[var(--fsusblog-page-bg)]'
          : 'text-[var(--fsusblog-text-muted)] hover:bg-[var(--fsusblog-page-bg-soft)] hover:text-[var(--fsusblog-text-secondary)]',
        props.disabled ? 'cursor-not-allowed opacity-55' : ''
      ]"
      :disabled="props.disabled"
      :aria-pressed="item.value === props.modelValue"
      @click="emit('update:modelValue', item.value)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'AdminSegmentedControl' })

type AdminSegmentedControlValue = string | number | boolean | undefined

type AdminSegmentedControlItem = {
  label: string
  value: AdminSegmentedControlValue
}

const props = withDefaults(defineProps<{
  modelValue?: AdminSegmentedControlValue
  items?: readonly AdminSegmentedControlItem[]
  disabled?: boolean
  ariaLabel?: string
}>(), {
  modelValue: undefined,
  items: () => [],
  disabled: false,
  ariaLabel: ''
})

const emit = defineEmits<{
  'update:modelValue': [value: AdminSegmentedControlValue]
}>()
</script>
