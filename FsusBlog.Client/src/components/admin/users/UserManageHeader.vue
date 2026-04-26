<template>
  <section class="admin-filter-bar mb-6 sm:mb-8" aria-label="用户筛选">
    <div class="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0">
        <h2 class="flex min-w-0 flex-wrap items-center gap-3 text-xl font-bold text-[#27272A] sm:text-2xl">
          用户管理
          <el-tag size="small" type="info" effect="plain" class="rounded-[var(--fsus-radius-sm)] border-[#E4E4E7] text-[#A1A1AA] tabular-nums px-3 py-1">
            Total: {{ total }}
          </el-tag>
        </h2>
        <p class="mt-3 max-w-2xl text-xs sm:text-sm text-[#71717A] leading-6">
          高危操作（封禁/重置密码）将触发强制算力校验
        </p>
      </div>

      <div class="account-soft-block user-filter-stack flex w-full min-w-0 flex-col gap-3 p-4 md:flex-row md:flex-wrap md:items-center lg:w-auto lg:min-w-[26rem]">
        <el-select
          :model-value="status"
          name="userStatusFilter"
          aria-label="用户状态筛选"
          placeholder="状态"
          clearable
          class="w-full md:w-32"
          :disabled="loading"
          @update:model-value="onStatusChange"
        >
          <el-option label="正常" :value="0" />
          <el-option label="已封禁" :value="1" />
          <el-option label="已注销" :value="2" />
        </el-select>

        <el-input
          :model-value="keyword"
          name="userKeyword"
          aria-label="搜索用户名"
          placeholder="搜用户名..."
          clearable
          class="w-full md:w-56 lg:w-72"
          :disabled="loading"
          @update:model-value="onKeywordChange"
          @clear="onSearch"
          @keyup.enter="onSearch"
        >
          <template #prefix>
            <el-icon class="text-[#A1A1AA]"><Search /></el-icon>
          </template>
        </el-input>

        <el-button type="primary" :icon="Search" :loading="loading" class="w-full md:w-auto" @click="onSearch">
          查询
        </el-button>
      </div>
    </div>
  </section>
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

<style scoped>
.user-filter-stack :deep(.el-select),
.user-filter-stack :deep(.el-input),
.user-filter-stack :deep(.el-button) {
  min-height: 44px;
}

@media (max-width: 767px) {
  .user-filter-stack :deep(.el-button) {
    margin-left: 0 !important;
  }
}
</style>
