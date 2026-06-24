<template>
  <component
    :is="FsusUiEmptyState"
    v-bind="emptyStateProps"
    class="admin-inline-empty-state"
    role="status"
    :title="title"
    :description="descriptionText"
  >
    <template v-if="$slots.actions" #actions>
      <div class="admin-inline-empty-state__actions">
        <slot name="actions" />
      </div>
    </template>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  resolveFsusUiEmptyState,
  toFsusUiInlineEmptyStateProps
} from '@/fsusui/primitiveAdapters'

defineOptions({ name: 'AdminInlineEmptyState' })

const props = withDefaults(defineProps<{
  title: string
  description?: string
  content?: string
}>(), {
  description: '',
  content: ''
})

const FsusUiEmptyState = resolveFsusUiEmptyState()
const emptyStateProps = toFsusUiInlineEmptyStateProps('adminCollection')
const descriptionText = computed(() => props.description || props.content || '')
</script>

<style scoped>
.admin-inline-empty-state {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 1.5rem;
  text-align: left;
}

.admin-inline-empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.875rem;
}

@media (max-width: 639px) {
  .admin-inline-empty-state {
    padding: 1.25rem;
  }

  .admin-inline-empty-state__actions {
    gap: 0.625rem;
  }
}
</style>
