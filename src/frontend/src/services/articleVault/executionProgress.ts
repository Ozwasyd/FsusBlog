/**
 * Display subset of ArticleVaultExecutionContracts.cs, not a receipt verifier.
 * Server completion has no authority over local materialization/base or other devices.
 */
export type VaultServerExecutionDocument = Readonly<{
    resultReference: string;
    siteIdentity: string;
    vaultIdentity: string;
    planReference: string;
    planSha256: string;
    outcome: 'completed' | 'no-op' | 'failed' | 'cancelled';
    reasonCode: string | null;
    completedAtUnixMs: number;
    contentSha256: string;
    groups: readonly Readonly<{
        groupIdentity: string;
        committed: boolean;
        reasonCode: string | null;
        operations: readonly Readonly<{
            operationIdentity: string;
            portableArticleIdentity: string;
            outcome: 'executed' | 'no-op' | 'failed';
            beforeRevision: number | null;
            afterRevision: number | null;
            reasonCode: string | null;
            contentSha256: string;
        }>[];
    }>[];
}>;

/** Identity comparison only rejects crossed display scope; it never admits execution. */
export function presentVaultServerExecution(
    result: VaultServerExecutionDocument,
    expected: Readonly<{ siteIdentity: string; vaultIdentity: string; planReference: string; planSha256: string; }>
)
{
    if (result.siteIdentity !== expected.siteIdentity
        || result.vaultIdentity !== expected.vaultIdentity
        || result.planReference !== expected.planReference
        || result.planSha256 !== expected.planSha256)
    {
        return null;
    }
    return {
        operationCount: result.groups.reduce((count, group) => count + group.operations.length, 0),
        committedGroupCount: result.groups.filter((group) => group.committed).length,
        failedOperationCount: result.groups.reduce((count, group) => count
            + group.operations.filter((operation) => operation.outcome === 'failed').length, 0)
    };
}
