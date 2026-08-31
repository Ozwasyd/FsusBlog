<template>
    <div class="space-y-8">
        <FsusUiSettingsSection
            title="审核运行状态"
            :description="overview ? `模型状态：${modelStateLabel}` : ''"
            id="moderation-overview-title"
        >
            <template #actions>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    @click="loadDashboard"
                >刷新</ElButton>
            </template>

            <AdminStatusMatrix
                :items="metrics"
                density="compact"
                aria-label="审核指标"
            />
        </FsusUiSettingsSection>

        <section
            class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
            :class="{
                'blog-motion-task-region--pending': savingGlobalState,
                'blog-motion-task-region--settled': isTaskHighlighted('moderation-global-runtime')
            }"
        >
            <AdminStatusMatrix
                :items="runtimeRows"
                density="compact"
                aria-label="审核运行状态"
            />
            <div class="moderation-runtime-control">
                <label class="moderation-runtime-control__field">
                    <span class="moderation-runtime-control__label">全局运行状态</span>
                    <ElSelect
                        v-model="globalStateDraft"
                        aria-label="全局审核运行状态"
                    >
                        <ElOption
                            v-for="option in globalStateOptions"
                            :key="option.value"
                            :label="option.label"
                            :value="option.value"
                        />
                    </ElSelect>
                </label>
                <ElButton
                    class="moderation-runtime-control__button"
                    type="primary"
                    :icon="Connection"
                    :loading="savingGlobalState"
                    @click="saveGlobalState"
                >
                    应用全局状态
                </ElButton>
            </div>
        </section>

    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';

import {
    getModerationOverview,
    getModerationRuntimeStatus,
    setModerationGlobalState,
    type ModerationOverviewResponse,
    type ModerationRuntimeStatusResponse
} from '@/api/authoring';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { FsusUiSettingsSection } from '@/fsusui';
import { toast } from '@/fsusui/feedback';
import { Connection, Refresh } from '@/fsusui/icons';
import { showErrorToast } from '@/utils/errorPresentation';


const loading = shallowRef(false);
const savingGlobalState = shallowRef(false);
const overview = shallowRef<ModerationOverviewResponse | null>(null);
const runtime = shallowRef<ModerationRuntimeStatusResponse | null>(null);
const globalStateDraft = shallowRef('enabled');
const taskFeedback = useAdminTaskFeedback();
const {
    isHighlighted: isTaskHighlighted
} = taskFeedback;

const formatRuntimeStatus = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        enabled: '已启用',
        disabled: '已关闭',
        loaded: '已载入',
        error: '异常',
        invalid: '异常',
        read_only: '只读',
        disabled_to_pending: '转入待审',
        emergency_lockdown: '紧急锁定'
    };
    return value ? labels[value] ?? value : '-';
};

const globalStateOptions = [
    { label: '已启用', value: 'enabled' },
    { label: '只读', value: 'read_only' },
    { label: '转入待审', value: 'disabled_to_pending' },
    { label: '紧急锁定', value: 'emergency_lockdown' }
] as const;

const metrics = computed<AdminStatusMatrixItem[]>(() => [
    { label: '待审', value: overview.value?.pendingCount ?? '-' },
    { label: '已拒绝', value: overview.value?.rejectedCount ?? '-' },
    { label: '已隐藏', value: overview.value?.hiddenCount ?? '-' },
    { label: '词库', value: overview.value?.dictionaryCount ?? '-' },
    { label: '地区策略', value: overview.value?.regionPolicyCount ?? '-' }
]);

const runtimeRows = computed<AdminStatusMatrixItem[]>(() => [
    { label: '全局状态', value: formatRuntimeStatus(runtime.value?.globalState) },
    { label: '地区覆盖', value: Object.keys(runtime.value?.regionStates ?? {}).length },
    { label: '已关闭词库', value: runtime.value?.disabledDictionaryIds.length ?? '-' },
    { label: '模型快照', value: runtime.value?.model.snapshotId ?? '-' },
    { label: '最近修改人', value: runtime.value?.changedBy ?? '-' }
]);

const modelStateLabel = computed(() =>
{
    if (!overview.value?.modelEnabled)
    {
        return '已关闭';
    }

    const provider = (overview.value.modelProvider ?? '').trim().toLowerCase();
    return provider === '' || provider === 'none' || provider === 'mock' ? '本地' : '远程';
});

const loadDashboard = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        const [overviewResponse, runtimeResponse] = await Promise.all([
            getModerationOverview(),
            getModerationRuntimeStatus()
        ]);
        overview.value = overviewResponse;
        runtime.value = runtimeResponse;
        globalStateDraft.value = runtimeResponse.globalState;
    }
    catch (error)
    {
        showErrorToast(error, '审核系统总览加载失败');
    }
    finally
    {
        loading.value = false;
    }
};


const saveGlobalState = async (): Promise<void> =>
{
    savingGlobalState.value = true;
    taskFeedback.begin('正在更新全局审核状态', formatRuntimeStatus(globalStateDraft.value), 'moderation-global-runtime');
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        runtime.value = await setModerationGlobalState({
            state: globalStateDraft.value,
            reason: 'global_runtime_state_update'
        }, { mfaProofToken });
        globalStateDraft.value = runtime.value.globalState;
        taskFeedback.succeed('全局审核状态已更新', formatRuntimeStatus(runtime.value.globalState), 'moderation-global-runtime');
        toast.success('全局审核状态已更新');
        await loadDashboard();
    }
    catch (error)
    {
        taskFeedback.fail('全局审核状态更新失败', error, '全局审核状态更新失败', 'moderation-global-runtime');
        showErrorToast(error, '全局审核状态更新失败');
    }
    finally
    {
        savingGlobalState.value = false;
    }
};

onMounted(() =>
{
    void loadDashboard();
});
</script>

<style scoped>
.tabular-nums
 {
    font-variant-numeric: tabular-nums;
}

.moderation-runtime-control
 {
    display: grid;
    grid-template-columns: minmax(12rem, 16rem) auto;
    align-items: end;
    gap: var(--fsus-space-3);
    padding: var(--fsus-space-3) var(--fsus-space-4);
    border-top: 1px solid var(--fsusblog-panel-border);
}

.moderation-runtime-control__field
 {
    display: grid;
    gap: var(--fsus-space-2);
    min-width: 0;
}

.moderation-runtime-control__label
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.moderation-runtime-control__button
 {
    justify-self: start;
}

@media (width <= 639px)
 {
    .moderation-runtime-control
 {
        grid-template-columns: 1fr;
    }

    .moderation-runtime-control__button
 {
        justify-self: stretch;
    }
}
</style>
