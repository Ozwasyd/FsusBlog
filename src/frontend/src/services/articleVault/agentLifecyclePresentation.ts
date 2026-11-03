import {
    isVaultAgentDisplayScope,
    matchesVaultAgentDisplayScope,
    type VaultAgentLeasePresentation,
    type VaultAgentLeaseScope
} from '@/services/articleVault/agentLeasePresentation';

/** Display subset of c962b70adcb049d8e2eb57ef016739d1e684f7f0.
 * ArticleVaultAgentProtocol encodes camelCase fields and kebab-case enums.
 * No receipt-chain verification, transition reducer or native admission is implemented here.
 */
export type VaultAgentLifecycleState = 'installed' | 'starting' | 'running' | 'stopping' | 'stopped'
    | 'updating' | 'rollback-required' | 'crashed' | 'reconnecting' | 'unlinking' | 'removed' | 'retained-control-state';

export type VaultAgentRecoveryReferences = Readonly<{
    rootManifestSha256: string;
    sourceTreeSha256: string;
    watcherWatermarkSha256: string;
    rescanReceiptSha256: string;
    operationReceiptsSha256: string;
}>;

export type VaultAgentLifecycleReport = Readonly<{
    schema: 'fsusblog.article-vault.agent-lifecycle.v1';
    binding: VaultAgentLeaseScope;
    platform: 'linux' | 'windows' | 'mac-os';
    previousState: VaultAgentLifecycleState;
    newState: VaultAgentLifecycleState;
    sequence: number;
    observedUnixMilliseconds: number;
    rescanRequired: boolean;
    leaseGeneration: number | null;
    leaseReceiptSha256: string | null;
    ipcReceiptSha256: string | null;
    retainedBinarySha256: string | null;
    candidateBinarySha256: string | null;
    recovery: VaultAgentRecoveryReferences | null;
    producerReceiptSha256: string | null;
    reasonCode: string | null;
    previousReceiptSha256: string | null;
    contentSha256: string;
}>;

const states: readonly VaultAgentLifecycleState[] = ['installed', 'starting', 'running', 'stopping', 'stopped',
    'updating', 'rollback-required', 'crashed', 'reconnecting', 'unlinking', 'removed', 'retained-control-state'];
const digestLabels = {
    leaseReceiptSha256: 'Lease receipt SHA-256',
    ipcReceiptSha256: 'IPC receipt SHA-256',
    retainedBinarySha256: '保留 binary SHA-256',
    candidateBinarySha256: '候选 binary SHA-256',
    producerReceiptSha256: 'Producer receipt SHA-256',
    previousReceiptSha256: '前序 receipt SHA-256'
} as const;
const recoveryLabels = {
    rootManifestSha256: 'Root manifest SHA-256',
    sourceTreeSha256: 'Source tree SHA-256',
    watcherWatermarkSha256: 'Watcher watermark SHA-256',
    rescanReceiptSha256: 'Rescan receipt SHA-256',
    operationReceiptsSha256: 'Operation receipts SHA-256'
} as const;

function isDigest(value: unknown): value is string
{
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

/** Whitelist report values for display; never establish receipt validity or current health. */
export function presentVaultAgentLifecycle(
    report: VaultAgentLifecycleReport | null,
    expectedScope: VaultAgentLeaseScope | null
): VaultAgentLeasePresentation
{
    if (!report || !expectedScope || !report.binding)
    {
        return { availability: 'unavailable', rows: [] };
    }
    if (!matchesVaultAgentDisplayScope(report.binding, expectedScope))
    {
        return { availability: 'scope-mismatch', rows: [] };
    }
    if (!isVaultAgentDisplayScope(report.binding)
        || report.schema !== 'fsusblog.article-vault.agent-lifecycle.v1'
        || !['linux', 'windows', 'mac-os'].includes(report.platform)
        || !states.includes(report.previousState) || !states.includes(report.newState)
        || !Number.isSafeInteger(report.sequence) || report.sequence < 1
        || !Number.isSafeInteger(report.observedUnixMilliseconds) || report.observedUnixMilliseconds < 0
        || typeof report.rescanRequired !== 'boolean'
        || report.leaseGeneration !== null && (!Number.isSafeInteger(report.leaseGeneration) || report.leaseGeneration < 1)
        || !isDigest(report.contentSha256)
        || (Object.keys(digestLabels) as (keyof typeof digestLabels)[]).some(field => report[field] !== null && !isDigest(report[field]))
        || report.reasonCode !== null && (typeof report.reasonCode !== 'string' || !/^[A-Za-z0-9_]{1,64}$/u.test(report.reasonCode))
        || report.recovery !== null && (Object.keys(recoveryLabels) as (keyof typeof recoveryLabels)[]).some(field => !isDigest(report.recovery?.[field])))
    {
        return { availability: 'unavailable', rows: [] };
    }
    return {
        availability: 'reported',
        rows: [
            { label: '报告平台（非平台资格）', value: report.platform },
            { label: '前序报告状态', value: report.previousState },
            { label: '当前报告状态（尚未验证当前性）', value: report.newState },
            { label: '报告序号', value: String(report.sequence) },
            { label: '报告观察时间（Unix 毫秒）', value: String(report.observedUnixMilliseconds) },
            { label: '报告要求 rescan', value: report.rescanRequired ? '是' : '否（不证明 rescan 已通过原生验证）' },
            { label: '报告原因', value: report.reasonCode ?? '无报告原因' },
            { label: 'Lease generation', value: report.leaseGeneration === null ? '无引用' : String(report.leaseGeneration) },
            ...(Object.keys(digestLabels) as (keyof typeof digestLabels)[]).map(field => ({ label: digestLabels[field], value: report[field] ?? '无引用' })),
            ...(report.recovery ? (Object.keys(recoveryLabels) as (keyof typeof recoveryLabels)[]).map(field => ({ label: recoveryLabels[field], value: report.recovery![field] })) : []),
            { label: 'Lifecycle receipt SHA-256（尚未验证）', value: report.contentSha256 }
        ]
    };
}
