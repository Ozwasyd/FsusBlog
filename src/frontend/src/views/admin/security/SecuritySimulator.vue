<template>
    <div class="space-y-8">
        <FsusUiSettingsSection
            title="风险模拟器"
            :description="result ? `策略版本：${result.policyVersion}` : ''"
            id="security-simulator-title"
        >
            <template #actions>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    type="primary"
                    @click="runSimulation"
                >运行</ElButton>
            </template>

            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.45fr)]">
                <ElForm
                    label-position="top"
                    class="grid gap-4 md:grid-cols-2"
                >
                    <ElFormItem label="动作">
                        <ElSelect
                            v-model="form.action"
                            class="w-full"
                            filterable
                        >
                            <ElOption
                                v-for="item in actionOptions"
                                :key="item.value"
                                :label="item.label"
                                :value="item.value"
                            />
                        </ElSelect>
                        <div class="mt-2 text-[12px] leading-5 text-[var(--fsusblog-text-muted)]">
                            路由标识：{{ derivedRouteKey }}
                        </div>
                    </ElFormItem>
                    <ElFormItem label="风险分">
                        <ElInputNumber
                            v-model="form.riskScore"
                            class="w-full"
                            :min="0"
                            :max="500"
                            :step="5"
                            controls-position="right"
                        />
                        <div class="risk-score-scale">
                            <span class="risk-score-scale__label">累计风险</span>
                            <span
                                v-for="item in riskScoreThresholds"
                                :key="item.score"
                                class="risk-score-scale__item"
                            >
                                <span class="risk-score-scale__score">{{ item.score }}</span>
                                <span>{{ item.label }}</span>
                            </span>
                        </div>
                    </ElFormItem>
                    <ElFormItem label="访问来源 IP">
                        <ElInput v-model="form.clientIp" />
                        <div class="mt-2 flex flex-wrap gap-2 text-[12px] leading-5 text-[var(--fsusblog-text-muted)]">
                            <span>计分对象：{{ derivedSubject || '-' }}</span>
                            <span>IP 归属地：{{ derivedRegionLabel }}</span>
                        </div>
                        <div class="mt-2 text-[12px] leading-5 text-[var(--fsusblog-text-muted)]">
                            只需要填来源 IP；模拟器会用它派生计分对象，并用模拟解析结果填充归属地。
                        </div>
                    </ElFormItem>
                    <ElFormItem label="登录状态">
                        <ElSelect
                            v-model="form.actorStatus"
                            class="w-full"
                        >
                            <ElOption
                                v-for="item in actorStatusOptions"
                                :key="item.value"
                                :label="item.label"
                                :value="item.value"
                            />
                        </ElSelect>
                        <div class="mt-2 text-[12px] leading-5 text-[var(--fsusblog-text-muted)]">
                            账号来源：{{ derivedIdentityKindLabel }}
                        </div>
                    </ElFormItem>
                    <ElFormItem label="设备指纹">
                        <ElInput v-model="form.deviceFingerprint" />
                    </ElFormItem>
                    <ElFormItem label="User-Agent">
                        <ElInput v-model="form.userAgent" />
                    </ElFormItem>
                </ElForm>

                <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                    <button
                        v-for="preset in presets"
                        :key="preset.label"
                        type="button"
                        class="flex w-full items-center justify-between border-b border-[var(--fsusblog-panel-border)] px-5 py-4 text-left transition hover:bg-[var(--fsusblog-page-bg-soft)]"
                        @click="applyPreset(preset)"
                    >
                        <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ preset.label }}</span>
                        <span class="text-[12px] font-medium text-[var(--fsusblog-text-muted)] tabular-nums">{{ preset.riskScore }}</span>
                    </button>
                </div>
            </div>
        </FsusUiSettingsSection>

        <section class="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">决策</div>
                    <div class="mt-2 text-base font-bold text-[var(--fsusblog-text-primary)]">{{ formatDecision(result?.decision) }}</div>
                </div>
                <AdminStatusMatrix
                    :items="resultMetrics"
                    density="compact"
                    aria-label="风险模拟结果指标"
                />
            </div>

            <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">命中原因</div>
                </div>
                <div class="grid gap-px bg-[var(--fsusblog-panel-border)]">
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">需要的验证任务</div>
                        <div class="mt-3 flex flex-wrap gap-2">
                            <ElTag
                                v-for="item in result?.requiredChallenges ?? []"
                                :key="item"
                                type="warning"
                            >{{ formatChallengeKind(item) }}</ElTag>
                            <span
                                v-if="(result?.requiredChallenges ?? []).length === 0"
                                class="text-[12px] text-[var(--fsusblog-text-muted)]"
                            >无需验证任务</span>
                        </div>
                    </div>
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="flex flex-wrap gap-2">
                            <ElTag
                                v-for="item in result?.reasons ?? []"
                                :key="item"
                            >{{ item }}</ElTag>
                            <span
                                v-if="(result?.reasons ?? []).length === 0"
                                class="text-[12px] text-[var(--fsusblog-text-muted)]"
                            >尚未返回原因</span>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, shallowRef } from 'vue';

import { simulateRiskControl, type RiskControlSimulationRequest, type RiskControlSimulationResponse } from '@/api/security';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import { FsusUiSettingsSection } from '@/fsusui';
import { Refresh } from '@/fsusui/icons';
import { showErrorToast } from '@/utils/errorPresentation';

interface Preset {
    label: string;
    riskScore: number;
}

const loading = shallowRef(false);
const result = shallowRef<RiskControlSimulationResponse | null>(null);

type SimulatorFormFields = Omit<RiskControlSimulationRequest, 'routeKey' | 'subject' | 'region' | 'identityKind' | 'verifiedCrawler' | 'socialPreviewBot'>;
type SimulatorForm = {
    [Key in keyof SimulatorFormFields]-?: NonNullable<SimulatorFormFields[Key]>;
};

const form = reactive<SimulatorForm>({
    action: 'comment.create',
    riskScore: 50,
    clientIp: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
    deviceFingerprint: 'device-123456',
    actorStatus: 'anonymous'
});

const toIpSubject = (ip: string): string =>
{
    const normalized = ip.trim();
    return normalized ? `ip:${normalized}` : '';
};

const derivedSubject = computed(() => toIpSubject(form.clientIp));

const actionOptions = [
    { label: '发布评论', value: 'comment.create', routeKey: 'comment.create' },
    { label: '回复评论', value: 'comment.reply', routeKey: 'comment.reply' },
    { label: '登录', value: 'auth.login', routeKey: 'auth.login' },
    { label: '发起 Passkey 登录', value: 'auth.passkey.begin', routeKey: 'auth.passkey.begin' },
    { label: '订阅通知', value: 'notification.subscribe', routeKey: 'notification.subscribe' },
    { label: '写入安全策略', value: 'admin.security.write', routeKey: 'admin.security.write' },
    { label: '批量处理评论', value: 'admin.comment.batch', routeKey: 'admin.comment.batch' }
] as const;

const selectedAction = computed(() => actionOptions.find((item) => item.value === form.action) ?? actionOptions[0]);
const derivedRouteKey = computed(() => selectedAction.value.routeKey);

const actorStatusOptions = [
    { label: '未登录访客', value: 'anonymous' },
    { label: '已登录账号', value: 'authenticated' },
    { label: '管理员会话', value: 'admin_principal' }
] as const;

const deriveRegionForSimulation = (ip: string): string =>
{
    const normalized = ip.trim();
    if (normalized.length === 0)
    {
        return 'UNKNOWN';
    }
    if (normalized.startsWith('223.') || normalized.startsWith('114.114.'))
    {
        return 'CN-MAINLAND';
    }
    if (normalized.startsWith('1.1.1.') || normalized.startsWith('8.8.8.'))
    {
        return 'OVERSEAS';
    }
    return 'UNKNOWN';
};

const formatRegion = (region: string): string =>
{
    const labels: Record<string, string> = {
        UNKNOWN: '未知地区',
        'CN-MAINLAND': '中国大陆',
        'CN-HK': '中国香港',
        'CN-MO': '中国澳门',
        'CN-TW': '中国台湾',
        OVERSEAS: '海外'
    };
    return labels[region] ?? region;
};

const derivedRegion = computed(() => deriveRegionForSimulation(form.clientIp));
const derivedRegionLabel = computed(() => formatRegion(derivedRegion.value));

const deriveIdentityKind = (actorStatus: string): string =>
{
    if (actorStatus === 'admin_principal')
    {
        return 'admin_principal';
    }
    if (actorStatus === 'authenticated')
    {
        return 'legacy_user';
    }
    return 'anonymous';
};

const derivedIdentityKind = computed(() => deriveIdentityKind(form.actorStatus));

const presets: Preset[] = [
    { label: '放行', riskScore: 10 },
    { label: '要求验证', riskScore: 50 },
    { label: '进入队列', riskScore: 90 },
    { label: '直接拦截', riskScore: 125 }
];

const riskScoreThresholds = [
    { score: 50, label: '要求验证' },
    { score: 90, label: '进入队列' },
    { score: 125, label: '直接拦截' }
] as const;

const formatDecision = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        allow: '放行',
        challenge: '要求验证',
        hard_challenge: '强验证',
        queue: '进入队列',
        block: '直接拦截'
    };
    return value ? labels[value] ?? value : '-';
};

const formatActorStatus = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        anonymous: '未登录访客',
        authenticated: '已登录账号',
        admin_principal: '管理员会话'
    };
    return value ? labels[value] ?? value : '-';
};

const formatIdentityKind = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        anonymous: '未登录访客',
        anonymous_account: '匿名账号体系',
        legacy_user: '旧版登录账号',
        admin_principal: '管理员凭证'
    };
    return value ? labels[value] ?? value : '-';
};

const derivedIdentityKindLabel = computed(() => formatIdentityKind(derivedIdentityKind.value));

const formatChallengeKind = (value: string | null | undefined): string =>
{
    const labels: Record<string, string> = {
        argon2idPoSpaceV1: 'PoSpace 验证',
        perceptionSealedV2: 'Perception V2'
    };
    return value ? labels[value] ?? value : '-';
};

const resultMetrics = computed<AdminStatusMatrixItem[]>(() => [
    { label: '原始风险分', value: result.value?.riskScore ?? '-' },
    { label: '生效风险分', value: result.value?.effectiveRiskScore ?? '-' },
    { label: '升级级别', value: result.value?.escalationLevel ?? '-' },
    { label: '策略版本', value: result.value?.policyVersion ?? '-' },
    { label: '动作', value: result.value?.action ?? '-' },
    { label: '路由标识', value: result.value?.routeKey ?? '-' },
    { label: '计分对象', value: result.value?.subject ?? '-' },
    { label: '登录状态', value: formatActorStatus(result.value?.actorStatus) },
    { label: '账号来源', value: formatIdentityKind(result.value?.identityKind) }
]);

const applyPreset = (preset: Preset): void =>
{
    form.riskScore = preset.riskScore;
};

const runSimulation = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        result.value = await simulateRiskControl({
            ...form,
            routeKey: derivedRouteKey.value,
            subject: derivedSubject.value,
            region: derivedRegion.value,
            identityKind: derivedIdentityKind.value,
            verifiedCrawler: false,
            socialPreviewBot: false
        });
    }
    catch (error)
    {
        showErrorToast(error, '风险模拟失败');
    }
    finally
    {
        loading.value = false;
    }
};
</script>

<style scoped>
.risk-score-scale
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-1);
    flex-basis: 100%;
    width: 100%;
    margin-top: var(--fsus-space-3);
    max-width: 100%;
}

.risk-score-scale__label
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.25rem;
}

.risk-score-scale__item
 {
    display: inline-flex;
    align-items: center;
    gap: var(--fsus-space-1);
    min-height: 1.75rem;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-pill);
    padding: 0 var(--fsus-space-2);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
}

.risk-score-scale__score
 {
    color: var(--fsusblog-text-primary);
    font-variant-numeric: tabular-nums;
}
</style>
