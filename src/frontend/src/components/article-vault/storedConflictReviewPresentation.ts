import type { ConflictEvidencePresentation } from './conflictEvidencePresentation';
import type { ResolutionPlanPresentation, VaultValidationPresentation } from './resolutionStatusPresentation';

/** Host request correlation, not an authentication grant or an additional wire DTO. */
export interface VaultReviewDisplayContext {
    readonly actorIdentity: string;
    readonly sessionEpoch: string;
    readonly siteIdentity: string;
    readonly vaultIdentity: string;
    readonly deviceIdentity: string;
    readonly serverArticleIdentity: string;
    readonly portableArticleIdentity: string;
}

/** Read-only fields of the actual ArticleVaultOperationIdentity; never constructed from a route. */
export interface StoredOperationPresentation {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly siteIdentity: string;
    readonly vaultIdentity: string;
    readonly deviceIdentity: string;
    readonly agentIdentity: string;
    readonly planReference: string;
    readonly planSha256: string;
    readonly requestSha256: string;
    readonly idempotencySha256: string;
    readonly deadlineUnixMs: number;
    readonly operationIdentity: string;
    readonly contentSha256: string;
}

export interface VaultStoredReviewReference {
    readonly resolutionOperationIdentity: string;
    readonly proposalSha256: string;
    readonly checkpoint: {
        readonly operation: StoredOperationPresentation;
        readonly sequence: number;
        readonly contentSha256: string;
    } | null;
}

type ScopedBinding = ConflictEvidencePresentation['binding'] & {
    readonly siteIdentity: string;
    readonly vaultIdentity: string;
    readonly deviceIdentity: string;
    readonly serverArticleIdentity: string | null;
    readonly planCandidateIdentity: string;
    readonly groupIdentity: string;
};

/** Subset of canonical operation-checkpoint fields, distinct from a recovery-journal checkpoint. */
export interface StoredOperationCheckpointPresentation {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly operationIdentity: string;
    readonly identitySha256: string;
    readonly sequence: number;
    readonly state: string;
    readonly serverCommit: string;
    readonly serverResult: { readonly reference: string; readonly contentSha256: string; } | null;
    readonly materializationReceipt: { readonly reference: string; readonly contentSha256: string; } | null;
    readonly cancellationRequested: boolean;
    readonly reasonCode: string | null;
    readonly contentSha256: string;
}

/** Read-only projection of ArticleVaultConflictReviewSnapshot, consumed after the canonical boundary. */
export interface VaultStoredReviewSnapshot {
    readonly proposal: ResolutionPlanPresentation & { readonly binding: ScopedBinding; };
    readonly currentEvidence: (ConflictEvidencePresentation & { readonly binding: ScopedBinding; }) | null;
    readonly currentValidation: VaultValidationPresentation;
    readonly executionAdmission: VaultValidationPresentation;
    readonly permissionSnapshotSha256: string;
    readonly checkpoint: {
        readonly resolutionPlanSha256: string;
        readonly operation: StoredOperationPresentation;
        readonly checkpoints: readonly StoredOperationCheckpointPresentation[];
        readonly missingCapabilities: readonly string[];
    } | null;
}

export interface VaultStoredReviewResponse {
    /** Host-issued correlation identity for this actual read; not a permission or machine receipt. */
    readonly requestIdentity: string;
    readonly context: VaultReviewDisplayContext;
    readonly requested: VaultStoredReviewReference;
    readonly snapshot: VaultStoredReviewSnapshot;
}

const operationFields: readonly (keyof StoredOperationPresentation)[] = [
    'schema', 'schemaVersion', 'siteIdentity', 'vaultIdentity', 'deviceIdentity', 'agentIdentity',
    'planReference', 'planSha256', 'requestSha256', 'idempotencySha256', 'deadlineUnixMs', 'operationIdentity', 'contentSha256'
];
const contextFields: readonly (keyof VaultReviewDisplayContext)[] = [
    'actorIdentity', 'sessionEpoch', 'siteIdentity', 'vaultIdentity', 'deviceIdentity', 'serverArticleIdentity', 'portableArticleIdentity'
];
const operationStates: Readonly<Record<string, string>> = {
    planned: '已记录计划阶段', validating: '已记录校验阶段', 'executing-server': '已记录服务端执行阶段',
    'materializing-local': '已记录本地物化阶段', 'recovery-required': '需要恢复', cancelled: '已记录取消',
    failed: '已记录失败', synced: '已记录同步检查点', blocked: '已记录阻止'
};

function sameOperation(left: StoredOperationPresentation, right: StoredOperationPresentation): boolean
{
    return operationFields.every(field => left[field] === right[field]);
}

/** Correlates display responses only; canonical permissions, hashes/history/currentness remain server-owned. */
export function presentStoredConflictReview(
    response: VaultStoredReviewResponse,
    expected: VaultStoredReviewReference,
    context: VaultReviewDisplayContext,
    requestIdentity: string
): VaultStoredReviewSnapshot | null
{
    if (response.requestIdentity !== requestIdentity
        || !contextFields.every(field => response.context[field] === context[field])
        || response.requested.resolutionOperationIdentity !== expected.resolutionOperationIdentity
        || response.requested.proposalSha256 !== expected.proposalSha256
        || (response.requested.checkpoint === null) !== (expected.checkpoint === null))
    {
        return null;
    }
    if (expected.checkpoint && (!response.requested.checkpoint
        || !sameOperation(response.requested.checkpoint.operation, expected.checkpoint.operation)
        || response.requested.checkpoint.sequence !== expected.checkpoint.sequence
        || response.requested.checkpoint.contentSha256 !== expected.checkpoint.contentSha256))
    {
        return null;
    }
    const snapshot = response.snapshot;
    const proposal = snapshot.proposal;
    const binding = proposal.binding;
    if (proposal.resolutionOperationIdentity !== expected.resolutionOperationIdentity
        || proposal.contentSha256 !== expected.proposalSha256
        || binding.siteIdentity !== context.siteIdentity || binding.vaultIdentity !== context.vaultIdentity
        || binding.deviceIdentity !== context.deviceIdentity || binding.serverArticleIdentity !== context.serverArticleIdentity
        || binding.portableArticleIdentity !== context.portableArticleIdentity)
    {
        return null;
    }
    if (snapshot.currentEvidence && (!snapshot.currentValidation.isValid
        || snapshot.currentEvidence.contentSha256 !== proposal.evidenceSha256
        || snapshot.currentEvidence.binding.operationIdentity !== binding.operationIdentity
        || snapshot.currentEvidence.binding.planCandidateIdentity !== binding.planCandidateIdentity
        || snapshot.currentEvidence.binding.planSha256 !== binding.planSha256
        || snapshot.currentEvidence.binding.groupIdentity !== binding.groupIdentity
        || snapshot.currentEvidence.binding.siteIdentity !== context.siteIdentity
        || snapshot.currentEvidence.binding.vaultIdentity !== context.vaultIdentity
        || snapshot.currentEvidence.binding.deviceIdentity !== context.deviceIdentity
        || snapshot.currentEvidence.binding.serverArticleIdentity !== context.serverArticleIdentity
        || snapshot.currentEvidence.binding.portableArticleIdentity !== context.portableArticleIdentity))
    {
        return null;
    }
    if (!expected.checkpoint)
    {
        return snapshot.checkpoint === null ? snapshot : null;
    }
    const checkpoint = snapshot.checkpoint;
    const tip = checkpoint?.checkpoints.at(-1);
    if (!checkpoint || !tip || checkpoint.resolutionPlanSha256 !== proposal.contentSha256
        || !sameOperation(checkpoint.operation, expected.checkpoint.operation)
        || checkpoint.operation.siteIdentity !== context.siteIdentity
        || checkpoint.operation.vaultIdentity !== context.vaultIdentity || checkpoint.operation.deviceIdentity !== context.deviceIdentity
        || checkpoint.operation.planReference !== binding.planCandidateIdentity || checkpoint.operation.planSha256 !== binding.planSha256
        || tip.schema !== 'fsusblog.article-vault.operation-checkpoint.v1' || tip.schemaVersion !== 1
        || tip.operationIdentity !== checkpoint.operation.operationIdentity || tip.identitySha256 !== checkpoint.operation.contentSha256
        || tip.sequence !== expected.checkpoint.sequence || tip.contentSha256 !== expected.checkpoint.contentSha256
        || !Object.hasOwn(operationStates, tip.state)
        || !['not-started', 'unknown', 'accepted', 'rejected'].includes(tip.serverCommit))
    {
        return null;
    }
    return snapshot;
}

export function storedOperationStateLabel(state: string): string | null
{
    return Object.hasOwn(operationStates, state) ? operationStates[state] : null;
}
