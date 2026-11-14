import type { ConflictDisplaySchema, ConflictEvidencePresentation } from './conflictEvidencePresentation';

/** Read-only fields consumed from ArticleVaultResolutionPlan at canonical capability bb49a4c.
 * The host owns codec/current validation; this projection cannot create or qualify a plan.
 */
export interface ResolutionPlanPresentation {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly resolutionOperationIdentity: string;
    readonly state: string;
    readonly contentSha256: string;
    readonly evidenceSha256: string;
    readonly gitFactsSha256: string;
    readonly binding: ConflictEvidencePresentation['binding'];
    readonly groups: readonly {
        readonly groupIdentity: string;
        readonly allOrNothing: boolean;
        readonly portableArticleIdentities: readonly string[];
        readonly dependencies: readonly {
            readonly prerequisitePortableArticleIdentity: string;
            readonly dependentPortableArticleIdentity: string;
        }[];
    }[];
    readonly decisions: readonly {
        readonly type: string;
        readonly action: string;
        readonly provenance: string;
        readonly resultCandidateSha256: string | null;
    }[];
    readonly expectedOutput: {
        readonly expectedServerRevision: number | null;
        readonly sourceSha256: string;
        readonly metadataManifestSha256: string;
        readonly dependencySha256: string;
    } | null;
    readonly expiresAtUnixMs: number;
}

export interface RecoveryReferencePresentation {
    readonly identity: string;
    readonly contentSha256: string;
}

/** A sealed checkpoint descriptor is not physical receipt, encryption or cleanup proof. */
export interface RecoveryJournalPresentation {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly resolutionOperationIdentity: string;
    readonly planSha256: string;
    readonly sequence: number;
    readonly state: string;
    readonly previousCheckpointSha256: string | null;
    readonly contentSha256: string;
    readonly serverResult: RecoveryReferencePresentation | null;
    readonly localMaterialization: RecoveryReferencePresentation | null;
    readonly baseCommit: RecoveryReferencePresentation | null;
    readonly beforeBaseSha256: string;
    readonly afterBaseSha256: string | null;
    readonly backupPolicy: {
        readonly maxBytes: number;
        readonly deleteAfterUnixMs: number;
        readonly encryptionRequired: boolean;
    };
}

/** Actual ArticleVaultValidationResult from its named canonical verifier, never a UI verified flag. */
export interface VaultValidationPresentation {
    readonly isValid: boolean;
    readonly reasonCode: string | null;
}

/** Host correlation metadata around the unchanged canonical result, not a new machine contract. */
export interface VaultBoundValidationPresentation {
    readonly requested: VaultCurrentCheckIntent;
    readonly result: VaultValidationPresentation;
}

export interface VaultCurrentCheckIntent {
    readonly resolutionOperationIdentity: string;
    readonly planSha256: string;
    readonly checkpoint: RecoveryReferencePresentation | null;
}

export function validationDisplayMatches(
    check: VaultBoundValidationPresentation,
    plan: ResolutionPlanPresentation,
    checkpoint: RecoveryReferencePresentation | null,
    includesHistory: boolean
): boolean
{
    return check.requested.resolutionOperationIdentity === plan.resolutionOperationIdentity
        && check.requested.planSha256 === plan.contentSha256
        && (!includesHistory || (check.requested.checkpoint?.identity === checkpoint?.identity
            && check.requested.checkpoint?.contentSha256 === checkpoint?.contentSha256));
}

const recoveryLabels: Readonly<Record<string, string>> = {
    prepared: '已准备检查点',
    'server-committing': '服务端提交阶段',
    'server-committed': '服务端已提交检查点',
    'local-materializing': '本地落盘阶段',
    'recovery-required': '需要恢复',
    recovered: '已恢复检查点',
    'rolled-forward': '已向前恢复检查点',
    cancelled: '已取消检查点',
    failed: '失败检查点',
    complete: '完成检查点'
};

export function recoveryStateLabel(state: string): string | null
{
    return Object.hasOwn(recoveryLabels, state) ? recoveryLabels[state] : null;
}

export function resolutionStateLabel(state: string): string | null
{
    if (state === 'prepared')
    {
        return '已封存的解决提案';
    }
    if (state === 'cancelled')
    {
        return '已取消的解决提案';
    }
    return null;
}

/** Display support only: canonical schema/version and closed names, never digest/current admission. */
export function resolutionDisplayCompatible(plan: ResolutionPlanPresentation, vocabulary: ConflictDisplaySchema): boolean
{
    return plan.schema === 'fsusblog.article-vault.resolution-plan.v1' && plan.schemaVersion === 1
        && resolutionStateLabel(plan.state) !== null
        && plan.decisions.length > 0 && plan.decisions.length <= vocabulary.properties.items.maxItems
        && plan.decisions.every(decision => vocabulary.$defs.type.enum.includes(decision.type)
            && vocabulary.$defs.action.enum.includes(decision.action)
            && vocabulary.$defs.disposition.enum.includes(decision.provenance));
}

/** Refuse displaying a different operation/tip; history/artifact validation still belongs to the owner. */
export function recoveryDisplayMatches(
    plan: ResolutionPlanPresentation,
    journal: RecoveryJournalPresentation,
    checkpoint: RecoveryReferencePresentation
): boolean
{
    return journal.schema === 'fsusblog.article-vault.recovery-journal.v1' && journal.schemaVersion === 1
        && recoveryStateLabel(journal.state) !== null
        && journal.resolutionOperationIdentity === plan.resolutionOperationIdentity
        && journal.planSha256 === plan.contentSha256
        && checkpoint.identity === `${plan.resolutionOperationIdentity}-checkpoint-${journal.sequence}`
        && checkpoint.contentSha256 === journal.contentSha256;
}

export function vaultCurrentCheckIntent(
    plan: ResolutionPlanPresentation,
    checkpoint: RecoveryReferencePresentation | null
): VaultCurrentCheckIntent
{
    return {
        resolutionOperationIdentity: plan.resolutionOperationIdentity,
        planSha256: plan.contentSha256,
        checkpoint: checkpoint ? { identity: checkpoint.identity, contentSha256: checkpoint.contentSha256 } : null
    };
}
