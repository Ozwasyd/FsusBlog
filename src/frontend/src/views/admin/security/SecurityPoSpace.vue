<template>
    <div class="space-y-8">
        <FsusUiSettingsSection
            title="设备内存验证"
            description="高风险操作时，让当前设备占用少量内存和计算资源完成验证，提高批量脚本成本。"
            id="security-pospace-title"
        >
            <template #actions>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    @click="loadPage"
                >刷新</ElButton>
            </template>

            <AdminStatusMatrix
                :items="metrics"
                density="compact"
                aria-label="PoSpace 指标"
            />
        </FsusUiSettingsSection>

        <section class="grid gap-8 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险控制绑定</div>
                </div>
                <AdminStatusMatrix
                    :items="policyRows"
                    density="compact"
                    aria-label="PoSpace 风险控制绑定"
                />
            </div>

            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近尝试</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="attempt in attempts"
                        :key="attempt.attemptId"
                        class="grid gap-3 p-5 md:grid-cols-[1fr_auto]"
                    >
                        <div class="min-w-0">
                            <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
                            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatAttemptContext(attempt.action, attempt.routeKey) }}</div>
                        </div>
                        <ElTag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ formatOutcome(attempt.outcome) }}</ElTag>
                    </div>
                    <div
                        v-if="attempts.length === 0"
                        class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]"
                    >暂无 PoSpace 尝试记录</div>
                </div>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';

import {
    getSecurityChallengeMetrics,
    getSecurityPolicyConsole,
    type SecurityChallengeMetricsResponse,
    type SecurityPolicyConsoleResponse
} from '@/api/security';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import { FsusUiSettingsSection } from '@/fsusui';
import { Refresh } from '@/fsusui/icons';
import { showErrorToast } from '@/utils/errorPresentation';

const argon2idPoSpaceV1 = 'argon2idPoSpaceV1';
const poSpaceDisplayName = '设备内存验证';
const loading = shallowRef(false);
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null);
const policyState = shallowRef<SecurityPolicyConsoleResponse | null>(null);

const attempts = computed(() => metricsState.value?.recentAttempts ?? []);

const formatPercent = (value: number | null | undefined): string =>
    `${Math.round((value ?? 0) * 1000) / 10}%`;

const formatOutcome = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        verified: '已通过',
        failed: '未通过',
        replayed: '重放拦截',
        expired: '已过期'
    };
    return value ? labels[value] ?? `结果代码：${value}` : '结果未知';
};

const formatAttemptContext = (action: string | null | undefined, routeKey: string | null | undefined): string =>
{
    const actionText = formatRiskAction(action);
    const routeText = formatRiskAction(routeKey);
    return actionText === routeText ? actionText : `${actionText} / ${routeText}`;
};

const formatRiskAction = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        'admin.comment.batch': '后台批量评论处理',
        'admin.security.write': '后台安全策略写入',
        'auth.login': '登录',
        'auth.passkey.begin': '开始 Passkey 验证',
        'auth.passkey.complete': '完成 Passkey 验证',
        'comment.create': '发表评论',
        'comment.reply': '回复评论',
        'notification.subscribe': '订阅通知流',
        'public.read': '公开读取',
        'recovery-key.verify': '恢复密钥验证'
    };
    return value ? labels[value] ?? value : '未知动作';
};

const formatPolicyMode = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        disabled: '关闭',
        dryRun: '仅记录',
        dry_run: '仅记录',
        enforce: '强制验证',
        observe: '观察',
        strict: '严格'
    };
    return value ? labels[value] ?? value : '-';
};

const hardChallengeActions = computed(() =>
{
    const activePolicy = policyState.value?.activePolicy;
    if (!activePolicy)
    {
        return [];
    }
    return Object.values(activePolicy.actionOverrides ?? {})
        .filter((item) => item.hardChallengeKinds?.includes(argon2idPoSpaceV1))
        .map((item) => formatRiskAction(item.actionName));
});

const policyRows = computed<AdminStatusMatrixItem[]>(() => [
    { label: '验证方式', value: poSpaceDisplayName },
    { label: '全局模式', value: formatPolicyMode(policyState.value?.activePolicy.globalMode) },
    { label: '触发验证的操作', value: hardChallengeActions.value.join(', ') || '-' },
    { label: '最高风险分', value: String(policyState.value?.activePolicy.maxRiskScore ?? '-') }
]);

const metrics = computed<AdminStatusMatrixItem[]>(() => [
    { label: '发起', value: metricsState.value?.totalIssued ?? '-' },
    { label: '提交', value: metricsState.value?.totalAttempts ?? '-' },
    { label: '成功率', value: formatPercent(metricsState.value?.successRate) },
    { label: '失败率', value: formatPercent(metricsState.value?.failureRate) }
]);

const loadPage = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        const [challengeMetrics, policyConsole] = await Promise.all([
            getSecurityChallengeMetrics({ kind: argon2idPoSpaceV1 }),
            getSecurityPolicyConsole()
        ]);
        metricsState.value = challengeMetrics;
        policyState.value = policyConsole;
    }
    catch (error)
    {
        showErrorToast(error, 'PoSpace 验证加载失败');
    }
    finally
    {
        loading.value = false;
    }
};

onMounted(() =>
{
    void loadPage();
});
</script>
