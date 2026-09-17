<template>
    <div class="account-page theme-admin-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="主题管理"
            class="account-task-page-header"
            density="compact"
        />

        <FsusUiSettingsSection
            title="已注册主题"
            id="theme-admin-registry-title"
            class="mb-8"
        >
            <ElTable
                v-loading="registryLoading"
                :data="registry"
                row-key="themeId"
            >
                <ElTableColumn
                    label="主题"
                    min-width="180"
                >
                    <template #default="{ row }: { row: ThemeRegistryItem }">
                        <div class="theme-admin-primary">{{ row.name }}</div>
                        <div class="theme-admin-secondary">{{ row.themeId }}</div>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    prop="version"
                    label="版本"
                    width="100"
                />
                <ElTableColumn
                    prop="author"
                    label="作者"
                    width="140"
                />
                <ElTableColumn
                    label="状态"
                    width="100"
                >
                    <template #default="{ row }: { row: ThemeRegistryItem }">
                        <ElTag :type="installStateTagType(row.installState)">{{ installStateLabel(row.installState) }}</ElTag>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    prop="packageHash"
                    label="包摘要"
                    min-width="130"
                >
                    <template #default="{ row }: { row: ThemeRegistryItem }">
                        {{ row.packageHash.slice(0, 12) }}…
                    </template>
                </ElTableColumn>
                <template #empty>
                    <AdminInlineEmptyState
                        title="暂未安装主题"
                        content="通过 Theme Package 安装和管理主题。"
                    />
                </template>
            </ElTable>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            title="激活范围"
            id="theme-admin-activations-title"
            class="mb-8"
        >
            <ElTable
                v-loading="activationsLoading"
                :data="activations"
                row-key="scope"
            >
                <ElTableColumn
                    label="范围"
                    width="140"
                >
                    <template #default="{ row }: { row: ThemeActivationItem }">
                        {{ scopeLabel(row.scope) }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="激活主题"
                    min-width="160"
                >
                    <template #default="{ row }: { row: ThemeActivationItem }">
                        {{ row.activeThemeId || '默认' }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    prop="mode"
                    label="模式"
                    width="80"
                />
                <template #empty>
                    <AdminInlineEmptyState
                        title="暂无激活记录"
                        content="主题注册并启用后在此显示。"
                    />
                </template>
            </ElTable>
        </FsusUiSettingsSection>
    </div>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue';

import type {
    ThemeActivationItem,
    ThemeRegistryItem
} from '@/api/themeAdmin';
import {
    getThemeActivations,
    getThemeRegistry
} from '@/api/themeAdmin';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import {
    FsusUiSettingsSection,
    FsusUiTaskPageHeader
} from '@/fsusui';
import { showErrorToast } from '@/utils/errorPresentation';

const registryLoading = shallowRef(false);
const activationsLoading = shallowRef(false);
const registry = shallowRef<ThemeRegistryItem[]>([]);
const activations = shallowRef<ThemeActivationItem[]>([]);

function installStateTagType(state: string): 'success' | 'warning' | 'danger' | 'info'
{
    return state === 'enabled' ? 'success'
        : state === 'installed' ? 'info'
            : state === 'failed' || state === 'rolled_back' ? 'danger'
                : 'warning';
}

function installStateLabel(state: string): string
{
    return {
        discovered: '发现',
        validated: '已验证',
        installed: '已安装',
        enabled: '活跃',
        disabled: '停用',
        failed: '失败',
        rolledBack: '已回滚',
        uninstalled: '已卸载'
    }[state] ?? state;
}

function scopeLabel(scope: string): string
{
    if (scope.startsWith('user-preview:'))
    {
        return '用户预览';
    }
    return {
        'site-wide': '全站',
        public: '公开',
        admin: '后台',
        console: '控制台'
    }[scope] ?? scope;
}

async function loadRegistry(): Promise<void>
{
    registryLoading.value = true;
    try
    {
        registry.value = await getThemeRegistry();
    }
    catch (error)
    {
        showErrorToast(error, '主题注册表加载失败');
    }
    finally
    {
        registryLoading.value = false;
    }
}

async function loadActivations(): Promise<void>
{
    activationsLoading.value = true;
    try
    {
        activations.value = await getThemeActivations();
    }
    catch (error)
    {
        showErrorToast(error, '主题激活列表加载失败');
    }
    finally
    {
        activationsLoading.value = false;
    }
}

onMounted(() =>
{
    loadRegistry();
    loadActivations();
});
</script>

<style scoped>
.theme-admin-primary
 {
    color: var(--fsusblog-text-primary);
    font-weight: 600;
}

.theme-admin-secondary
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}
</style>
