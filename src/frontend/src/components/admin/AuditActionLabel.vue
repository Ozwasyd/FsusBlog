<template>
  <span v-if="display.kind === 'label'">{{ display.text }}</span>
  <span v-else class="audit-action-label">
    <span v-if="display.namespace" class="audit-action-label__namespace">{{ display.namespace }}</span>
    <span v-if="display.namespace" class="audit-action-label__separator" aria-hidden="true">·</span>
    <span class="audit-action-label__name">{{ display.name }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatAuditAction } from '@/view-contracts/auditActionLabels'

const props = defineProps<{
  value: string | null | undefined
}>()

const display = computed(() => formatAuditAction(props.value))
</script>

<style scoped>
.audit-action-label {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.25rem;
}

.audit-action-label__namespace {
  min-width: 0;
  overflow: hidden;
  color: var(--fsusblog-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-action-label__separator {
  color: var(--fsusblog-text-subtle);
}

.audit-action-label__name {
  min-width: 0;
  overflow: hidden;
  color: var(--fsusblog-text-primary);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
