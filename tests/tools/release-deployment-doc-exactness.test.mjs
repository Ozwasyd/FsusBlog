import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { produceRuntimeRoleObservation } from '../../tools/contracts/lib/runtime-role-observation.mjs';
import { buildBehaviorDocExactnessReceipt } from '../../tools/docs/behavior-doc-exactness.mjs';
import { verifyProseClaims } from '../../tools/docs/prose-claim-verifier/verifier.mjs';
import {
    buildReleaseDeploymentDocExactnessReceipt,
    loadReleaseDeploymentExactnessInputs,
    releaseDeploymentBehaviorIds,
    releaseDeploymentScopeId,
    root,
    runReleaseDeploymentDocMutationCases,
    scanReleaseDeploymentDocResidue,
    validateReleaseDeploymentDocExactnessReceipt,
    verifyReleaseDeploymentGeneratedSections
} from '../../tools/docs/release-deployment-doc-exactness.mjs';
import { runExtractor } from '../../tools/fact-extractors/runner.mjs';

let observation;

test.before(async () =>
{
    const buildIdentity = produceRuntimeRoleObservation({ repositoryRoot: root }).buildIdentity;
    observation = (await runExtractor({
        extractorId: 'test-matrix-fact-extractor',
        repositoryRoot: root,
        buildIdentity,
        useCache: false
    })).receipt;
});

test('release/deployment negative classes are all killed', () =>
{
    const evidence = runReleaseDeploymentDocMutationCases();
    assert.equal(evidence.total, 12);
    assert.equal(evidence.killed, evidence.total);
});

test('current release/deployment documents contain no forbidden manual authority residue', () =>
{
    const catalog = JSON.parse(readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'));
    const documents = catalog.contracts
        .filter((entry) => releaseDeploymentBehaviorIds.includes(entry.id))
        .flatMap((entry) => entry.documents);
    assert.deepEqual(scanReleaseDeploymentDocResidue(root, documents), []);
});

test('current release/deployment claims and sections are bidirectionally exact', () =>
{
    const receipt = buildReleaseDeploymentDocExactnessReceipt({
        repositoryRoot: root,
        observationReceipt: observation,
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint
    });
    validateReleaseDeploymentDocExactnessReceipt(receipt);
    assert.equal(receipt.scopeId, releaseDeploymentScopeId);
    assert.equal(receipt.counts.required, 2);
    assert.equal(receipt.counts.generated, 4);
    assert.equal(receipt.counts.prose, 3);
    assert.equal(receipt.counts.proseVerified, 3);
});

test('missing ledger entry, orphan section and typed fact drift fail closed', () =>
{
    const input = loadReleaseDeploymentExactnessInputs(root, observation);
    const base = {
        repositoryRoot: root,
        catalog: input.catalog,
        lifecycle: input.lifecycle,
        migrationLedger: input.migrationLedger,
        claimReceipt: input.claimReceipt,
        sectionCatalog: input.sectionCatalog,
        observationReceipts: [input.receiptRaw],
        domains: ['release', 'deployment'],
        selectedBehaviorIds: [...releaseDeploymentBehaviorIds],
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint,
        scopeId: releaseDeploymentScopeId
    };

    const missing = structuredClone(input.migrationLedger);
    missing.scopes.find((entry) => entry.scopeId === releaseDeploymentScopeId).entries.pop();
    assert.equal(buildBehaviorDocExactnessReceipt({ ...base, migrationLedger: missing }).status, 'failed');

    const orphan = structuredClone(input.sectionCatalog);
    orphan.sections.find((entry) => entry.sectionId === 'release.aggregate-contract').factPath = 'release-final.missing';
    assert.equal(buildBehaviorDocExactnessReceipt({ ...base, sectionCatalog: orphan }).status, 'failed');

    const drift = structuredClone(input.receipt);
    drift.observations.facts['deployment.blue-green-contract'].switchState = 'rolled-back';
    assert.match(
        verifyReleaseDeploymentGeneratedSections(root, input.sectionCatalog, drift).join('\n'),
        /deployment\.blue-green-contract generated section drift/u
    );

    const reversed = structuredClone(input.claimReceipt.claims);
    reversed.find((entry) => entry.declaration.claimId === 'release-final-aggregate-contract.aggregate-only')
        .location.bodyText = 'Release closeout re-runs every producer and the aggregate is true.';
    assert.equal(verifyProseClaims({ claims: reversed, receipts: [input.receiptRaw] }).ok, false);
});
