import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    produceOpenApiObservation,
    runOpenApiFactExtractor
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/contracts/lib/openapi-observation.mjs';
import {
    apiProtocolScopeId,
    buildApiProtocolDocExactnessReceipt,
    loadApiProtocolExactnessInputs,
    root,
    runApiProtocolDocMutationCases,
    scanApiProtocolDocResidue,
    validateApiProtocolDocExactnessReceipt,
    verifyApiProtocolGeneratedSections
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/docs/api-protocol-doc-exactness.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { buildBehaviorDocExactnessReceipt } from '../../tools/docs/behavior-doc-exactness.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { verifyProseClaims } from '../../tools/docs/prose-claim-verifier/verifier.mjs';

let observation;

test.before(async () =>
{
    const produced = produceOpenApiObservation({ repositoryRoot: root });
    observation = (await runOpenApiFactExtractor({
        repositoryRoot: root,
        buildIdentity: produced.buildIdentity,
        useCache: false
    })).receipt;
});

test('API/protocol negative classes are all killed', () =>
{
    const evidence = runApiProtocolDocMutationCases();
    assert.equal(evidence.total, 13);
    assert.equal(evidence.killed, evidence.total);
});

test('current API/protocol documents contain no forbidden manual authority residue', () =>
{
    const catalog = JSON.parse(readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'));
    const documents = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract').documents;
    assert.deepEqual(scanApiProtocolDocResidue(root, documents), []);
});

test('current API/protocol claims and sections are bidirectionally exact', () =>
{
    const receipt = buildApiProtocolDocExactnessReceipt({
        repositoryRoot: root,
        observationReceipt: observation,
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint
    });
    validateApiProtocolDocExactnessReceipt(receipt);
    assert.equal(receipt.scopeId, apiProtocolScopeId);
    assert.equal(receipt.counts.required, 1);
    assert.equal(receipt.counts.generated, 8);
    assert.equal(receipt.counts.prose, 10);
    assert.equal(receipt.counts.proseVerified, 10);
});

test('missing ledger entry, orphan section and typed fact drift fail closed', () =>
{
    const input = loadApiProtocolExactnessInputs(root, observation);
    const base = {
        repositoryRoot: root,
        catalog: input.catalog,
        lifecycle: input.lifecycle,
        migrationLedger: input.migrationLedger,
        claimReceipt: input.claimReceipt,
        sectionCatalog: input.sectionCatalog,
        observationReceipts: [input.receiptRaw],
        domains: ['protocol'],
        selectedBehaviorIds: ['binary-api-aeds-contract'],
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint,
        scopeId: apiProtocolScopeId
    };

    const missing = structuredClone(input.migrationLedger);
    missing.scopes.find((entry) => entry.scopeId === apiProtocolScopeId).entries.pop();
    assert.equal(buildBehaviorDocExactnessReceipt({ ...base, migrationLedger: missing }).status, 'failed');

    const orphan = structuredClone(input.sectionCatalog);
    orphan.sections.find((entry) => entry.sectionId === 'api.operations').factPath = 'operations.missing';
    assert.equal(buildBehaviorDocExactnessReceipt({ ...base, sectionCatalog: orphan }).status, 'failed');

    const drift = structuredClone(input.receipt);
    drift.observations.operations[Object.keys(drift.observations.operations)[0]].resultPlacement = 'json.body';
    assert.match(
        verifyApiProtocolGeneratedSections(root, input.sectionCatalog, drift).join('\n'),
        /api\.operations generated section drift/u
    );

    const reversed = structuredClone(input.claimReceipt.claims);
    reversed.find((entry) => entry.declaration.claimId === 'binary-api-aeds-contract.request-source')
        .location.bodyText = 'The response supplies the request through a JSON body.';
    assert.equal(verifyProseClaims({ claims: reversed, receipts: [input.receiptRaw] }).ok, false);
});
