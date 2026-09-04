<template>
    <div class="account-page font-admin-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="字体管理"
            class="account-task-page-header"
            density="compact"
        />

        <FsusUiSettingsSection
            title="已注册字体"
            id="font-admin-registry-title"
            class="mb-8"
        >
            <ElTable
                v-loading="registryLoading"
                :data="registry"
                row-key="fontId"
            >
                <ElTableColumn
                    label="字体"
                    min-width="180"
                >
                    <template #default="{ row }: { row: FontRegistryItem }">
                        <div class="font-admin-primary">{{ row.name }}</div>
                        <div class="font-admin-secondary">{{ row.family }}</div>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="分类"
                    width="90"
                >
                    <template #default="{ row }: { row: FontRegistryItem }">
                        {{ categoryLabel(row.category) }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    prop="version"
                    label="版本"
                    width="100"
                />
                <ElTableColumn
                    label="来源"
                    width="80"
                >
                    <template #default="{ row }: { row: FontRegistryItem }">
                        <ElTag
                            :type="row.builtIn ? 'info' : ''"
                            size="small"
                        >
                            {{ row.builtIn ? '内置' : '安装' }}
                        </ElTag>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="启用"
                    width="70"
                >
                    <template #default="{ row }: { row: FontRegistryItem }">
                        <ElTag
                            :type="row.enabled ? 'success' : 'warning'"
                            size="small"
                        >
                            {{ row.enabled ? '是' : '否' }}
                        </ElTag>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="字形"
                    width="70"
                >
                    <template #default="{ row }: { row: FontRegistryItem }">
                        {{ row.faceCount }}
                    </template>
                </ElTableColumn>
                <template #empty>
                    <AdminInlineEmptyState
                        title="暂未安装字体"
                        content="通过 Font Package 安装和管理字体。"
                    />
                </template>
            </ElTable>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            title="激活范围"
            id="font-admin-activations-title"
            class="mb-8"
        >
            <ElTable
                v-loading="activationsLoading"
                :data="activations"
                row-key="scope"
            >
                <ElTableColumn
                    label="范围"
                    width="120"
                >
                    <template #default="{ row }: { row: FontActivationItem }">
                        {{ scopeLabel(row.scope) }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="UI 字体"
                    min-width="160"
                >
                    <template #default="{ row }: { row: FontActivationItem }">
                        {{ row.uiFontId }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="正文字体"
                    min-width="160"
                >
                    <template #default="{ row }: { row: FontActivationItem }">
                        {{ row.proseFontId }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="代码字体"
                    min-width="160"
                >
                    <template #default="{ row }: { row: FontActivationItem }">
                        {{ row.codeFontId }}
                    </template>
                </ElTableColumn>
                <template #empty>
                    <AdminInlineEmptyState
                        title="暂无激活记录"
                        content="字体注册并启用后在此显示。"
                    />
                </template>
            </ElTable>
        </FsusUiSettingsSection>
    </div>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue';

import type {
    FontActivationItem,
    FontRegistryItem
} from '@/api/fontAdmin';
import {
    getFontActivations,
    getFontRegistry
} from '@/api/fontAdmin';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import {
    FsusUiSettingsSection,
    FsusUiTaskPageHeader
} from '@/fsusui';
import { showErrorToast } from '@/utils/errorPresentation';

const registryLoading = shallowRef(false);
const activationsLoading = shallowRef(false);
const registry = shallowRef<FontRegistryItem[]>([]);
const activations = shallowRef<FontActivationItem[]>([]);

function categoryLabel(category: string): string
{
    return {
        'ui-sans': 'UI',
        'prose-sans': '正文',
        'code-mono': '代码',
        'cjk-sans': 'CJK',
        'emoji': 'Emoji'
    }[category] ?? category;
}

function scopeLabel(scope: string): string
{
    if (scope.startsWith('user-preview:'))
    {
        return '用户预览';
    }
    return {
        'default': '默认',
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
        registry.value = await getFontRegistry();
    }
    catch (error)
    {
        showErrorToast(error, '字体注册表加载失败');
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
        activations.value = await getFontActivations();
    }
    catch (error)
    {
        showErrorToast(error, '字体激活列表加载失败');
    }
    finally
    {
        activationsLoading.value = false;
    }
}

onMounted(() =>
{
    void loadRegistry();
    void loadActivations();
});
</script>

<style scoped>
.font-admin-primary
 {
    color: var(--fsusblog-text-primary);
    font-weight: 600;
}

.font-admin-secondary
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}
</style>
