<template>
  <el-dialog
    :model-value="visible"
    title="账号封禁处理"
    width="min(95vw, 480px)"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="pt-6 pb-2">
      <div class="mb-8 flex items-center gap-6 rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]/80 p-5">
        <el-avatar :size="40">{{ targetInitials }}</el-avatar>
        <span class="text-base font-bold text-[var(--fsusblog-text-secondary)]">{{ targetUsername }}</span>
      </div>

      <el-form label-position="top">
        <el-form-item label="封禁原因 (将公示给用户)">
          <div class="w-full">
            <el-select
              :model-value="reason"
              aria-label="封禁原因"
              placeholder="请选择或输入理由"
              allow-create
              filterable
              maxlength="100"
              @update:model-value="emit('update:reason', $event)"
            >
              <el-option v-for="item in quickReasons" :key="item" :label="item" :value="item" />
            </el-select>
          </div>
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="grid grid-cols-2 gap-6 border-t border-[var(--fsusblog-panel-border)] pt-5">
        <el-button :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button type="danger" :loading="isProcessing" @click="emit('submit')">
          {{ isCalculating ? '安全校验中...' : '确认封禁' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
interface Props {
  visible: boolean
  reason: string
  quickReasons: readonly string[]
  isProcessing: boolean
  isCalculating: boolean
  targetUsername: string
  targetInitials: string
}

defineProps<Props>()

const emit = defineEmits<{
  submit: []
  'update:visible': [value: boolean]
  'update:reason': [value: string]
}>()
</script>
