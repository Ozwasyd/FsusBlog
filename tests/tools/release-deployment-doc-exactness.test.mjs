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
    buildReleaseDeploymentDocExactnessReceipt,
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
import { sealReceipt } from '../../tools/fact-extractors/receipt.mjs'
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
    assert.equal(evidence.total, 61)
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

test('typed closed ownership preserves typed spans and exact protected fenced code', () =>
{
    const source = `# Operator guidance

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
    const protectedHeadingNodes = extractReleaseDeploymentProseNodes(
        `# Operator guidance

## Typed projection

\`\`\`bash
./tools/deployment/gateway-switch.sh --check
\`\`\`
`,
        'fixture.md'
    )
    assert.deepEqual(scanReleaseDeploymentSourceResidue(source, 'fixture.md', {
        protectedHeadingNodes
    }), [])
})

test('actual deployment documents retain exact AST coverage across fences and owned spans', () =>
{
    const expected = {
        'docs/releases/blue-green-deployment-runbook.md': [
            ['heading', 1, 1],
            ['heading', 3, 3],
            ['fenced-code', 5, 8],
            ['heading', 10, 10],
            ['heading', 30, 30]
        ],
        'docs/architecture/monolithic-distributed-boundary.md': [
            ['heading', 1, 1],
            ['heading', 3, 3],
            ['heading', 25, 25],
            ['fenced-code', 27, 31],
            ['heading', 32, 32]
        ]
    }
    for (const [documentPath, spans] of Object.entries(expected))
    {
        const source = readFileSync(path.join(root, documentPath), 'utf8')
        assert.deepEqual(extractReleaseDeploymentProseNodes(source, documentPath)
            .map((entry) => [entry.nodeType, entry.startLine, entry.endLine]), spans)
    }
})

test('closed and EOF fences are classified while typed ownership cannot mask adjacent prose', () =>
{
    const fencedSources = [
        ['```text\nThe deployment claim is valid.', 1],
        ['~~~text\nThe deployment claim is valid.', 1],
        ['```text\none\n```\n~~~text\ntwo\n~~~', 2]
    ]
    for (const [source, count] of fencedSources)
    {
        assert.equal(extractReleaseDeploymentProseNodes(source, 'fixture.md')
            .filter((entry) => entry.nodeType === 'fenced-code').length, count)
        assert.equal(scanReleaseDeploymentSourceResidue(source, 'fixture.md').length, count)
    }

    const generatedOnly = `<!-- fsus-doc-claim
claimId: fixture.generated-only
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.generated-only
render: generated-section
-->
<!-- FSUSBLOG-GENERATED:BEGIN fixture.generated-only -->
The deployment claim is valid.
<!-- FSUSBLOG-GENERATED:END fixture.generated-only -->`
    assert.deepEqual(scanReleaseDeploymentSourceResidue(generatedOnly, 'fixture.md'), [])

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
    ).map((entry) => entry.nodeType), ['fenced-code'])
    assert.equal(scanReleaseDeploymentSourceResidue(
        '````text\ninside\n````\nThe deployment claim is valid.',
        'fixture.md'
    ).length, 2)
})

test('hidden carriers, visible HTML tails and ordinary blockquotes remain classified nodes', () =>
{
    const samples = [
        ['<!-- hidden --> The deployment claim is valid.', ['html-comment', 'paragraph']],
        ['<pre>hidden\n</pre> The deployment claim is valid.', ['html-pre', 'paragraph']],
        ['> The deployment claim is valid.', ['quote']],
        ['    deployment-waiver: cleanup may delete the active release', ['indented-code']]
    ]
    for (const [source, nodeTypes] of samples)
    {
        const nodes = extractReleaseDeploymentProseNodes(source, 'fixture.md')
        assert.deepEqual(nodes.map((entry) => entry.nodeType), nodeTypes)
        assert.equal(scanReleaseDeploymentSourceResidue(source, 'fixture.md').length, nodeTypes.length)
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

test('coordinated two-commit prose and diagnostic self-grant cannot cross the protected PR base', () =>
{
    const repository = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-doc-self-grant-'))
    const deploymentPath = 'docs/deployment.md'
    const releasePath = 'docs/release.md'
    const runGit = (...args) => execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    try
    {
        mkdirSync(path.join(repository, 'config/contracts'), { recursive: true })
        mkdirSync(path.join(repository, 'docs'), { recursive: true })
        writeFileSync(path.join(repository, 'config/contracts/behavior-contracts.json'), JSON.stringify({
            contracts: [
                {
                    id: 'fixture-deployment',
                    status: 'active',
                    documentationPolicy: 'required',
                    domain: 'deployment',
                    documents: [deploymentPath]
                },
                {
                    id: 'fixture-release',
                    status: 'active',
                    documentationPolicy: 'required',
                    domain: 'release',
                    documents: [releasePath]
                }
            ]
        }, null, 4) + '\n')
        writeFileSync(path.join(repository, deploymentPath), '# Deployment\n')
        writeFileSync(
            path.join(repository, releasePath),
            '# Release\n\n## `release-final` — final publish credential\n\nLegacy finalizer guidance.\n'
        )
        runGit('init', '-q')
        runGit('config', 'user.name', 'fixture')
        runGit('config', 'user.email', 'fixture@example.test')
        runGit('add', '.')
        runGit('commit', '-qm', 'protected base')
        const protectedBase = runGit('rev-parse', 'HEAD')

        writeFileSync(path.join(repository, deploymentPath),
            '# Deployment\n\nTraffic handoff is permitted and the deployment claim is valid.\n')
        const policyPath = 'config/contracts/release-deployment-prose-classification-authority.json'
        const indexPath = 'config/contracts/release-deployment-prose-classifications.json'
        writeFileSync(path.join(repository, policyPath), JSON.stringify({
            documentPath: deploymentPath,
            classification: 'diagnostic'
        }, null, 4) + '\n')
        runGit('add', '.')
        runGit('commit', '-qm', 'add active prose and self-granted policy')

        writeFileSync(path.join(repository, indexPath), JSON.stringify({
            source: policyPath,
            classification: 'diagnostic'
        }, null, 4) + '\n')
        runGit('add', '.')
        runGit('commit', '-qm', 'seal self-granted classification index')

        assert.equal(runGit('rev-list', '--count', `${protectedBase}..HEAD`), '2')
        const findings = scanReleaseDeploymentDocResidue(
            repository,
            [deploymentPath, releasePath],
            { approvedBaseRef: protectedBase }
        )
        assert.equal(findings.length, 3)
        assert.deepEqual(
            [...new Set(findings.map((entry) => entry.documentPath))].sort(),
            [deploymentPath, releasePath]
        )
        assert.ok(findings.every((entry) => entry.classId === 'manual-deployment-authority'))
    }
    finally
    {
        rmSync(repository, { recursive: true, force: true })
    }
})

test('current release/deployment documents contain no forbidden manual authority residue', () =>
{
    const catalog = JSON.parse(readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'))
    const contracts = catalog.contracts
        .filter((entry) => releaseDeploymentBehaviorIds.includes(entry.id))
    const documents = contracts.flatMap((entry) => entry.documents)
    assert.deepEqual(scanReleaseDeploymentDocResidue(root, documents), [])
})

test('CLI and library reject sealed receipts or caller identities from another source state', () =>
{
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-doc-stale-receipt-'))
    const receiptPath = path.join(temporaryRoot, 'receipt.json')
    const staleSourceCommit = observation.sourceCommit === '0'.repeat(40)
        ? '1'.repeat(40)
        : '0'.repeat(40)
    try
    {
        writeFileSync(receiptPath, JSON.stringify(sealReceipt({
            ...structuredClone(observation),
            sourceCommit: staleSourceCommit
        }), null, 4) + '\n')
        assert.throws(
            () => execFileSync(process.execPath, [
                path.join(root, 'tools/docs/release-deployment-doc-exactness.mjs'),
                '--receipt',
                receiptPath
            ], {
                cwd: root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            }),
            (error) =>
            {
                assert.match(String(error.stderr), /receipt sourceCommit does not match current source/u)
                return true
            }
        )

        assert.throws(() => buildReleaseDeploymentDocExactnessReceipt({
            repositoryRoot: root,
            observationReceipt: observation,
            sourceCommit: staleSourceCommit,
            worktreeFingerprint: observation.worktreeFingerprint
        }), /sourceCommit differs from the current repository identity/u)

        const staleWorktreeReceipt = sealReceipt({
            ...structuredClone(observation),
            worktreeFingerprint: observation.worktreeFingerprint === '0'.repeat(64)
                ? '1'.repeat(64)
                : '0'.repeat(64)
        })
        assert.throws(
            () => loadReleaseDeploymentExactnessInputs(root, staleWorktreeReceipt),
            /worktreeFingerprint does not match current worktree/u
        )
    }
    finally
    {
        rmSync(temporaryRoot, { recursive: true, force: true })
    }
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
    assert.equal(receipt.counts.mutationKilled, 72)
    assert.equal(receipt.counts.mutationTotal, 72)
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
