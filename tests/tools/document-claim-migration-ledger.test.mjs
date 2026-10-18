import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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
