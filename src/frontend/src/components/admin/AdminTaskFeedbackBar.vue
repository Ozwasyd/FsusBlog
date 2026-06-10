<template>
  <div>
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ ariaMessage }}
    </p>
    <p v-if="assertiveMessage" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
      {{ assertiveMessage }}
    </p>

    <section
      v-if="visible"
      class="admin-task-feedback blog-motion-state-change"
      :class="`admin-task-feedback--${phase}`"
      :aria-busy="busy"
      data-admin-task-feedback="true"
    >
      <div class="admin-task-feedback__meta">{{ phaseLabel }}</div>
      <div class="admin-task-feedback__body">
        <strong>{{ message }}</strong>
        <span v-if="detail">{{ detail }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AdminTaskFeedbackPhase } from '@/composables/useAdminTaskFeedback'

const props = withDefaults(defineProps<{
  phase: AdminTaskFeedbackPhase
  message: string
  detail?: string
  ariaMessage?: string
  assertiveMessage?: string
  busy?: boolean
}>(), {
  detail: '',
  ariaMessage: '',
  assertiveMessage: '',
  busy: false
})

const visible = computed(() => props.phase !== 'idle' && props.message.trim().length > 0)
const phaseLabel = computed(() => {
  if (props.phase === 'pending') return '处理中'
  if (props.phase === 'success') return '已完成'
  if (props.phase === 'partial') return '部分完成'
  if (props.phase === 'error') return '需要处理'
  return '状态'
})
</script>

<style scoped>
.admin-task-feedback {
  display: grid;
  gap: 0.35rem;
  border-block: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.9rem 1rem;
  color: var(--fsusblog-text-secondary);
}

.admin-task-feedback__meta {
  color: var(--fsusblog-text-muted);
  font-size: 0.6875rem;
  font-weight: 800;
}

.admin-task-feedback__body {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.8125rem;
  line-height: 1.55;
}

.admin-task-feedback__body strong {
  color: var(--fsusblog-text-primary);
}

.admin-task-feedback--pending {
  opacity: 0.82;
}

.admin-task-feedback--success,
.admin-task-feedback--partial {
  border-color: var(--blog-motion-highlight-border);
  animation: blog-motion-highlight calc(var(--blog-motion-panel) * 2) var(--blog-motion-ease) both;
}

.admin-task-feedback--error {
  border-color: var(--fsusblog-color-error);
  color: var(--fsusblog-color-error);
}

@media (prefers-reduced-motion: reduce) {
  .admin-task-feedback {
    animation: none !important;
    transition: none !important;
  }
}
</style>
