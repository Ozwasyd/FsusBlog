<template>
    <div class="space-y-8">
        <FsusUiSettingsSection
            title="PoW 系统"
            :description="overview ? `快照：${overview.policy.snapshotId}` : ''"
            id="security-pow-title"
        >
            <template #actions>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    @click="loadPow"
                >刷新</ElButton>
            </template>

            <AdminStatusMatrix
                :items="metrics"
                density="compact"
                aria-label="PoW 指标"
            />
        </FsusUiSettingsSection>

        <section class="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div
                class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
                :class="{
                    'blog-motion-task-region--pending': saving,
                    'blog-motion-task-region--settled': isTaskHighlighted('security-pow-options')
                }"
            >
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div>
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行策略</div>
                        <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">PoW 运行模式</div>
                    </div>
                    <div class="flex gap-2">
                        <ElButton
                            :loading="saving"
                            @click="rollbackOptions"
                        >回滚</ElButton>
                        <ElButton
                            type="primary"
                            :loading="saving"
                            @click="saveOptions"
                        >保存</ElButton>
                    </div>
                </div>

                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="grid gap-4 sm:grid-cols-[minmax(0,1.1fr)_minmax(9rem,0.55fr)_minmax(11rem,0.65fr)]">
                        <label class="min-w-0">
                            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">运行模式</span>
                            <ElSelect
                                v-model="draft.mode"
                                class="mt-2 w-full"
                                aria-label="PoW 运行模式"
                            >
                                <ElOption
                                    v-for="mode in modes"
                                    :key="mode"
                                    :label="formatSecurityMode(mode)"
                                    :value="mode"
                                />
                            </ElSelect>
                        </label>
                        <label class="min-w-0">
                            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">默认难度</span>
                            <ElInputNumber
                                v-model="draft.defaultDifficulty"
                                class="mt-2 w-full"
                                :min="1"
                                :max="12"
                                controls-position="right"
                            />
                        </label>
                        <label class="min-w-0">
                            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">Proof 有效期（秒）</span>
                            <ElInputNumber
                                v-model="draft.proofTtlSeconds"
                                class="mt-2 w-full"
                                :min="30"
                                :max="3600"
                                controls-position="right"
                            />
                        </label>
                    </div>
                </div>

                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="toggle in toggles"
                        :key="toggle.key"
                        class="flex items-center justify-between gap-4 bg-[var(--fsusblog-page-bg)] p-5"
                    >
                        <div>
                            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ toggle.label }}</div>
                            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ toggle.caption }}</div>
                        </div>
                        <ElSwitch v-model="draft[toggle.key]" />
                    </div>
                </div>
            </div>

            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">边界</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="row in boundaryRows"
                        :key="row.label"
                        class="p-5"
                    >
                        <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
                        <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ row.value }}</p>
                    </div>
                </div>
            </div>
        </section>

        <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
            <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行状态</div>
            </div>
            <AdminStatusMatrix
                :items="statusRows"
                density="compact"
                aria-label="PoW 运行状态"
            />
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue';

import {
    getPowOverview,
    rollbackPowOptions,
    updatePowOptions,
    type PowOverviewResponse,
    type PowPolicyOptions,
    type SecurityMode
} from '@/api/security';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { FsusUiSettingsSection } from '@/fsusui';
import { promptText, toast } from '@/fsusui/feedback';
import { Refresh } from '@/fsusui/icons';
import { showErrorToast } from '@/utils/errorPresentation';

const modes: SecurityMode[] = ['disabled', 'observe', 'enforce', 'strict'];

const formatSecurityMode = (mode: SecurityMode | string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        disabled: '已关闭',
        observe: '观察',
        enforce: '执行',
        strict: '严格'
    };
    return mode ? labels[mode] ?? mode : '-';
};

const formatEnabled = (value: boolean | null | undefined): string =>
    value === undefined || value === null ? '-' : value ? '已启用' : '已关闭';

const loading = shallowRef(false);
const saving = shallowRef(false);
const overview = shallowRef<PowOverviewResponse | null>(null);
const taskFeedback = useAdminTaskFeedback();
const {
    isHighlighted: isTaskHighlighted
} = taskFeedback;

const draft = reactive<PowPolicyOptions>({
    mode: 'enforce',
    defaultDifficulty: 4,
    adaptiveDifficultyEnabled: true,
    proofTtlSeconds: 300,
    replayProtectionEnabled: true,
    riskScoreLinkEnabled: true,
    challengeEndpoint: '/api/binary/auth/pow-challenge',
    verificationStrategy: 'RedisPowService'
});

const toggles = [
    { key: 'adaptiveDifficultyEnabled', label: '自适应难度', caption: '根据全局压力调整难度。' },
    { key: 'replayProtectionEnabled', label: '重放防护', caption: 'Proof nonce 一次性消费。' },
    { key: 'riskScoreLinkEnabled', label: '风险分联动', caption: '读取统一安全风险分。' }
] as const;

const metrics = computed<AdminStatusMatrixItem[]>(() => [
    { label: '运行模式', value: formatSecurityMode(overview.value?.policy.options.mode) },
    { label: '默认难度', value: overview.value?.policy.options.defaultDifficulty ?? '-' },
    { label: '1 小时校验失败', value: overview.value?.validationFailuresLastHour ?? '-' },
    { label: '1 小时重放拒绝', value: overview.value?.replayRejectsLastHour ?? '-' }
]);

const statusRows = computed<AdminStatusMatrixItem[]>(() => [
    { label: '验证端点', value: overview.value?.policy.options.challengeEndpoint ?? '-' },
    { label: '端点状态', value: overview.value?.challengeEndpointStatus ?? '-' },
    { label: '验证策略', value: overview.value?.policy.options.verificationStrategy ?? '-' },
    { label: '1 小时验证次数', value: overview.value?.challengeRequiredLastHour ?? '-' },
    { label: '自适应难度', value: formatEnabled(overview.value?.policy.options.adaptiveDifficultyEnabled) },
    { label: '重放防护', value: formatEnabled(overview.value?.policy.options.replayProtectionEnabled) },
    { label: '风险分联动', value: formatEnabled(overview.value?.policy.options.riskScoreLinkEnabled) }
]);

const boundaryRows = [
    { label: 'PoW 只管理验证任务与 Proof', value: 'PoW 页面只管理验证任务、Proof TTL、重放防护和难度。' },
    { label: '反爬虫只写入爬虫风险', value: '反爬虫系统不会拥有 PoW；它只写入爬虫类风险信号。' },
    { label: '风险信号共用', value: '公开读取过滤器读取统一风险分，再引用 security.pow 作为验证能力。' }
] as const;

const assignDraft = (options: PowPolicyOptions): void =>
{
    Object.assign(draft, options);
};

const loadPow = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        overview.value = await getPowOverview();
        assignDraft(overview.value.policy.options);
    }
    catch (error)
    {
        showErrorToast(error, 'PoW 系统加载失败');
    }
    finally
    {
        loading.value = false;
    }
};


const saveOptions = async (): Promise<void> =>
{
    saving.value = true;
    try
    {
        const reason = await promptText('变更原因', '保存 PoW 策略', {
            confirmButtonText: '保存',
            cancelButtonText: '取消',
            inputPlaceholder: '变更原因',
            inputValidator: (value: string) => value.trim().length > 0 || '请输入变更原因'
        });
        if (!reason)
        {
            return;
        }
        taskFeedback.begin('正在保存 PoW 策略', reason, 'security-pow-options');
        const mfaProofToken = await ensureAdminSensitiveProof();
        const snapshot = await updatePowOptions({ ...draft, reason }, { mfaProofToken });
        assignDraft(snapshot.options);
        taskFeedback.succeed('PoW 策略已更新', `默认难度：${snapshot.options.defaultDifficulty}`, 'security-pow-options');
        toast.success('PoW 策略已更新');
        await loadPow();
    }
    catch (error)
    {
        taskFeedback.fail('PoW 策略保存失败', error, 'PoW 策略保存失败', 'security-pow-options');
        showErrorToast(error, 'PoW 策略保存失败');
    }
    finally
    {
        saving.value = false;
    }
};

const rollbackOptions = async (): Promise<void> =>
{
    saving.value = true;
    taskFeedback.begin('正在回滚 PoW 策略', '需要管理员二次验证', 'security-pow-options');
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const snapshot = await rollbackPowOptions({ mfaProofToken });
        assignDraft(snapshot.options);
        taskFeedback.succeed('PoW 策略已回滚', `默认难度：${snapshot.options.defaultDifficulty}`, 'security-pow-options');
        toast.success('PoW 策略已回滚');
        await loadPow();
    }
    catch (error)
    {
        taskFeedback.fail('PoW 策略回滚失败', error, 'PoW 策略回滚失败', 'security-pow-options');
        showErrorToast(error, 'PoW 策略回滚失败');
    }
    finally
    {
        saving.value = false;
    }
};

onMounted(() =>
{
    void loadPow();
});
</script>
