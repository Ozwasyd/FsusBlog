<template>
  <section class="mb-12" aria-label="用户筛选">
    <div class="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between px-8">
      <div class="min-w-0">
        <div class="text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">管理 / USERS</div>
        <h2 class="flex flex-wrap items-center gap-6 text-4xl font-bold tracking-normal text-[var(--fsusblog-text-primary)] sm:text-5xl">
          用户管理
          <span class="text-xs tabular-nums font-bold text-[var(--fsusblog-text-muted)] bg-[var(--fsusblog-panel-bg-soft)] px-3 py-1 normal-case tracking-normal">
            Total: {{ total }}
          </span>
        </h2>
        <p class="mt-6 max-w-2xl text-[11px] text-[var(--fsusblog-text-tertiary)] leading-relaxed normal-case tracking-normal font-bold">
          高危操作（封禁/重置密码）将触发强制算力校验
        </p>
      </div>

      <div class="user-filter-stack flex flex-col gap-px bg-[var(--fsusblog-panel-bg-soft)] border border-[var(--fsusblog-panel-border)] md:flex-row lg:w-auto">
        <div class="bg-[var(--fsusblog-page-bg)] p-1 w-full md:w-32">
          <el-select
            :model-value="status"
            name="userStatusFilter"
            aria-label="用户状态筛选"
            placeholder="状态"
            clearable
            :disabled="loading"
            @update:model-value="onStatusChange"
          >
            <el-option label="正常" :value="0" />
            <el-option label="已封禁" :value="1" />
            <el-option label="已注销" :value="2" />
          </el-select>
        </div>

        <div class="bg-[var(--fsusblog-page-bg)] p-1 grow md:grow-0 w-full md:w-56 lg:w-72">
          <el-input
            :model-value="keyword"
            name="userKeyword"
            aria-label="搜索用户名"
            placeholder="搜用户名..."
            clearable
            :disabled="loading"
            @update:model-value="onKeywordChange"
            @clear="onSearch"
            @keyup.enter="onSearch"
          >
            <template #prefix>
              <span class="text-[var(--fsusblog-text-muted)]">
                <el-icon><Search /></el-icon>
              </span>
            </template>
          </el-input>
        </div>

        <div class="bg-[var(--fsusblog-page-bg)] p-1">
          <el-button
            type="primary"
            :disabled="loading"
            :loading="loading"
            @click="onSearch"
          >
            <span v-if="loading">Searching...</span>
            <span v-else>查询</span>
          </el-button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Search } from '@/ui/fsusIcons'

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
@media (max-width: 767px) {
  .user-filter-stack {
    width: 100%;
  }
}
</style>
