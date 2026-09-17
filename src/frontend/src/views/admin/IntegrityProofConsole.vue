<template>
    <div class="account-page integrity-proof-console account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="Integrity Proof"
            class="account-task-page-header"
            density="compact"
        />

        <FsusUiSettingsSection
            class="mb-8"
            title="查询"
            id="integrity-proof-query-title"
        >
            <template #actions>
                <div class="flex flex-wrap items-center justify-end gap-2">
                    <ElButton
                        :icon="Refresh"
                        :loading="loading"
                        @click="loadConsole"
                    >刷新</ElButton>
                </div>
            </template>

            <div class="integrity-proof-console__filters">
                <ElInput
                    v-model="filters.articleId"
                    placeholder="Article ID"
                    aria-label="Article ID"
                />
                <ElInput
                    v-model="filters.articleRevisionId"
                    placeholder="Revision ID"
                    aria-label="Article revision ID"
                />
                <ElInput
                    v-model="filters.revisionNo"
                    placeholder="Revision No"
                    aria-label="Revision No"
                />
                <ElButton
                    type="primary"
                    :icon="Search"
                    :loading="loading"
                    @click="loadConsole"
                >查询</ElButton>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-if="loadErrorMessage"
            class="mb-8"
            title="读取失败"
            id="integrity-proof-error-title"
        >
            <AdminInlineEmptyState
                title="Proof 状态读取失败"
                :content="loadErrorMessage"
            >
                <template #actions>
                    <ElButton
                        type="primary"
                        :loading="loading"
                        @click="loadConsole"
                    >重新加载</ElButton>
                </template>
            </AdminInlineEmptyState>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            class="mb-8"
            title="状态总览"
            id="integrity-proof-status-title"
        >
            <FsusUiKeyValueGrid
                v-if="consoleState"
                class="grid gap-4 md:grid-cols-4"
            >
                <FsusUiKeyValueItem label="Proof">
                    {{ consoleState.proofs.ready }} / {{ consoleState.proofs.total }}
                </FsusUiKeyValueItem>
                <FsusUiKeyValueItem label="失败">
                    {{ consoleState.proofs.failed }}
                </FsusUiKeyValueItem>
                <FsusUiKeyValueItem
                    label="透明日志"
                    :tone="statusTone(consoleState.transparencyLog.status)"
                >
                    {{ formatStatus(consoleState.transparencyLog.status) }}
                </FsusUiKeyValueItem>
                <FsusUiKeyValueItem
                    label="Checkpoint"
                    :tone="statusTone(consoleState.checkpoint.status)"
                >
                    {{ formatStatus(consoleState.checkpoint.status) }}
                </FsusUiKeyValueItem>
            </FsusUiKeyValueGrid>
            <AdminInlineEmptyState
                v-else
                title="Proof 状态待加载"
                content="加载后显示 proof、log、checkpoint 和 signing key 状态。"
            />
        </FsusUiSettingsSection>

        <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
            <FsusUiSettingsSection
                title="最近 proof"
                id="integrity-proof-list-title"
            >
                <ElTable
                    v-loading="loading"
                    :data="consoleState?.recentProofs ?? []"
                    row-key="proofId"
                >
                    <ElTableColumn
                        label="Proof"
                        min-width="210"
                    >
                        <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
                            <div class="font-medium text-[var(--fsusblog-text-primary)]">#{{ row.proofId }} · Article {{ row.articleId }}</div>
                            <div class="text-[11px] text-[var(--fsusblog-text-muted)]">revision {{ row.revisionNo }} / {{ row.articleRevisionId }}</div>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="状态"
                        width="120"
                    >
                        <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
                            <ElTag :type="tagType(row.proofStatus)">{{ formatStatus(row.proofStatus) }}</ElTag>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="签名"
                        min-width="150"
                    >
                        <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
                            {{ formatStatus(row.signatureStatus) }}
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="Log"
                        width="120"
                    >
                        <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
                            {{ formatStatus(row.transparencyLogStatus) }}
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="操作"
                        width="110"
                        align="right"
                    >
                        <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
                            <ElButton
                                link
                                :disabled="!row.retryAvailable"
                                :loading="retryingProofId === row.proofId"
                                @click="retryProof(row)"
                            >
                                重试
                            </ElButton>
                        </template>
                    </ElTableColumn>
                    <template #empty>
                        <AdminInlineEmptyState
                            title="暂无 proof"
                            content="当前查询没有发布证明记录。"
                        />
                    </template>
                </ElTable>
            </FsusUiSettingsSection>

            <div class="space-y-8">
                <FsusUiSettingsSection
                    title="失败 / 重试中"
                    id="integrity-proof-failed-title"
                >
                    <div
                        v-if="consoleState?.failedOrRetryingProofs.length"
                        class="integrity-proof-console__failed-list"
                    >
                        <div
                            v-for="proof in consoleState.failedOrRetryingProofs"
                            :key="proof.proofId"
                            class="integrity-proof-console__failed-item"
                        >
                            <div>
                                <div class="font-medium">#{{ proof.proofId }} · {{ formatStatus(proof.proofStatus) }}</div>
                                <div class="mt-1 text-xs text-[var(--fsusblog-text-muted)]">{{ proof.failureCode || '无失败摘要' }}</div>
                            </div>
                            <ElButton
                                link
                                :disabled="!proof.retryAvailable"
                                :loading="retryingProofId === proof.proofId"
                                @click="retryProof(proof)"
                            >
                                重试
                            </ElButton>
                        </div>
                    </div>
                    <AdminInlineEmptyState
                        v-else
                        title="暂无失败 proof"
                        content="没有 failed 或 retrying 状态记录。"
                    />
                </FsusUiSettingsSection>

                <FsusUiSettingsSection
                    title="Signing Keys"
                    id="integrity-proof-keys-title"
                >
                    <div
                        v-if="consoleState?.keyRegistry.keys.length"
                        class="integrity-proof-console__key-list"
                    >
                        <div
                            v-for="key in consoleState.keyRegistry.keys"
                            :key="key.keyId"
                            class="integrity-proof-console__key-row"
                        >
                            <div class="min-w-0">
                                <div class="truncate font-medium">{{ key.keyId }}</div>
                                <div class="text-xs text-[var(--fsusblog-text-muted)]">{{ key.algorithm }} / v{{ key.version ?? '-' }}</div>
                            </div>
                            <span
                                class="integrity-proof-console__status-dot"
                                :data-status="key.status"
                            />
                            <span>{{ formatStatus(key.status) }}</span>
                        </div>
                    </div>
                    <AdminInlineEmptyState
                        v-else
                        title="Signing key registry 未配置"
                        content="未配置可展示的 signing key registry。"
                    />
                </FsusUiSettingsSection>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, shallowRef } from 'vue';

import {
    getIntegrityAdminConsole,
    retryIntegrityProof,
    type IntegrityAdminConsoleResponse,
    type IntegrityAdminProofRowResponse
} from '@/api/integrityConsole';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import {
    FsusUiKeyValueGrid,
    FsusUiKeyValueItem,
    FsusUiTaskPageHeader,
    FsusUiSettingsSection
} from '@/fsusui';
import { toast } from '@/fsusui/feedback';
import { Refresh, Search } from '@/fsusui/icons';
import { toFsusUiTagType } from '@/fsusui/primitiveAdapters';
import { showErrorToast } from '@/utils/errorPresentation';
import type { AdminStatusTone } from '@/view-contracts/adminStatus';

const loading = ref(false);
const retryingProofId = ref<number | null>(null);
const consoleState = shallowRef<IntegrityAdminConsoleResponse | null>(null);
const loadErrorMessage = ref('');

const filters = reactive({
    articleId: '',
    articleRevisionId: '',
    revisionNo: ''
});

function optionalNumber(value: string): number | null
{
    const trimmed = value.trim();
    if (!trimmed)
    {
        return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function loadConsole(): Promise<void>
{
    loading.value = true;
    loadErrorMessage.value = '';
    try
    {
        consoleState.value = await getIntegrityAdminConsole({
            articleId: optionalNumber(filters.articleId),
            articleRevisionId: optionalNumber(filters.articleRevisionId),
            revisionNo: optionalNumber(filters.revisionNo)
        });
    }
    catch (error)
    {
        loadErrorMessage.value = error instanceof Error && error.message
            ? error.message
            : 'Integrity Proof 状态暂时不可用，请重新加载。';
        showErrorToast(error);
    }
    finally
    {
        loading.value = false;
    }
}

async function retryProof(row: IntegrityAdminProofRowResponse): Promise<void>
{
    retryingProofId.value = row.proofId;
    try
    {
        const proof = await ensureAdminSensitiveProof();
        await retryIntegrityProof(row.proofId, proof);
        toast.success('已提交 proof 重试');
        await loadConsole();
    }
    catch (error)
    {
        showErrorToast(error);
    }
    finally
    {
        retryingProofId.value = null;
    }
}

function formatStatus(status: string): string
{
    const map: Record<string, string> = {
        pending: '等待中',
        ready: '已就绪',
        failed: '失败',
        retrying: '重试中',
        superseded: '已替代',
        'not-public': '非公开',
        'chain-broken': '日志断链',
        missing: '缺失',
        stale: '过期',
        blocked: '阻塞',
        logged: '已入日志',
        'signature-valid': '签名有效',
        'signature-invalid': '签名异常',
        'signature-missing': '缺少签名',
        'key-revoked': 'key 已撤销',
        'key-compromised': 'key 已泄露',
        active: '当前',
        old: '旧 key',
        revoked: '已撤销',
        compromised: '已泄露'
    };
    return map[status] ?? status;
}

function statusTone(status: string): AdminStatusTone
{
    if (['ready', 'active', 'signature-valid', 'logged'].includes(status))
    {
        return 'success';
    }
    if (['pending', 'retrying', 'old', 'stale'].includes(status))
    {
        return 'warning';
    }
    if (['failed', 'chain-broken', 'missing', 'blocked', 'signature-invalid', 'key-revoked', 'key-compromised', 'revoked', 'compromised'].includes(status))
    {
        return 'danger';
    }
    return 'neutral';
}

function tagType(status: string)
{
    return toFsusUiTagType(statusTone(status));
}

onMounted(() =>
{
    void loadConsole();
});
</script>

<style scoped>
.integrity-proof-console__filters
 {
    display: grid;
    gap: var(--fsus-space-3);
    grid-template-columns: repeat(4, minmax(0, 1fr));
}

.integrity-proof-console__failed-list,
.integrity-proof-console__key-list
 {
    display: grid;
    gap: var(--fsus-space-3);
}

.integrity-proof-console__failed-item,
.integrity-proof-console__key-row
 {
    align-items: center;
    border-top: 1px solid var(--fsusblog-panel-border);
    display: flex;
    gap: var(--fsus-space-3);
    justify-content: space-between;
    padding-top: var(--fsus-space-3);
}

.integrity-proof-console__status-dot
 {
    background: var(--fsusblog-text-muted);
    border-radius: var(--fsus-radius-pill);
    display: inline-block;
    height: 8px;
    width: 8px;
}

.integrity-proof-console__status-dot[data-status='active']
 {
    background: var(--fsusblog-admin-status-success);
}

.integrity-proof-console__status-dot[data-status='old']
 {
    background: var(--fsusblog-admin-status-warning);
}

.integrity-proof-console__status-dot[data-status='revoked'],
.integrity-proof-console__status-dot[data-status='compromised']
 {
    background: var(--fsusblog-admin-status-danger);
}

@media (width <= 1023px)
 {
    .integrity-proof-console__filters
 {
        grid-template-columns: 1fr;
    }
}
</style>
