import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
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

function fixture(overrides = {})
{
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
        source: { commit, worktreeFingerprint: fingerprint },
        worktree: { root: '/repo' },
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
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`, staticClaimVerificationDigest: `sha256:${'c'.repeat(64)}`,
        behaviorIds: ['alpha-behavior'], requiredTestKinds: { 'alpha-behavior': ['positive'] },
        observedTestKinds: { 'alpha-behavior': ['positive'] }, mutationStatus: {},
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        candidateIdentity: { buildReceiptDigest: `sha256:${'d'.repeat(64)}`, runtimeEvidenceDigest: `sha256:${'e'.repeat(64)}`, browserContractDigest: `sha256:${'f'.repeat(64)}` },
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${catalogHash}`,
        behaviorIds: [], requiredRuntimeProducers: [], observedBehaviorResults: [], documentClaimDigests: {},
        missing: [], orphans: [], conflicts: [], releaseFinalSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: []
    })
    const owner = seal({ status: 'ok', bindings: [{ behaviorId: 'alpha-behavior', sourcePath: 'src/alpha.cs' }] })
    const fact = seal({ status: 'ok', extractorId: 'alpha-facts', behaviorIds: ['alpha-behavior'], sourceCommit: commit, worktreeFingerprint: fingerprint })
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
        catalog, migrationLedger, matrix, zeroLegacyScan: emptyZeroLegacyScan(),
        ...overrides
    }
}

test('final consistency report deterministically closes every behavior edge', () =>
{
    const report = buildFinalConsistencyReport(fixture())
    assert.equal(validateFinalReport(report).status, 'ok', report.failureReasons.join('; '))
    assert.equal(report.behaviorNodes[0].status, 'ok')
    assert.equal(report.dagAudit.stronglyConnectedComponents.length, 0)
})

test('stale identities, graph cycles and legacy residue fail without repairing producers', () =>
{
    const stalePost = fixture().postRuntimeReceipt
    stalePost.sourceIdentity.commit = 'd'.repeat(40)
    stalePost.contentDigest = seal(Object.fromEntries(Object.entries(stalePost).filter(([key]) => key !== 'contentDigest'))).contentDigest
    const input = fixture({
        postRuntimeReceipt: stalePost,
        matrix: { tiers: [{ id: 'a', executionDependsOn: ['b'] }, { id: 'b', executionDependsOn: ['a'] }] },
        zeroLegacyScan: {
            ...emptyZeroLegacyScan(),
            scannedFileCount: 1,
            pathClassCounts: { ...emptyZeroLegacyScan().pathClassCounts, config: 1 },
            findings: [{
                file: 'config/active.json',
                pathClasses: ['config'],
                rule: 'forbidden-machine-field:lastReviewedAt',
                location: '$.lastReviewedAt'
            }]
        }
    })
    const report = buildFinalConsistencyReport(input)
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('identity mismatch')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('SCC')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy')))
})

test('tampered input receipt is rejected before final aggregation', () =>
{
    const input = fixture()
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
        'tools/release/behavior-qualification.mjs': 'spawnSync("deprecated-claim-cli", ["--run"])\nselectReceipt("latest")\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file.endsWith('.cs') && finding.rule === 'forbidden-self-certification:verified'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs') && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs') && finding.rule === 'forbidden-evidence-selection:selectReceipt=latest'))
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

    const report = buildFinalConsistencyReport(fixture({ zeroLegacyScan: first }))
    const schema = JSON.parse(fs.readFileSync('config/schemas/behavior-document-consistency-final-report.schema.json', 'utf8'))
    assert.deepEqual(validateJsonSchema(report, schema), [])
    const openScan = structuredClone(report)
    openScan.zeroLegacyScan.unowned = true
    assert.match(validateJsonSchema(openScan, schema).join('\n'), /additional properties/u)
    const mismatchedRoot = structuredClone(report)
    mismatchedRoot.zeroLegacyScan.scanRoots[0].pathClass = 'production'
    assert.match(validateJsonSchema(mismatchedRoot, schema).join('\n'), /must be equal to constant/u)
})
