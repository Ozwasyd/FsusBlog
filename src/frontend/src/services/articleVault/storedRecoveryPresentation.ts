import type { VaultServerExecutionDocument } from '@/services/articleVault/executionProgress';

/** Read-only subsets of the exact proposal store/checkpoint reader at 8b98366438ed76de4b6b57e682dba3939f89eb87.
 * These are already-decoded producer documents, not a transport codec, store, journal or verifier.
 * Operation checkpoints must never be cast into ArticleVaultRecoveryJournal.
 */
export type VaultStoredResolutionProposal = Readonly<{
    schema: 'fsusblog.article-vault.resolution-plan.v1';
    schemaVersion: 1;
    resolutionOperationIdentity: string;
    state: 'prepared' | 'cancelled';
    binding: Readonly<{
        siteIdentity: string;
        vaultIdentity: string;
        deviceIdentity: string;
        portableArticleIdentity: string;
        serverArticleIdentity: string | null;
        planCandidateIdentity: string;
        planSha256: string;
        groupIdentity: string;
        operationIdentity: string;
    }>;
    evidenceSha256: string;
    gitFactsSha256: string;
    rootManifestSha256: string;
    contentSha256: string;
}>;

export type VaultStoredOperationIdentity = Readonly<{
    schema: 'fsusblog.article-vault.operation-identity.v1';
    schemaVersion: 1;
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    agentIdentity: string;
    planReference: string;
    planSha256: string;
    operationIdentity: string;
    contentSha256: string;
}>;

export type VaultStoredOperationCheckpoint = Readonly<{
    schema: 'fsusblog.article-vault.operation-checkpoint.v1';
    schemaVersion: 1;
    operationIdentity: string;
    identitySha256: string;
    sequence: number;
    state: 'planned' | 'validating' | 'executing-server' | 'materializing-local' | 'recovery-required'
        | 'cancelled' | 'failed' | 'synced' | 'blocked';
    serverCommit: 'not-started' | 'unknown' | 'accepted' | 'rejected';
    serverResult: Readonly<{ reference: string; contentSha256: string; }> | null;
    materializationReceipt: Readonly<{ reference: string; contentSha256: string; }> | null;
    reasonCode: string | null;
    contentSha256: string;
}>;

export type VaultStoredRecoverySnapshot = Readonly<{
    resolutionPlanSha256: string;
    operation: VaultStoredOperationIdentity;
    checkpoints: readonly VaultStoredOperationCheckpoint[];
    serverResult: VaultServerExecutionDocument | null;
    missingCapabilities: readonly string[];
}>;

export type VaultStoredRecoveryDisplayScope = Readonly<{
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    agentIdentity: string;
    portableArticleIdentity: string;
    serverArticleIdentity: string | null;
    planReference: string;
    planSha256: string;
    groupIdentity: string;
    itemOperationIdentity: string;
    operationIdentity: string;
    operationSha256: string;
    resolutionOperationIdentity: string;
    resolutionPlanSha256: string;
    exactSequence: number;
    exactCheckpointSha256: string;
}>;

const missingLabels = {
    canonical_conflict_resolution_execution_admission: '冲突解决执行准入',
    encrypted_recovery_backup_and_journal_persistence: '加密恢复备份与日志持久化',
    native_conditional_write_and_readback: '原生条件写入与回读',
    atomic_verified_manifest_base_receipt_commit: '原子 manifest/base 回执提交'
} as const;
const states = ['planned', 'validating', 'executing-server', 'materializing-local', 'recovery-required', 'cancelled', 'failed', 'synced', 'blocked'];
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const safeReference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,1024}$/u.test(value);

function isReadonlyList(value: unknown): value is readonly unknown[]
{
    return Array.isArray(value);
}

/** Display isolation, never VerifyCurrent/history admission, latest selection or current publication eligibility. */
export function presentVaultStoredRecovery(
    proposal: VaultStoredResolutionProposal | null,
    snapshot: VaultStoredRecoverySnapshot | null,
    expected: VaultStoredRecoveryDisplayScope | null
)
{
    if (!proposal || !snapshot || !expected || !proposal.binding || !snapshot.operation)
    {
        return null;
    }
    const binding = proposal.binding;
    const operation = snapshot.operation;
    if (proposal.schema !== 'fsusblog.article-vault.resolution-plan.v1' || proposal.schemaVersion !== 1
        || !['prepared', 'cancelled'].includes(proposal.state)
        || proposal.resolutionOperationIdentity !== expected.resolutionOperationIdentity
        || proposal.contentSha256 !== expected.resolutionPlanSha256 || snapshot.resolutionPlanSha256 !== proposal.contentSha256
        || binding.siteIdentity !== expected.siteIdentity || binding.vaultIdentity !== expected.vaultIdentity
        || binding.deviceIdentity !== expected.deviceIdentity || binding.portableArticleIdentity !== expected.portableArticleIdentity
        || binding.serverArticleIdentity !== expected.serverArticleIdentity
        || binding.planCandidateIdentity !== expected.planReference || binding.planSha256 !== expected.planSha256
        || binding.groupIdentity !== expected.groupIdentity || binding.operationIdentity !== expected.itemOperationIdentity
        || operation.schema !== 'fsusblog.article-vault.operation-identity.v1' || operation.schemaVersion !== 1
        || operation.siteIdentity !== expected.siteIdentity || operation.vaultIdentity !== expected.vaultIdentity
        || operation.deviceIdentity !== expected.deviceIdentity || operation.agentIdentity !== expected.agentIdentity
        || operation.planReference !== expected.planReference || operation.planSha256 !== expected.planSha256
        || operation.operationIdentity !== expected.operationIdentity || operation.contentSha256 !== expected.operationSha256
        || ![proposal.contentSha256, proposal.evidenceSha256, proposal.gitFactsSha256, proposal.rootManifestSha256,
            operation.contentSha256, operation.planSha256, expected.exactCheckpointSha256].every(digest)
        || expected.serverArticleIdentity !== null && !safeReference(expected.serverArticleIdentity)
        || ![expected.siteIdentity, expected.vaultIdentity, expected.deviceIdentity, expected.agentIdentity,
            proposal.resolutionOperationIdentity, expected.portableArticleIdentity, expected.groupIdentity,
            expected.itemOperationIdentity, operation.operationIdentity, operation.planReference].every(safeReference)
        || !Number.isSafeInteger(expected.exactSequence) || expected.exactSequence < 0
        || !isReadonlyList(snapshot.checkpoints) || snapshot.checkpoints.length === 0
        || !isReadonlyList(snapshot.missingCapabilities))
    {
        return null;
    }
    const last = snapshot.checkpoints[snapshot.checkpoints.length - 1];
    if (last?.sequence !== expected.exactSequence || last.contentSha256 !== expected.exactCheckpointSha256
        || snapshot.checkpoints.some(checkpoint => checkpoint?.schema !== 'fsusblog.article-vault.operation-checkpoint.v1'
            || checkpoint.schemaVersion !== 1 || checkpoint.operationIdentity !== operation.operationIdentity
            || checkpoint.identitySha256 !== operation.contentSha256
            || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0
            || !states.includes(checkpoint.state) || !['not-started', 'unknown', 'accepted', 'rejected'].includes(checkpoint.serverCommit)
            || !digest(checkpoint.contentSha256)
            || checkpoint.reasonCode !== null && (typeof checkpoint.reasonCode !== 'string' || !/^[A-Za-z0-9_]{1,128}$/u.test(checkpoint.reasonCode))
            || [checkpoint.serverResult, checkpoint.materializationReceipt].some(reference => reference !== null
                && (!safeReference(reference?.reference) || !digest(reference?.contentSha256)))))
    {
        return null;
    }
    return {
        proposalState: proposal.state,
        rows: [
            { label: 'Site / Vault / device / agent', value: `${expected.siteIdentity} / ${expected.vaultIdentity} / ${expected.deviceIdentity} / ${expected.agentIdentity}` },
            { label: 'Portable / server article identity', value: `${expected.portableArticleIdentity} / ${expected.serverArticleIdentity ?? '无 server identity'}` },
            { label: 'Resolution operation / proposal SHA-256', value: `${proposal.resolutionOperationIdentity} / ${proposal.contentSha256}` },
            { label: '原始 sync plan / SHA-256', value: `${operation.planReference} / ${operation.planSha256}` },
            { label: 'Operation / identity SHA-256', value: `${operation.operationIdentity} / ${operation.contentSha256}` },
            { label: 'Evidence / Git / root SHA-256', value: `${proposal.evidenceSha256} / ${proposal.gitFactsSha256} / ${proposal.rootManifestSha256}` }
        ],
        // Project only whitelisted fields; private extra producer/package fields are not returned.
        checkpoints: snapshot.checkpoints.map(checkpoint => ({
            sequence: checkpoint.sequence, state: checkpoint.state, serverCommit: checkpoint.serverCommit,
            reasonCode: checkpoint.reasonCode, contentSha256: checkpoint.contentSha256,
            serverResultReference: checkpoint.serverResult?.reference ?? null,
            materializationReference: checkpoint.materializationReceipt?.reference ?? null
        })),
        missingCapabilities: snapshot.missingCapabilities.map(code => typeof code === 'string' && Object.hasOwn(missingLabels, code)
            ? missingLabels[code as keyof typeof missingLabels] : '未识别的能力缺口（不展示未经约束的值）')
    };
}
