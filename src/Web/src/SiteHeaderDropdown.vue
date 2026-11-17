<script setup lang="ts">
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from '@ozwasyd/element-plus'
import { ArrowDown } from '@ozwasyd/element-plus/icons-vue'

defineProps<{ label: string; selected: string; items: readonly { value: string; label: string }[] }>()
const emit = defineEmits<{ select: [value: string] }>()
function select(value: unknown) {
  if (typeof value === 'string') emit('select', value)
}
</script>

<template>
  <ElDropdown trigger="click" placement="bottom-end" @command="select">
    <button class="site-header-text-action" type="button" :aria-label="label">
      {{ items.find(item => item.value === selected)?.label }}
      <ArrowDown class="site-header-chevron" v-bind="{ 'aria-hidden': true }" />
    </button>
    <template #dropdown>
      <ElDropdownMenu>
        <ElDropdownItem v-for="item in items" :key="item.value" :command="item.value"
          :class="{ 'site-header-current-option': item.value === selected }">{{ item.label }}</ElDropdownItem>
      </ElDropdownMenu>
    </template>
  </ElDropdown>
</template>

<style scoped>
.site-header-current-option { font-weight: 600; }
.site-header-chevron { inline-size: .75rem; block-size: .75rem; }
</style>
