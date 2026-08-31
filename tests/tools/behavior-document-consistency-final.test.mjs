import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import {
    buildFinalConsistencyReport,
    scanZeroLegacyGovernance,
    validateFinalReport,
    validateZeroLegacyScan,
    zeroLegacyRequiredPathClasses,
    zeroLegacyScanSchema
} from '../../tools/docs/behavior-document-consistency-final.mjs'
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const commit = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const runId = 'final-round'
const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const seal = (value, keepNull = false) => {
    const receipt = { ...value, contentDigest: null }
    const content = keepNull ? receipt : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    receipt.contentDigest = `sha256:${hash(content)}`
    return receipt
}
const emptyZeroLegacyScan = () => ({
    schema: zeroLegacyScanSchema,
    scanRoots: [
        { path: 'config', pathClass: 'config' },
        { path: 'docs', pathClass: 'docs' },
        { path: 'src', pathClass: 'production' },
        { path: 'tests', pathClass: 'tests' },
        { path: 'tools', pathClass: 'tools' }
    ],
    scannedFileCount: 0,
    pathClassCounts: Object.fromEntries(zeroLegacyRequiredPathClasses.map((pathClass) => [pathClass, 0])),
    findings: []
})

function repositoryFixture(t, files)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zero-legacy-'))
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    for (const [relative, content] of Object.entries(files))
    {
        const absolute = path.join(repositoryRoot, relative)
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, content)
    }
    return repositoryRoot
}

function sourceRepositoryFixture(t, files = {})
{
    const repositoryRoot = repositoryFixture(t, files)
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    execFileSync('git', ['config', 'user.email', 'tests@fsusblog.local'], { cwd: repositoryRoot })
    execFileSync('git', ['config', 'user.name', 'FsusBlog Tests'], { cwd: repositoryRoot })
    execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'test: seal source state'], { cwd: repositoryRoot })
    return repositoryRoot
}

function fixture(overrides = {})
{
    const sourceRoot = overrides.sourceRoot ?? null
    const sourceIdentity = sourceRoot === null
        ? { sourceCommit: commit, worktreeFingerprint: fingerprint }
        : sealSourceIdentity(sourceRoot)
    const sourceCommit = sourceIdentity.sourceCommit
    const sourceFingerprint = sourceIdentity.worktreeFingerprint
    const catalog = {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        domains: ['testing'],
        extractors: [{ id: 'alpha-facts', path: 'tools/alpha.mjs' }],
        contracts: [{
            id: 'alpha-behavior', domain: 'testing', risk: 'high', status: 'active',
            implementationOwnerCardinality: 'one', allowedImplementationOwnerRoles: [],
            factExtractorId: 'alpha-facts', requiredTestKinds: ['positive'],
            documentationPolicy: 'required', documentationRationale: 'Alpha is current.',
            allowedClaimTypes: ['behavioral'], releaseQualification: true,
            evidenceStage: 'pre-runtime', coverageIds: ['alpha'], documents: ['docs/alpha.md']
        }]
    }
    const catalogHash = digestCatalog(catalog)
    const admission = seal({
        schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
        run: { id: runId },
        source: { commit: sourceCommit, worktreeFingerprint: sourceFingerprint },
        worktree: { root: sourceRoot ?? '/repo' },
        toolchain: { node: 'v24', dotnet: '10', platform: 'linux', architecture: 'x64', directoryBuildPropsDigest: '1'.repeat(64) },
        authorityDigests: {
            catalog: catalogHash, claim: '2'.repeat(64), extractorRegistry: '3'.repeat(64),
            generatedSectionCatalog: '4'.repeat(64), generatedRenderer: '5'.repeat(64),
            proseRenderer: '6'.repeat(64), mutationCatalog: '7'.repeat(64)
        },
        implementationOwner: { status: 'ok', bindingCount: 1, contentDigest: '8'.repeat(64) },
        factObservations: {},
        minimalContractBuild: { contentDigest: '9'.repeat(64) },
        generated: { status: 'ok' }, prose: { status: 'ok' }, mutationFixtures: { status: 'ok' },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: [], durationMs: 1
    }, true)
    const pre = seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
        runIdentity: runId, sourceIdentity: { commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`, staticClaimVerificationDigest: `sha256:${'c'.repeat(64)}`,
        behaviorIds: ['alpha-behavior'], requiredTestKinds: { 'alpha-behavior': ['positive'] },
        observedTestKinds: { 'alpha-behavior': ['positive'] }, mutationStatus: {},
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}` },
        candidateIdentity: { buildReceiptDigest: `sha256:${'d'.repeat(64)}`, runtimeEvidenceDigest: `sha256:${'e'.repeat(64)}`, browserContractDigest: `sha256:${'f'.repeat(64)}` },
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${catalogHash}`,
        behaviorIds: [], requiredRuntimeProducers: [], observedBehaviorResults: [], documentClaimDigests: {},
        missing: [], orphans: [], conflicts: [], releaseFinalSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: []
    })
    const owner = seal({ status: 'ok', bindings: [{ behaviorId: 'alpha-behavior', sourcePath: 'src/alpha.cs' }] })
    const fact = seal({ status: 'ok', extractorId: 'alpha-facts', behaviorIds: ['alpha-behavior'], sourceCommit, worktreeFingerprint: sourceFingerprint })
    const claims = seal({ claims: [{ declaration: { behaviorId: 'alpha-behavior', claimId: 'alpha.current' } }] })
    const verification = seal({ status: 'ok' })
    const generated = seal({ status: 'ok' })
    const migrationLedger = { schema: 'fixture', scopes: [{ scopeId: 'alpha', entries: [{ behaviorId: 'alpha-behavior', documentPath: 'docs/alpha.md', claimIds: ['alpha.current'], generatedSectionIds: [] }] }] }
    const matrix = { tiers: [
        { id: 'static', executionDependsOn: [], summaryAuthority: null },
        { id: 'pre', executionDependsOn: ['static'], summaryAuthority: null },
        { id: 'post', executionDependsOn: ['pre'], summaryAuthority: null }
    ] }
    return {
        staticAdmissionReceipt: admission, preRuntimeReceipt: pre, postRuntimeReceipt: post,
        ownerReceipt: owner, factObservationReceipts: [fact], docClaimParseReceipt: claims,
        docClaimVerificationReceipt: verification, generatedSectionReceipt: generated,
        catalog, migrationLedger, matrix,
        ...overrides
    }
}

test('final consistency report deterministically closes every behavior edge', (t) =>
{
    const sourceRoot = sourceRepositoryFixture(t)
    const report = buildFinalConsistencyReport(fixture({ sourceRoot }))
    assert.equal(validateFinalReport(report).status, 'ok', report.failureReasons.join('; '))
    assert.equal(report.behaviorNodes[0].status, 'ok')
    assert.equal(report.dagAudit.stronglyConnectedComponents.length, 0)
})

test('stale identities, graph cycles and legacy residue fail without repairing producers', (t) =>
{
    const sourceRoot = sourceRepositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify({ lastReviewedAt: 'now' })
    })
    const stalePost = fixture({ sourceRoot }).postRuntimeReceipt
    stalePost.sourceIdentity.commit = 'd'.repeat(40)
    stalePost.contentDigest = seal(Object.fromEntries(Object.entries(stalePost).filter(([key]) => key !== 'contentDigest'))).contentDigest
    const input = fixture({
        postRuntimeReceipt: stalePost,
        sourceRoot,
        matrix: { tiers: [{ id: 'a', executionDependsOn: ['b'] }, { id: 'b', executionDependsOn: ['a'] }] }
    })
    const report = buildFinalConsistencyReport(input)
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('identity mismatch')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('SCC')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy')))
})

test('tampered input receipt is rejected before final aggregation', (t) =>
{
    const input = fixture({ sourceRoot: sourceRepositoryFixture(t) })
    input.ownerReceipt.bindings = []
    assert.throws(() => buildFinalConsistencyReport(input), /contentDigest mismatch/u)
})

test('zero-legacy scan covers every terminal path class and rejects root-specific residue', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/behavior-qualification.json': JSON.stringify({ lastVerifiedCommit: 'a'.repeat(40) }),
        'config/testing/behavior-qualification.json': JSON.stringify({ maximum_verification_distance: 1 }),
        'tools/release/behavior-qualification.mjs': 'const lastReviewedAt = "now"\n',
        'tests/fixtures/behavior-qualification.json': JSON.stringify({ content_baseline_sha: 'b'.repeat(64) }),
        'docs/behavior-contract.md': '# Contract\n```json\n{ "approvedContentDigest": "sha256:old" }\n```\n',
        'src/frontend/package.json': JSON.stringify({ scripts: { 'check:behavior': 'node deprecated-claim-cli.mjs' } }),
        'config/testing/behavior.generated.json': JSON.stringify({ expectedValue: 'old' }),
        'config/schemas/behavior-output.schema.json': JSON.stringify({ approved_content_digest: { type: 'string' } })
    })
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.deepEqual(Object.keys(scan.pathClassCounts).sort(), [...zeroLegacyRequiredPathClasses].sort())
    for (const pathClass of zeroLegacyRequiredPathClasses) assert.ok(scan.pathClassCounts[pathClass] > 0, `${pathClass} was not scanned`)
    for (const pathClass of zeroLegacyRequiredPathClasses)
    {
        assert.ok(scan.findings.some((finding) => finding.pathClasses.includes(pathClass)), `${pathClass} residue escaped`)
    }
})

test('zero-legacy machine-field mutation corpus rejects separator variants and boolean self-certification', (t) =>
{
    const machineFields = {
        last_verified_commit: 'a'.repeat(40),
        'maximum-verification-distance': 1,
        lastReviewedCommit: 'b'.repeat(40),
        'last-reviewed-at': 'now',
        verified_at: 'now',
        contentBaselineSha: 'c'.repeat(64),
        approved_content_digest: 'd'.repeat(64),
        expectedValue: 1,
        baseline_value: 1,
        ignoreDifference: true,
        allow_stale_until: 'tomorrow',
        waiver: 'manual',
        verified: true,
        reviewed: true
    }
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify(machineFields)
    })
    const rules = scanZeroLegacyGovernance(repositoryRoot).findings.map((finding) => finding.rule)
    for (const field of [
        'lastVerifiedCommit', 'maximumVerificationDistance', 'lastReviewedCommit', 'lastReviewedAt',
        'verifiedAt', 'contentBaselineSha', 'approvedContentDigest', 'expectedValue', 'baselineValue',
        'ignoreDifference', 'allowStaleUntil', 'waiver'
    ])
    {
        assert.ok(rules.includes(`forbidden-machine-field:${field}`), `${field} mutation survived`)
    }
    assert.ok(rules.includes('forbidden-self-certification:verified'))
    assert.ok(rules.includes('forbidden-self-certification:reviewed'))
})

test('zero-legacy source declaration mutations cannot bypass field matching', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/behavior-qualification.cs': 'public string LastVerifiedCommit { get; init; }\n',
        'tools/release/behavior-qualification.ts': 'receipt.last_reviewed_at = "now"\ninterface Receipt { allowStaleUntil?: string }\n',
        'tests/release/behavior-qualification.test.mjs': 'const lastVerifiedCommit = "deadbeef"\n',
        'tests/tools/scanner-fixture.test.mjs': 'const fixture = \'const lastVerifiedCommit = "deadbeef"\'\n',
        'docs/behavior-contract.md': '# Contract\n```yaml\nverified: true\n```\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file.endsWith('.cs') && finding.rule.endsWith(':lastVerifiedCommit')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.ts') && finding.rule.endsWith(':lastReviewedAt')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.ts') && finding.rule.endsWith(':allowStaleUntil')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.test.mjs') && finding.rule.endsWith(':lastVerifiedCommit')))
    assert.equal(findings.some((finding) => finding.file === 'tests/tools/scanner-fixture.test.mjs'), false)
    assert.ok(findings.some((finding) => finding.file.endsWith('.md') && finding.rule.endsWith(':verified')))
})

test('zero-legacy source invocations and C# initializers cannot hide terminal residue', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/behavior-qualification.cs': 'public bool Verified { get; init; } = true;\n',
        'tools/release/behavior-qualification.mjs': [
            'spawnSync("deprecated-claim-cli", ["--run"])',
            'selectReceipt("latest")',
            'const command = "deprecated-" +',
            '    "claim-cli"',
            'const commandBeforePlus = "deprecated-" // continue before plus',
            '    + "claim-cli"',
            'const commandAfterPlus = "deprecated-" + // continue after comment',
            '    "claim-cli"',
            'const commandBlockComment = "deprecated-" /* continue */ + "claim-cli"'
        ].join('\n'),
        'tools/release/comment-only-behavior-qualification.mjs': [
            'const command = "current-claim-cli" // deprecated-claim-cli',
            'const authority = "current-openapi" /* checked-in-openapi */'
        ].join('\n'),
        'tools/release/cr-behavior-qualification.mjs': [
            'const command = "deprecated-" + // continue',
            '    "claim-cli"'
        ].join('\r'),
        'tools/release/u2028-behavior-qualification.mjs': [
            'const command = "deprecated-" + // continue',
            '    "claim-cli"'
        ].join('\u2028'),
        'tools/release/u2029-behavior-qualification.mjs': [
            'const command = "deprecated-" + // continue',
            '    "claim-cli"'
        ].join('\u2029')
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file.endsWith('.cs') && finding.rule === 'forbidden-self-certification:verified'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs') && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs')
        && finding.rule.startsWith('forbidden-legacy-surface:deprecated--claim-cli')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs') && finding.rule === 'forbidden-evidence-selection:selectReceipt=latest'))
    assert.equal(findings.some((finding) => finding.file === 'tools/release/comment-only-behavior-qualification.mjs'), false)
    for (const file of [
        'tools/release/cr-behavior-qualification.mjs',
        'tools/release/u2028-behavior-qualification.mjs',
        'tools/release/u2029-behavior-qualification.mjs'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file
            && finding.rule.startsWith('forbidden-legacy-surface:deprecated--claim-cli')), `${file} line terminator escaped`)
    }
})

test('zero-legacy shell and YAML hash comments do not create residue or hide active values', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/release/comment-only-behavior-qualification.sh': '# command="deprecated-claim-cli"\ncommand="current-claim-cli" # checked-in-openapi\necho current;# authority="checked-in-openapi"\n',
        'tools/release/active-behavior-qualification.sh': 'command="deprecated-claim-cli"\n',
        'config/testing/comment-only-behavior-qualification.yaml': '# latestReceipt: stale.json\ncommand: current-claim-cli # deprecated-claim-cli\n',
        'config/testing/active-behavior-qualification.yaml': 'command: deprecated-claim-cli\n',
        'config/testing/hash-scalar-active-behavior-qualification.yaml': 'command: current#deprecated-claim-cli\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of [
        'tools/release/comment-only-behavior-qualification.sh',
        'config/testing/comment-only-behavior-qualification.yaml'
    ])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} hash comment was scanned`)
    }
    for (const file of [
        'tools/release/active-behavior-qualification.sh',
        'config/testing/active-behavior-qualification.yaml',
        'config/testing/hash-scalar-active-behavior-qualification.yaml'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file
            && finding.rule.includes('deprecated-claim-cli')), `${file} active value escaped`)
    }
})

test('zero-legacy scanner excludes untracked and ignored build or runtime outputs', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/authoritative.mjs': 'export const currentReceipt = "receipt.json"\n',
        'src/release/untracked.mjs': 'const lastVerifiedCommit = "deadbeef"\n',
        'src/frontend/dist/release.mjs': 'const lastVerifiedCommit = "deadbeef"\n',
        'tools/out/release.mjs': 'selectReceipt("latest")\n',
        'tests/coverage/release.json': JSON.stringify({ lastVerifiedCommit: 'deadbeef' }),
        'tests/TestResults/release.json': JSON.stringify({ lastVerifiedCommit: 'deadbeef' })
    })
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    execFileSync('git', ['add', 'src/release/authoritative.mjs'], { cwd: repositoryRoot })
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(scan.scannedFileCount, 1)
    assert.deepEqual(scan.findings, [])
})

test('zero-legacy scanner never excludes tracked source by coverage or dist path names', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/coverage/behavior-qualification.mjs': 'const receiptSource = "latest-receipt"\n',
        'src/frontend/dist/behavior-qualification.mjs': 'const command = "deprecated-claim-cli"\n',
        'src/frontend/coverage/current.mjs': 'export const current = true\n'
    })
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(scan.scannedFileCount, 3)
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/coverage/behavior-qualification.mjs'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(scan.findings.some((finding) => finding.file === 'src/frontend/dist/behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
    assert.equal(scan.findings.some((finding) => finding.file === 'src/frontend/coverage/current.mjs'), false)
})

test('zero-legacy selection and authority mutation corpus rejects latest history fallback and self-authority fields', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/release-final-qualification.json': JSON.stringify({
            latest_receipt: 'receipt.json',
            latestRuntimeReceipt: 'runtime.json',
            evidenceHistory: [],
            historicalFactReceipt: 'old-fact.json',
            fallbackEvidence: 'old.json',
            evidence_mtime: 1,
            evidenceSelectionStrategy: 'latest',
            lastGreen: 'run-1',
            retryUntilPass: true,
            self_certification: true,
            authority: 'checked-in-openapi',
            synchronizationStrategy: 'git-diff',
            checkedInOpenapi: 'openapi.json',
            openapiRegexFallback: 'route regex',
            releaseFinalDiscovery: true,
            releaseFinalParseReceipts: true,
            llmQualification: 'accepted'
        })
    })
    const rules = scanZeroLegacyGovernance(repositoryRoot).findings.map((finding) => finding.rule)
    for (const field of [
        'latestReceipt', 'latestRuntimeReceipt', 'evidenceHistory', 'historicalFactReceipt',
        'fallbackEvidence', 'evidenceMtime', 'lastGreen', 'retryUntilPass'
    ])
    {
        assert.ok(rules.includes(`forbidden-evidence-selection:${field}`), `${field} mutation survived`)
    }
    assert.ok(rules.includes('forbidden-evidence-selection:evidenceSelectionStrategy=latest'))
    for (const field of [
        'selfCertification', 'gitDiff', 'checkedInOpenapi', 'openapiRegexFallback',
        'releaseFinalDiscovery', 'releaseFinalParseReceipts', 'llmQualification'
    ])
    {
        assert.ok(rules.includes(`forbidden-self-authority:${field}`), `${field} mutation survived`)
    }
})

test('zero-legacy scanner rejects legacy role surfaces but allows historical prose and skips symlinks', (t) =>
{
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zero-legacy-outside-'))
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
    fs.writeFileSync(path.join(outside, 'behavior-qualification.json'), JSON.stringify({ lastVerifiedCommit: 'a'.repeat(40) }))
    const repositoryRoot = repositoryFixture(t, {
        'docs/history.md': '# History\nIn 2025 the retired record mentioned lastVerifiedCommit deadbeef.\n',
        'tools/docs/behavior-qualification.mjs': 'class CompatRenderer {}\n',
        'config/testing/behavior-qualification.json': JSON.stringify({
            deprecatedFeatureFlag: true,
            kind: 'deprecated-claim'
        })
    })
    fs.mkdirSync(path.join(repositoryRoot, 'src'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'behavior-qualification.json'), path.join(repositoryRoot, 'src', 'linked.json'))
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.ok(scan.findings.some((finding) => finding.rule.includes('CompatRenderer')))
    assert.ok(scan.findings.some((finding) => finding.rule.includes('deprecatedFeatureFlag')))
    assert.ok(scan.findings.some((finding) => finding.rule.includes('deprecated-claim')))
    assert.equal(scan.findings.some((finding) => finding.file === 'docs/history.md'), false)
    assert.equal(scan.findings.some((finding) => finding.file === 'src/linked.json'), false)
})

test('zero-legacy JSON not exemption requires an explicit JSON Schema dialect', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify({
            not: { latestReceipt: 'ambient.json', verified: true }
        }),
        'config/schemas/behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            not: { properties: { latestReceipt: { type: 'string' }, verified: { const: true } } }
        }),
        'config/schemas/not-property-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/unproven-behavior-qualification.schema.json': JSON.stringify({
            not: { latestReceipt: 'ambient.json', verified: true }
        }),
        'config/schemas/double-not-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            not: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/current-dependencies-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            dependencies: { currentField: { not: { latestReceipt: 'ambient.json' } } }
        })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of [
        'config/testing/behavior-qualification.json',
        'config/schemas/unproven-behavior-qualification.schema.json'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
        assert.ok(findings.some((finding) => finding.file === file && finding.rule === 'forbidden-self-certification:verified'))
    }
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/behavior-qualification.schema.json'), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/not-property-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/double-not-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/current-dependencies-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
})

test('zero-legacy draft 4 6 and 7 dependencies preserve schema-valued negation', (t) =>
{
    const files = Object.fromEntries([
        ['draft-04', 'http://json-schema.org/draft-04/schema#'],
        ['draft-06', 'http://json-schema.org/draft-06/schema#'],
        ['draft-07', 'http://json-schema.org/draft-07/schema#']
    ].map(([name, dialect]) => [
        `config/schemas/${name}-behavior-qualification.schema.json`,
        JSON.stringify({
            $schema: dialect,
            dependencies: {
                currentField: { not: { properties: { latestReceipt: { type: 'string' } } } },
                otherField: ['currentField']
            }
        })
    ]))
    const repositoryRoot = repositoryFixture(t, files)
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of Object.keys(files))
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} schema negation escaped`)
    }
})

test('zero-legacy contentSchema traversal follows only 2019-09 and 2020-12 dialects', (t) =>
{
    const files = {
        'config/schemas/2019-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2019-09/schema',
            contentSchema: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/2020-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            contentSchema: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/2020-double-not-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            contentSchema: { not: { not: { properties: { latestReceipt: { type: 'string' } } } } }
        }),
        'config/schemas/draft-07-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            contentSchema: { not: { latestReceipt: 'ambient.json' } }
        })
    }
    const findings = scanZeroLegacyGovernance(repositoryFixture(t, files)).findings
    for (const file of [
        'config/schemas/2019-content-behavior-qualification.schema.json',
        'config/schemas/2020-content-behavior-qualification.schema.json'
    ])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} contentSchema negation escaped`)
    }
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/2020-double-not-content-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/draft-07-content-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
})

test('zero-legacy schema traversal switches dialect at each embedded schema resource', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/schemas/embedded-draft7-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $defs: {
                legacyResource: {
                    $id: 'legacy-resource',
                    $schema: 'http://json-schema.org/draft-07/schema#',
                    dependencies: {
                        currentField: { not: { properties: { latestReceipt: { type: 'string' } } } }
                    },
                    contentSchema: { not: { latestReceipt: 'ambient.json' } }
                }
            }
        }),
        'config/schemas/embedded-2020-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            definitions: {
                currentResource: {
                    $id: 'current-resource',
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    contentSchema: { not: { properties: { latestReceipt: { type: 'string' } } } },
                    dependencies: { currentField: { not: { latestReceipt: 'ambient.json' } } }
                }
            }
        })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/embedded-draft7-behavior-qualification.schema.json'
        && finding.location.includes('.dependencies.')), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/embedded-draft7-behavior-qualification.schema.json'
        && finding.location.endsWith('.contentSchema.not.latestReceipt')))
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/embedded-2020-behavior-qualification.schema.json'
        && finding.location.includes('.contentSchema.')), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/embedded-2020-behavior-qualification.schema.json'
        && finding.location.endsWith('.dependencies.currentField.not.latestReceipt')))
})

test('zero-legacy scanner self exemptions are exact and owner names cannot suppress values', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/docs/behavior-document-consistency-final.mjs': [
            "// export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'",
            "export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'",
            'const zeroLegacyScanSchema = "deprecated-claim-cli"',
            'const evidenceSelectionRuleParts = Object.freeze([["latest", "receipt"]])',
            'const authorityResidueRuleParts = Object.freeze([["checked", "in", "openapi"]])',
            'const rejectLegacyClaimCli = true'
        ].join('\n'),
        'tools/release/behavior-qualification.mjs': 'const rejectCommand = "deprecated-claim-cli"\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.equal(findings.some((finding) => finding.file === 'tools/docs/behavior-document-consistency-final.mjs'
        && finding.location === 'source:line:2'), false)
    assert.ok(findings.some((finding) => finding.location === 'source:line:3'
        && finding.rule.includes('zeroLegacyScanSchema')))
    assert.ok(findings.some((finding) => finding.rule === 'forbidden-evidence-selection:latestReceipt'
        && finding.location === 'source:line:4'))
    assert.ok(findings.some((finding) => finding.rule === 'forbidden-self-authority:checkedInOpenapi'
        && finding.location === 'source:line:5'))
    assert.ok(findings.some((finding) => finding.rule === 'forbidden-legacy-surface:rejectLegacyClaimCli'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
})

test('zero-legacy value scanning is bounded without truncating long commands', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/long-behavior-qualification.json': JSON.stringify({
            command: `${'x'.repeat(505)} deprecated-claim-cli ${'y'.repeat(600)}`,
            evidenceSelectionStrategy: `${'p'.repeat(500)} latest     receipt ${' padding'.repeat(90)}`,
            evidenceSource: `${'p'.repeat(500)} retry as correctness ${' padding'.repeat(90)}`,
            authorityCommand: `${'p'.repeat(500)} checked-in-openapi ${' padding'.repeat(90)}`
        }),
        'config/testing/long-benign-behavior-qualification.json': JSON.stringify({
            command: `${'x'.repeat(505)}current-claim-command${'y'.repeat(600)}`
        })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule.startsWith('forbidden-legacy-surface:')))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule === 'forbidden-evidence-selection:retryAsCorrectness'))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule === 'forbidden-self-authority:checkedInOpenapi'))
    assert.equal(findings.some((finding) => finding.file === 'config/testing/long-benign-behavior-qualification.json'), false)
})

test('zero-legacy malformed machine JSON fails closed through final aggregation', (t) =>
{
    const malformed = '{"latestReceipt":"ambient.json"} trailing-token\n'
    const scanRoot = repositoryFixture(t, {
        'config/testing/malformed-behavior-qualification.json': malformed,
        'config/testing/comment-only-behavior-qualification.jsonc': '{\n  // "latestReceipt": "stale.json"\n  "command": "current-claim-cli"\n}\n',
        'config/testing/active-behavior-qualification.jsonc': '{\n  /* current config */\n  "latestReceipt": "stale.json"\n}\n'
    })
    const scan = scanZeroLegacyGovernance(scanRoot)
    assert.ok(scan.findings.some((finding) => finding.file === 'config/testing/malformed-behavior-qualification.json'
        && finding.rule === 'invalid-machine-json'))
    assert.equal(scan.findings.some((finding) => finding.file === 'config/testing/comment-only-behavior-qualification.jsonc'), false)
    assert.ok(scan.findings.some((finding) => finding.file === 'config/testing/active-behavior-qualification.jsonc'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))

    const sourceRoot = sourceRepositoryFixture(t, {
        'config/testing/malformed-behavior-qualification.json': malformed
    })
    const report = buildFinalConsistencyReport(fixture({ sourceRoot }))
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy scan found')))
    assert.ok(report.zeroLegacyScan.findings.some((finding) => finding.rule === 'invalid-machine-json'))
})

test('final builder recomputes zero-legacy findings from the sealed source state', (t) =>
{
    const residueRoot = sourceRepositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify({ latestReceipt: 'ambient.json' })
    })
    const injected = buildFinalConsistencyReport(fixture({
        sourceRoot: residueRoot,
        zeroLegacyScan: emptyZeroLegacyScan()
    }))
    assert.equal(injected.status, 'failed')
    assert.ok(injected.zeroLegacyScan.findings.some((finding) => finding.rule === 'forbidden-evidence-selection:latestReceipt'))

    const driftRoot = sourceRepositoryFixture(t, { 'src/current.mjs': 'export const current = true\n' })
    const drifted = fixture({ sourceRoot: driftRoot })
    fs.writeFileSync(path.join(driftRoot, 'src/current.mjs'), 'export const current = false\n')
    assert.throws(() => buildFinalConsistencyReport(drifted), /source\/worktree identity mismatch before scan/u)

    const parentRoot = sourceRepositoryFixture(t, Object.fromEntries(
        ['config', 'docs', 'src', 'tests', 'tools'].map((directory) => [
            `nested/${directory}/current.txt`,
            'current\n'
        ])
    ))
    const nested = fixture({ sourceRoot: path.join(parentRoot, 'nested') })
    assert.throws(() => buildFinalConsistencyReport(nested), /source root must equal the git top-level/u)
})

test('zero-legacy scan and final report schema are deterministic and structurally closed', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/behavior-qualification.ts': 'const last_reviewed_commit = "a"\n',
        'config/schemas/behavior.schema.json': JSON.stringify({ type: 'object' }),
        'tools/noop.mjs': 'export const value = 1\n',
        'tests/noop.test.mjs': 'export const value = 1\n',
        'docs/history.md': '# History\nNo active contract.\n'
    })
    const first = scanZeroLegacyGovernance(repositoryRoot)
    const second = scanZeroLegacyGovernance(repositoryRoot)
    assert.deepEqual(first, second)
    assert.equal(validateZeroLegacyScan(first), first)
    assert.throws(() => validateZeroLegacyScan({ ...first, scanRoots: first.scanRoots.slice(1) }), /roots are incomplete/u)
    assert.throws(() => validateZeroLegacyScan({ ...first, pathClassCounts: { production: 1 } }), /classes are incomplete/u)

    const report = buildFinalConsistencyReport(fixture({ sourceRoot: sourceRepositoryFixture(t) }))
    const schema = JSON.parse(fs.readFileSync('config/schemas/behavior-document-consistency-final-report.schema.json', 'utf8'))
    assert.deepEqual(validateJsonSchema(report, schema), [])
    const openScan = structuredClone(report)
    openScan.zeroLegacyScan.unowned = true
    assert.match(validateJsonSchema(openScan, schema).join('\n'), /additional properties/u)
    const mismatchedRoot = structuredClone(report)
    mismatchedRoot.zeroLegacyScan.scanRoots[0].pathClass = 'production'
    assert.match(validateJsonSchema(mismatchedRoot, schema).join('\n'), /must be equal to constant/u)
})
