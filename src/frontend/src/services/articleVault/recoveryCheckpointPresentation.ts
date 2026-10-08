/**
 * Read-only subset of ArticleVaultRecoveryJournal at bb49a4c1f579ddf8630c67776d6cd9fa1f8c0661.
 * Comparing display scope does not verify checkpoint history or referenced artifacts.
 */
export type VaultRecoveryArtifactReference = Readonly<{
    identity: string;
    contentSha256: string;
}>;

export type VaultRecoveryCheckpointState =
    | 'prepared'
    | 'server-committing'
    | 'server-committed'
    | 'local-materializing'
    | 'recovery-required'
    | 'recovered'
    | 'rolled-forward'
    | 'cancelled'
    | 'failed'
    | 'complete';

export type VaultRecoveryCheckpointDocument = Readonly<{
    schema: 'fsusblog.article-vault.recovery-journal.v1';
    schemaVersion: 1;
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    resolutionOperationIdentity: string;
    planSha256: string;
    sequence: number;
    state: VaultRecoveryCheckpointState;
    serverResult: VaultRecoveryArtifactReference | null;
    localMaterialization: VaultRecoveryArtifactReference | null;
    baseCommit: VaultRecoveryArtifactReference | null;
    contentSha256: string;
}>;

export type VaultRecoveryCheckpointDisplayScope = Readonly<{
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    resolutionOperationIdentity: string;
    /** Resolution-plan digest; never substitute the original sync-plan digest. */
    planSha256: string;
    checkpoint: VaultRecoveryArtifactReference;
}>;

const checkpointStates: readonly VaultRecoveryCheckpointState[] = [
    'prepared', 'server-committing', 'server-committed', 'local-materializing',
    'recovery-required', 'recovered', 'rolled-forward', 'cancelled', 'failed', 'complete'
];
const digestPattern = /^[a-f0-9]{64}$/u;

function hasArtifactReferenceShape(reference: VaultRecoveryArtifactReference | null): boolean
{
    return reference === null || (typeof reference?.identity === 'string'
        && reference.identity.length > 0 && digestPattern.test(reference.contentSha256));
}

/** Rejects crossed/malformed display input only; this is not machine admission. */
export function presentVaultRecoveryCheckpoint(
    journal: VaultRecoveryCheckpointDocument,
    expected: VaultRecoveryCheckpointDisplayScope
): VaultRecoveryCheckpointDocument | null
{
    if (journal.schema !== 'fsusblog.article-vault.recovery-journal.v1'
        || journal.schemaVersion !== 1
        || !Number.isSafeInteger(journal.sequence) || journal.sequence < 0
        || !checkpointStates.includes(journal.state)
        || !digestPattern.test(journal.planSha256) || !digestPattern.test(journal.contentSha256)
        || journal.siteIdentity !== expected.siteIdentity
        || journal.vaultIdentity !== expected.vaultIdentity
        || journal.deviceIdentity !== expected.deviceIdentity
        || journal.resolutionOperationIdentity !== expected.resolutionOperationIdentity
        || journal.planSha256 !== expected.planSha256
        || expected.checkpoint?.identity !== `${journal.resolutionOperationIdentity}-checkpoint-${journal.sequence}`
        || expected.checkpoint.contentSha256 !== journal.contentSha256
        || !hasArtifactReferenceShape(journal.serverResult)
        || !hasArtifactReferenceShape(journal.localMaterialization)
        || !hasArtifactReferenceShape(journal.baseCommit))
    {
        return null;
    }
    return journal;
}
