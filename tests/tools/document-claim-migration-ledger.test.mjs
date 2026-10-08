import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { digestValue } from '../../tools/fact-extractors/identity.mjs';
import {
    globalExactnessSchema,
    globalExactnessScopeId,
    loadGlobalDocumentAuthority,
    validateGlobalClaimExactnessReceipt
} from '../../tools/docs/global-claim-exactness-final.mjs';

const { parseRepositoryClaims } = await import(new URL('../../tools/docs/doc-claim.mjs', import.meta.url));
const { root, validateMigrationLedgerData, validateRepositoryMigrationLedger } = await import(new URL('../../tools/docs/check-document-claim-migration-ledger.mjs', import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));

test('repository migration ledger exactly covers catalog current documents', () =>
{
    assert.deepEqual(validateRepositoryMigrationLedger(), {
        scopeCount: 6,
        entryCount: 43,
        requiredBehaviorCount: 9,
        generatedClaimCount: 84,
        proseClaimCount: 37
    });
});

const authorityInput = () => ({
    ledger: readJson('config/contracts/document-claim-migration-ledger.json'),
    catalog: readJson('config/contracts/behavior-contracts.json'),
    lifecycle: readJson('config/development/document-lifecycle.json'),
    claims: parseRepositoryClaims(root).claims,
    sectionCatalog: readJson('config/contracts/generated-fact-sections.json')
});

test('canonical release and deployment claim identities include committed rationale additions', () =>
{
    const input = authorityInput();
    const contract = input.catalog.contracts.find((entry) => entry.id === 'deployment-blue-green-runtime-role');
    assert.deepEqual(contract.documentAuthorities.find((entry) => entry.path === 'docs/architecture/monolithic-distributed-boundary.md').claimIds, [
        'deployment-blue-green-runtime-role.distributed-issue-rationale',
        'deployment-blue-green-runtime-role.monolithic-distributed-rationale',
        'deployment-blue-green-runtime-role.runtime-roles'
    ]);
    assert.deepEqual(input.catalog.contracts.find((entry) => entry.id === 'release-final-aggregate-contract')
        .documentAuthorities.find((entry) => entry.path === 'docs/releases/release-identity.md').claimIds, [
            'release-final-aggregate-contract.aggregate-only',
            'release-final-aggregate-contract.aggregate-artifact-only',
            'release-final-aggregate-contract.aggregate-contract'
        ]);
    validateMigrationLedgerData(input);
});

for (const field of ['claimIds', 'sectionIds'])
{
    for (const mutation of ['missing', 'extra', 'stale', 'duplicate'])
    {
        test(`catalog-only ${field} ${mutation} fails closed`, () =>
        {
            const input = authorityInput();
            const ids = input.catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
                .documentAuthorities[0][field];
            if (mutation === 'missing') ids.pop();
            if (mutation === 'extra') ids.push('opaque.extra-id');
            if (mutation === 'stale') ids[0] = 'legacy.compat-id';
            if (mutation === 'duplicate') ids.push(ids[0]);
            assert.throws(() => validateMigrationLedgerData(input), /catalog.*IDs.*not exact/u);
        });
    }
}

for (const layer of ['ledger-claim', 'ledger-section', 'parsed-claim', 'generated-section'])
{
    test(`${layer}-only mutation cannot replace catalog document authority`, () =>
    {
        const input = authorityInput();
        const entry = input.ledger.scopes.flatMap((scope) => scope.entries)
            .find((candidate) => candidate.behaviorId === 'binary-api-aeds-contract');
        if (layer === 'ledger-claim') entry.claimIds.push('binary-api-aeds-contract.reverse-orphan');
        if (layer === 'ledger-section') entry.generatedSectionIds.push('api.reverse-orphan');
        if (layer === 'parsed-claim') input.claims.find((claim) => claim.declaration.claimId === entry.claimIds[0]).declaration.claimId += '.stale';
        if (layer === 'generated-section') input.sectionCatalog.sections.find((section) => section.sectionId === entry.generatedSectionIds[0]).sectionId += '.stale';
        assert.throws(() => validateMigrationLedgerData(input), /not exactly match|not bidirectionally exact/u);
    });
}

for (const mutation of ['cross-path-claim', 'cross-path-section', 'cross-behavior-claim', 'cross-behavior-section', 'duplicate-path', 'missing-authorities', 'archived', 'wrong-owner', 'unknown-field'])
{
    test(`document authority ${mutation} fails closed`, () =>
    {
        const input = authorityInput();
        const contract = input.catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract');
        const authority = contract.documentAuthorities[0];
        if (mutation === 'cross-path-claim') authority.claimIds[0] = contract.documentAuthorities[1].claimIds[0];
        if (mutation === 'cross-path-section') authority.sectionIds[0] = contract.documentAuthorities[1].sectionIds[0];
        const other = input.catalog.contracts.find((entry) => entry.id === 'release-final-aggregate-contract').documentAuthorities[0];
        if (mutation === 'cross-behavior-claim') authority.claimIds[0] = other.claimIds[0];
        if (mutation === 'cross-behavior-section') authority.sectionIds[0] = other.sectionIds[0];
        if (mutation === 'duplicate-path') contract.documentAuthorities.push(structuredClone(authority));
        if (mutation === 'missing-authorities') delete contract.documentAuthorities;
        if (mutation === 'archived') input.lifecycle.documents.find((document) => document.path === authority.path).status = 'historical';
        if (mutation === 'wrong-owner') authority.owner = 'release';
        if (mutation === 'unknown-field') authority.compatAlias = authority.claimIds[0];
        assert.throws(() => validateMigrationLedgerData(input), /not exact|invalid|not current|conflicts|unsupported/u);
    });
}

test('coordinated ledger and parsed claim orphan still cannot bypass the catalog authority', () =>
{
    const input = authorityInput();
    const entry = input.ledger.scopes.flatMap((scope) => scope.entries)
        .find((candidate) => candidate.behaviorId === 'binary-api-aeds-contract');
    const claim = structuredClone(input.claims.find((candidate) => candidate.declaration.claimId === entry.claimIds[0]));
    claim.declaration.claimId += '.reverse-orphan';
    entry.claimIds.push(claim.declaration.claimId);
    input.claims.push(claim);
    assert.throws(() => validateMigrationLedgerData(input), /catalog.*IDs.*not exact/u);
});

test('active required behaviors and actual claims are bidirectionally exact', () =>
{
    const input = {
        ledger: readJson('config/contracts/document-claim-migration-ledger.json'),
        catalog: readJson('config/contracts/behavior-contracts.json'),
        lifecycle: readJson('config/development/document-lifecycle.json'),
        claims: parseRepositoryClaims(root).claims,
        sectionCatalog: readJson('config/contracts/generated-fact-sections.json')
    };

    const addedBehavior = structuredClone(input);
    addedBehavior.catalog.contracts.push({
        ...structuredClone(addedBehavior.catalog.contracts.find((entry) => entry.id === 'article-comment-lifecycle-outbox')),
        id: 'new-required-content-behavior',
        documents: ['docs/api/article-publication-revisions.md']
    });
    assert.throws(
        () => validateMigrationLedgerData(addedBehavior),
        /behavior roster does not exactly match/u
    );

    const orphanClaim = structuredClone(input);
    orphanClaim.claims.push({
        ...structuredClone(orphanClaim.claims.find((claim) => claim.declaration.claimId === 'article-comment-lifecycle-outbox.rollback-causal')),
        declaration: {
            ...structuredClone(orphanClaim.claims.find((claim) => claim.declaration.claimId === 'article-comment-lifecycle-outbox.rollback-causal').declaration),
            claimId: 'article-comment-lifecycle-outbox.orphan-prose'
        }
    });
    assert.throws(
        () => validateMigrationLedgerData(orphanClaim),
        /claims do not exactly match ledger/u
    );

    const noContentProse = structuredClone(input);
    noContentProse.claims = noContentProse.claims.filter((claim) =>
        claim.declaration.behaviorId !== 'article-comment-lifecycle-outbox'
        || claim.declaration.claimType === 'generated-section');
    assert.throws(
        () => validateMigrationLedgerData(noContentProse),
        /claims do not exactly match ledger/u
    );

    const stale = structuredClone(input);
    stale.claims.find((claim) => claim.declaration.claimId === 'article-comment-lifecycle-outbox.rollback-causal')
        .location.documentStatus = 'historical';
    assert.throws(
        () => validateMigrationLedgerData(stale),
        /claims do not exactly match ledger|stale lifecycle authority/u
    );
});

test('missing document entry and orphan section fail closed', () =>
{
    const input = {
        ledger: readJson('config/contracts/document-claim-migration-ledger.json'),
        catalog: readJson('config/contracts/behavior-contracts.json'),
        lifecycle: readJson('config/development/document-lifecycle.json'),
        claims: parseRepositoryClaims(root).claims,
        sectionCatalog: readJson('config/contracts/generated-fact-sections.json')
    };
    const missing = structuredClone(input);
    missing.ledger.scopes[0].entries.pop();
    assert.throws(() => validateMigrationLedgerData(missing), /does not exactly match/u);
    const orphan = structuredClone(input);
    orphan.ledger.scopes[0].entries[0].generatedSectionIds = ['missing.section'];
    assert.throws(() => validateMigrationLedgerData(orphan), /generated sections do not exactly match/u);
});

const seal = (receipt) => ({ ...receipt, contentDigest: digestValue({ ...receipt, contentDigest: null }) });

// Synthetic terminal envelopes exercise only the independent document mapping
// replay. They do not stand in for compiled observations or terminal acceptance.
function mappingReplayFixture()
{
    const authority = loadGlobalDocumentAuthority();
    const summary = authority.ledgerSummary;
    return seal({
        schema: globalExactnessSchema,
        scopeId: globalExactnessScopeId,
        runId: 'document-authority-replay-test',
        source: {
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: 'b'.repeat(64),
            ...authority.documentAuthorityDigests,
            observationDigests: {}
        },
        authorityDigests: [],
        claimAcceptance: authority.claimAcceptance,
        counts: {
            requiredBehaviors: summary.requiredBehaviorCount,
            scopes: summary.scopeCount,
            ledgerEntries: summary.entryCount,
            generatedClaimCount: summary.generatedClaimCount,
            proseClaimCount: summary.proseClaimCount,
            proseTotal: summary.proseClaimCount,
            proseVerified: summary.proseClaimCount,
            generatedSectionsVerified: summary.generatedClaimCount,
            generatedSectionDrifts: 0,
            missing: 0,
            extra: 0,
            residue: 0,
            mutationKilled: 1,
            mutationTotal: 1,
            warnings: 0
        },
        mutationAggregate: { killed: 1, total: 1 },
        residue: [],
        proseVerification: { diagnostics: [] },
        status: 'ok',
        failureReasons: []
    });
}

test('current catalog, ledger, parsed claims and sections replay independently', () =>
{
    const receipt = mappingReplayFixture();
    validateGlobalClaimExactnessReceipt(receipt, { expectedRunId: receipt.runId });
});

for (const digest of ['catalogDigest', 'documentOwnershipDigest', 'migrationLedgerDigest', 'claimsDigest', 'sectionCatalogDigest'])
{
    test(`re-sealed ${digest} forgery fails current authority replay`, () =>
    {
        const receipt = mappingReplayFixture();
        receipt.source[digest] = 'f'.repeat(64);
        assert.throws(() => validateGlobalClaimExactnessReceipt(seal(receipt)), /current document authority mismatch/u);
    });
}

for (const mutation of ['path', 'behavior', 'claim-digest', 'opaque-id', 'section', 'counts', 'unknown-source-field', 'unknown-count-field', 'wrong-scope'])
{
    test(`re-sealed terminal ${mutation} forgery fails current authority replay`, () =>
    {
        const receipt = mappingReplayFixture();
        const claim = receipt.claimAcceptance.find((entry) => entry.generatedSectionId !== null);
        if (mutation === 'path') claim.documentPath = 'docs/testing.md';
        if (mutation === 'behavior') claim.behaviorId = 'release-final-aggregate-contract';
        if (mutation === 'claim-digest') claim.claimDigest = `sha256:${'f'.repeat(64)}`;
        if (mutation === 'opaque-id') claim.claimId = 'legacy.compat-id';
        if (mutation === 'section') claim.generatedSectionId = 'release.aggregate-contract';
        if (mutation === 'counts') receipt.counts.requiredBehaviors += 1;
        if (mutation === 'unknown-source-field') receipt.source.compatAlias = receipt.source.claimsDigest;
        if (mutation === 'unknown-count-field') receipt.counts.compatAlias = 0;
        if (mutation === 'wrong-scope') receipt.scopeId = 'unowned-document-authority';
        assert.throws(() => validateGlobalClaimExactnessReceipt(seal(receipt)), /current claim acceptance mismatch|current coverage mismatch|source identity fields are not sealed|coverage fields are not sealed|unexpected global exactness schema/u);
    });
}

test('coordinated mapping, digest and count re-seal cannot replace current documents', () =>
{
    const receipt = mappingReplayFixture();
    receipt.claimAcceptance.pop();
    receipt.counts.generatedClaimCount = receipt.claimAcceptance.filter((claim) => claim.generatedSectionId !== null).length;
    receipt.counts.proseClaimCount = receipt.claimAcceptance.length - receipt.counts.generatedClaimCount;
    receipt.source.claimsDigest = digestValue(receipt.claimAcceptance);
    assert.throws(() => validateGlobalClaimExactnessReceipt(seal(receipt)), /current document authority mismatch/u);
});
