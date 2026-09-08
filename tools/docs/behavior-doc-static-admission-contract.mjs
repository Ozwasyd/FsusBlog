import path from 'node:path';
import { digestValue } from '../fact-extractors/lib/canonicalize.mjs';
import { validateMinimalContractBuildReceipt } from './behavior-doc-minimal-contract-build-contract.mjs';
import { validateMinimalContractBuildReceipt as validateMinimalContractBuildReceiptV3 } from './behavior-doc-minimal-contract-build-v3-contract.mjs';

export const behaviorDocAdmissionReceiptSchema =
    'fsusblog.behavior-doc-static-admission-receipt.v1';
export const defaultBehaviorDocAdmissionReceipt =
    '.tmp/behavior-doc-static-admission/receipt.json';
export const defaultBehaviorDocAdmissionComponentsDirectory =
    '.tmp/behavior-doc-static-admission/components';
export const behaviorDocGlobalClaimExactnessComponent = 'global-claim-exactness.json';

const authorityDigestKeys = Object.freeze([
    'catalog',
    'claim',
    'extractorRegistry',
    'generatedSectionCatalog',
    'generatedRenderer',
    'proseRenderer',
    'mutationCatalog'
]);
const digestPattern = /^[a-f0-9]{64}$/u;
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const receiptKeys = Object.freeze([
    'schema',
    'run',
    'source',
    'worktree',
    'toolchain',
    'authorityDigests',
    'implementationOwner',
    'factObservations',
    'minimalContractBuild',
    'generated',
    'prose',
    'mutationFixtures',
    'candidateSpawnCountBeforeReceipt',
    'status',
    'failureReasons',
    'durationMs',
    'contentDigest'
]);

function hasExactKeys(value, keys)
{
    return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function receiptDigestValid(receipt)
{
    const copy = structuredClone(receipt);
    const digest = copy?.contentDigest;
    copy.contentDigest = null;
    return typeof digest === 'string' && digest === digestValue(copy);
}

export function validateBehaviorDocStaticAdmissionReceipt(receipt, options = {})
{
    return validateAdmission(receipt, options, validateMinimalContractBuildReceipt);
}

export function validateBehaviorDocStaticAdmissionReceiptV3(receipt, options = {})
{
    return validateAdmission(receipt, options, validateMinimalContractBuildReceiptV3);
}

function validateAdmission(receipt, {
    expectedRunId = null,
    expectedSourceIdentity = null,
    expectedWorktree = null,
    artifactRepositoryRoot = null,
    expectedExtractorIds = null,
    readArtifactDigest = null
} = {}, validateMinimalReceipt)
{
    if (receipt?.schema !== behaviorDocAdmissionReceiptSchema)
    {
        throw new Error(`BehaviorDoc admission schema must be ${behaviorDocAdmissionReceiptSchema}`);
    }
    if (!hasExactKeys(receipt, receiptKeys))
    {
        throw new Error('BehaviorDoc admission receipt fields are not sealed');
    }
    if (!receiptDigestValid(receipt))
    {
        throw new Error('BehaviorDoc admission content digest mismatch');
    }
    if (receipt.status !== 'ok' || !Array.isArray(receipt.failureReasons)
    || receipt.failureReasons.length !== 0)
    {
        throw new Error(
            `BehaviorDoc admission is not successful: ${(receipt.failureReasons ?? []).join('; ')}`
        );
    }
    if (receipt.candidateSpawnCountBeforeReceipt !== 0)
    {
        throw new Error('BehaviorDoc admission requires zero candidate spawns before receipt');
    }
    if (expectedRunId !== null && receipt.run.id !== expectedRunId)
    {
        throw new Error('BehaviorDoc admission run identity mismatch');
    }
    if (expectedSourceIdentity
    && (receipt.source.commit !== expectedSourceIdentity.sourceCommit
      || receipt.source.worktreeFingerprint !== expectedSourceIdentity.worktreeFingerprint))
    {
        throw new Error('BehaviorDoc admission source/worktree identity mismatch');
    }
    if (expectedWorktree !== null && receipt.worktree.root !== path.resolve(expectedWorktree))
    {
        throw new Error('BehaviorDoc admission worktree root mismatch');
    }
    if (!hasExactKeys(receipt.run, ['id'])
    || !hasExactKeys(receipt.source, ['commit', 'worktreeFingerprint'])
    || !hasExactKeys(receipt.worktree, ['root'])
    || !hasExactKeys(receipt.toolchain, [
        'node',
        'dotnet',
        'platform',
        'architecture',
        'directoryBuildPropsDigest'
    ])
    || !isNonEmptyString(receipt.run.id)
    || !/^[a-f0-9]{40}$/u.test(receipt.source.commit ?? '')
    || !digestPattern.test(receipt.source.worktreeFingerprint ?? '')
    || !isNonEmptyString(receipt.worktree.root)
    || !isNonEmptyString(receipt.toolchain.node)
    || !isNonEmptyString(receipt.toolchain.dotnet)
    || !isNonEmptyString(receipt.toolchain.platform)
    || !isNonEmptyString(receipt.toolchain.architecture)
    || !digestPattern.test(receipt.toolchain.directoryBuildPropsDigest ?? ''))
    {
        throw new Error('BehaviorDoc admission run/source/toolchain identity is incomplete');
    }
    if (receipt.implementationOwner.status !== 'ok')
    {
        throw new Error('BehaviorDoc admission implementation owner scan failed');
    }
    if (!hasExactKeys(receipt.implementationOwner, ['status', 'bindingCount', 'contentDigest'])
    || !Number.isInteger(receipt.implementationOwner.bindingCount)
    || receipt.implementationOwner.bindingCount < 1
    || !digestPattern.test(receipt.implementationOwner.contentDigest ?? ''))
    {
        throw new Error('BehaviorDoc admission implementation owner receipt is incomplete');
    }
    if (authorityDigestKeys.some((key) =>
        !digestPattern.test(receipt.authorityDigests?.[key] ?? ''))
    || Object.keys(receipt.authorityDigests ?? {}).sort().join('\0')
      !== [...authorityDigestKeys].sort().join('\0'))
    {
        throw new Error('BehaviorDoc admission authority digest roster is incomplete');
    }
    if (!hasExactKeys(receipt.generated, ['status', 'documentCount', 'contentDigest'])
    || !hasExactKeys(receipt.prose, ['status', 'verifiedClaimCount', 'contentDigest'])
    || !hasExactKeys(receipt.mutationFixtures, ['status', 'caseCount', 'contentDigest'])
    || receipt.generated.status !== 'ok' || receipt.prose.status !== 'ok'
    || receipt.mutationFixtures.status !== 'ok')
    {
        throw new Error('BehaviorDoc admission verification component is not successful');
    }
    if (!digestPattern.test(receipt.generated.contentDigest ?? '')
    || !digestPattern.test(receipt.prose.contentDigest ?? '')
    || !digestPattern.test(receipt.mutationFixtures.contentDigest ?? '')
    || !isNonNegativeInteger(receipt.generated.documentCount)
    || !isNonNegativeInteger(receipt.prose.verifiedClaimCount)
    || !Number.isInteger(receipt.mutationFixtures.caseCount)
    || receipt.mutationFixtures.caseCount < 1)
    {
        throw new Error('BehaviorDoc admission verification component receipt is incomplete');
    }
    if (!receipt.factObservations
    || Object.keys(receipt.factObservations).length === 0
    || Object.values(receipt.factObservations).some((entry) =>
        !hasExactKeys(entry, [
            'status',
            'extractorDigest',
            'semanticDigest',
            'contentDigest'
        ])
      || entry.status !== 'ok'
      || !digestPattern.test(entry.extractorDigest ?? '')
      || !digestPattern.test(entry.semanticDigest ?? '')
      || !digestPattern.test(entry.contentDigest ?? '')))
    {
        throw new Error('BehaviorDoc admission fact observations are incomplete');
    }
    if (!Number.isInteger(receipt.candidateSpawnCountBeforeReceipt)
        || !isNonNegativeInteger(receipt.durationMs))
    {
        throw new Error('BehaviorDoc admission counters are invalid');
    }
    if (expectedWorktree !== null)
    {
        if (!Array.isArray(expectedExtractorIds) || expectedExtractorIds.length === 0)
        {
            throw new Error('BehaviorDoc admission requires the independent extractor roster');
        }
        const actualExtractorIds = Object.keys(receipt.factObservations).sort();
        if (JSON.stringify(actualExtractorIds) !== JSON.stringify(expectedExtractorIds))
        {
            throw new Error('BehaviorDoc admission fact observation roster drifted');
        }
    }
    validateMinimalReceipt(receipt.minimalContractBuild, {
        repositoryRoot: artifactRepositoryRoot,
        readArtifactDigest,
        expectedRunId: receipt.run.id,
        expectedSourceIdentity: {
            sourceCommit: receipt.source.commit,
            worktreeFingerprint: receipt.source.worktreeFingerprint
        }
    });
    return receipt;
}
