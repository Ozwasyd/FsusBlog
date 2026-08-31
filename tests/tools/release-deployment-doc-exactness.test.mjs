import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
    buildReleaseDeploymentDocExactnessReceipt,
    loadReleaseDeploymentExactnessInputs,
    releaseDeploymentBehaviorIds,
    releaseDeploymentDomains,
    releaseDeploymentScopeId,
    root,
    runReleaseDeploymentDocMutationCases,
    scanReleaseDeploymentDocResidue,
    scanReleaseDeploymentSourceResidue,
    selectReleaseDeploymentBehaviorIds,
    validateReleaseDeploymentDocExactnessReceipt,
    verifyReleaseDeploymentGeneratedSections
} from '../../tools/docs/release-deployment-doc-exactness.mjs'
import { buildBehaviorDocExactnessReceipt } from '../../tools/docs/behavior-doc-exactness.mjs'
import { produceRuntimeRoleObservation } from '../../tools/contracts/lib/runtime-role-observation.mjs'
import { runExtractor } from '../../tools/fact-extractors/runner.mjs'
import { verifyProseClaims } from '../../tools/docs/prose-claim-verifier/verifier.mjs'

let observation

test.before(async () =>
{
    const buildIdentity = produceRuntimeRoleObservation({ repositoryRoot: root }).buildIdentity
    observation = (await runExtractor({
        extractorId: 'test-matrix-fact-extractor',
        repositoryRoot: root,
        buildIdentity,
        useCache: false
    })).receipt
})

test('release/deployment negative classes are all killed', () =>
{
    const evidence = runReleaseDeploymentDocMutationCases()
    assert.equal(evidence.total, 29)
    assert.equal(evidence.killed, evidence.total)
})

test('semantic residue scan rejects renamed, reordered and synonymous manual deployment authority', () =>
{
    const sources = [
        '## Traffic handoff\nThe controller verifies the candidate and reloads the gateway upstream.',
        '## Recovery procedure\nRestore the former serving slot.\n## Promotion steps\nPromote the standby and switch traffic.',
        '## Active slot maintenance\nThe operator must retain the serving slot until the drain finishes.',
        '## Operator sequence\nInvoke the cutover utility, promote standby, then retire the former serving slot.',
        '## Service transfer\nA standby becomes serving after the proxy is reloaded; fallback reactivates the former slot.',
        '## Deployment conclusion\nThe blue/green deployment claim is eligible and runtime-role ownership is verified.',
        '## Readiness conclusion\nThe blue-green deployment qualification is approved.',
        '## Topology conclusion\nThe runtime-role authority is established.',
        'The candidate is cleared for cutover.',
        'Traffic handoff permitted after observation.',
        '| Target | State |\n| --- | --- |\n| Candidate | Cleared for cutover |',
        '- Traffic handoff permitted.',
        'The run**time-role** owner**ship** is veri**fied**.',
        'The blue&#x2d;green deployment claim is elig&#105;ble.',
        'Cutover is not blocked.',
        'The policy does not forbid traffic handoff.',
        `<!-- fsus-doc-claim
claimId: fixture.generated
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.deployment
render: generated-section
-->
The blue-green deployment claim is eligible.`
    ]
    for (const source of sources)
    {
        assert.ok(scanReleaseDeploymentSourceResidue(source, 'fixture.md')
            .some((entry) => entry.classId === 'manual-deployment-authority'))
    }
})

test('release-domain documents still reject positive deployment qualification prose', () =>
{
    const source = '## Release conclusion\nThe blue-green deployment claim is eligible and runtime-role ownership is verified.'
    assert.ok(scanReleaseDeploymentSourceResidue(source, 'docs/testing.md', {
        semanticDeployment: false
    }).some((entry) => entry.classId === 'manual-deployment-authority'))
})

test('semantic residue scan preserves non-authoritative operational guidance', () =>
{
    const source = `# Operator guidance

Read the generated observation before an operation; this paragraph does not define slot transitions or switch traffic.

If \`claimEligible\` is false, stop and request owner evidence; do not infer an active identity from this guidance.

The validation command is diagnostic only and is not execution evidence.

The blue-green deployment claim is not approved.

No blue-green deployment claim is eligible.

No runtime-role ownership is verified.

Traffic handoff is not permitted.

## Historical behavior

Previously, the blue-green deployment claim was eligible and runtime-role ownership was verified.

## Forbidden examples

> The blue-green deployment claim is eligible.

Rejected example: traffic handoff is permitted.

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.future-eligibility
behaviorId: deployment-blue-green-runtime-role
claimType: boolean
factPath: deploymentBlueGreen.claimEligible
render: boolean-affirmed
-->

The blue/green deployment claim is eligible.

\`\`\`bash
./tools/deployment/gateway-switch.sh --check
\`\`\`

<!-- FSUSBLOG-GENERATED:BEGIN fixture.deployment -->
## Traffic handoff
The controller must promote standby and switch traffic.
<!-- FSUSBLOG-GENERATED:END fixture.deployment -->`
    assert.deepEqual(scanReleaseDeploymentSourceResidue(source, 'fixture.md'), [])
})

test('release/deployment behavior roster comes from active required catalog domains', () =>
{
    const catalog = JSON.parse(readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'))
    assert.deepEqual(selectReleaseDeploymentBehaviorIds(catalog), releaseDeploymentBehaviorIds)
    assert.deepEqual(releaseDeploymentDomains, ['release', 'deployment'])

    const changed = structuredClone(catalog)
    const addedBehaviorId = `${releaseDeploymentBehaviorIds[0]}-catalog-drift`
    changed.contracts.push({
        ...changed.contracts.find((entry) => entry.id === releaseDeploymentBehaviorIds[0]),
        id: addedBehaviorId
    })
    assert.deepEqual(
        selectReleaseDeploymentBehaviorIds(changed),
        [...releaseDeploymentBehaviorIds, addedBehaviorId].sort()
    )
})

test('current release/deployment documents contain no forbidden manual authority residue', () =>
{
    const catalog = JSON.parse(readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'))
    const contracts = catalog.contracts
        .filter((entry) => releaseDeploymentBehaviorIds.includes(entry.id))
    const documents = contracts.flatMap((entry) => entry.documents)
    const deploymentDocuments = contracts
        .filter((entry) => entry.domain === 'deployment')
        .flatMap((entry) => entry.documents)
    assert.deepEqual(scanReleaseDeploymentDocResidue(root, documents, deploymentDocuments), [])
})

test('current release/deployment claims and sections are bidirectionally exact', () =>
{
    const receipt = buildReleaseDeploymentDocExactnessReceipt({
        repositoryRoot: root,
        observationReceipt: observation,
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint
    })
    validateReleaseDeploymentDocExactnessReceipt(receipt)
    assert.equal(receipt.scopeId, releaseDeploymentScopeId)
    assert.equal(receipt.counts.required, 2)
    assert.equal(receipt.counts.generated, 4)
    assert.equal(receipt.counts.prose, 3)
    assert.equal(receipt.counts.proseVerified, 3)
    assert.equal(receipt.counts.mutationKilled, 37)
    assert.equal(receipt.counts.mutationTotal, 37)
})

test('missing ledger entry, orphan section and typed fact drift fail closed', () =>
{
    const input = loadReleaseDeploymentExactnessInputs(root, observation)
    const base = {
        repositoryRoot: root,
        catalog: input.catalog,
        lifecycle: input.lifecycle,
        migrationLedger: input.migrationLedger,
        claimReceipt: input.claimReceipt,
        sectionCatalog: input.sectionCatalog,
        observationReceipts: [input.receiptRaw],
        domains: [...releaseDeploymentDomains],
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint,
        scopeId: releaseDeploymentScopeId
    }

    const missing = structuredClone(input.migrationLedger)
    missing.scopes.find((entry) => entry.scopeId === releaseDeploymentScopeId).entries.pop()
    assert.equal(buildBehaviorDocExactnessReceipt({ ...base, migrationLedger: missing }).status, 'failed')

    const orphan = structuredClone(input.sectionCatalog)
    orphan.sections.find((entry) => entry.sectionId === 'release.aggregate-contract').factPath = 'release-final.missing'
    assert.equal(buildBehaviorDocExactnessReceipt({ ...base, sectionCatalog: orphan }).status, 'failed')

    const drift = structuredClone(input.receipt)
    drift.observations.facts['deployment.blue-green-contract'].switchState = 'rolled-back'
    assert.match(
        verifyReleaseDeploymentGeneratedSections(root, input.sectionCatalog, drift).join('\n'),
        /deployment\.blue-green-contract generated section drift/u
    )

    const reversed = structuredClone(input.claimReceipt.claims)
    reversed.find((entry) => entry.declaration.claimId === 'release-final-aggregate-contract.aggregate-only')
        .location.bodyText = 'Release closeout re-runs every producer and the aggregate is true.'
    assert.equal(verifyProseClaims({ claims: reversed, receipts: [input.receiptRaw] }).ok, false)
})
