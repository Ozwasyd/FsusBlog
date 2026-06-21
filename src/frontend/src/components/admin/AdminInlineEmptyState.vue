<template>
  <component
    :is="FsusUiEmptyState"
    v-bind="emptyStateProps"
    class="px-4 py-6 text-left"
    role="status"
    :title="title"
    :description="description"
  >
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
  </component>
</template>

<script setup lang="ts">
import {
  resolveFsusUiEmptyState,
  toFsusUiInlineEmptyStateProps
} from '@/fsusui/primitiveAdapters'

defineOptions({ name: 'AdminInlineEmptyState' })

withDefaults(defineProps<{
  title: string
  description?: string
}>(), {
  description: ''
})

const FsusUiEmptyState = resolveFsusUiEmptyState()
const emptyStateProps = toFsusUiInlineEmptyStateProps('adminCollection')
</script>
