import path from 'node:path';
import { digestValue } from '../fact-extractors/lib/canonicalize.mjs';
import { validateMinimalContractBuildReceipt } from './behavior-doc-minimal-contract-build-v3-contract.mjs';

export const behaviorDocAdmissionReceiptSchema =
    'fsusblog.behavior-doc-static-admission-receipt.v2';
export const behaviorDocClaimStagesSchema = 'fsusblog.behavior-doc-claim-stages.v1';
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
    'claimStages',
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

const claimStageKeys = Object.freeze([
    'schema', 'catalogDigest', 'parseReceiptDigest', 'migrationLedgerDigest',
    'preRuntimeClaims', 'deferredPostClaims', 'contentDigest'
]);
const claimIdentityKeys = Object.freeze([
    'claimId', 'behaviorId', 'claimType', 'documentPath', 'documentStatus',
    'factPath', 'claimDigest'
]);
const isStageDigest = (value) => typeof value === 'string'
    && value.length === 64 && digestPattern.test(value);

function claimIdentity(claim)
{
    return {
        claimId: claim.declaration?.claimId,
        behaviorId: claim.declaration?.behaviorId,
        claimType: claim.declaration?.claimType,
        documentPath: claim.location?.documentPath,
        documentStatus: claim.location?.documentStatus,
        factPath: claim.declaration?.factPath ?? null,
        claimDigest: digestValue(claim)
    };
}

function validateStageAuthority(stages, catalog, migrationLedger)
{
    if (stages.catalogDigest !== digestValue(catalog)
    || stages.migrationLedgerDigest !== digestValue(migrationLedger))
    {
        throw new Error('BehaviorDoc claim stages authority digest mismatch');
    }
    const contracts = new Map();
    if (!Array.isArray(catalog.contracts) || catalog.contracts.length === 0)
    {
        throw new Error('BehaviorDoc claim stages require a nonempty catalog');
    }
    for (const contract of catalog.contracts ?? [])
    {
        if (!isNonEmptyString(contract.id) || contracts.has(contract.id)
        || !['pre-runtime', 'post-runtime'].includes(contract.evidenceStage))
        {
            throw new Error('BehaviorDoc claim stages require a unique catalog with explicit known stages');
        }
        contracts.set(contract.id, contract);
    }
    const currentClaims = new Map();
    for (const [stage, rows] of [
        ['pre-runtime', stages.preRuntimeClaims],
        ['post-runtime', stages.deferredPostClaims]
    ])
    {
        for (const row of rows)
        {
            const contract = contracts.get(row.behaviorId);
            if (contract?.evidenceStage !== stage
            || (row.documentStatus === 'current'
                && !contract.documents?.includes(row.documentPath)))
            {
                throw new Error(`BehaviorDoc claim ${row.claimId} has an unknown or mismatched catalog stage/document`);
            }
            if (row.documentStatus === 'current')
            {
                currentClaims.set(row.claimId, row);
            }
        }
    }
    if (migrationLedger?.schema !== 'fsusblog.document-claim-migration-ledger.v1'
    || !Array.isArray(migrationLedger.scopes))
    {
        throw new Error('BehaviorDoc claim stages require the original migration ledger');
    }
    const requiredIds = [...contracts.values()]
        .filter((contract) => contract.status === 'active' && contract.documentationPolicy === 'required')
        .map((contract) => contract.id).sort();
    const ledgerIds = migrationLedger.scopes.flatMap((scope) => scope.behaviorIds ?? []).sort();
    if (JSON.stringify(requiredIds) !== JSON.stringify(ledgerIds)
    || new Set(ledgerIds).size !== ledgerIds.length)
    {
        throw new Error('BehaviorDoc claim stages ledger behavior roster mismatch');
    }
    for (const behaviorId of requiredIds)
    {
        const contract = contracts.get(behaviorId);
        if (!Array.isArray(contract.documents) || contract.documents.length === 0
        || contract.documents.some((documentPath) =>
            ![...currentClaims.values()].some((row) =>
                row.behaviorId === behaviorId && row.documentPath === documentPath)))
        {
            throw new Error('BehaviorDoc claim stages cannot pass an empty required document claim roster');
        }
    }
    const ledgerClaims = new Set();
    for (const scope of migrationLedger.scopes)
    {
        for (const entry of scope.entries ?? [])
        {
            for (const claimId of entry.claimIds ?? [])
            {
                const row = currentClaims.get(claimId);
                if (ledgerClaims.has(claimId) || !row
                || row.behaviorId !== entry.behaviorId || row.documentPath !== entry.documentPath)
                {
                    throw new Error('BehaviorDoc claim stages ledger claim roster mismatch');
                }
                ledgerClaims.add(claimId);
            }
        }
    }
    if (ledgerClaims.size !== currentClaims.size)
    {
        throw new Error('BehaviorDoc claim stages have missing or extra current claims');
    }
}

export function validateBehaviorDocClaimStages(stages, {
    catalog = null, claimReceipt = null, migrationLedger = null
} = {})
{
    if (!hasExactKeys(stages, claimStageKeys)
    || stages.schema !== behaviorDocClaimStagesSchema
    || !receiptDigestValid(stages)
    || !['catalogDigest', 'parseReceiptDigest', 'migrationLedgerDigest']
        .every((key) => isStageDigest(stages[key]))
    || !Array.isArray(stages.preRuntimeClaims) || !Array.isArray(stages.deferredPostClaims))
    {
        throw new Error('BehaviorDoc claim stages are not closed and sealed');
    }
    const ids = new Set();
    for (const rows of [stages.preRuntimeClaims, stages.deferredPostClaims])
    {
        let previous = null;
        for (const row of rows)
        {
            if (!hasExactKeys(row, claimIdentityKeys)
            || !['claimId', 'behaviorId', 'claimType', 'documentPath'].every((key) => isNonEmptyString(row[key]))
            || !['current', 'historical'].includes(row.documentStatus)
            || !(row.factPath === null || isNonEmptyString(row.factPath))
            || !isStageDigest(row.claimDigest)
            || ids.has(row.claimId)
            || (previous !== null && previous.localeCompare(row.claimId) >= 0))
            {
                throw new Error('BehaviorDoc claim stages have duplicate, unordered or malformed claims');
            }
            ids.add(row.claimId);
            previous = row.claimId;
        }
    }
    if ((catalog === null) !== (migrationLedger === null))
    {
        throw new Error('BehaviorDoc claim stages require both catalog and ledger authority');
    }
    if (catalog !== null)
    {
        validateStageAuthority(stages, catalog, migrationLedger);
    }
    if (claimReceipt !== null)
    {
        const parsed = structuredClone(claimReceipt);
        const parseDigest = parsed.contentDigest;
        delete parsed.contentDigest;
        if (claimReceipt.schema !== 'fsusblog.doc-claim-parse-receipt.v1'
        || !Array.isArray(claimReceipt.claims) || parseDigest !== digestValue(parsed)
        || stages.parseReceiptDigest !== parseDigest
        || stages.catalogDigest !== claimReceipt.behaviorCatalogDigest)
        {
            throw new Error('BehaviorDoc claim stages parse receipt mismatch');
        }
        const actual = [...stages.preRuntimeClaims, ...stages.deferredPostClaims]
            .sort((left, right) => left.claimId.localeCompare(right.claimId));
        const expected = claimReceipt.claims.map(claimIdentity)
            .sort((left, right) => left.claimId.localeCompare(right.claimId));
        if (digestValue(actual) !== digestValue(expected))
        {
            throw new Error('BehaviorDoc claim stages do not exactly cover the parse receipt');
        }
    }
    return stages;
}

export function partitionBehaviorDocClaims({ catalog, claimReceipt, migrationLedger })
{
    const contracts = new Map((catalog.contracts ?? []).map((contract) => [contract.id, contract]));
    const preRuntimeClaims = [];
    const deferredPostClaims = [];
    for (const claim of claimReceipt.claims ?? [])
    {
        const stage = contracts.get(claim.declaration?.behaviorId)?.evidenceStage;
        if (stage === 'pre-runtime')
        {
            preRuntimeClaims.push(claim);
        }
        else if (stage === 'post-runtime')
        {
            deferredPostClaims.push(claim);
        }
        else
        {
            throw new Error('BehaviorDoc claim has no explicit known catalog evidence stage');
        }
    }
    const identityRows = (claims) => claims.map(claimIdentity)
        .sort((left, right) => left.claimId.localeCompare(right.claimId));
    const stages = {
        schema: behaviorDocClaimStagesSchema,
        catalogDigest: digestValue(catalog),
        parseReceiptDigest: claimReceipt.contentDigest,
        migrationLedgerDigest: digestValue(migrationLedger),
        preRuntimeClaims: identityRows(preRuntimeClaims),
        deferredPostClaims: identityRows(deferredPostClaims),
        contentDigest: null
    };
    stages.contentDigest = digestValue(stages);
    validateBehaviorDocClaimStages(stages, { catalog, claimReceipt, migrationLedger });
    return { stages, preRuntimeClaims, deferredPostClaims };
}

export function validateBehaviorDocStaticAdmissionReceipt(receipt, options = {})
{
    return validateAdmission(receipt, options, validateMinimalContractBuildReceipt);
}

// Release/deployment post-runtime observers name the current runtime-role
// admission contract explicitly so they cannot silently fall back to an older
// minimal-contract shape.
export function validateBehaviorDocStaticAdmissionReceiptV3(receipt, options = {})
{
    return validateAdmission(receipt, options, validateMinimalContractBuildReceipt);
}

function validateAdmission(receipt, {
    expectedRunId = null,
    expectedSourceIdentity = null,
    expectedWorktree = null,
    expectedClaimStageAuthority = null,
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
    if (expectedWorktree === null)
    {
        throw new Error('BehaviorDoc claim stages require an independent expected worktree');
    }
    // This value contract checks exact materials, not their I/O provenance.
    // Real entry points must obtain them internally from the bound source.
    if (!hasExactKeys(expectedClaimStageAuthority, ['catalog', 'claimReceipt', 'migrationLedger'])
    || !Object.values(expectedClaimStageAuthority).every((value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)))
    {
        throw new Error('BehaviorDoc claim stages require closed expected source materials');
    }
    validateBehaviorDocClaimStages(receipt.claimStages, expectedClaimStageAuthority);
    if (receipt.claimStages.catalogDigest !== receipt.authorityDigests.catalog
    || receipt.claimStages.parseReceiptDigest !== receipt.authorityDigests.claim)
    {
        throw new Error('BehaviorDoc admission claim stages authority binding mismatch');
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
    if (receipt.prose.verifiedClaimCount !== receipt.claimStages.preRuntimeClaims
        .filter((claim) => claim.claimType !== 'generated-section').length)
    {
        throw new Error('BehaviorDoc admission prose count must cover pre-runtime claims only');
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
