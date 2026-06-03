<template>
  <section class="border-t border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-6" aria-label="评论批量审核">
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <el-input
        :model-value="reason"
        maxlength="120"
        show-word-limit
        placeholder="审核原因，会写入评论审核审计"
        aria-label="评论审核原因"
        :disabled="loading"
        @update:model-value="emit('update:reason', String($event))"
      />

      <div class="flex flex-wrap items-center gap-3">
        <el-checkbox
          :model-value="banUsers"
          :disabled="loading"
          @update:model-value="emit('update:banUsers', Boolean($event))"
        >
          联动封禁用户
        </el-checkbox>
        <el-button :icon="Check" size="small" type="success" :disabled="disabled" :loading="loading" @click="emit('apply', CommentModerationStatus.Approved)">
          批量通过
        </el-button>
        <el-button :icon="Close" size="small" type="danger" :disabled="disabled" :loading="loading" @click="emit('apply', CommentModerationStatus.Rejected)">
          批量拒绝
        </el-button>
        <el-button :icon="Hide" size="small" :disabled="disabled" :loading="loading" @click="emit('apply', CommentModerationStatus.Hidden)">
          批量隐藏
        </el-button>
        <el-button size="small" :disabled="loading || selectedCount === 0" @click="emit('clear')">
          清空选择
        </el-button>
      </div>
    </div>

    <p class="mt-3 text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">
      已选择 {{ selectedCount }} 条
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Check, Close, Hide } from '@/fsusui/icons'
import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring'

const props = defineProps<{
  selectedCount: number
  reason: string
  banUsers: boolean
  loading: boolean
}>()

const emit = defineEmits<{
  apply: [status: CommentModerationStatusValue]
  clear: []
  'update:reason': [value: string]
  'update:banUsers': [value: boolean]
}>()

const disabled = computed(() => props.loading || props.selectedCount === 0)
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
