<template>
  <el-dialog
    :model-value="visible"
    title="高危操作：强制重置密码"
    width="90%"
    style="max-width: 420px"
    append-to-body
    class="custom-dialog rounded-2xl"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="pt-1">
      <div class="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg flex gap-3">
        <el-icon class="text-red-500 mt-0.5 shrink-0"><WarningFilled /></el-icon>
        <div class="text-[12px] text-red-600 leading-relaxed">
          <p class="font-bold mb-1">警告：该操作将记录审计日志</p>
          <p>重置后，用户 <span class="font-bold underline">{{ targetUsername }}</span> 将被强制踢出所有在线会话。</p>
        </div>
      </div>

      <el-form @submit.prevent="emit('submit')" label-position="top">
        <el-form-item label="设置新登录密码" required>
          <el-input
            :model-value="password"
            placeholder="请输入 6 位以上密码，禁止使用空格"
            show-password
            size="large"
            @update:model-value="emit('update:password', $event)"
          />
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="flex gap-3">
        <el-button class="flex-1 rounded-xl" :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button type="danger" class="flex-1 rounded-xl font-bold" :loading="isProcessing" @click="emit('submit')">
          {{ isCalculating ? '安全校验中...' : '确认重置' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { WarningFilled } from '@element-plus/icons-vue'

interface Props {
  visible: boolean
  isProcessing: boolean
  isCalculating: boolean
  targetUsername: string
  password: string
}

defineProps<Props>()

const emit = defineEmits<{
  submit: []
  'update:visible': [value: boolean]
  'update:password': [value: string]
}>()
</script>
