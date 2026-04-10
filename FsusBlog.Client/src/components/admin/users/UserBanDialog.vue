<template>
  <el-dialog
    :model-value="visible"
    title="账号封禁处理"
    width="90%"
    style="max-width: 400px"
    class="custom-dialog rounded-2xl"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="pt-1">
      <div class="mb-4 flex items-center gap-3 p-3 bg-zinc-50 rounded-lg">
        <el-avatar :size="32">{{ targetInitials }}</el-avatar>
        <span class="font-bold text-zinc-700">{{ targetUsername }}</span>
      </div>

      <el-form label-position="top">
        <el-form-item label="封禁原因 (将公示给用户)">
          <el-select
            :model-value="reason"
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
      <div class="flex gap-3">
        <el-button class="flex-1 rounded-xl" :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button type="danger" class="flex-1 rounded-xl font-bold" :loading="isProcessing" @click="emit('submit')">
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
