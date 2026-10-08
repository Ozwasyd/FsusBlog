/**
 * Read-only subset of ArticleVaultAgentBinding/ArticleVaultWriterLeaseReceipt at
 * 1e3da416a469ccfabd00fbcbf52a9ff333ef6483. This is a display projection, not the
 * canonical lease verifier or proof of native ownership, trust, or lifecycle.
 * UserSessionIdentity participates in scope rejection but is never projected for display.
 */
export type VaultAgentLeaseScope = Readonly<{
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    agentInstanceIdentity: string;
    userSessionIdentity: string;
    rootSha256: string;
    binarySha256: string;
    agentVersion: string;
    protocolVersion: number;
}>;

export type VaultAgentLeaseReport = Readonly<{
    schema: 'fsusblog.article-vault.writer-lease.v1';
    binding: VaultAgentLeaseScope;
    generation: number;
    state: 'released' | 'active' | 'revoked' | 'expired';
    observedUnixMilliseconds: number;
    deadlineUnixMilliseconds: number;
    previousReceiptSha256: string | null;
    contentSha256: string;
}>;

export type VaultAgentLeasePresentation = Readonly<{
    availability: 'unavailable' | 'scope-mismatch' | 'reported';
    rows: readonly Readonly<{ label: string; value: string; }>[];
}>;

const identityFields = ['siteIdentity', 'vaultIdentity', 'deviceIdentity', 'agentInstanceIdentity', 'userSessionIdentity'] as const;
const digestFields = ['rootSha256', 'binarySha256'] as const;
const scopeFields = [...identityFields, ...digestFields, 'agentVersion', 'protocolVersion'] as const;
const stateLabels = {
    released: 'released（报告已释放）',
    active: 'active（报告有效；不证明当前持有原生锁或正在运行）',
    revoked: 'revoked（报告已撤销）',
    expired: 'expired（报告已过期）'
} as const;

function isDigest(value: unknown): value is string
{
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isDisplayScope(scope: VaultAgentLeaseScope): boolean
{
    return identityFields.every(field => typeof scope[field] === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(scope[field]))
        && digestFields.every(field => isDigest(scope[field]))
        && typeof scope.agentVersion === 'string'
        && scope.agentVersion.length <= 32
        && /^\d+(?:\.\d+){1,3}$/u.test(scope.agentVersion)
        && Number.isSafeInteger(scope.protocolVersion);
}

/** Scope equality and display safety never establish canonical receipt validity. */
export function presentVaultAgentLease(
    report: VaultAgentLeaseReport | null,
    expectedScope: VaultAgentLeaseScope | null
): VaultAgentLeasePresentation
{
    if (!report || !expectedScope || !report.binding)
    {
        return { availability: 'unavailable', rows: [] };
    }
    if (scopeFields.some(field => report.binding[field] !== expectedScope[field]))
    {
        return { availability: 'scope-mismatch', rows: [] };
    }
    // This whitelist avoids echoing unsafe display values; it does not reproduce
    // the canonical verifier's hash chain, session binding, or machine authority.
    if (!isDisplayScope(report.binding)
        || report.schema !== 'fsusblog.article-vault.writer-lease.v1'
        || !Object.hasOwn(stateLabels, report.state)
        || !Number.isSafeInteger(report.generation) || report.generation < 1
        || !Number.isSafeInteger(report.observedUnixMilliseconds) || report.observedUnixMilliseconds < 0
        || !Number.isSafeInteger(report.deadlineUnixMilliseconds) || report.deadlineUnixMilliseconds < 0
        || !isDigest(report.contentSha256)
        || report.previousReceiptSha256 !== null && !isDigest(report.previousReceiptSha256))
    {
        return { availability: 'unavailable', rows: [] };
    }
    const binding = report.binding;
    return {
        availability: 'reported',
        rows: [
            { label: '站点 identity', value: binding.siteIdentity },
            { label: 'Vault identity', value: binding.vaultIdentity },
            { label: '设备 identity', value: binding.deviceIdentity },
            { label: 'Agent instance identity', value: binding.agentInstanceIdentity },
            { label: 'Agent 报告版本', value: binding.agentVersion },
            { label: '报告协议版本', value: String(binding.protocolVersion) },
            { label: 'Binary SHA-256（非签名或信任证明）', value: binding.binarySha256 },
            { label: 'Root SHA-256（不含完整路径）', value: binding.rootSha256 },
            { label: 'Lease 报告状态', value: stateLabels[report.state] },
            { label: 'Lease generation', value: String(report.generation) },
            { label: '报告观察时间（Unix 毫秒）', value: String(report.observedUnixMilliseconds) },
            { label: '报告截止时间（Unix 毫秒；不推断当前状态）', value: String(report.deadlineUnixMilliseconds) },
            { label: 'Receipt SHA-256（尚未验证）', value: report.contentSha256 },
            { label: '前序 receipt SHA-256（尚未验证）', value: report.previousReceiptSha256 ?? '无前序引用' }
        ]
    };
}
