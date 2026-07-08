<template>
  <section class="mb-10 px-8" aria-label="账号筛选">
    <div class="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0">
        <h2 class="flex flex-wrap items-center gap-4 text-[15px] font-bold tracking-normal text-[var(--fsusblog-text-primary)]">
          账号筛选
          <span class="text-xs tabular-nums font-bold text-[var(--fsusblog-text-muted)] bg-[var(--fsusblog-panel-bg-soft)] px-3 py-1 normal-case tracking-normal">
            共 {{ total }}
          </span>
        </h2>
        <p class="mt-3 max-w-2xl text-[12px] text-[var(--fsusblog-text-tertiary)] leading-relaxed normal-case tracking-normal font-bold">
          封禁与解封会触发强制算力校验。
        </p>
      </div>

      <div class="user-filter-stack grid gap-2">
        <div class="min-w-0">
          <el-select
            :model-value="status"
            name="userStatusFilter"
            aria-label="账号状态筛选"
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

        <div class="min-w-0">
          <el-input
            :model-value="keyword"
            name="userKeyword"
            aria-label="搜索账号标识"
            placeholder="搜账号 ID / public handle..."
            clearable
            :disabled="loading"
            @update:model-value="onKeywordChange"
            @clear="onSearch"
            @keyup.enter="onSearch"
          >
            <template #prefix>
              <span class="text-[var(--fsusblog-text-muted)]">
                <el-icon aria-hidden="true"><Search /></el-icon>
              </span>
            </template>
          </el-input>
        </div>

        <div class="user-filter-actions flex gap-2">
          <el-button
            type="primary"
            :disabled="loading"
            :loading="loading"
            @click="onSearch"
          >
            <span v-if="loading">查询中...</span>
            <span v-else>查询</span>
          </el-button>
          <el-button
            :disabled="loading || activeFilters.length === 0"
            @click="emit('reset')"
          >
            重置
          </el-button>
        </div>
      </div>
    </div>

    <div v-if="activeFilters.length > 0" class="mt-6 flex flex-wrap gap-3">
      <el-tag
        v-for="chip in activeFilters"
        :key="chip.key"
        closable
        size="small"
        @close="emit('remove-filter', chip.key)"
      >
        {{ chip.label }}
      </el-tag>
      </div>
  </section>
</template>

<script setup lang="ts">
import { Search } from '@/fsusui/icons'

interface Props {
  total: number
  keyword: string
  status: number | undefined
  loading: boolean
  activeFilters: ReadonlyArray<{ key: 'status' | 'keyword'; label: string }>
}

defineProps<Props>()

const emit = defineEmits<{
  search: []
  reset: []
  'remove-filter': [key: 'status' | 'keyword']
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
.user-filter-stack {
  width: 100%;
  max-width: 44rem;
  grid-template-columns: minmax(0, 1fr);
}

.user-filter-actions {
  align-items: stretch;
}

.user-filter-actions :deep(.el-button) {
  min-width: 5rem;
}

@media (min-width: 640px) {
  .user-filter-stack {
    grid-template-columns: 10rem minmax(0, 1fr) auto;
    align-items: stretch;
  }
}
</style>
