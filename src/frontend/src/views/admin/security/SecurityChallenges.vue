<template>
    <div class="space-y-8">
        <FsusUiSettingsSection
            title="客户端验证能力"
            :description="`构建清单 ${capabilityManifestVersion}；能力状态不包含设备、身份或 Proof 数据。`"
            id="security-challenge-capabilities-title"
        >
            <div class="blog-scroll-x-safe security-challenges-table-scroll border-y border-[var(--fsusblog-panel-border)]">
                <table
                    class="w-full min-w-[52rem] md:min-w-[58rem] text-left text-[12px]"
                    data-test="challenge-capability-matrix"
                >
                    <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
                        <tr class="border-b border-[var(--fsusblog-panel-border)]">
                            <th class="px-5 py-3 whitespace-nowrap">类型</th>
                            <th class="px-5 py-3 whitespace-nowrap">契约可表达</th>
                            <th class="px-5 py-3 whitespace-nowrap">当前客户端可执行</th>
                            <th class="px-5 py-3 whitespace-nowrap">策略可启用 / 模式</th>
                            <th class="px-5 py-3 whitespace-nowrap">Provider</th>
                            <th class="px-5 py-3 whitespace-nowrap">业务表面</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="row in capabilityRows"
                            :key="row.wireName"
                            class="border-b border-[var(--fsusblog-panel-border)]"
                        >
                            <td class="px-5 py-3 whitespace-nowrap font-bold text-[var(--fsusblog-text-primary)]">{{ row.wireName }}</td>
                            <td
                                class="px-5 py-3 whitespace-nowrap"
                                :data-test="`capability-contract-${row.wireName}`"
                            >{{ row.contractLabel }}</td>
                            <td
                                class="px-5 py-3 whitespace-nowrap"
                                :data-test="`capability-client-${row.wireName}`"
                            >{{ row.clientExecutionLabel }}</td>
                            <td
                                class="px-5 py-3 whitespace-nowrap"
                                :data-test="`capability-policy-${row.wireName}`"
                            >{{ row.policyLabel }}</td>
                            <td class="px-5 py-3 whitespace-nowrap">{{ statusLabel(row.providerAvailable) }}</td>
                            <td class="px-5 py-3 whitespace-nowrap">{{ row.surfaces }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            title="验证任务状态"
            :description="metricsState ? `统计窗口起点：${formatTime(metricsState.windowStartedAtUtc)}` : ''"
            id="security-challenges-title"
        >
            <template #actions>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    @click="loadMetrics"
                >刷新</ElButton>
            </template>

            <AdminStatusMatrix
                :items="headerMetrics"
                density="compact"
                aria-label="验证任务状态指标"
            />
        </FsusUiSettingsSection>

        <section class="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">验证任务类型</div>
                </div>
                <div class="blog-scroll-x-safe security-challenges-table-scroll">
                    <table
                        class="w-full min-w-[34rem] md:min-w-[42rem] text-left text-[12px]"
                        data-test="challenge-kind-breakdown"
                    >
                        <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
                            <tr class="border-b border-[var(--fsusblog-panel-border)]">
                                <th class="px-5 py-3 whitespace-nowrap">类型</th>
                                <th class="px-5 py-3 whitespace-nowrap">发起</th>
                                <th class="px-5 py-3 whitespace-nowrap">提交</th>
                                <th class="px-5 py-3 whitespace-nowrap">通过率</th>
                                <th class="px-5 py-3 whitespace-nowrap">失败率</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in kindBreakdown"
                                :key="row.kind"
                                class="border-b border-[var(--fsusblog-panel-border)]"
                            >
                                <td class="px-5 py-3 whitespace-nowrap font-bold text-[var(--fsusblog-text-primary)]">{{ row.kind }}</td>
                                <td class="px-5 py-3 whitespace-nowrap tabular-nums">{{ row.totalIssued }}</td>
                                <td class="px-5 py-3 whitespace-nowrap tabular-nums">{{ row.totalAttempts }}</td>
                                <td class="px-5 py-3 whitespace-nowrap tabular-nums">{{ formatPercent(row.successRate) }}</td>
                                <td class="px-5 py-3 whitespace-nowrap tabular-nums">{{ formatPercent(row.failureRate) }}</td>
                            </tr>
                            <tr v-if="kindBreakdown.length === 0">
                                <td
                                    colspan="5"
                                    class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]"
                                >暂无验证任务数据</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近提交</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="attempt in recentAttempts"
                        :key="attempt.attemptId"
                        class="grid gap-3 p-5 md:grid-cols-[1fr_auto]"
                    >
                        <div class="min-w-0">
                            <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
                            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ attempt.kind }} / {{ attempt.action }} / {{ attempt.routeKey }}</div>
                        </div>
                        <div class="text-right">
                            <ElTag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ formatOutcome(attempt.outcome) }}</ElTag>
                            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatTime(attempt.attemptedAtUtc) }}</div>
                        </div>
                    </div>
                    <div
                        v-if="recentAttempts.length === 0"
                        class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]"
                    >暂无验证提交记录</div>
                </div>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';

import {
    getRiskControlOptions,
    getSecurityChallengeMetrics,
    type SecurityChallengeMetricsResponse,
    type SecurityRiskPolicy
} from '@/api/security';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import { FsusUiSettingsSection } from '@/fsusui';
import { Refresh } from '@/fsusui/icons';
import {
    SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
    resolveChallengeCapability,
    securityChallengeCapabilityManifest
} from '@/security/challenge-capability-registry';
import { showErrorToast } from '@/utils/errorPresentation';

const loading = shallowRef(false);
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null);
const policyState = shallowRef<SecurityRiskPolicy | null>(null);

const successRate = computed(() => metricsState.value?.successRate ?? 0);
const failureRate = computed(() => metricsState.value?.failureRate ?? 0);
const kindBreakdown = computed(() => metricsState.value?.kindBreakdown ?? []);
const recentAttempts = computed(() => metricsState.value?.recentAttempts ?? []);
const capabilityManifestVersion = SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION;
const capabilityRows = computed(() => securityChallengeCapabilityManifest.map((item) =>
{
    const action = item.surfaces.includes('*') ? '*' : item.surfaces[0] ?? '';
    const executor = item.executorFactory?.() ?? null;
    const manifestCompatible = capabilityManifestVersion === SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION;
    const surfaceAvailable = item.surfaces.includes('*') || item.surfaces.includes(action);
    const uiClientExecutable = manifestCompatible && surfaceAvailable && item.uiHost !== null
        && (executor?.mode === 'ui' || executor?.mode === 'universal');
    const headlessClientExecutable = manifestCompatible && surfaceAvailable && item.headlessHost !== null
        && (executor?.mode === 'headless' || executor?.mode === 'universal');
    const uiPolicy = resolveChallengeCapability(item.kind, {
        action,
        mode: 'ui',
        manifestVersion: capabilityManifestVersion
    });
    const headlessPolicy = resolveChallengeCapability(item.kind, {
        action,
        mode: 'headless',
        manifestVersion: capabilityManifestVersion
    });
    const subsystem = challengeSubsystemByWireName[item.wireName];
    const policyMode = subsystem ? policyState.value?.subsystemModes[subsystem] : undefined;
    return {
        wireName: item.wireName,
        contractLabel: item.kindKnown ? '可表达' : '不可表达',
        providerAvailable: item.providerAvailable,
        clientExecutionLabel: executionModeLabel(uiClientExecutable, headlessClientExecutable, '不可执行'),
        policyLabel: uiPolicy.policyEligible || headlessPolicy.policyEligible
            ? `可启用（${executionModeLabel(uiPolicy.policyEligible, headlessPolicy.policyEligible, '-')}）；模式：${policyMode ?? '按动作策略'}`
            : '不可启用',
        surfaces: item.surfaces.length > 0 ? item.surfaces.join(', ') : '-'
    };
}));

const challengeSubsystemByWireName: Readonly<Record<string, string>> = Object.freeze({
    sha256PowV1: 'pow',
    argon2idPoSpaceV1: 'pospace',
    perceptionLocalizationV2: 'perception-localization',
    perceptionMicroInteractionV2: 'perception-micro-interaction'
});

const statusLabel = (available: boolean): string => available ? '可用' : '不可用';

const executionModeLabel = (ui: boolean, headless: boolean, fallback: string): string =>
{
    if (ui && headless)
    {
        return 'UI + Headless';
    }
    if (ui)
    {
        return 'UI';
    }
    if (headless)
    {
        return 'Headless';
    }
    return fallback;
};

const formatPercent = (value: number | null | undefined): string =>
    `${Math.round((value ?? 0) * 1000) / 10}%`;

const formatTime = (value: string | null | undefined): string =>
    value ? new Date(value).toLocaleString() : '-';

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

const headerMetrics = computed<AdminStatusMatrixItem[]>(() => [
    { label: '发起总量', value: metricsState.value?.totalIssued ?? '-' },
    { label: '提交总量', value: metricsState.value?.totalAttempts ?? '-' },
    { label: '通过次数', value: metricsState.value?.verified ?? '-' },
    { label: '通过率', value: formatPercent(successRate.value) },
    { label: '失败率', value: formatPercent(failureRate.value) }
]);

const loadMetrics = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        const [metrics, policy] = await Promise.all([
            getSecurityChallengeMetrics(),
            getRiskControlOptions()
        ]);
        metricsState.value = metrics;
        policyState.value = policy;
    }
    catch (error)
    {
        showErrorToast(error, '验证任务状态加载失败');
    }
    finally
    {
        loading.value = false;
    }
};

onMounted(() =>
{
    void loadMetrics();
});
</script>

<style scoped>
.security-challenges-table-scroll
{
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
}
</style>
