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
        <el-button :icon="Check" size="small" type="success" :disabled="disabled" :loading="loading" @click="openPreview(CommentModerationStatus.Approved)">
          批量通过
        </el-button>
        <el-button :icon="Hide" size="small" :disabled="disabled" :loading="loading" @click="openPreview(CommentModerationStatus.Hidden)">
          批量隐藏
        </el-button>
        <el-button :icon="Close" size="small" type="danger" :disabled="disabled" :loading="loading" @click="openPreview(CommentModerationStatus.Rejected)">
          批量拒绝
        </el-button>
        <el-button size="small" :disabled="loading || selectedCount === 0" @click="emit('clear')">
          清空选择
        </el-button>
      </div>
    </div>

    <p class="mt-3 text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">
      已选择 {{ selectedCount }} 条
    </p>

    <el-dialog
      v-model="previewVisible"
      title="批量审核预演"
      width="min(92vw, 28rem)"
      :close-on-click-modal="false"
    >
      <p class="text-sm leading-6 text-[var(--fsusblog-text-secondary)]">
        将{{ previewActionText }} {{ selectedCount }} 条评论。该操作会写入审核日志{{ banUsers ? '，并尝试联动封禁命中的用户。' : '。' }}
      </p>
      <p v-if="reason.trim()" class="mt-4 text-xs leading-5 text-[var(--fsusblog-text-muted)]">
        审核原因：{{ reason.trim() }}
      </p>
      <template #footer>
        <div class="grid grid-cols-2 gap-4 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <el-button :disabled="loading" @click="previewVisible = false">
            返回调整
          </el-button>
          <el-button type="primary" :loading="loading" @click="confirmPreview">
            {{ previewConfirmText }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
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
const previewVisible = ref(false)
const previewStatus = ref<CommentModerationStatusValue | null>(null)
const previewActionText = computed(() => {
  if (previewStatus.value === CommentModerationStatus.Approved) return '通过'
  if (previewStatus.value === CommentModerationStatus.Hidden) return '隐藏'
  if (previewStatus.value === CommentModerationStatus.Rejected) return '拒绝'
  return '处理'
})
const previewConfirmText = computed(() => {
  if (previewStatus.value === CommentModerationStatus.Approved) return '通过评论'
  if (previewStatus.value === CommentModerationStatus.Hidden) return '隐藏评论'
  if (previewStatus.value === CommentModerationStatus.Rejected) return '拒绝评论'
  return '执行审核'
})

const openPreview = (status: CommentModerationStatusValue): void => {
  previewStatus.value = status
  previewVisible.value = true
}

const confirmPreview = (): void => {
  if (previewStatus.value === null) {
    return
  }

  const status = previewStatus.value
  previewVisible.value = false
  emit('apply', status)
}
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
