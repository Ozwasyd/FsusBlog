<template>
    <div
        class="ops-workbench"
        data-ops-health-workbench
    >
        <section
            class="ops-status-strip"
            data-ops-status-strip
            aria-labelledby="ops-status-title"
        >
            <div class="ops-status-strip__heading">
                <div>
                    <h2 id="ops-status-title">当前运维状态</h2>
                    <p>{{ statusSummary }}</p>
                </div>
                <FsusUiButton
                    class="ops-refresh"
                    native-type="button"
                    text
                    :disabled="loading"
                    @click="$emit('refresh')"
                >
                    {{ loading ? '正在刷新' : '刷新状态' }}
                </FsusUiButton>
            </div>
            <dl class="ops-status-strip__values">
                <div>
                    <dt>需要处理</dt>
                    <dd>{{ incidents.length }} 项</dd>
                </div>
                <div>
                    <dt>最近变化</dt>
                    <dd>{{ latestChangeLabel }}</dd>
                </div>
                <div>
                    <dt>最后更新</dt>
                    <dd>{{ formatTime(health.checkedAt) }}</dd>
                </div>
                <div>
                    <dt>发布</dt>
                    <dd :title="releaseIdentity.fullCommitSha ?? undefined">
                        {{ releaseIdentity.releaseLabel }}
                    </dd>
                </div>
            </dl>
        </section>

        <section
            class="ops-section"
            aria-labelledby="ops-incidents-title"
        >
            <header class="ops-section__header">
                <div>
                    <h2 id="ops-incidents-title">需要处理</h2>
                    <p>按严重度优先，同级按最近发生时间排列。</p>
                </div>
            </header>

            <ol
                v-if="incidents.length"
                class="ops-incident-list"
            >
                <li
                    v-for="incident in incidents"
                    :key="incident.key"
                    class="ops-incident-row"
                    data-ops-incident-row
                >
                    <div
                        class="ops-incident-row__severity"
                        :data-severity="incident.severity"
                        data-ops-severity
                    >
                        <span aria-hidden="true">{{ incident.icon }}</span>
                        <span>{{ incident.severityLabel }}</span>
                    </div>
                    <div class="ops-incident-row__content">
                        <h3>{{ incident.title }}</h3>
                        <p>{{ incident.message }}</p>

                        <div
                            v-if="incident.evidence"
                            class="ops-evidence"
                        >
                            <code
                                v-if="incident.evidence.path"
                                class="ops-evidence__path"
                                data-ops-evidence-path
                            >{{ expandedEvidence.has(incident.key)
                                ? incident.evidence.path
                                : compactPath(incident.evidence.path) }}</code>

                            <div class="ops-evidence__actions">
                                <FsusUiButton
                                    class="ops-evidence__copy"
                                    native-type="button"
                                    text
                                    aria-label="复制证据"
                                    @click="copyEvidence(incident)"
                                >
                                    复制
                                </FsusUiButton>
                                <FsusUiButton
                                    class="ops-evidence__disclosure"
                                    native-type="button"
                                    text
                                    data-ops-evidence-disclosure
                                    :aria-expanded="expandedEvidence.has(incident.key)"
                                    :aria-controls="`ops-evidence-${incident.key}`"
                                    @click="toggleEvidence(incident.key)"
                                >
                                    {{ expandedEvidence.has(incident.key) ? '收起详情' : '展开详情' }}
                                </FsusUiButton>
                            </div>

                            <pre
                                v-if="expandedEvidence.has(incident.key)"
                                :id="`ops-evidence-${incident.key}`"
                                class="ops-evidence__detail"
                                data-ops-evidence-detail
                            >{{ incident.evidence.detail }}</pre>
                        </div>
                    </div>
                    <time
                        class="ops-incident-row__time"
                        data-ops-time
                        :datetime="incident.occurredAt"
                    >
                        {{ formatTime(incident.occurredAt) }}
                    </time>
                </li>
            </ol>

            <p
                v-else
                class="ops-incidents-empty"
                role="status"
            >
                当前没有需要处理的异常
            </p>
        </section>

        <section
            class="ops-section ops-quiet"
            data-ops-healthy-summary
        >
            <details>
                <summary>
                    <span>正常与可选状态</span>
                    <span class="ops-quiet__count">{{ quietSummary }}</span>
                </summary>
                <div class="ops-quiet__body">
                    <dl>
                        <div>
                            <dt>服务与 worker</dt>
                            <dd>{{ healthyServiceLabels }}</dd>
                        </div>
                        <div>
                            <dt>可接受的缺失</dt>
                            <dd>{{ optionalAbsenceLabels }}</dd>
                        </div>
                        <div>
                            <dt>环境</dt>
                            <dd>{{ health.environment }}</dd>
                        </div>
                        <div>
                            <dt>提交 / 槽位</dt>
                            <dd>{{ releaseIdentity.commitLabel }} / {{ releaseIdentity.releaseSlotLabel }}</dd>
                        </div>
                    </dl>
                </div>
            </details>
        </section>

        <p
            class="ops-copy-feedback"
            role="status"
            aria-live="polite"
        >
            {{ copyFeedback }}
        </p>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type {
    AdminServiceStatusResponse,
    BackupArtifactResponse,
    OpsHealthResponse
} from '@/api/authoring';
import { FsusUiButton } from '@/fsusui/button';
import {
    adminStatusLabel,
    adminStatusTone,
    type AdminSystemStatus
} from '@/view-contracts/adminStatus';
import { toOpsReleaseIdentityView } from '@/view-contracts/opsReleaseIdentity';

interface IncidentEvidence {
    detail: string;
    path: string | null;
}

interface OpsIncident {
    evidence: IncidentEvidence | null;
    icon: string;
    key: string;
    message: string;
    occurredAt: string;
    rank: number;
    severity: AdminSystemStatus;
    severityLabel: string;
    title: string;
}

const props = defineProps<{
    health: OpsHealthResponse;
    loading: boolean;
}>();

defineEmits<{
    refresh: [];
}>();

const expandedEvidence = ref(new Set<string>());
const copyFeedback = ref('');
const healthyStatuses = new Set<AdminSystemStatus>([
    'ok',
    'ready',
    'success',
    'applied',
    'queued',
    'empty'
]);
const optionalArtifactKinds = new Set(['restore-drill']);

const toStatus = (value: string | null | undefined): AdminSystemStatus =>
    value && value in adminStatusTone ? value as AdminSystemStatus : 'unknown';

const severityRank = (status: AdminSystemStatus): number =>
{
    if (status === 'critical')
    {
        return 4;
    }
    if (['failed', 'failure', 'error', 'not_ready'].includes(status))
    {
        return 3;
    }
    if (['warning', 'degraded', 'stale', 'denied', 'issue', 'issues'].includes(status))
    {
        return 2;
    }
    return 1;
};

const severityIcon = (rank: number): string => rank >= 3 ? '!' : rank === 2 ? '△' : 'i';

const serviceIncident = (
    item: AdminServiceStatusResponse,
    source: '服务' | 'Worker'
): OpsIncident | null =>
{
    const status = toStatus(item.status);
    if (healthyStatuses.has(status))
    {
        return null;
    }
    const rank = severityRank(status);
    return {
        evidence: item.detail ? { detail: item.detail, path: null } : null,
        icon: severityIcon(rank),
        key: `${source}-${item.key}`,
        message: item.detail ?? `${item.label} 没有返回可用的运行详情。`,
        occurredAt: item.updatedAt ?? props.health.checkedAt,
        rank,
        severity: status,
        severityLabel: adminStatusLabel[status],
        title: `${source}：${item.label}`
    };
};

const isOptionalAbsence = (artifact: BackupArtifactResponse): boolean =>
    toStatus(artifact.status) === 'missing'
    && optionalArtifactKinds.has(artifact.kind)
    && ['not_run', 'not_found'].includes(artifact.detail ?? '');

const artifactIncident = (artifact: BackupArtifactResponse): OpsIncident | null =>
{
    const status = toStatus(artifact.status);
    if (healthyStatuses.has(status) || isOptionalAbsence(artifact))
    {
        return null;
    }
    const rank = severityRank(status);
    return {
        evidence: {
            detail: artifact.detail ?? artifact.path ?? '备份产物未返回详情',
            path: artifact.path
        },
        icon: severityIcon(rank),
        key: `backup-${artifact.kind}`,
        message: artifact.detail ?? '备份产物需要检查。',
        occurredAt: artifact.updatedAt ?? props.health.backup.checkedAt,
        rank,
        severity: status,
        severityLabel: adminStatusLabel[status],
        title: `备份：${artifactKindLabel(artifact.kind)}`
    };
};

const incidents = computed<OpsIncident[]>(() =>
{
    const items: OpsIncident[] = [];
    for (const error of props.health.recentErrors)
    {
        const severity = toStatus(error.severity);
        const rank = severityRank(severity);
        items.push({
            evidence: error.detail ? { detail: error.detail, path: null } : null,
            icon: severityIcon(rank),
            key: `error-${error.action}-${error.occurredAt}-${error.count}`,
            message: error.message,
            occurredAt: error.occurredAt,
            rank,
            severity,
            severityLabel: adminStatusLabel[severity],
            title: error.action
        });
    }
    for (const service of props.health.services)
    {
        const incident = serviceIncident(service, '服务');
        if (incident)
        {
            items.push(incident);
        }
    }
    for (const worker of props.health.workers)
    {
        const incident = serviceIncident(worker, 'Worker');
        if (incident)
        {
            items.push(incident);
        }
    }
    for (const artifact of props.health.backup.artifacts)
    {
        const incident = artifactIncident(artifact);
        if (incident)
        {
            items.push(incident);
        }
    }
    const backupStatus = toStatus(props.health.backup.status);
    const hasBackupArtifactIncident = items.some(item => item.key.startsWith('backup-'));
    if (!healthyStatuses.has(backupStatus) && !hasBackupArtifactIncident)
    {
        const rank = severityRank(backupStatus);
        items.push({
            evidence: {
                detail: `备份根目录：${props.health.backup.backupRoot}`,
                path: props.health.backup.backupRoot
            },
            icon: severityIcon(rank),
            key: 'backup-overall',
            message: '备份状态需要检查，但没有返回具体的异常产物。',
            occurredAt: props.health.backup.checkedAt,
            rank,
            severity: backupStatus,
            severityLabel: adminStatusLabel[backupStatus],
            title: '备份运行状态'
        });
    }
    const failedMutations = props.health.queueBacklog.articleMutationFailed;
    const droppedAudits = props.health.queueBacklog.auditDropped;
    if (failedMutations > 0 || droppedAudits > 0)
    {
        items.push({
            evidence: {
                detail: `文章变更失败 ${failedMutations} 项；审计丢弃 ${droppedAudits} 项`,
                path: null
            },
            icon: '!',
            key: 'queue-failures',
            message: `文章变更失败 ${failedMutations} 项，审计丢弃 ${droppedAudits} 项。`,
            occurredAt: props.health.checkedAt,
            rank: 3,
            severity: 'failed',
            severityLabel: adminStatusLabel.failed,
            title: '队列出现不可恢复项'
        });
    }
    return items.sort((left, right) => (
        right.rank - left.rank
        || Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
        || left.key.localeCompare(right.key)
    ));
});

const releaseIdentity = computed(() => toOpsReleaseIdentityView(props.health.releaseIdentity));
const latestChangeLabel = computed(() => incidents.value[0]
    ? formatTime(incidents.value[0].occurredAt)
    : '无异常变化');
const statusSummary = computed(() => incidents.value.length > 0
    ? `发现 ${incidents.value.length} 项需要处理的运行异常。`
    : '系统处于预期状态，没有需要处理的运行异常。');
const healthyItems = computed(() => [...props.health.services, ...props.health.workers]
    .filter(item => healthyStatuses.has(toStatus(item.status))));
const optionalAbsences = computed(() => props.health.backup.artifacts.filter(isOptionalAbsence));
const quietSummary = computed(() =>
{
    const parts = [`${healthyItems.value.length} 个服务正常`];
    if (optionalAbsences.value.length)
    {
        parts.push(`${optionalAbsences.value.length} 项可选状态未提供`);
    }
    return parts.join(' · ');
});
const healthyServiceLabels = computed(() => healthyItems.value.map(item => item.label).join('、') || '无');
const optionalAbsenceLabels = computed(() => optionalAbsences.value
    .map(item => artifactKindLabel(item.kind))
    .join('、') || '无');

function artifactKindLabel(kind: string): string
{
    const labels: Readonly<Record<string, string>> = {
        database: '数据库',
        uploads: '上传文件',
        'data-protection-keyring': '数据保护密钥',
        config: '配置文件',
        'site-package': '站点包',
        'restore-drill': '恢复演练'
    };
    return labels[kind] ?? kind;
}

function formatTime(value: string | null | undefined): string
{
    if (!value)
    {
        return '-';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? '-'
        : new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(date);
}

function compactPath(path: string): string
{
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 3)
    {
        return path;
    }
    const root = path.startsWith('/') ? `/${parts[0]}` : parts[0];
    return `${root}/…/${parts.at(-1)}`;
}

function toggleEvidence(key: string): void
{
    const next = new Set(expandedEvidence.value);
    if (next.has(key))
    {
        next.delete(key);
    }
    else
    {
        next.add(key);
    }
    expandedEvidence.value = next;
}

async function copyEvidence(incident: OpsIncident): Promise<void>
{
    if (!incident.evidence)
    {
        return;
    }
    const text = [
        incident.title,
        incident.message,
        incident.evidence.path,
        incident.evidence.detail
    ].filter(Boolean).join('\n');
    try
    {
        await navigator.clipboard.writeText(text);
        copyFeedback.value = '证据已复制';
    }
    catch
    {
        copyFeedback.value = '复制失败，请展开详情手动复制';
    }
}
</script>

<style scoped>
.ops-workbench
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-6);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-panel-bg);
}

.ops-status-strip
 {
    padding: var(--fsus-space-5);
}

.ops-status-strip__heading,
.ops-section__header
 {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fsus-space-4);
}

.ops-status-strip h2,
.ops-section h2
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 16px;
    font-weight: 700;
    line-height: 1.4;
}

.ops-status-strip p,
.ops-section__header p
 {
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
}

.ops-quiet summary:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.ops-status-strip__values
 {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: var(--fsus-space-4) 0 0;
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-top: var(--fsus-space-4);
}

.ops-status-strip__values > div
 {
    min-width: 0;
    border-left: 1px solid var(--fsusblog-panel-border);
    padding: 0 var(--fsus-space-4);
}

.ops-status-strip__values > div:first-child
 {
    border-left: 0;
    padding-left: 0;
}

.ops-status-strip__values dt,
.ops-quiet dt
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
}

.ops-status-strip__values dd
 {
    overflow: hidden;
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ops-section__header
 {
    padding: var(--fsus-space-4);
}

.ops-incident-list
 {
    margin: 0;
    padding: 0;
    list-style: none;
}

.ops-incident-row
 {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr) 144px;
    min-height: 56px;
    border-top: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-3) var(--fsus-space-4);
}

.ops-incident-row__severity
 {
    display: flex;
    align-items: flex-start;
    gap: var(--fsus-space-2);
    padding-top: var(--fsus-space-1);
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
}

.ops-incident-row__severity[data-severity="critical"],
.ops-incident-row__severity[data-severity="failed"],
.ops-incident-row__severity[data-severity="failure"],
.ops-incident-row__severity[data-severity="error"],
.ops-incident-row__severity[data-severity="not_ready"]
 {
    color: var(--fsusblog-admin-status-danger);
}

.ops-incident-row__content
 {
    min-width: 0;
}

.ops-incident-row__content h3
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.5;
}

.ops-incident-row__content > p
 {
    overflow: hidden;
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ops-incident-row__time
 {
    width: 144px;
    padding-top: var(--fsus-space-1);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
    text-align: right;
}

.ops-evidence
 {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--fsus-space-2) var(--fsus-space-3);
    margin-top: var(--fsus-space-2);
}

.ops-evidence__path
 {
    flex: 1 1 18rem;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--fsusblog-text-muted);
    font-family: var(--fsus-typography-code-family, var(--fsus-font-code, ui-monospace, monospace));
    font-size: 12px;
    line-height: 1.5;
}

.ops-evidence__actions
 {
    display: flex;
    flex: 0 0 auto;
    gap: var(--fsus-space-1);
}

.ops-evidence__actions > .ops-evidence__disclosure
 {
    margin: 0;
}

.ops-evidence__detail
 {
    flex: 1 0 100%;
    max-height: 12rem;
    overflow: auto;
    margin: 0;
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-panel-bg-soft);
    padding: var(--fsus-space-3) var(--fsus-space-3);
    color: var(--fsusblog-text-secondary);
    font-family: var(--fsus-typography-code-family, var(--fsus-font-code, ui-monospace, monospace));
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.ops-incidents-empty
 {
    margin: 0;
    border-top: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-5) var(--fsus-space-4);
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
}

.ops-quiet details
 {
    min-width: 0;
}

.ops-quiet summary
 {
    display: flex;
    min-height: 48px;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-3);
    padding: 0 var(--fsus-space-4);
    color: var(--fsusblog-text-primary);
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
}

.ops-quiet__count
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 500;
}

.ops-quiet__body
 {
    border-top: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-4) var(--fsus-space-4) var(--fsus-space-4);
}

.ops-quiet__body dl
 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fsus-space-4) var(--fsus-space-6);
    margin: 0;
}

.ops-quiet dd
 {
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
}

.ops-copy-feedback
 {
    min-height: 18px;
    margin: -18px 0 0;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
}

@media (width <= 1023px)
 {
    .ops-status-strip__values
 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--fsus-space-3) 0;
    }

    .ops-status-strip__values > div:nth-child(3)
 {
        border-left: 0;
        padding-left: 0;
    }

    .ops-incident-row
 {
        grid-template-columns: minmax(72px, 88px) minmax(0, 1fr);
    }

    .ops-incident-row__time
 {
        grid-column: 2;
        width: auto;
        margin-top: var(--fsus-space-1);
        text-align: left;
    }
}

@media (width <= 479px)
 {
    .ops-status-strip
 {
        padding: var(--fsus-space-4);
    }

    .ops-status-strip__heading
 {
        display: grid;
    }

    .ops-status-strip__values
 {
        grid-template-columns: 1fr;
    }

    .ops-status-strip__values > div
 {
        border-left: 0;
        padding: 0;
    }

    .ops-incident-row
 {
        grid-template-columns: 1fr;
        padding: var(--fsus-space-3);
    }

    .ops-incident-row__severity
 {
        width: auto;
        margin-bottom: var(--fsus-space-1);
    }

    .ops-incident-row__time
 {
        grid-column: 1;
    }

    .ops-evidence__path
 {
        flex-basis: 100%;
    }

    .ops-quiet summary
 {
        align-items: flex-start;
        flex-direction: column;
        justify-content: center;
        padding-block: var(--fsus-space-3);
    }

    .ops-quiet__body dl
 {
        grid-template-columns: 1fr;
    }
}
</style>
