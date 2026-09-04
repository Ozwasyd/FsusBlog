<template>
    <div class="admin-data-surface anonymous-governance-page">
        <FsusUiTaskPageHeader
            :title="section.title"
            :description="section.description"
            density="compact"
            title-tag="h2"
        />

        <FsusUiSettingsSection
            v-if="showRuntimeStatus"
            class="anonymous-governance-section"
            title="运行状态"
            :description="section.caption"
            :title-tag="'h2'"
        >
            <div class="anonymous-governance-status-grid">
                <div
                    v-for="signal in policySignals"
                    :key="signal.label"
                    class="anonymous-governance-signal"
                >
                    <span>{{ signal.label }}</span>
                    <strong>{{ signal.value }}</strong>
                    <p>{{ signal.helper }}</p>
                </div>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-if="showPolicyControls"
            class="anonymous-governance-section"
            title="强匿名评论策略"
            description="配置 ZK 强匿名评论与显式公开发送策略。历史服务端可见假名评论只读保留。"
            :title-tag="'h2'"
        >
            <div class="anonymous-governance-controls">
                <label class="anonymous-governance-control">
                    <span>
                        <strong>强匿名评论</strong>
                        <small>控制 ZK 证明评论是否可提交；不会启用已退役的普通 anonymous 模式。</small>
                    </span>
                    <ElSwitch
                        :model-value="anonymousCommentsEnabled"
                        :disabled="!canConfigureAnonymousPolicy || loadingPolicy"
                        aria-label="匿名评论开关"
                        @change="(value: string | number | boolean) => void updatePolicy('anonymousCommentsEnabled', value)"
                    />
                </label>
                <label class="anonymous-governance-control">
                    <span>
                        <strong>公开发送</strong>
                        <small>允许用户明确选择公开名称；绝不作为强匿名失败后的自动降级。</small>
                    </span>
                    <ElSwitch
                        :model-value="publicSendOptionEnabled"
                        :disabled="!canConfigureAnonymousPolicy || loadingPolicy"
                        aria-label="公开发送开关"
                        @change="(value: string | number | boolean) => void updatePolicy('publicSendOptionEnabled', value)"
                    />
                </label>
                <label class="anonymous-governance-control">
                    <span>
                        <strong>隐私证明</strong>
                        <small>仅用于匿名评论证明。</small>
                    </span>
                    <ElSwitch
                        :model-value="zkAnonymousEnabled"
                        :disabled="!canConfigureAnonymousPolicy || !zkAnonymousConfigurable || loadingPolicy"
                        aria-label="隐私证明开关"
                        @change="(value: string | number | boolean) => void updatePolicy('zkAnonymousEnabled', value)"
                    />
                </label>
                <label class="anonymous-governance-control">
                    <span>
                        <strong>评论字数上限</strong>
                        <small>默认 1000，后台可调至 3000。</small>
                    </span>
                    <ElInputNumber
                        :model-value="commentMaxChars"
                        :min="100"
                        :max="3000"
                        :step="100"
                        :disabled="!canConfigureAnonymousPolicy || loadingPolicy"
                        controls-position="right"
                        aria-label="评论字数上限"
                        @change="(value: number | undefined) => void updatePolicy('commentMaxChars', value ?? commentMaxChars)"
                    />
                </label>
                <label class="anonymous-governance-control">
                    <span>
                        <strong>UTF-8 字节上限</strong>
                        <small>默认 4096，后台可调至 12288，仍受 16KB 帧上限保护。</small>
                    </span>
                    <ElInputNumber
                        :model-value="commentMaxUtf8Bytes"
                        :min="1024"
                        :max="12288"
                        :step="512"
                        :disabled="!canConfigureAnonymousPolicy || loadingPolicy"
                        controls-position="right"
                        aria-label="UTF-8 字节上限"
                        @change="(value: number | undefined) => void updatePolicy('commentMaxUtf8Bytes', value ?? commentMaxUtf8Bytes)"
                    />
                </label>
            </div>
            <div class="anonymous-governance-controls">
                <label class="anonymous-governance-control">
                    <span><strong>文章评论策略</strong><small>输入文章 ID 后配置文章 override；版本冲突会要求重新加载。</small></span>
                    <ElInputNumber
                        v-model="articlePolicyId"
                        :min="1"
                        controls-position="right"
                        aria-label="文章 ID"
                    />
                    <ElButton
                        :loading="loadingArticlePolicy"
                        @click="void loadArticlePolicy()"
                    >加载</ElButton>
                </label>
                <template v-if="articlePolicy">
                    <label class="anonymous-governance-control">
                        <span><strong>允许新评论</strong><small>关闭后保留所有公共读取。</small></span>
                        <ElSwitch v-model="articlePolicy.enabled" />
                    </label>
                    <label class="anonymous-governance-control">
                        <span><strong>文章公开/匿名入口</strong><small>分别继承并收紧全站策略。</small></span>
                        <ElSwitch
                            v-model="articlePolicy.publicCommentsEnabled"
                            aria-label="文章公开评论"
                        />
                        <ElSwitch
                            v-model="articlePolicy.anonymousCommentsEnabled"
                            aria-label="文章匿名评论"
                        />
                    </label>
                    <label class="anonymous-governance-control">
                        <span><strong>审核与慢速模式</strong><small>慢速模式使用隐私安全主体摘要。</small></span>
                        <ElSelect
                            v-model="articlePolicy.moderationMode"
                            aria-label="文章评论审核模式"
                        >
                            <ElOption
                                label="风险判定"
                                value="risk_based"
                            />
                            <ElOption
                                label="先审后发"
                                value="premoderated"
                            />
                            <ElOption
                                label="直接发布"
                                value="direct"
                            />
                        </ElSelect>
                        <ElInputNumber
                            v-model="articlePolicy.slowModeSeconds"
                            :min="0"
                            :max="86400"
                            aria-label="慢速模式秒数"
                        />
                    </label>
                    <label class="anonymous-governance-control">
                        <span><strong>线程锁定</strong><small>只阻止目标根线程的新回复。</small></span>
                        <ElInputNumber
                            v-model="threadRootId"
                            :min="1"
                            controls-position="right"
                            aria-label="根评论 ID"
                        />
                        <ElButton @click="void setThreadLocked(true)">锁定</ElButton>
                        <ElButton @click="void setThreadLocked(false)">解锁</ElButton>
                    </label>
                    <ElButton
                        type="primary"
                        :loading="loadingArticlePolicy"
                        @click="void saveArticlePolicy()"
                    >保存文章策略</ElButton>
                </template>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-if="showGovernanceRecords"
            class="anonymous-governance-section"
            title="治理记录"
            description="匿名主体、标识封禁与资格撤销记录。"
            :title-tag="'h2'"
        >
            <div class="anonymous-governance-records">
                <section
                    v-if="showRiskRecords"
                    class="anonymous-governance-record-block"
                >
                    <header class="anonymous-governance-record-block__header">
                        <div>
                            <h3>匿名主体</h3>
                            <p>汇总匿名评论的审核信号；不提供账号反查。</p>
                        </div>
                        <span class="anonymous-governance-record-count">{{ riskRows.length }} 条</span>
                    </header>
                    <div
                        v-if="hasRiskRows"
                        class="blog-scroll-x-safe anonymous-governance-table-scroll"
                    >
                        <ElTable
                            v-loading="loadingStatus"
                            :data="riskRows"
                            row-key="subject"
                            class="anonymous-governance-table"
                        >
                            <ElTableColumn
                                label="主体"
                                min-width="190"
                            >
                                <template #default="{ row }: { row: AnonymousRiskRow }">
                                    <div class="anonymous-governance-subject">
                                        <strong>{{ row.displayName }}</strong>
                                        <span>{{ row.subject }}</span>
                                    </div>
                                </template>
                            </ElTableColumn>
                            <ElTableColumn
                                label="审核信号"
                                min-width="260"
                            >
                                <template #default="{ row }: { row: AnonymousRiskRow }">
                                    <div class="anonymous-governance-tags">
                                        <ElTag
                                            size="small"
                                            type="info"
                                        >{{ row.authorMode }}</ElTag>
                                        <ElTag
                                            size="small"
                                            type="info"
                                        >{{ row.displayLanguage }}</ElTag>
                                        <ElTag
                                            size="small"
                                            type="info"
                                        >{{ row.scope }}</ElTag>
                                        <ElTag
                                            size="small"
                                            type="info"
                                        >{{ row.credential }}</ElTag>
                                        <ElTag
                                            size="small"
                                            type="info"
                                        >{{ row.reputation }}</ElTag>
                                        <ElTag
                                            size="small"
                                            type="info"
                                        >{{ row.accountAge }}</ElTag>
                                    </div>
                                </template>
                            </ElTableColumn>
                            <ElTableColumn
                                label="处置标签"
                                min-width="180"
                            >
                                <template #default="{ row }: { row: AnonymousRiskRow }">
                                    <div class="anonymous-governance-tags">
                                        <ElTag
                                            v-for="label in row.riskLabels"
                                            :key="label"
                                            size="small"
                                            type="warning"
                                        >
                                            {{ label }}
                                        </ElTag>
                                    </div>
                                </template>
                            </ElTableColumn>
                            <template #empty>
                                <AdminInlineEmptyState
                                    title="主体记录为空"
                                    description="匿名评论进入审核队列后显示。"
                                />
                            </template>
                        </ElTable>
                    </div>
                    <AdminInlineEmptyState
                        v-else
                        class="anonymous-governance-empty"
                        title="主体记录为空"
                        description="匿名评论进入审核队列后显示。"
                    />
                </section>

                <section
                    v-if="showNullifierRecords"
                    class="anonymous-governance-record-block"
                >
                    <header class="anonymous-governance-record-block__header">
                        <div>
                            <h3>匿名标识</h3>
                            <p>按匿名标识处理评论来源；不展示账号身份。</p>
                        </div>
                        <span class="anonymous-governance-record-count">{{ nullifierRows.length }} 条</span>
                    </header>
                    <div
                        v-if="hasNullifierRows"
                        class="blog-scroll-x-safe anonymous-governance-table-scroll"
                    >
                        <ElTable
                            v-loading="loadingNullifiers"
                            :data="nullifierRows"
                            row-key="key"
                            class="anonymous-governance-table"
                        >
                            <ElTableColumn
                                prop="scope"
                                label="适用范围"
                                min-width="160"
                            />
                            <ElTableColumn
                                prop="maskedHash"
                                label="匿名标识"
                                min-width="220"
                            />
                            <ElTableColumn
                                prop="status"
                                label="状态"
                                min-width="120"
                            />
                            <ElTableColumn
                                label="操作"
                                width="170"
                                align="right"
                            >
                                <template #default="{ row }: { row: AnonymousNullifierRow }">
                                    <ElButton
                                        type="danger"
                                        plain
                                        size="small"
                                        :disabled="!canBlockAnonymousNullifier || row.status === 'blocked'"
                                        :loading="processingAction === row.key"
                                        @click="previewNullifierBlock(row)"
                                    >
                                        封禁标识
                                    </ElButton>
                                </template>
                            </ElTableColumn>
                            <template #empty>
                                <AdminInlineEmptyState
                                    title="标识记录为空"
                                    description="观察或封禁记录显示在这里。"
                                />
                            </template>
                        </ElTable>
                    </div>
                    <AdminInlineEmptyState
                        v-else
                        class="anonymous-governance-empty"
                        title="标识记录为空"
                        description="观察或封禁记录显示在这里。"
                    />
                </section>

                <section
                    v-if="showCredentialRecords"
                    class="anonymous-governance-record-block"
                >
                    <header class="anonymous-governance-record-block__header">
                        <div>
                            <h3>匿名资格</h3>
                            <p>查看匿名资格状态；撤销动作独立于账号资料。</p>
                        </div>
                        <span class="anonymous-governance-record-count">{{ credentialRows.length }} 条</span>
                    </header>
                    <div
                        v-if="hasCredentialRows"
                        class="blog-scroll-x-safe anonymous-governance-table-scroll"
                    >
                        <ElTable
                            v-loading="loadingStatus"
                            :data="credentialRows"
                            row-key="id"
                            class="anonymous-governance-table"
                        >
                            <ElTableColumn
                                prop="id"
                                label="资格"
                                min-width="180"
                            />
                            <ElTableColumn
                                prop="level"
                                label="级别"
                                min-width="120"
                            />
                            <ElTableColumn
                                prop="status"
                                label="状态"
                                min-width="120"
                            />
                            <ElTableColumn
                                prop="revocation"
                                label="撤销状态"
                                min-width="150"
                            />
                            <ElTableColumn
                                label="操作"
                                width="170"
                                align="right"
                            >
                                <template #default="{ row }: { row: AnonymousCredentialRow }">
                                    <ElButton
                                        type="danger"
                                        plain
                                        size="small"
                                        :disabled="!canRevokeAnonymousCredential"
                                        :loading="processingAction === row.id"
                                        @click="previewCredentialRevoke(row)"
                                    >
                                        撤销匿名资格
                                    </ElButton>
                                </template>
                            </ElTableColumn>
                            <template #empty>
                                <AdminInlineEmptyState
                                    title="资格记录为空"
                                    description="资格状态和撤销记录显示在这里。"
                                />
                            </template>
                        </ElTable>
                    </div>
                    <AdminInlineEmptyState
                        v-else
                        class="anonymous-governance-empty"
                        title="资格记录为空"
                        description="资格状态和撤销记录显示在这里。"
                    />
                </section>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-if="showZkStatus"
            class="anonymous-governance-section"
            title="隐私证明状态"
            description="查看隐私证明配置状态；不改变登录链路。"
            :title-tag="'h2'"
        >
            <div class="anonymous-governance-zk">
                <div
                    v-for="item in zkStatusRows"
                    :key="item.label"
                    class="anonymous-governance-zk__row"
                >
                    <span>{{ item.label }}</span>
                    <strong>{{ item.value }}</strong>
                    <p>{{ item.helper }}</p>
                </div>
            </div>
        </FsusUiSettingsSection>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import {
    blockAnonymousGovernanceNullifier,
    getAnonymousGovernanceStatus,
    listAnonymousGovernanceNullifiers,
    revokeAnonymousGovernanceCredential,
    type AnonymousGovernanceStatusResponse
} from '@/api/anonymousGovernance';
import {
    getAnonymousCommentPolicy,
    getArticleCommentPolicy,
    updateArticleCommentPolicy,
    updateCommentThreadPolicy,
    updateAnonymousCommentPolicy,
    type EffectiveArticleCommentPolicyResponse,
    type AnonymousCommentPolicyResponse,
    type AnonymousCommentPolicyUpdateRequest
} from '@/api/authoring';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { FsusUiSettingsSection, FsusUiTaskPageHeader } from '@/fsusui';
import { promptText, toast } from '@/fsusui/feedback';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { useAdminStore, type AnonymousCommentPolicySnapshot } from '@/store/admin';
import { isAppError } from '@/utils/appError';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';

const route = useRoute();
const adminStore = useAdminStore();
const articlePolicyId = ref<number>();
const threadRootId = ref<number>();
const articlePolicy = ref<EffectiveArticleCommentPolicyResponse | null>(null);
const loadingArticlePolicy = ref(false);

const sections = {
    ManageAnonymousCommentPolicy: {
        title: '匿名评论策略',
        description: '',
        caption: '需要 anonymous.comment.configure 权限。'
    },
    ManageAnonymousRisk: {
        title: '匿名风险',
        description: '',
        caption: '展示匿名信号，不提供真实账号反查。'
    },
    ManageAnonymousCredentials: {
        title: '匿名资格',
        description: '',
        caption: '需要 anonymous.credential.revoke 权限。'
    },
    ManageAnonymousNullifiers: {
        title: '匿名标识治理',
        description: '',
        caption: '需要 anonymous.nullifier.block 权限。'
    },
    ManageZkAnonymousStatus: {
        title: '隐私证明状态',
        description: '',
        caption: '需要 anonymous.comment.configure 权限。'
    }
} as const;

type GovernanceSectionKey = keyof typeof sections;
type PolicyBooleanKey = Extract<keyof AnonymousCommentPolicySnapshot, 'anonymousCommentsEnabled' | 'publicSendOptionEnabled' | 'zkAnonymousEnabled'>;
type PolicyNumberKey = Extract<keyof AnonymousCommentPolicySnapshot, 'commentMaxChars' | 'commentMaxUtf8Bytes'>;
type PolicyKey = PolicyBooleanKey | PolicyNumberKey;

interface AnonymousRiskRow {
    subject: string;
    displayName: string;
    authorMode: string;
    displayLanguage: string;
    scope: string;
    credential: string;
    reputation: string;
    accountAge: string;
    riskLabels: string[];
}

interface AnonymousNullifierRow {
    key: string;
    scope: string;
    maskedHash: string;
    governanceHash: string;
    status: string;
    useCount: number;
}

interface AnonymousCredentialRow {
    id: string;
    epoch: number;
    rootHash: string;
    revocationRootHash: string;
    level: string;
    status: string;
    revocation: string;
}

const governanceStatus = ref<AnonymousGovernanceStatusResponse | null>(null);
const nullifierRecords = ref<AnonymousNullifierRow[]>([]);
const loadingStatus = ref(false);
const loadingNullifiers = ref(false);
const loadingPolicy = ref(false);
const processingAction = ref<string | null>(null);

const sectionKey = computed<GovernanceSectionKey>(() =>
{
    const key = typeof route.name === 'string' && route.name in sections
        ? route.name as GovernanceSectionKey
        : 'ManageAnonymousCommentPolicy';
    return key;
});

const section = computed(() => sections[sectionKey.value]);

const anonymousCommentsEnabled = computed(() => adminStore.anonymousCommentsEnabled);
const publicSendOptionEnabled = computed(() => adminStore.publicSendOptionEnabled);
const zkAnonymousEnabled = computed(() => adminStore.zkAnonymousEnabled);
const zkAnonymousConfigurable = computed(() => adminStore.zkAnonymousConfigurable);
const commentMaxChars = computed(() => adminStore.commentMaxChars);
const commentMaxUtf8Bytes = computed(() => adminStore.commentMaxUtf8Bytes);
const publicOnlyMode = computed(() => adminStore.publicOnlyMode);
const canConfigureAnonymousPolicy = computed(() => adminStore.hasPermission('anonymous.comment.configure'));
const canBlockAnonymousNullifier = computed(() => adminStore.hasPermission('anonymous.nullifier.block'));
const canRevokeAnonymousCredential = computed(() => adminStore.hasPermission('anonymous.credential.revoke'));
const showRuntimeStatus = computed(() => sectionKey.value !== 'ManageAnonymousNullifiers');
const showPolicyControls = computed(() => sectionKey.value === 'ManageAnonymousCommentPolicy');
const showRiskRecords = computed(() => sectionKey.value === 'ManageAnonymousRisk');
const showNullifierRecords = computed(() => sectionKey.value === 'ManageAnonymousNullifiers');
const showCredentialRecords = computed(() => sectionKey.value === 'ManageAnonymousCredentials');
const showGovernanceRecords = computed(() => showRiskRecords.value || showNullifierRecords.value || showCredentialRecords.value);
const showZkStatus = computed(() => sectionKey.value === 'ManageZkAnonymousStatus');
const shouldLoadGovernanceStatus = computed(() =>
    showRuntimeStatus.value &&
    (canConfigureAnonymousPolicy.value || canRevokeAnonymousCredential.value)
);
const shouldLoadNullifiers = computed(() =>
    sectionKey.value === 'ManageAnonymousNullifiers' && canBlockAnonymousNullifier.value
);

const policySignals = computed(() => [
    {
        label: '强匿名评论',
        value: anonymousCommentsEnabled.value ? '启用' : '关闭',
        helper: anonymousCommentsEnabled.value ? '仅 ZK 强匿名评论可提交。' : '强匿名评论不可提交。'
    },
    {
        label: '仅公开',
        value: publicOnlyMode.value ? '启用' : '关闭',
        helper: publicOnlyMode.value ? '仅允许显式公开身份评论。' : '强匿名与显式公开按策略并行。'
    },
    {
        label: '凭据批次',
        value: governanceStatus.value?.root.credentialEpoch ? String(governanceStatus.value.root.credentialEpoch) : '未就绪',
        helper: governanceStatus.value?.root.maskedRootHash ? `批次 ${governanceStatus.value.root.maskedRootHash}` : '当前没有可用凭据批次。'
    },
    {
        label: '隐私证明',
        value: governanceStatus.value?.verifier.configured ? '可用' : '未启用',
        helper: governanceStatus.value?.verifier.circuitStatus ?? (zkAnonymousConfigurable.value ? '仅用于匿名评论证明。' : '当前环境隐藏配置入口。')
    }
]);

const riskRows = computed<AnonymousRiskRow[]>(() =>
{
    const stats = governanceStatus.value?.commentStats;
    if (!stats)
    {
        return [];
    }

    return [{
        subject: 'anonymous-comment-governance',
        displayName: '强匿名评论主体',
        authorMode: `ZK 强匿名 ${stats.totalAnonymous}`,
        displayLanguage: '按评论记录',
        scope: `待审 ${stats.pendingAnonymous}`,
        credential: `证明 ${stats.zkAnonymous}`,
        reputation: `通过 ${stats.approvedAnonymous}`,
        accountAge: `隐藏 ${stats.hiddenAnonymous}`,
        riskLabels: [
            `rejected:${stats.rejectedAnonymous}`,
            `pending:${stats.pendingAnonymous}`,
            `legacy-server-visible:${stats.legacyServerVisiblePseudonymous}`
        ]
    }];
});

const nullifierRows = computed(() => nullifierRecords.value);

const credentialRows = computed<AnonymousCredentialRow[]>(() =>
    (governanceStatus.value?.credentials ?? []).map(item => ({
        id: `epoch:${item.epoch}:${item.maskedRootHash}`,
        epoch: item.epoch,
        rootHash: item.rootHash,
        revocationRootHash: item.revocationRootHash,
        level: item.maskedRootHash,
        status: item.status,
        revocation: `${item.maskedRevocationRootHash} / ${item.revocationCount}`
    })));

const hasRiskRows = computed(() => riskRows.value.length > 0);
const hasNullifierRows = computed(() => nullifierRows.value.length > 0);
const hasCredentialRows = computed(() => credentialRows.value.length > 0);

const zkStatusRows = computed(() => [
    {
        label: '校验器',
        value: governanceStatus.value?.verifier.configured ? '已启用' : '未启用',
        helper: governanceStatus.value?.verifier.circuitStatus ?? '用于匿名评论证明校验，不参与登录认证。'
    },
    {
        label: '凭据根',
        value: governanceStatus.value?.root.maskedRootHash ?? '未就绪',
        helper: governanceStatus.value?.root.circuitId ?? '只展示公开校验状态，不展示账号身份。'
    },
    {
        label: '撤销记录',
        value: governanceStatus.value?.revocation.maskedRevocationRootHash ?? '未就绪',
        helper: governanceStatus.value?.revocation.latestRevokedAtUtc
            ? `最近撤销 ${formatDate(governanceStatus.value.revocation.latestRevokedAtUtc)}`
            : '尚无撤销记录。'
    }
]);

const mapPolicySnapshotToStore = (snapshot: AnonymousCommentPolicyResponse): Partial<AnonymousCommentPolicySnapshot> => ({
    anonymousCommentsEnabled: snapshot.anonymousCommentsEnabled,
    publicSendOptionEnabled: snapshot.publicCommentsEnabled,
    zkAnonymousEnabled: snapshot.zkAnonymousEnabled,
    commentMaxChars: snapshot.commentMaxChars,
    commentMaxUtf8Bytes: snapshot.commentMaxUtf8Bytes,
    anonymousCommentGovernanceAvailable: true
});

const loadAnonymousPolicy = async (): Promise<void> =>
{
    if (!showPolicyControls.value || !canConfigureAnonymousPolicy.value)
    {
        return;
    }

    loadingPolicy.value = true;
    try
    {
        const snapshot = await getAnonymousCommentPolicy();
        adminStore.setAnonymousCommentPolicy(mapPolicySnapshotToStore(snapshot));
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '匿名评论策略加载失败'), '匿名评论策略');
    }
    finally
    {
        loadingPolicy.value = false;
    }
};

const buildPolicyUpdateRequest = (key: PolicyKey, value: string | number | boolean): AnonymousCommentPolicyUpdateRequest =>
{
    if (key === 'publicSendOptionEnabled')
    {
        return { publicCommentsEnabled: Boolean(value), reason: 'admin_policy_update' };
    }

    if (key === 'commentMaxChars')
    {
        return { commentMaxChars: Number(value), reason: 'admin_policy_update' };
    }

    if (key === 'commentMaxUtf8Bytes')
    {
        return { commentMaxUtf8Bytes: Number(value), reason: 'admin_policy_update' };
    }

    if (key === 'anonymousCommentsEnabled')
    {
        return { anonymousCommentsEnabled: Boolean(value), reason: 'admin_policy_update' };
    }

    return { zkAnonymousEnabled: Boolean(value), reason: 'admin_policy_update' };
};

const updatePolicy = async (key: PolicyKey, value: string | number | boolean): Promise<void> =>
{
    if (!canConfigureAnonymousPolicy.value)
    {
        showWarningToast('当前管理员没有匿名评论策略配置权限');
        return;
    }

    loadingPolicy.value = true;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const snapshot = await updateAnonymousCommentPolicy(buildPolicyUpdateRequest(key, value), { mfaProofToken });
        adminStore.setAnonymousCommentPolicy(mapPolicySnapshotToStore(snapshot));
        if (key === 'zkAnonymousEnabled' && !snapshot.zkAnonymousEnabled)
        {
            await clearPrivateBrowserState('feature-disabled');
        }
        toast.success('匿名评论策略已更新');
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '匿名评论策略更新失败'), '匿名评论策略');
    }
    finally
    {
        loadingPolicy.value = false;
    }
};

const loadArticlePolicy = async (): Promise<void> =>
{
    if (!articlePolicyId.value)
    {
        return;
    }
    loadingArticlePolicy.value = true;
    try
    {
        articlePolicy.value = await getArticleCommentPolicy(articlePolicyId.value, undefined);
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '文章评论策略加载失败'), '评论策略');
    }
    finally
    {
        loadingArticlePolicy.value = false;
    }
};

const saveArticlePolicy = async (): Promise<void> =>
{
    if (!articlePolicyId.value || !articlePolicy.value)
    {
        return;
    }
    loadingArticlePolicy.value = true;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        articlePolicy.value = await updateArticleCommentPolicy(articlePolicyId.value, {
            enabled: articlePolicy.value.enabled,
            publicCommentsEnabled: articlePolicy.value.publicCommentsEnabled,
            anonymousCommentsEnabled: articlePolicy.value.anonymousCommentsEnabled,
            moderationMode: articlePolicy.value.moderationMode,
            slowModeSeconds: articlePolicy.value.slowModeSeconds,
            closedAtUtc: articlePolicy.value.closedAtUtc,
            expectedPolicyVersion: articlePolicy.value.articlePolicyVersion,
            reason: 'admin_article_comment_policy_update'
        }, { mfaProofToken });
        toast.success('文章评论策略已更新');
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '文章评论策略更新失败'), '评论策略');
    }
    finally
    {
        loadingArticlePolicy.value = false;
    }
};

const setThreadLocked = async (locked: boolean): Promise<void> =>
{
    if (!articlePolicyId.value || !articlePolicy.value || !threadRootId.value)
    {
        return;
    }
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const currentThreadPolicy = await getArticleCommentPolicy(articlePolicyId.value, threadRootId.value);
        articlePolicy.value = await updateCommentThreadPolicy(articlePolicyId.value, threadRootId.value, {
            locked,
            expectedPolicyVersion: currentThreadPolicy.threadPolicyVersion,
            reason: locked ? 'admin_thread_lock' : 'admin_thread_reopen'
        }, { mfaProofToken });
        toast.success(locked ? '讨论串已锁定' : '讨论串已解锁');
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '线程策略更新失败'), '评论策略');
    }
};

const loadGovernanceStatus = async (): Promise<void> =>
{
    if (!shouldLoadGovernanceStatus.value)
    {
        governanceStatus.value = null;
        return;
    }

    loadingStatus.value = true;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        governanceStatus.value = await getAnonymousGovernanceStatus({ mfaProofToken });
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '匿名治理状态加载失败'), '匿名治理');
    }
    finally
    {
        loadingStatus.value = false;
    }
};

const loadNullifiers = async (): Promise<void> =>
{
    if (!shouldLoadNullifiers.value)
    {
        nullifierRecords.value = [];
        return;
    }

    loadingNullifiers.value = true;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const response = await listAnonymousGovernanceNullifiers({ mfaProofToken });
        nullifierRecords.value = response.items.map(item => ({
            key: `${item.scope}:${item.maskedHash}`,
            scope: item.scope,
            maskedHash: item.maskedHash,
            governanceHash: item.nullifierHash,
            status: item.status,
            useCount: item.useCount
        }));
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '匿名标识列表加载失败'), '匿名标识治理');
    }
    finally
    {
        loadingNullifiers.value = false;
    }
};

const previewNullifierBlock = async (row: AnonymousNullifierRow): Promise<void> =>
{
    if (!canBlockAnonymousNullifier.value)
    {
        showWarningToast('当前管理员没有封禁匿名标识的权限');
        return;
    }

    const reason = await promptText('输入处理原因', '封禁匿名标识', {
        confirmButtonText: '封禁',
        inputPlaceholder: '说明封禁原因'
    });
    if (reason === null)
    {
        return;
    }

    processingAction.value = row.key;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await blockAnonymousGovernanceNullifier({
            nullifierHash: row.governanceHash,
            scope: row.scope,
            reason
        }, { mfaProofToken });
        if (!result.applied)
        {
            throw new Error('ANONYMOUS_GOVERNANCE_NOT_APPLIED');
        }

        toast.success('匿名标识已封禁');
        await loadNullifiers();
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '匿名标识封禁失败'), '匿名标识治理');
    }
    finally
    {
        processingAction.value = null;
    }
};

const previewCredentialRevoke = async (row: AnonymousCredentialRow): Promise<void> =>
{
    if (!canRevokeAnonymousCredential.value)
    {
        showWarningToast('当前管理员没有撤销匿名资格的权限');
        return;
    }

    const revocationHandleHash = await promptText('输入撤销标识', '撤销匿名资格', {
        confirmButtonText: '继续',
        inputPlaceholder: '撤销标识'
    });
    if (revocationHandleHash === null)
    {
        return;
    }

    const revocationRootHash = await promptText('输入更新后的撤销根', '撤销匿名资格', {
        confirmButtonText: '撤销',
        inputPlaceholder: '撤销根'
    });
    if (revocationRootHash === null)
    {
        return;
    }

    processingAction.value = row.id;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await revokeAnonymousGovernanceCredential({
            epoch: row.epoch,
            rootHash: row.rootHash,
            revocationHandleHash,
            revocationRootHash,
            reason: 'revoked_by_admin'
        }, { mfaProofToken });
        if (!result.applied)
        {
            throw new Error('ANONYMOUS_GOVERNANCE_NOT_APPLIED');
        }

        await clearPrivateBrowserState('credential-revoked');
        toast.success('匿名资格已撤销');
        await loadGovernanceStatus();
    }
    catch (error)
    {
        showErrorToast(governanceErrorMessage(error, '匿名资格撤销失败'), '匿名资格');
    }
    finally
    {
        processingAction.value = null;
    }
};

const governanceErrorMessage = (error: unknown, fallback: string): string =>
{
    if (error instanceof Error)
    {
        if (error.message === 'MFA_PROOF_REQUIRED' || error.message === 'ADMIN_STEP_UP_CHALLENGE_REQUIRED')
        {
            return '管理员验证已过期，请重新完成二次验证';
        }
        if (error.message === 'ANONYMOUS_GOVERNANCE_NOT_APPLIED')
        {
            return '匿名治理动作未被应用，请刷新后重试';
        }
    }

    if (!isAppError(error))
    {
        return fallback;
    }

    if (error.status === 401)
    {
        return '登录状态已失效，请重新登录';
    }
    if (error.status === 403)
    {
        return '当前账号无权限执行匿名治理操作';
    }
    if (error.status === 428)
    {
        return '管理员验证已过期，请重新完成二次验证';
    }
    if (error.status === 404)
    {
        return '匿名治理对象不存在或已失效，请刷新';
    }
    if (error.status === 429)
    {
        return '匿名治理操作过于频繁，请稍后再试';
    }

    return error.message || fallback;
};

const formatDate = (value: string | null | undefined): string =>
{
    if (!value)
    {
        return '未记录';
    }

    return new Date(value).toLocaleString('zh-CN');
};

onMounted(() =>
{
    void loadAnonymousPolicy();
    void loadGovernanceStatus();
    void loadNullifiers();
});

watch(() => route.name, () =>
{
    void loadAnonymousPolicy();
    void loadGovernanceStatus();
    void loadNullifiers();
});
</script>

<style scoped>
.anonymous-governance-page
 {
    display: grid;
    gap: var(--fsus-space-5);
    min-width: 0;
    max-width: 100%;
}

.anonymous-governance-page > *
 {
    min-width: 0;
    max-width: 100%;
}

.anonymous-governance-section
 {
    border-top: 0;
}

.anonymous-governance-status-grid
 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--fsus-space-3);
}

.anonymous-governance-signal,
.anonymous-governance-zk__row
 {
    display: grid;
    gap: var(--fsus-space-1);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    padding: var(--fsus-space-3);
    background: var(--fsusblog-page-bg);
}

.anonymous-governance-signal span,
.anonymous-governance-zk__row span
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.anonymous-governance-signal strong,
.anonymous-governance-zk__row strong
 {
    color: var(--fsusblog-text-primary);
    font-size: 1rem;
}

.anonymous-governance-signal p,
.anonymous-governance-zk__row p
 {
    margin: 0;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    line-height: 1.6;
}

.anonymous-governance-controls
 {
    display: grid;
    gap: var(--fsus-space-3);
}

.anonymous-governance-control
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-4);
    border: 0;
    border-radius: var(--fsus-radius-control);
    padding: var(--fsus-space-3);
    background: color-mix(in srgb, var(--fsusblog-panel-bg) 46%, transparent);
}

.anonymous-governance-control span
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.anonymous-governance-control strong,
.anonymous-governance-subject strong
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
}

.anonymous-governance-control small,
.anonymous-governance-subject span
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
}

.anonymous-governance-table
 {
    min-width: 640px;
    width: 100%;
}

.anonymous-governance-table-scroll
 {
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
}

.anonymous-governance-records
 {
    display: grid;
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-page-bg);
}

.anonymous-governance-record-block
 {
    display: grid;
    gap: var(--fsus-space-3);
    min-width: 0;
    padding: var(--fsus-space-4);
    border-top: 1px solid var(--fsusblog-panel-border);
}

.anonymous-governance-record-block:first-child
 {
    border-top: 0;
}

.anonymous-governance-record-block__header
 {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fsus-space-4);
    min-width: 0;
}

.anonymous-governance-record-block__header div
 {
    min-width: 0;
}

.anonymous-governance-record-block__header h3
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 16px;
    font-weight: 700;
    line-height: 1.35;
}

.anonymous-governance-record-block__header p
 {
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    line-height: 1.55;
}

.anonymous-governance-record-count
 {
    flex: 0 0 auto;
    min-width: 3rem;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-pill);
    padding: var(--fsus-space-1) var(--fsus-space-2);
    color: var(--fsusblog-text-muted);
    background: color-mix(in srgb, var(--fsusblog-page-bg) 82%, var(--fsusblog-panel-bg) 18%);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    text-align: center;
    white-space: nowrap;
}

.anonymous-governance-empty
 {
    min-height: 5rem;
    border: 1px dashed color-mix(in srgb, var(--fsusblog-text-muted) 34%, transparent);
    border-radius: var(--fsus-radius-control);
    background: color-mix(in srgb, var(--fsusblog-panel-bg) 68%, var(--fsusblog-page-bg) 32%);
}

.anonymous-governance-subject
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.anonymous-governance-tags,
.anonymous-governance-zk
 {
    display: grid;
    gap: var(--fsus-space-2);
}

.anonymous-governance-tags
 {
    display: flex;
    flex-wrap: wrap;
}

@media (width <= 767px)
 {
    .anonymous-governance-control
 {
        align-items: flex-start;
        flex-direction: column;
    }

    .anonymous-governance-record-block
 {
        padding: var(--fsus-space-4) var(--fsus-space-3);
    }

    .anonymous-governance-record-block__header
 {
        gap: var(--fsus-space-3);
    }
}
</style>
