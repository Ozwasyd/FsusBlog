<template>
  <el-dialog
    :model-value="visible"
    title="账号封禁处理"
    width="95%"
    style="max-width: 480px"
    class="custom-dialog  p-6"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="pt-6 pb-2">
      <div class="mb-8 flex items-center gap-6 rounded-[var(--fsus-radius-lg)] border border-[var(--fsus-panel-border)] bg-[#FCFCFC]/80 p-5">
        <el-avatar :size="40">{{ targetInitials }}</el-avatar>
        <span class="text-base font-bold text-[#3F3F46] dark:text-[#E4E4E7]">{{ targetUsername }}</span>
      </div>

      <el-form label-position="top">
        <el-form-item label="封禁原因 (将公示给用户)">
          <el-select
            :model-value="reason"
            size="large"
            class="w-full"
            placeholder="请选择或输入理由"
            allow-create
            filterable
            maxlength="100"
            @update:model-value="emit('update:reason', $event)"
          >
            <el-option v-for="item in quickReasons" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="flex gap-6 border-t border-[#F4F4F5] pt-5">
        <el-button size="large" class="flex-1 rounded-[var(--fsus-radius-md)] border-[var(--fsus-border)]" :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button size="large" type="danger" class="flex-1 rounded-[var(--fsus-radius-md)] font-bold" :loading="isProcessing" @click="emit('submit')">
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
