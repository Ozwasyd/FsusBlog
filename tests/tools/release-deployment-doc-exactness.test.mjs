import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    buildReleaseDeploymentProseClassificationIndex,
    buildReleaseDeploymentDocExactnessReceipt,
    classifyReleaseDeploymentSource,
    extractReleaseDeploymentProseNodes,
    loadReleaseDeploymentExactnessInputs,
    readCanonicalReleaseDeploymentDocument,
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
    assert.equal(evidence.total, 56)
    assert.equal(evidence.killed, evidence.total)
})

test('closed ownership rejects renamed, reordered and synonymous manual deployment authority', () =>
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
        `<!-- fsus-doc-claim
claimId: fixture.generated
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.deployment
render: generated-section
-->
The blue-green deployment claim is eligible.`,
        '[deployment](https://example.test/a.b) claim is eligible.',
        '[runtime](https://example.test/runtime)-[role](https://example.test/role) ownership is settled.',
        'deploy<!-- split -->ment claim is valid.',
        'deploy​ment claim passed.',
        'blue&shy;-green deployment claim valid.',
        '> [!IMPORTANT]\n> Standby may take traffic.',
        'Without receipts, the deployment claim is valid.',
        'No evidence required, the deployment claim passed.',
        'The deployment claim is not only eligible.',
        'The deployment claim is not merely valid.',
        'Standby may take traffic.',
        'The gateway points at standby.',
        'Runtime-role ownership is settled.',
        'The deployment claim passed.',
        'The deployment claim is valid.',
        '> > [!IMPORTANT]\n> > The deployment claim is valid.',
        '[deployment claim](https://example.test/a.b\n/c.d) is valid.',
        'https://example.test/deployment-claim-eligible',
        'Except after drain, the deployment claim is valid.',
        'The observer failed to deny that the deployment claim is valid.',
        'The deployment claim failed to remain blocked.',
        'The old claim was invalid, but the current deployment claim is valid.',
        '```text\nignored\n```\nThe deployment claim is valid.',
        '~~~text\nignored\n~~~\nThe deployment claim is valid.',
        '```text\none\n```\n~~~text\ntwo\n~~~\nThe deployment claim is valid.',
        `<!-- fsus-doc-claim
claimId: fixture.generated-adjacent
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.adjacent
render: generated-section
-->
<!-- FSUSBLOG-GENERATED:BEGIN fixture.adjacent -->
generated body
<!-- FSUSBLOG-GENERATED:END fixture.adjacent -->
The deployment claim is valid.`
    ]
    for (const source of sources)
    {
        assert.ok(scanReleaseDeploymentSourceResidue(source, 'fixture.md')
            .some((entry) => entry.classId === 'manual-deployment-authority'))
    }
})

test('release-domain documents reject every unclassified active prose block', () =>
{
    const source = '## Release conclusion\nThe blue-green deployment claim is eligible and runtime-role ownership is verified.'
    assert.ok(scanReleaseDeploymentSourceResidue(source, 'docs/testing.md')
        .some((entry) => entry.classId === 'manual-deployment-authority'))
})

test('typed closed ownership preserves non-authority and AST-excluded nodes', () =>
{
    const source = `# Operator guidance

Read the generated observation before an operation; this paragraph does not define slot transitions or switch traffic.

If \`claimEligible\` is false, stop and request owner evidence; do not infer an active identity from this guidance.

The validation command is diagnostic only and is not execution evidence.

The blue-green deployment claim is not approved.

No blue-green deployment claim is eligible.

No runtime-role ownership is verified.

Traffic handoff is not permitted.

Traffic handoff is not not permitted.

Cutover is not blocked.

The policy does not forbid traffic handoff.

Without receipts, the deployment claim remains blocked.

No evidence required, the deployment claim remains blocked.

## Historical behavior

Previously, the blue-green deployment claim was eligible and runtime-role ownership was verified.

The deployment claim was eligible before migration.

The old runtime-role ownership was verified.

## Forbidden examples

> The blue-green deployment claim is eligible.

Rejected example: traffic handoff is permitted.

Inline example: the deployment claim is eligible.

Historically the claim was invalid, but the current paragraph remains diagnostic only.

<!-- The deployment claim is eligible. -->

<pre>
The deployment claim is eligible.
</pre>

> > This ordinary nested quote says the deployment claim is eligible.

## Typed projection

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
    const classificationAuthority = {
        entries: extractReleaseDeploymentProseNodes(source, 'fixture.md').map((node) => ({
            documentPath: node.documentPath,
            behaviorIds: ['deployment-blue-green-runtime-role'],
            startLine: node.startLine,
            endLine: node.endLine,
            nodeType: node.nodeType,
            classification: 'diagnostic',
            contentDigest: node.contentDigest
        }))
    }
    const classifications = classifyReleaseDeploymentSource(
        source,
        'fixture.md',
        classificationAuthority
    )
    assert.ok(classifications.length > 0)
    assert.deepEqual(scanReleaseDeploymentSourceResidue(source, 'fixture.md', {
        proseClassifications: classifications,
        classificationAuthority
    }), [])
})

test('actual deployment documents retain exact AST coverage across fences and owned spans', () =>
{
    const expected = {
        'docs/releases/blue-green-deployment-runbook.md': [
            ['heading', 1, 1],
            ['paragraph', 3, 3],
            ['heading', 5, 5],
            ['paragraph', 12, 12],
            ['heading', 13, 13],
            ['heading', 33, 33]
        ],
        'docs/architecture/monolithic-distributed-boundary.md': [
            ['heading', 1, 1],
            ['paragraph', 3, 3],
            ['heading', 5, 5],
            ['paragraph', 7, 7],
            ['paragraph', 29, 29],
            ['heading', 31, 31],
            ['paragraph', 33, 33],
            ['paragraph', 35, 35],
            ['paragraph', 43, 43],
            ['heading', 44, 44]
        ]
    }
    for (const [documentPath, spans] of Object.entries(expected))
    {
        const source = readFileSync(path.join(root, documentPath), 'utf8')
        assert.deepEqual(extractReleaseDeploymentProseNodes(source, documentPath)
            .map((entry) => [entry.nodeType, entry.startLine, entry.endLine]), spans)
    }
})

test('EOF fences and adjacent typed ownership cannot create orphan delimiter masking', () =>
{
    const excludedOnly = [
        '```text\nThe deployment claim is valid.',
        '~~~text\nThe deployment claim is valid.',
        '```text\none\n```\n~~~text\ntwo\n~~~',
        `<!-- fsus-doc-claim
claimId: fixture.generated-only
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.generated-only
render: generated-section
-->
<!-- FSUSBLOG-GENERATED:BEGIN fixture.generated-only -->
The deployment claim is valid.
<!-- FSUSBLOG-GENERATED:END fixture.generated-only -->`
    ]
    for (const source of excludedOnly)
        assert.deepEqual(scanReleaseDeploymentSourceResidue(source, 'fixture.md'), [])

    const adjacentTypedAndGenerated = `<!-- fsus-doc-claim
claimId: fixture.typed-adjacent
behaviorId: deployment-blue-green-runtime-role
claimType: boolean
factPath: deploymentBlueGreen.claimEligible
render: boolean-negated
-->

The deployment claim remains blocked.

<!-- fsus-doc-claim
claimId: fixture.generated-adjacent-positive
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.adjacent-positive
render: generated-section
-->
<!-- FSUSBLOG-GENERATED:BEGIN fixture.adjacent-positive -->
The deployment claim is valid.
<!-- FSUSBLOG-GENERATED:END fixture.adjacent-positive -->`
    assert.deepEqual(extractReleaseDeploymentProseNodes(adjacentTypedAndGenerated, 'fixture.md'), [])

    for (const malformed of [
        '<!-- FSUSBLOG-GENERATED:BEGIN fixture.unclosed -->\nbody',
        '<!-- FSUSBLOG-GENERATED:END fixture.orphan -->',
        '<!-- FSUSBLOG-GENERATED:BEGIN fixture.one -->\nbody\n<!-- FSUSBLOG-GENERATED:END fixture.two -->'
    ])
        assert.throws(() => extractReleaseDeploymentProseNodes(malformed, 'fixture.md'), /generated section/u)
})

test('fence delimiter length is structural and cannot hide following active prose', () =>
{
    assert.deepEqual(extractReleaseDeploymentProseNodes(
        '````text\ninside\n```\nstill inside',
        'fixture.md'
    ), [])
    assert.equal(scanReleaseDeploymentSourceResidue(
        '````text\ninside\n````\nThe deployment claim is valid.',
        'fixture.md'
    ).length, 1)
})

test('visible HTML tails and ordinary blockquotes remain classified prose nodes', () =>
{
    const samples = [
        ['<!-- hidden --> The deployment claim is valid.', 'paragraph'],
        ['<pre>hidden\n</pre> The deployment claim is valid.', 'paragraph'],
        ['> The deployment claim is valid.', 'quote']
    ]
    for (const [source, nodeType] of samples)
    {
        const nodes = extractReleaseDeploymentProseNodes(source, 'fixture.md')
        assert.equal(nodes.length, 1)
        assert.equal(nodes[0].nodeType, nodeType)
        assert.equal(scanReleaseDeploymentSourceResidue(source, 'fixture.md').length, 1)
    }
})

test('canonical document reader binds UTF-8 bytes, paths, filesystem identity and Git blobs', () =>
{
    const repository = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-doc-path-'))
    const documentPath = 'docs/release.md'
    const document = path.join(repository, documentPath)
    const runGit = (...args) => execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    })
    try
    {
        mkdirSync(path.dirname(document), { recursive: true })
        writeFileSync(document, '# Release\n')
        runGit('init', '-q')
        runGit('config', 'user.name', 'fixture')
        runGit('config', 'user.email', 'fixture@example.test')
        runGit('add', documentPath)
        runGit('commit', '-qm', 'fixture')
        assert.equal(readCanonicalReleaseDeploymentDocument(repository, documentPath), '# Release\n')

        writeFileSync(document, '# Release\r\n')
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, documentPath), /canonical LF/u)
        writeFileSync(document, '# Release  \n')
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, documentPath), /trailing horizontal/u)
        writeFileSync(document, Buffer.from([0xff, 0xfe]))
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, documentPath), /strict UTF-8/u)
        writeFileSync(document, '# Changed\n')
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, documentPath), /blobs differ/u)

        const hardlinkTarget = path.join(repository, 'hardlink-target.md')
        writeFileSync(hardlinkTarget, '# Release\n')
        unlinkSync(document)
        linkSync(hardlinkTarget, document)
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, documentPath), /singly-linked/u)
        unlinkSync(document)
        symlinkSync(hardlinkTarget, document)
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, documentPath), /symbolic link/u)

        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, 'docs/../release.md'), /non-canonical/u)
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, 'docs/rele\u0301ase.md'), /non-canonical/u)
        assert.throws(() => readCanonicalReleaseDeploymentDocument(repository, 'Docs/release.md'), /non-canonical/u)
    }
    finally
    {
        rmSync(repository, { recursive: true, force: true })
    }
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

test('classification index is an exact projection of the prior typed policy commit', () =>
{
    const expected = JSON.parse(readFileSync(path.join(
        root,
        'config/contracts/release-deployment-prose-classifications.json'
    ), 'utf8'))
    const generated = buildReleaseDeploymentProseClassificationIndex(root)
    const policyCommit = execFileSync('git', [
        'log', '-1', '--format=%H', '--',
        'config/contracts/release-deployment-prose-classification-authority.json'
    ], { cwd: root, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    assert.deepEqual(generated, expected)
    assert.equal(generated.source.commit, policyCommit)
    assert.notEqual(generated.source.commit, head)
    assert.equal(generated.entries.length, 441)
    assert.equal(generated.entries.filter((entry) => entry.nodeType === 'quote').length, 1)
})

test('current release/deployment documents contain no forbidden manual authority residue', () =>
{
    const catalog = JSON.parse(readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'))
    const contracts = catalog.contracts
        .filter((entry) => releaseDeploymentBehaviorIds.includes(entry.id))
    const documents = contracts.flatMap((entry) => entry.documents)
    assert.deepEqual(scanReleaseDeploymentDocResidue(root, documents), [])
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
    assert.equal(receipt.counts.mutationKilled, 75)
    assert.equal(receipt.counts.mutationTotal, 75)
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
