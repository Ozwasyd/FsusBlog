// Schema extraction only: no expected run, catalog or success defaults enter a
// description. Domain owners supply their own field paths and verifier below.
export function receiptField(receipt, field)
{
    return field.split('.').reduce((value, key) => value?.[key], receipt);
}

export function describeOwnerReceipt(receipt, fields)
{
    const identity = Object.fromEntries(Object.entries(fields.identity).map(([key, field]) =>
        [key, receiptField(receipt, field)]));
    if (/^[a-f0-9]{64}$/u.test(identity.worktreeFingerprint ?? ''))
    {
        identity.worktreeFingerprint = `sha256:${identity.worktreeFingerprint}`;
    }
    return {
        identity,
        testIds: receipt.testIds === undefined ? [] : receipt.testIds,
        coverageIds: receipt.coverageIds === undefined ? [] : receipt.coverageIds,
        artifactIds: receipt.artifactIds === undefined
            ? (Array.isArray(receipt.artifacts) && receipt.artifacts.every((artifact) => typeof artifact === 'object')
                ? receipt.artifacts.map((artifact) => artifact.id) : []) : receipt.artifactIds,
        status: receiptField(receipt, fields.status),
        evidenceClass: receipt.evidenceClass,
        contentDigest: receiptField(receipt, fields.contentDigest)
    };
}

export function verifiedOwnerResult(result)
{
    return { status: 'success', reasonCodes: [], verification: result };
}

export function requireOwnerChecks(errors)
{
    if (!Array.isArray(errors) || errors.length > 0)
    {
        throw new Error(`owner verifier rejected evidence: ${Array.isArray(errors) ? errors.join('; ') : 'missing structured checks'}`);
    }
}

export function describeJobEvidence(receipt)
{
    return describeOwnerReceipt(receipt, {
        identity: { namespace: 'namespace', runId: 'schedulerRunId', sourceCommit: 'commit',
            worktreeFingerprint: 'worktreeFingerprint' },
        status: 'status', contentDigest: 'contentDigest'
    });
}

