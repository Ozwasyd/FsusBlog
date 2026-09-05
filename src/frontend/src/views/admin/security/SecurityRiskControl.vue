<template>
    <div class="space-y-8">
        <FsusUiSettingsSection
            title="风险控制"
            :description="consoleState ? `策略版本：${activePolicy?.policyVersion ?? '-'}` : ''"
            id="security-risk-control-title"
        >
            <template #actions>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    @click="loadConsole"
                >刷新</ElButton>
            </template>

            <AdminStatusMatrix
                :items="metrics"
                density="compact"
                aria-label="风险控制指标"
            />
        </FsusUiSettingsSection>

        <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.72fr)]">
            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="grid gap-3 border-b border-[var(--fsusblog-panel-border)] p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                    <div>
                        <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">策略执行模式</div>
                        <div class="mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-muted)]">{{ globalModeDescription }}</div>
                    </div>
                    <ElTag
                        class="w-fit justify-self-start md:justify-self-end"
                        :type="activePolicy?.globalMode === 'enforce' ? 'success' : 'info'"
                    >
                        {{ formatSecurityMode(activePolicy?.globalMode) }}
                    </ElTag>
                </div>
                <div class="overflow-x-auto blog-scroll-x-safe">
                    <table class="w-full min-w-full text-left text-[12px]">
                        <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
                            <tr class="border-b border-[var(--fsusblog-panel-border)]">
                                <th class="px-5 py-3">动作</th>
                                <th class="px-5 py-3">验证任务</th>
                                <th class="px-5 py-3">升级</th>
                                <th class="px-5 py-3">阈值</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in actionPolicyRows"
                                :key="row.actionName"
                                class="border-b border-[var(--fsusblog-panel-border)]"
                            >
                                <td class="px-5 py-3 font-bold text-[var(--fsusblog-text-primary)]">{{ row.actionLabel }}</td>
                                <td class="px-5 py-3 whitespace-nowrap">{{ row.challengeKind || '-' }}</td>
                                <td class="px-5 py-3 tabular-nums">{{ row.escalationLevel }}</td>
                                <td class="px-5 py-3 tabular-nums whitespace-nowrap">{{ row.thresholds }}</td>
                            </tr>
                            <tr v-if="actionPolicyRows.length === 0">
                                <td
                                    colspan="4"
                                    class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]"
                                >暂无策略动作</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">子系统模式</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="row in subsystemRows"
                        :key="row.name"
                        class="flex items-center justify-between gap-4 p-5"
                    >
                        <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ formatSubsystemName(row.name) }}</span>
                        <ElTag>{{ formatSecurityMode(row.mode) }}</ElTag>
                    </div>
                    <div
                        v-if="subsystemRows.length === 0"
                        class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]"
                    >暂无子系统策略配置</div>
                </div>
            </div>
        </section>

        <section class="grid gap-8 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险事件聚合</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="row in riskEventAggregate"
                        :key="`${row.source}:${row.reason}`"
                        class="grid gap-3 p-5 md:grid-cols-[1fr_auto]"
                    >
                        <div>
                            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ formatRiskSource(row.source) }} / {{ formatRiskReason(row.reason) }}</div>
                            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">最近：{{ formatTime(row.lastOccurredAtUtc) }}</div>
                        </div>
                        <div class="text-right text-sm font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ row.count }} 次 / +{{ row.scoreDeltaSum }}</div>
                    </div>
                    <div
                        v-if="riskEventAggregate.length === 0"
                        class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]"
                    >暂无聚合事件</div>
                </div>
            </div>

            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">高风险主体</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="snapshot in topRiskSnapshots"
                        :key="snapshot.subject"
                        class="flex items-center justify-between gap-4 p-5"
                    >
                        <div class="min-w-0">
                            <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ snapshot.subject }}</div>
                            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatRiskSource(snapshot.lastSource) }} / {{ formatRiskReason(snapshot.lastReason) }}</div>
                        </div>
                        <ElTag type="warning">{{ snapshot.score }}</ElTag>
                    </div>
                    <div
                        v-if="topRiskSnapshots.length === 0"
                        class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]"
                    >暂无风险快照</div>
                </div>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';

import { getRiskControlConsole, type RiskControlConsoleResponse, type SecurityRiskActionPolicy } from '@/api/security';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import { FsusUiSettingsSection } from '@/fsusui';
import { Refresh } from '@/fsusui/icons';
import { showErrorToast } from '@/utils/errorPresentation';

const loading = shallowRef(false);
const consoleState = shallowRef<RiskControlConsoleResponse | null>(null);

const activePolicy = computed(() => consoleState.value?.activePolicy ?? null);
const riskEventAggregate = computed(() => consoleState.value?.riskEventAggregate ?? []);
const topRiskSnapshots = computed(() => consoleState.value?.topRiskSnapshots ?? []);

const formatSecurityMode = (mode: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        disabled: '已关闭',
        observe: '观察',
        enforce: '强制执行',
        strict: '严格',
        lockdown: '锁定',
        dryRun: '仅记录',
        dry_run: '仅记录'
    };
    return mode ? labels[mode] ?? mode : '-';
};

const formatSecurityModeDescription = (mode: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        disabled: '风险控制不会触发验证或拦截。',
        observe: '只记录命中的风险信号，不影响用户操作。',
        enforce: '命中阈值后会要求验证；达到拦截线会直接拒绝请求。',
        strict: '使用更严格的阈值处理高风险请求。',
        lockdown: '进入锁定状态，只放行明确允许的低风险请求。',
        dryRun: '只写入策略结果，用于上线前观察。',
        dry_run: '只写入策略结果，用于上线前观察。'
    };
    return mode ? labels[mode] ?? '使用当前策略处理风险请求。' : '暂无生效策略。';
};

const globalModeDescription = computed(() => formatSecurityModeDescription(activePolicy.value?.globalMode));

const formatPercent = (value: number | null | undefined): string =>
    `${Math.round((value ?? 0) * 1000) / 10}%`;

const formatTime = (value: string | null | undefined): string =>
    value ? new Date(value).toLocaleString() : '-';

const formatChallengeKind = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        sha256PowV1: '工作量证明',
        argon2idPoSpaceV1: '设备内存验证',
        perceptionSealedV2: '人机感知验证',
        localizationV2: '点选定位题',
        microInteractionV2: '微交互题'
    };
    return value ? labels[value] ?? value : '-';
};

const formatRiskAction = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        '*': '默认规则',
        'public.read': '公开读取',
        'comment.create': '发表评论',
        'comment.reply': '回复评论',
        'auth.login': '登录',
        'auth.passkey.begin': '开始 Passkey 验证',
        'auth.passkey.complete': '完成 Passkey 验证',
        'recovery-key.verify': '恢复密钥验证',
        'notification.subscribe': '订阅通知流',
        'admin.security.write': '后台安全策略写入',
        'admin.comment.batch': '后台批量评论处理'
    };
    return value ? labels[value] ?? value : '-';
};

const formatSubsystemName = (value: string): string =>
{
    const labels: Record<string, string> = {
        antiCrawler: '反爬虫',
        anti_crawler: '反爬虫',
        'anti-crawler': '反爬虫',
        auth: '认证',
        pow: '工作量证明',
        riskControl: '风险控制',
        risk_control: '风险控制',
        'risk-control': '风险控制',
        'comment-governance': '评论治理',
        publicRead: '公开读取',
        public_read: '公开读取',
        'public-read': '公开读取',
        pospace: '设备内存验证',
        poSpace: '设备内存验证',
        perceptionSealedV2: '人机感知验证',
        perception: '人机感知验证',
        'perception-localization': '点选定位题',
        'perception-micro-interaction': '微交互题'
    };
    return labels[value] ?? value;
};

const riskSourceLabels: Record<string, string> = {
    'anti-crawler': '反爬虫',
    auth: '认证',
    'comment-governance': '评论治理',
    'device-fingerprint': '设备指纹',
    'human-read-proof': '阅读证明',
    passkey: 'Passkey',
    perception: '人机感知验证',
    'perception-localization': '点选定位题',
    'perception-micro-interaction': '微交互题',
    pospace: '设备内存验证',
    pow: '工作量证明',
    'public-read': '公开读取',
    'rate-limiter': '限流',
    'region-policy': '区域策略',
    'risk-control': '风险控制',
    'admin-step-up': '管理员二次验证'
};

const riskReasonLabels: Record<string, string> = {
    AdminStepUpFailed: '管理员二次验证失败',
    AdminStepUpRequired: '需要管理员二次验证',
    AnonymousNullifierAbuse: '匿名凭据滥用',
    AuthFailureBurst: '登录失败过多',
    AuthLoginFailed: '登录失败',
    BlockedUserAgent: 'User-Agent 被拦截',
    ChallengeExpired: '验证任务过期',
    ChallengeKindMismatch: '验证任务类型不匹配',
    ChallengeSignatureInvalid: '验证任务签名无效',
    CommentNullifierAbuse: '评论匿名凭据滥用',
    CommentRegionCompliance: '评论区域合规命中',
    CommentSpamPattern: '评论垃圾模式',
    CommentSpamPatternHit: '评论垃圾模式命中',
    DeviceFingerprintChanged: '设备指纹变化',
    DeviceFingerprintMissing: '缺少设备指纹',
    FakeCrawler: '伪装爬虫',
    PasskeyAssertionAccepted: 'Passkey 验证通过',
    PasskeyAssertionFailed: 'Passkey 验证失败',
    PasskeyAssertionFailure: 'Passkey 验证失败',
    PowInvalid: '工作量证明无效',
    PowReplay: '工作量证明重放',
    PublicReadBlocked: '公开读取被拦截',
    PublicReadChallengeRequired: '公开读取需要验证',
    RateLimited: '触发限流',
    ReadProofAccepted: '阅读证明通过',
    ReadProofRejected: '阅读证明拒绝',
    RegionPolicyHit: '区域策略命中',
    SecurityChallengeRejected: '验证任务被拒绝',
    UnknownBot: '未知自动化访问',
    UserAgentMissing: '缺少 User-Agent',
    VerifiedCrawler: '已验证爬虫'
};

const formatRiskText = (value: string | null | undefined, labels: Record<string, string>): string =>
{
    if (!value)
    {
        return '-';
    }
    return labels[value] ?? value;
};

const formatRiskSource = (value: string | null | undefined): string => formatRiskText(value, riskSourceLabels);

const formatRiskReason = (value: string | null | undefined): string => formatRiskText(value, riskReasonLabels);

const formatThresholds = (policy: SecurityRiskActionPolicy): string =>
    `${policy.thresholds.challengeScore}/${policy.thresholds.hardChallengeScore}/${policy.thresholds.queueScore}/${policy.thresholds.blockScore}`;

const actionPolicyRows = computed(() =>
{
    const policy = activePolicy.value;
    if (!policy)
    {
        return [];
    }
    const overrides = Object.values(policy.actionOverrides ?? {});
    return [
        policy.defaultAction,
        ...overrides
    ].map((item) => ({
        actionName: item.actionName,
        actionLabel: formatRiskAction(item.actionName),
        challengeKind: formatChallengeKind(item.challengeKind),
        escalationLevel: item.escalationLevel,
        thresholds: formatThresholds(item)
    }));
});

const subsystemRows = computed(() =>
    Object.entries(activePolicy.value?.subsystemModes ?? {}).map(([name, mode]) => ({ name, mode }))
);

const metrics = computed<AdminStatusMatrixItem[]>(() => [
    { label: '全局模式', value: formatSecurityMode(activePolicy.value?.globalMode) },
    { label: '24 小时风险事件', value: consoleState.value?.risk.eventsLastDay ?? '-' },
    { label: '验证通过率', value: formatPercent(consoleState.value?.challengeMetrics.successRate) },
    { label: '验证失败率', value: formatPercent(consoleState.value?.challengeMetrics.failureRate) }
]);

const loadConsole = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        consoleState.value = await getRiskControlConsole();
    }
    catch (error)
    {
        showErrorToast(error, '风险控制加载失败');
    }
    finally
    {
        loading.value = false;
    }
};

onMounted(() =>
{
    void loadConsole();
});
</script>
