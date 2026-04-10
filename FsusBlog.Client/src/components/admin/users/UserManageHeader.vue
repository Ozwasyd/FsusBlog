<template>
  <el-card shadow="never" class="action-card mb-4 sm:mb-5 border-none rounded-xl">
    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-1">
      <div class="header-info">
        <h2 class="text-lg sm:text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
          用户管理
          <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400 tabular-nums">
            Total: {{ total }}
          </el-tag>
        </h2>
        <p class="text-[11px] sm:text-[12px] text-zinc-400 mt-1 italic font-medium">
          高危操作（封禁/重置密码）将触发强制算力校验
        </p>
      </div>

      <div class="flex flex-wrap sm:flex-nowrap gap-2 w-full sm:w-auto">
        <el-select
          :model-value="status"
          placeholder="状态"
          clearable
          class="w-24 flex-1 sm:flex-none"
          :disabled="loading"
          @update:model-value="onStatusChange"
        >
          <el-option label="正常" :value="0" />
          <el-option label="已封禁" :value="1" />
        </el-select>

        <el-input
          :model-value="keyword"
          placeholder="搜用户名..."
          clearable
          class="w-full sm:w-48 lg:w-64 flex-2 sm:flex-none"
          :disabled="loading"
          @update:model-value="onKeywordChange"
          @clear="onSearch"
          @keyup.enter="onSearch"
        >
          <template #prefix>
            <el-icon class="text-zinc-400"><Search /></el-icon>
          </template>
        </el-input>

        <el-button type="primary" :icon="Search" class="shadow-md shadow-blue-50" :loading="loading" @click="onSearch">
          查询
        </el-button>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { Search } from '@element-plus/icons-vue'

interface Props {
  total: number
  keyword: string
  status: number | undefined
  loading: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  search: []
  'update:keyword': [value: string]
  'update:status': [value: number | undefined]
}>()

const onSearch = (): void => {
  emit('search')
}

const onKeywordChange = (value: string): void => {
  emit('update:keyword', value)
}

const onStatusChange = (value: number | undefined): void => {
  emit('update:status', value)
}
</script>
