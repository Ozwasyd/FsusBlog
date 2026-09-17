<template>
    <div
        class="user-filter-stack grid gap-2"
        role="search"
        aria-label="账号筛选"
    >
        <div class="min-w-0">
            <ElSelect
                :model-value="status"
                name="userStatusFilter"
                aria-label="账号状态筛选"
                placeholder="状态"
                clearable
                :disabled="loading"
                @update:model-value="onStatusChange"
            >
                <ElOption
                    label="正常"
                    :value="0"
                />
                <ElOption
                    label="已封禁"
                    :value="1"
                />
                <ElOption
                    label="已注销"
                    :value="2"
                />
            </ElSelect>
        </div>

        <div class="min-w-0">
            <ElInput
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
                        <ElIcon aria-hidden="true"><Search /></ElIcon>
                    </span>
                </template>
            </ElInput>
        </div>

        <div class="user-filter-actions flex gap-2">
            <ElButton
                type="primary"
                :disabled="loading"
                :loading="loading"
                @click="onSearch"
            >
                <span v-if="loading">查询中...</span>
                <span v-else>查询</span>
            </ElButton>
            <ElButton
                :disabled="loading || activeFilters.length === 0"
                @click="emit('reset')"
            >
                重置
            </ElButton>
        </div>
        <div
            v-if="activeFilters.length > 0"
            class="mt-6 flex flex-wrap gap-3"
        >
            <ElTag
                v-for="chip in activeFilters"
                :key="chip.key"
                closable
                size="small"
                @close="emit('remove-filter', chip.key)"
            >
                {{ chip.label }}
            </ElTag>
        </div>
    </div>
</template>

<script setup lang="ts">
import { Search } from '@/fsusui/icons';

interface Props {
    total: number;
    keyword: string;
    status: number | undefined;
    loading: boolean;
    activeFilters: readonly { key: 'status' | 'keyword'; label: string; }[];
}

defineProps<Props>();

const emit = defineEmits<{
    search: [];
    reset: [];
    'remove-filter': [key: 'status' | 'keyword'];
    'update:keyword': [value: string];
    'update:status': [value: number | undefined];
}>();

const onSearch = (): void =>
{
    emit('search');
};

const onKeywordChange = (value: string): void =>
{
    emit('update:keyword', value);
};

const onStatusChange = (value: number | undefined): void =>
{
    emit('update:status', value);
};
</script>

<style scoped>
.user-filter-stack
 {
    width: 100%;
    max-width: 52rem;
    grid-template-columns: minmax(0, 1fr);
}

.user-filter-actions
 {
    align-items: stretch;
}

.user-filter-actions > *
 {
    min-width: 5rem;
}

@media (width >= 640px)
 {
    .user-filter-stack
 {
        grid-template-columns: 10rem minmax(0, 1fr) auto;
        align-items: center;
    }
}
</style>
