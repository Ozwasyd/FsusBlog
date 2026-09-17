<template>
    <div class="account-page cluster-runtime-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="集群与运行时"
            class="account-task-page-header"
            density="compact"
        />

        <FsusUiSettingsSection
            title="集群健康"
            id="cluster-runtime-health-title"
            class="mb-8"
        >
            <template #actions>
                <ElButton
                    :loading="loading"
                    @click="loadSnapshot"
                >刷新状态</ElButton>
            </template>
            <FsusUiKeyValueGrid
                v-if="snapshot"
                class="grid gap-4 md:grid-cols-4"
            >
                <FsusUiKeyValueItem
                    label="状态"
                    :tone="healthTone"
                >
                    {{ healthLabel }}
                </FsusUiKeyValueItem>
                <FsusUiKeyValueItem label="运行模式">
                    {{ modeLabel(snapshot.mode) }}
                </FsusUiKeyValueItem>
                <FsusUiKeyValueItem label="活跃节点">
                    {{ snapshot.health.aliveNodes }} / {{ snapshot.nodes.length }}
                </FsusUiKeyValueItem>
                <FsusUiKeyValueItem label="调度">
                    {{ snapshot.schedulingAllowed && snapshot.scheduler.enabled ? '运行中' : '已停止接收新职责' }}
                </FsusUiKeyValueItem>
            </FsusUiKeyValueGrid>
            <AdminInlineEmptyState
                v-else
                title="集群状态待加载"
                :content="loadError || '加载后显示节点健康和调度状态。'"
            >
                <template #actions>
                    <ElButton
                        type="primary"
                        :loading="loading"
                        @click="loadSnapshot"
                    >重新加载</ElButton>
                </template>
            </AdminInlineEmptyState>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            title="节点"
            id="cluster-runtime-nodes-title"
            class="mb-8"
        >
            <ElTable
                v-loading="loading"
                :data="snapshot?.nodes ?? []"
                row-key="instanceId"
            >
                <ElTableColumn
                    label="节点"
                    min-width="220"
                >
                    <template #default="{ row }: { row: ClusterNodeResponse }">
                        <div class="cluster-runtime-primary">{{ row.nodeId }}</div>
                        <div class="cluster-runtime-secondary">{{ row.version }} · {{ modeLabel(row.mode) }}</div>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="状态"
                    width="125"
                >
                    <template #default="{ row }: { row: ClusterNodeResponse }">
                        <ElTag :type="nodeTagType(row.status)">{{ nodeStatusLabel(row.status) }}</ElTag>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="职责 / Lease"
                    min-width="170"
                >
                    <template #default="{ row }: { row: ClusterNodeResponse }">
                        {{ row.activeResponsibilities.length }} / {{ row.resources.activeLeaseCount }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="CPU / Memory"
                    min-width="170"
                >
                    <template #default="{ row }: { row: ClusterNodeResponse }">
                        {{ percent(row.resources.cpuUsagePercent) }} / {{ percent(row.resources.memoryPressurePercent) }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="P95 / P99"
                    min-width="160"
                >
                    <template #default="{ row }: { row: ClusterNodeResponse }">
                        {{ milliseconds(row.resources.p95LatencyMilliseconds) }} / {{ milliseconds(row.resources.p99LatencyMilliseconds) }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="最近心跳"
                    min-width="170"
                >
                    <template #default="{ row }: { row: ClusterNodeResponse }">
                        {{ formatTime(row.lastHeartbeatAt) }}
                    </template>
                </ElTableColumn>
                <template #empty>
                    <AdminInlineEmptyState
                        title="尚未发现活动节点"
                        content="当前成员存储没有返回节点。"
                    />
                </template>
            </ElTable>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            title="职责分配"
            id="cluster-runtime-assignments-title"
            class="mb-8"
        >
            <ElTable
                v-loading="loading"
                :data="snapshot?.scheduler.assignments ?? []"
                :row-key="assignmentKey"
            >
                <ElTableColumn
                    prop="responsibilityId"
                    label="职责"
                    min-width="235"
                />
                <ElTableColumn
                    prop="nodeId"
                    label="节点"
                    min-width="150"
                />
                <ElTableColumn
                    label="状态"
                    width="130"
                >
                    <template #default="{ row }: { row: ClusterAssignmentResponse }">
                        <ElTag :type="assignmentTagType(row.state)">{{ assignmentStateLabel(row.state) }}</ElTag>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="Fence"
                    width="110"
                >
                    <template #default="{ row }: { row: ClusterAssignmentResponse }">
                        {{ row.fencingToken ?? '等待' }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    prop="reason"
                    label="决策原因"
                    min-width="190"
                />
                <template #empty>
                    <AdminInlineEmptyState
                        title="暂无职责分配"
                        content="调度器尚未生成职责分配快照，可能是集群刚启动或尚未选举主调度器。"
                    />
                </template>
            </ElTable>
            <p
                v-if="snapshot?.scheduler.unassigned.length"
                class="cluster-runtime-warning"
            >
                未分配：{{ snapshot.scheduler.unassigned.join('、') }}
            </p>
        </FsusUiSettingsSection>

        <section class="cluster-runtime-grid">
            <FsusUiSettingsSection
                title="Lease"
                id="cluster-runtime-leases-title"
            >
                <ElTable
                    v-loading="loading"
                    :data="snapshot?.leases ?? []"
                    row-key="leaseId"
                >
                    <ElTableColumn
                        label="Lease"
                        min-width="220"
                    >
                        <template #default="{ row }: { row: ClusterLeaseResponse }">
                            <div class="cluster-runtime-primary">{{ row.key }}</div>
                            <div class="cluster-runtime-secondary">{{ row.holderNodeId }} · fence {{ row.fencingToken }}</div>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="到期"
                        min-width="170"
                    >
                        <template #default="{ row }: { row: ClusterLeaseResponse }">
                            {{ formatTime(row.expiresAt) }}
                        </template>
                    </ElTableColumn>
                    <template #empty>
                        <AdminInlineEmptyState
                            title="暂无活跃分布式租约"
                            content="当前没有活跃的分布式租约，可能因为尚未有需要排他执行的任务。"
                        />
                    </template>
                </ElTable>
            </FsusUiSettingsSection>

            <FsusUiSettingsSection
                title="Checkpoint"
                id="cluster-runtime-checkpoints-title"
            >
                <ElTable
                    v-loading="loading"
                    :data="checkpointTasks"
                    row-key="key"
                >
                    <ElTableColumn
                        label="任务"
                        min-width="220"
                    >
                        <template #default="{ row }: { row: ClusterTaskResponse }">
                            <div class="cluster-runtime-primary">{{ row.key }}</div>
                            <div class="cluster-runtime-secondary">{{ nodeStatusLabel(row.status) }} · attempt {{ row.attempt }}</div>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="版本 / 摘要"
                        min-width="170"
                    >
                        <template #default="{ row }: { row: ClusterTaskResponse }">
                            v{{ row.checkpoint?.version }} · {{ compactDigest(row.checkpoint?.payloadSha256) }}
                        </template>
                    </ElTableColumn>
                    <template #empty>
                        <AdminInlineEmptyState
                            title="暂无检查点"
                            content="调度任务尚未保存检查点快照。"
                        />
                    </template>
                </ElTable>
            </FsusUiSettingsSection>
        </section>

        <FsusUiSettingsSection
            title="最近迁移与故障事件"
            id="cluster-runtime-events-title"
            class="mt-8"
        >
            <ElTable
                v-loading="loading"
                :data="recentEvents"
                row-key="sequence"
            >
                <ElTableColumn
                    prop="kind"
                    label="类型"
                    width="185"
                />
                <ElTableColumn
                    prop="state"
                    label="状态"
                    width="150"
                />
                <ElTableColumn
                    label="对象"
                    min-width="210"
                >
                    <template #default="{ row }: { row: ClusterEventResponse }">
                        {{ row.responsibilityId || row.nodeId || 'cluster' }}
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    prop="reason"
                    label="原因"
                    min-width="220"
                />
                <ElTableColumn
                    label="时间"
                    min-width="170"
                >
                    <template #default="{ row }: { row: ClusterEventResponse }">
                        {{ formatTime(row.observedAt) }}
                    </template>
                </ElTableColumn>
                <template #empty>
                    <AdminInlineEmptyState
                        title="暂无运行事件"
                        content="集群尚未产生调度决策或节点生命周期事件。"
                    />
                </template>
            </ElTable>
        </FsusUiSettingsSection>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';

import {
    getClusterOperations,
    type ClusterAssignmentResponse,
    type ClusterEventResponse,
    type ClusterLeaseResponse,
    type ClusterNodeResponse,
    type ClusterOperationsResponse,
    type ClusterTaskResponse
} from '@/api/clusterOperations';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import {
    FsusUiKeyValueGrid,
    FsusUiKeyValueItem,
    FsusUiSettingsSection,
    FsusUiTaskPageHeader
} from '@/fsusui';
import { showErrorToast } from '@/utils/errorPresentation';

const loading = shallowRef(false);
const loadError = shallowRef('');
const snapshot = shallowRef<ClusterOperationsResponse | null>(null);

const healthLabel = computed(() =>
{
    if (snapshot.value?.health.status === 'healthy')
    {
        return '健康';
    }
    if (snapshot.value?.health.status === 'degraded')
    {
        return '需要关注';
    }
    return '不可用';
});
const healthTone = computed<'success' | 'warning' | 'danger'>(() =>
{
    if (snapshot.value?.health.status === 'healthy')
    {
        return 'success';
    }
    if (snapshot.value?.health.status === 'degraded')
    {
        return 'warning';
    }
    return 'danger';
});
const checkpointTasks = computed(() => snapshot.value?.tasks.filter((task) => task.checkpoint) ?? []);
const recentEvents = computed(() => [...(snapshot.value?.events ?? [])].reverse().slice(0, 100));

async function loadSnapshot(): Promise<void>
{
    loading.value = true;
    loadError.value = '';
    try
    {
        snapshot.value = await getClusterOperations();
    }
    catch (error)
    {
        loadError.value = '集群运行状态暂不可用，请重试。';
        showErrorToast(error, '集群与运行时加载失败');
    }
    finally
    {
        loading.value = false;
    }
}

const modeLabel = (mode: string): string => ({
    single: '单机',
    'static-role': '固定职责',
    adaptive: '自适应'
})[mode] ?? mode;

const nodeStatusLabel = (status: ClusterNodeResponse['status']): string => ({
    alive: '在线',
    suspect: '可疑',
    dead: '失联',
    draining: '排空中',
    maintenance: '维护中'
})[status];

const nodeTagType = (status: ClusterNodeResponse['status']): 'success' | 'warning' | 'danger' | 'info' =>
    status === 'alive' ? 'success' : status === 'dead' ? 'danger' : status === 'maintenance' ? 'info' : 'warning';

const assignmentStateLabel = (state: ClusterAssignmentResponse['state']): string => ({
    active: '运行中',
    activating: '启动中',
    deactivating: '停止中',
    migrating: '迁移中',
    failed: '失败',
    waitingLease: '等待 Lease'
})[state];

const assignmentTagType = (state: ClusterAssignmentResponse['state']): 'success' | 'warning' | 'danger' | 'info' =>
    state === 'active' ? 'success' : state === 'failed' ? 'danger' : state === 'waitingLease' ? 'warning' : 'info';

const assignmentKey = (row: ClusterAssignmentResponse): string =>
    `${row.responsibilityId}:${row.replica}:${row.nodeId}`;
const compactDigest = (digest?: string): string => digest ? `${digest.slice(0, 10)}…` : '-';
const percent = (value: number): string => `${value.toFixed(1)}%`;
const milliseconds = (value: number): string => `${value.toFixed(1)} ms`;
const formatTime = (value: string): string =>
{
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
};

onMounted(loadSnapshot);
</script>

<style scoped>
.cluster-runtime-grid
 {
    display: grid;
    gap: var(--fsus-space-6);
}

.cluster-runtime-primary
 {
    color: var(--fsusblog-text-primary);
    font-weight: 600;
}

.cluster-runtime-secondary
 {
    margin-top: var(--fsus-space-1);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}

.cluster-runtime-warning
 {
    margin: var(--fsus-space-4) 0 0;
    color: var(--fsusblog-color-warning);
    font-size: 13px;
}

@media (width >= 1200px)
 {
    .cluster-runtime-grid
 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
</style>
