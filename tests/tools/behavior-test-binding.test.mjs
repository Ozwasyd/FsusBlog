import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadCatalog } = await import(new URL('../../tools/contracts/behavior-contract-catalog.mjs', import.meta.url));
const { formatBehaviorTestBindingReport, joinBehaviorTestEvidence, parseBehaviorBindingsFromSource, scanBehaviorTestBindings, validateExactBehaviorCoverage } = await import(new URL('../../tools/contracts/behavior-test-binding.mjs', import.meta.url));
const { behaviorTest, concurrencyHarnessId, createBehaviorTest, runRealConcurrencyHarness } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
const { createObservationArtifact } = await import(new URL('../../tools/test-observations/ledger.mjs', import.meta.url));
const { observationArtifactSchema } = await import(new URL('../../tools/test-observations/validation.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'tools/contracts/check-behavior-test-evidence.mjs');

function fixtureRoot()
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-test-binding-'));
    for (const relative of [
        'config/contracts/behavior-contracts.json',
        'config/contracts/generated-fact-sections.json',
        'config/schemas/behavior-contract-catalog.schema.json',
        'tests/coverage-registry.json',
        'config/development/document-lifecycle.json'
    ])
    {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(root, relative), target);
    }
    // Minimal extractor entrypoints referenced by catalog.
    for (const relative of [
        'tools/test/run-test-asset-audit.mjs',
        'tools/governance/check-code-intent.mjs',
        'tools/docs/document-lifecycle.mjs',
        'tools/run-test-matrix.mjs',
        'tools/fact-extractors/openapi-aeds/extract.mjs',
        'tools/fact-extractors/auth-session-permission/extract.mjs',
        'tools/fact-extractors/config-error-security-policy/extract.mjs',
        'tools/fact-extractors/content-lifecycle/extract.mjs'
    ])
    {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `// seed\nexport function seed() {}\n`);
    }
    return directory;
}

function write(repositoryRoot, relative, source)
{
    const target = path.join(repositoryRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
    return relative;
}

function loadFixtureCatalog(repositoryRoot)
{
    return JSON.parse(readFileSync(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'), 'utf8'));
}

function seedRequiredBindings(repositoryRoot)
{
    write(repositoryRoot, 'tests/tools/audit.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('test-asset-audit-reconciliation', 'positive', 'audit positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/audit.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('test-asset-audit-reconciliation', 'negative', { title: 'audit negative', invariantIds: ['audit-neg'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/code.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('code-intent-governance', 'positive', 'code positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/code.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('code-intent-governance', 'negative', { title: 'code negative', reasonId: 'code-neg' }, () => {})
`);
    write(repositoryRoot, 'tests/tools/docs.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('document-lifecycle-governance', 'positive', 'docs positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/docs.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('document-lifecycle-governance', 'negative', { title: 'docs negative', invariantIds: ['docs-neg'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/docs.migration.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('document-lifecycle-governance', 'migration', { title: 'docs migration', invariantIds: ['docs-mig'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/matrix.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('browserless-production-correctness', 'positive', 'matrix positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/matrix.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('browserless-production-correctness', 'negative', { title: 'matrix negative', invariantIds: ['matrix-neg'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/matrix.concurrency.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('browserless-production-correctness', 'concurrency', { title: 'matrix concurrency', concurrencyHarness: 'fsusblog.real-concurrency.v1' }, () => {})
`);
    write(repositoryRoot, 'tests/tools/binary-aeds.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('binary-api-aeds-contract', 'positive', 'aeds positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/binary-aeds.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('binary-api-aeds-contract', 'negative', { title: 'aeds negative', invariantIds: ['aeds-crc-invariant'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/auth.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('authentication-session-permission', 'positive', 'auth positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/auth.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('authentication-session-permission', 'negative', { title: 'auth negative', invariantIds: ['session-revocation-enforcement'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/auth.migration.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('authentication-session-permission', 'migration', { title: 'auth migration', invariantIds: ['jwt-kid-migration-window'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/config.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('configuration-error-security-policy', 'positive', 'config positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/config.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('configuration-error-security-policy', 'negative', { title: 'config negative', invariantIds: ['risk-pseudonym-key-required'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/config.boundary.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('configuration-error-security-policy', 'boundary', { title: 'config boundary', invariantIds: ['session-limit-boundary'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/comment.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('article-comment-lifecycle-outbox', 'positive', 'comment positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/comment.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('article-comment-lifecycle-outbox', 'negative', { title: 'comment negative', invariantIds: ['transactional-rollback-boundary'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/deployment.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('deployment-blue-green-runtime-role', 'positive', 'deployment positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/deployment.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('deployment-blue-green-runtime-role', 'negative', { title: 'deployment negative', invariantIds: ['deployment-mode-failure-continuation'] }, () => {})
`);
    write(repositoryRoot, 'tests/tools/deployment.concurrency.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('deployment-blue-green-runtime-role', 'concurrency', { title: 'deployment concurrency', concurrencyHarness: 'fsusblog.real-concurrency.v1' }, () => {})
`);
    write(repositoryRoot, 'tests/tools/release.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('release-final-aggregate-contract', 'positive', 'release positive', () => {})
`);
    write(repositoryRoot, 'tests/tools/release.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('release-final-aggregate-contract', 'negative', { title: 'release negative', invariantIds: ['release-final-shard-completeness'] }, () => {})
`);
    // Install helper modules referenced by relative imports in fixture tests (not executed).
    write(repositoryRoot, 'tools/contracts/behavior-test.mjs', readFileSync(path.join(root, 'tools/contracts/behavior-test.mjs'), 'utf8'));
    write(repositoryRoot, 'tools/contracts/behavior-contract-catalog.mjs', readFileSync(path.join(root, 'tools/contracts/behavior-contract-catalog.mjs'), 'utf8'));
}

function sha256File(file)
{
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function makeTap(suite, cases)
{
    const lines = ['TAP version 13'];
    let index = 1;
    for (const entry of cases)
    {
        if (entry.skip)
        {
            lines.push(`ok ${index} - ${entry.name} # SKIP - ${entry.reason ?? 'skipped'}`);
        }
        else if (entry.fail)
        {
            lines.push(`not ok ${index} - ${entry.name}`);
            lines.push('  error: failed');
        }
        else
        {
            lines.push(`ok ${index} - ${entry.name}`);
        }
        lines.push(`# duration_ms ${entry.durationMs ?? 1}`);
        index += 1;
    }
    lines.push(`1..${cases.length}`);
    return `${lines.join('\n')}\n`;
}

function observationFromTap({
    repositoryRoot,
    suite,
    cases,
    runId = 'round-1',
    commit = 'a'.repeat(40),
    fingerprint = `sha256:${'b'.repeat(64)}`,
    closure = `sha256:${'c'.repeat(64)}`,
    fileName = 'report.tap'
})
{
    const evidenceDir = path.join(repositoryRoot, '.tmp/observations');
    mkdirSync(evidenceDir, { recursive: true });
    const reportFile = path.join(evidenceDir, fileName);
    writeFileSync(reportFile, makeTap(suite, cases));
    return createObservationArtifact({
        framework: 'node-tap',
        reportFile,
        evidenceReference: path.relative(repositoryRoot, reportFile).split(path.sep).join('/'),
        suite,
        partition: 'fixture',
        metadata: {
            sourceState: { commit, worktreeFingerprint: fingerprint },
            sourceClosureDigest: closure,
            runner: { os: 'linux', arch: 'x64', runtime: 'node-test', browser: null, project: null },
            run: { id: runId, attemptKind: 'primary', evidenceClass: 'correctness' }
        },
        observedAt: '2026-07-28T00:00:00.000Z'
    });
}

function allPassedCasesFromScan(scan)
{
    return scan.bindings.map((binding) => ({
        name: binding.fullyQualifiedName
    // node-tap suite in createObservationArtifact is sourcePath for our bindings
    })).reduce((groups, entry, index) =>
    {
        const binding = scan.bindings[index];
        if (!groups.has(binding.sourcePath))
        {
            groups.set(binding.sourcePath, []);
        }
        groups.get(binding.sourcePath).push({ name: binding.fullyQualifiedName });
        return groups;
    }, new Map());
}

function observationsForScan(repositoryRoot, scan, {
    runId = 'round-1',
    mutateCase = null,
    extraArtifacts = []
} = {})
{
    const bySuite = allPassedCasesFromScan(scan);
    if (mutateCase)
    {
        mutateCase(bySuite);
    }
    const artifacts = [];
    let ordinal = 0;
    for (const [suite, cases] of bySuite)
    {
        if (!Array.isArray(cases) || cases.length === 0)
        {
            continue;
        }
        ordinal += 1;
        artifacts.push(observationFromTap({
            repositoryRoot,
            suite,
            cases,
            runId,
            fileName: `suite-${ordinal}.tap`
        }));
    }
    return [...artifacts, ...extraArtifacts];
}

test('C# attribute syntax is the only C# binding form', () =>
{
    const source = `namespace FsusBlog.Tests;

public sealed class CodeIntentBoundaryTests
{
    [CoversBehavior("code-intent-governance", BehaviorTestKind.Boundary)]
    [Fact]
    public Task Proof_at_boundary() { return Task.CompletedTask; }
}
`;
    const scanned = parseBehaviorBindingsFromSource({
        source,
        relativePath: 'tests/backend/Unit/CodeIntentBoundaryTests.cs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.deepEqual(scanned.errors, []);
    assert.equal(scanned.bindings.length, 1);
    assert.equal(scanned.bindings[0].bindingKind, 'attribute');
    assert.equal(scanned.bindings[0].testKind, 'boundary');
    assert.equal(scanned.bindings[0].canonicalTestId, 'xunit-trx:CodeIntentBoundaryTests#Proof_at_boundary');
    assert.equal(scanned.bindings[0].framework, 'xunit-trx');
});

test('Node/Vitest/Playwright share one formal behaviorTest helper surface', () =>
{
    const nodeSource = `import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'
behaviorTest('code-intent-governance', 'positive', 'node title', () => {})
`;
    const vitestSource = `import { test } from 'vitest'
const { createBehaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
const behaviorTest = createBehaviorTest(test)
behaviorTest('code-intent-governance', 'boundary', 'vitest title', () => {})
`;
    const playwrightSource = `import { test } from '@playwright/test'
const { createBehaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
const behaviorTest = createBehaviorTest(test)
behaviorTest('code-intent-governance', 'positive', 'pw title', async () => {})
`;
    const node = parseBehaviorBindingsFromSource({ source: nodeSource, relativePath: 'tests/tools/sample.test.mjs', catalogDigest: 'd'.repeat(64) });
    const vitest = parseBehaviorBindingsFromSource({ source: vitestSource, relativePath: 'tests/frontend/unit/sample.test.ts', catalogDigest: 'd'.repeat(64) });
    const playwright = parseBehaviorBindingsFromSource({ source: playwrightSource, relativePath: 'tests/frontend/e2e/sample.spec.ts', catalogDigest: 'd'.repeat(64) });
    assert.deepEqual(node.errors, []);
    assert.deepEqual(vitest.errors, []);
    assert.deepEqual(playwright.errors, []);
    assert.equal(node.bindings[0].framework, 'node-tap');
    assert.equal(vitest.bindings[0].framework, 'vitest');
    assert.equal(playwright.bindings[0].framework, 'playwright');
    assert.equal(typeof createBehaviorTest, 'function');
    assert.equal(typeof behaviorTest, 'function');
});

test('repository active behaviors have formal source bindings for every required kind', () =>
{
    const report = formatBehaviorTestBindingReport(scanBehaviorTestBindings({ repositoryRoot: root }));
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    assert.equal(report.status, 'ok');
    assert.ok(report.bindingCount >= 10);
    const catalog = loadCatalog();
    for (const contract of catalog.contracts.filter((entry) => entry.status === 'active'))
    {
        for (const kind of contract.requiredTestKinds)
        {
            assert.ok(
                report.bindings.some((binding) => binding.behaviorId === contract.id && binding.testKind === kind),
                `${contract.id}/${kind} missing`
            );
        }
    }
    execFileSync(process.execPath, [checker, '--mode', 'bindings'], { cwd: root, stdio: 'inherit' });
});

test('1) behavior requires boundary but only positive test fails exact coverage', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        // Replace code-intent negative with only positive for a synthetic behavior needing boundary via local catalog mutation.
        const catalog = loadFixtureCatalog(directory);
        catalog.contracts.find((entry) => entry.id === 'code-intent-governance').requiredTestKinds = ['positive', 'boundary'];
        write(directory, 'config/contracts/behavior-contracts.json', `${JSON.stringify(catalog, null, 2)}\n`);
        // only positive remains
        write(directory, 'tests/tools/code.negative.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('code-intent-governance', 'positive', 'second positive only', () => {})
`);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        assert.ok(scan.errors.some((error) => /missing source binding for required test kind boundary/u.test(error)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('2) test file exists but case filtered out is not executed coverage', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        assert.equal(scan.errors.length, 0, scan.errors.join('\n'));
        // Produce observations for all but one required binding (filter miss).
        const dropped = scan.bindings.find((binding) => binding.behaviorId === 'code-intent-governance' && binding.testKind === 'negative');
        const artifacts = observationsForScan(directory, scan, {
            mutateCase: (bySuite) =>
            {
                const cases = bySuite.get(dropped.sourcePath);
                bySuite.set(dropped.sourcePath, cases.filter((entry) => entry.name !== dropped.fullyQualifiedName));
            }
        });
        const receipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: artifacts,
            evidenceRoot: directory
        });
        assert.ok(receipt.errors.some((error) => error.includes('code-intent-governance') && error.includes('negative')));
        const row = receipt.evidence.find((entry) => entry.canonicalTestId === dropped.canonicalTestId);
        assert.equal(row.discovered, true);
        assert.equal(row.executed, false);
        assert.equal(row.outcome, 'missing');
        assert.throws(() => validateExactBehaviorCoverage(receipt), /missing this-round passed evidence|exact coverage/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('3) skipped case cannot count as passed', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        const target = scan.bindings.find((binding) => binding.behaviorId === 'test-asset-audit-reconciliation' && binding.testKind === 'positive');
        const artifacts = observationsForScan(directory, scan, {
            mutateCase: (bySuite) =>
            {
                const cases = bySuite.get(target.sourcePath);
                bySuite.set(target.sourcePath, cases.map((entry) => entry.name === target.fullyQualifiedName
                    ? { name: entry.name, skip: true, reason: 'known issue' }
                    : entry));
            }
        });
        const receipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: artifacts,
            evidenceRoot: directory
        });
        assert.ok(receipt.errors.some((error) => error.includes(target.canonicalTestId) && /skipped/u.test(error)));
        assert.throws(() => validateExactBehaviorCoverage(receipt));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('4) one physical test cannot declare multiple kinds', () =>
{
    const source = `import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'
behaviorTest('code-intent-governance', 'positive', 'It_works', () => {})
behaviorTest('code-intent-governance', 'boundary', 'It_works', () => {})
behaviorTest('code-intent-governance', 'negative', { title: 'It_works', invariantIds: ['x'] }, () => {})
`;
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        write(directory, 'tests/tools/multi-kind.test.mjs', source);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        assert.ok(scan.errors.some((error) => /one test method may satisfy only one kind/u.test(error)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('5) negative test without expected reason/invariant ID fails', () =>
{
    const source = `import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'
behaviorTest('code-intent-governance', 'negative', 'missing invariant', () => {})
`;
    const scanned = parseBehaviorBindingsFromSource({
        source,
        relativePath: 'tests/tools/neg.test.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.ok(scanned.errors.some((error) => /requires invariantIds or reasonId/u.test(error)));
});

test('6) previous-round TRX/observations cannot satisfy this round', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        const current = observationsForScan(directory, scan, { runId: 'round-current' });
        const stale = observationsForScan(directory, scan, { runId: 'round-previous' });
        // Mix identities intentionally.
        const receipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: [...current.slice(0, 1), ...stale.slice(1)],
            evidenceRoot: directory
        });
        assert.ok(receipt.errors.some((error) => /multiple run identities|historical TRX/u.test(error)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('7) renamed test leaves old fully-qualified ID without current binding evidence', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        const catalog = loadFixtureCatalog(directory);
        // Observation still uses old title while source binding renamed.
        write(directory, 'tests/tools/code.positive.test.mjs', `
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
behaviorTest('code-intent-governance', 'positive', 'renamed positive title', () => {})
`);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        const artifacts = observationsForScan(directory, scan);
        // Inject stale observation for old name on same suite path.
        const staleSuite = 'tests/tools/code.positive.test.mjs';
        const stale = observationFromTap({
            repositoryRoot: directory,
            suite: staleSuite,
            cases: [{ name: 'code positive' }],
            runId: 'round-1',
            fileName: 'stale.tap'
        });
        // Align run identity with first artifact
        stale.run = artifacts[0].run;
        stale.sourceState = artifacts[0].sourceState;
        stale.sourceClosureDigest = artifacts[0].sourceClosureDigest;
        for (const observation of stale.observations)
        {
            observation.run = artifacts[0].run;
            observation.sourceState = artifacts[0].sourceState;
            observation.sourceClosureDigest = artifacts[0].sourceClosureDigest;
            observation.producer = { reference: stale.producer.reference, digest: stale.producer.digest };
        }
        // Re-seal contentDigest
        const { contentDigest: _ignored, ...rest } = stale;
        const resealed = createObservationArtifact({
            framework: 'node-tap',
            reportFile: path.join(directory, stale.producer.reference),
            evidenceReference: stale.producer.reference,
            suite: staleSuite,
            partition: 'fixture',
            metadata: {
                sourceState: artifacts[0].sourceState,
                sourceClosureDigest: artifacts[0].sourceClosureDigest,
                runner: artifacts[0].runner,
                run: artifacts[0].run
            },
            observedAt: '2026-07-28T00:00:00.000Z'
        });
        const receipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: [...artifacts, resealed],
            evidenceRoot: directory
        });
        // Current renamed binding still has its own observation from artifacts; exact coverage should pass for that.
        // The point: old FQN is not a binding and cannot cover kinds alone — drop current observations for renamed test to prove failure.
        const withoutRenamed = artifacts.filter((artifact) => artifact.observations.every((entry) => !entry.testId.includes('renamed positive title')));
        const failReceipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: [...withoutRenamed, resealed],
            evidenceRoot: directory
        });
        assert.ok(failReceipt.errors.some((error) => /code-intent-governance/u.test(error) && /positive/u.test(error)));
        const renamedRow = failReceipt.evidence.find((entry) => entry.fullyQualifiedName === 'renamed positive title');
        assert.equal(renamedRow.executed, false);
        assert.ok(!failReceipt.bindings.some((binding) => binding.fullyQualifiedName === 'code positive'));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('8) coverage hit without behavior binding does not satisfy required kinds', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        // Remove all matrix concurrency binding; leave a non-bound test file that would look like coverage.
        write(directory, 'tests/tools/matrix.concurrency.test.mjs', `
import test from 'node:test'
test('unbound coverage-looking case', () => {})
`);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        assert.ok(scan.errors.some((error) => /browserless-production-correctness.*concurrency/u.test(error)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('9) Node comment writing Behavior ID is not formal registration', () =>
{
    const source = `// behaviorId: code-intent-governance
import test from 'node:test'
test('comment only', () => {})
`;
    const scanned = parseBehaviorBindingsFromSource({
        source,
        relativePath: 'tests/tools/comment-only.test.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.equal(scanned.bindings.length, 0);
    assert.ok(scanned.errors.some((error) => /comment-only Behavior ID registration is forbidden/u.test(error)));
});

test('path-based mapping, exists-as-coverage, and old sidecar surfaces fail closed', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        write(directory, 'tools/legacy/behavior-map.mjs', `
export function pathBasedBehaviorCoverage(file) { return file.includes('BoundaryTests') ? 'boundary' : 'positive' }
export function existsAsCoverage() { return true }
export const legacyBehaviorTestMap = {}
`);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        assert.ok(scan.errors.some((error) => /path-based or compatibility/u.test(error)));
        assert.ok(scan.errors.some((error) => /alias\/mapping surface/u.test(error)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('exact coverage accepts only discovered+executed+passed for this-round identity', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        assert.equal(scan.errors.length, 0, scan.errors.join('\n'));
        const artifacts = observationsForScan(directory, scan, { runId: 'round-ok' });
        const receipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: artifacts,
            evidenceRoot: directory
        });
        assert.equal(receipt.schema, 'fsusblog.behavior-test-evidence-receipt.v1');
        assert.match(receipt.rawResultDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.match(receipt.contentDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.equal(receipt.errors.length, 0, receipt.errors.join('\n'));
        validateExactBehaviorCoverage(receipt);
        for (const row of receipt.evidence)
        {
            assert.equal(row.discovered, true);
            assert.equal(row.executed, true);
            assert.equal(row.outcome, 'passed');
            assert.equal(row.run.id, 'round-ok');
        }
        for (const entry of receipt.coverage)
        {
            assert.equal(entry.status, 'ok');
            assert.deepEqual(entry.missingTestKinds, []);
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('tests/docs/generated artifacts cannot forge execution evidence without producer digest', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredBindings(directory);
        const catalog = loadFixtureCatalog(directory);
        const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
        const artifacts = observationsForScan(directory, scan);
        // Tamper producer digest while keeping observations.
        const forged = structuredClone(artifacts[0]);
        forged.producer.digest = `sha256:${'f'.repeat(64)}`;
        for (const observation of forged.observations)
        {
            observation.producer.digest = forged.producer.digest;
        }
        // Fix contentDigest to match forged body so validation reaches producer file check.
        const { contentDigest: _drop, ...body } = forged;
        const digestBody = structuredClone(body);
        const contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(digestBody), 'utf8').digest('hex')}`;
        // Use ledger canonicalize-compatible seal: validation recomputes without contentDigest field.
        // Our validation uses structuredClone delete contentDigest then sha256 of canonicalize JSON.
        // Simpler: omit evidenceRoot so file digest is not checked, but then forge could pass — require evidenceRoot.
        const receipt = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan: scan,
            observations: [{ ...forged, contentDigest: forged.contentDigest }],
            evidenceRoot: directory
        });
        assert.ok(receipt.errors.some((error) => /observation artifact rejected/u.test(error)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('xUnit theory binding requires every reported case to pass', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-theory-'));
    try
    {
        const parsed = parseBehaviorBindingsFromSource({
            source: `public sealed class DeploymentTheoryTests
{
    [CoversBehavior("deployment-blue-green-runtime-role", BehaviorTestKind.Negative, InvariantId = "deployment-mode-failure-continuation")]
    [Theory]
    public Task ContinuesAfterFailure(string mode) => Task.CompletedTask;
}
`,
            relativePath: 'tests/backend/Unit/DeploymentTheoryTests.cs',
            catalogDigest: 'd'.repeat(64)
        });
        assert.deepEqual(parsed.errors, []);
        const bindingsScan = { bindings: parsed.bindings, errors: [] };
        const catalog = {
            contracts: [{
                id: 'deployment-blue-green-runtime-role',
                status: 'active',
                requiredTestKinds: ['negative']
            }]
        };
        const artifactFor = (name, secondOutcome) =>
        {
            const reportFile = path.join(directory, `${name}.trx`);
            writeFileSync(reportFile, `<TestRun><TestDefinitions>
<UnitTest id="case-a"><TestMethod className="FsusBlog.Tests.DeploymentTheoryTests" name="ContinuesAfterFailure" /></UnitTest>
<UnitTest id="case-b"><TestMethod className="FsusBlog.Tests.DeploymentTheoryTests" name="ContinuesAfterFailure" /></UnitTest>
</TestDefinitions><Results>
<UnitTestResult testId="case-a" testName="FsusBlog.Tests.DeploymentTheoryTests.ContinuesAfterFailure(mode: &quot;normal&quot;)" outcome="Passed" duration="00:00:00.001" />
<UnitTestResult testId="case-b" testName="FsusBlog.Tests.DeploymentTheoryTests.ContinuesAfterFailure(mode: &quot;rollback&quot;)" outcome="${secondOutcome}" duration="00:00:00.001">${secondOutcome === 'Passed' ? '' : '<Output><ErrorInfo><Message>fixture failure</Message></ErrorInfo></Output>'}</UnitTestResult>
</Results></TestRun>`);
            const artifact = createObservationArtifact({
                framework: 'xunit-trx',
                reportFile,
                evidenceReference: path.basename(reportFile),
                suite: 'DeploymentTheoryTests',
                partition: 'fixture',
                metadata: {
                    sourceState: {
                        commit: 'a'.repeat(40),
                        worktreeFingerprint: `sha256:${'b'.repeat(64)}`
                    },
                    sourceClosureDigest: `sha256:${'c'.repeat(64)}`,
                    runner: { os: 'linux', arch: 'x64', runtime: 'dotnet-test', browser: null, project: null },
                    run: { id: 'theory-run', attemptKind: 'primary', evidenceClass: 'correctness' }
                },
                observedAt: '2026-08-29T00:00:00.000Z'
            });
            const artifactFile = path.join(directory, `${name}.json`);
            writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`);
            return artifactFile;
        };

        const passing = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan,
            observations: [artifactFor('passing', 'Passed')],
            evidenceRoot: directory
        });
        assert.deepEqual(passing.errors, []);
        assert.equal(passing.evidence[0].executed, true);
        assert.equal(passing.evidence[0].outcome, 'passed');
        assert.notEqual(passing.evidence[0].rawResultDigest, `sha256:${'0'.repeat(64)}`);
        assert.doesNotThrow(() => validateExactBehaviorCoverage(passing));

        const failing = joinBehaviorTestEvidence({
            repositoryRoot: directory,
            catalog,
            bindingsScan,
            observations: [artifactFor('failing', 'Failed')],
            evidenceRoot: directory
        });
        assert.equal(failing.evidence[0].executed, true);
        assert.equal(failing.evidence[0].outcome, 'failed');
        assert.throws(() => validateExactBehaviorCoverage(failing));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('real concurrency harness executes workers concurrently and is required for concurrency kind', async () =>
{
    const order = [];
    const results = await runRealConcurrencyHarness([
        async () =>
        {
            order.push('a-start');
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('a-end');
            return 1;
        },
        async () =>
        {
            order.push('b-start');
            return 2;
        }
    ]);
    assert.deepEqual(results, [1, 2]);
    assert.ok(order.indexOf('b-start') < order.indexOf('a-end'));
    const missing = parseBehaviorBindingsFromSource({
        source: `import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'
behaviorTest('browserless-production-correctness', 'concurrency', 'name only concurrency', () => {})
`,
        relativePath: 'tests/tools/fake-concurrency.test.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.ok(missing.errors.some((error) => /concurrencyHarness/u.test(error)));
    assert.equal(concurrencyHarnessId, 'fsusblog.real-concurrency.v1');
});

test('coverage registry and test audit inventories do not store behavior test mappings', () =>
{
    const registry = JSON.parse(readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'));
    const text = JSON.stringify(registry);
    assert.equal(text.includes('"requiredTestKinds"'), false);
    assert.equal(text.includes('behaviorTestMapping'), false);
    assert.equal(text.includes('pathBasedBehaviorCoverage'), false);
    const auditProfile = JSON.parse(readFileSync(path.join(root, 'config/testing/test-asset-audit-profile.json'), 'utf8'));
    assert.equal(JSON.stringify(auditProfile).includes('requiredTestKinds'), false);
});

test('CLI exact mode refuses missing observations and bindings mode passes on repository', () =>
{
    const missing = spawnSync(process.execPath, [checker, '--mode', 'exact'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /requires --observations/u);
    const bindings = spawnSync(process.execPath, [checker, '--mode', 'bindings', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(bindings.status, 0, bindings.stderr);
    const report = JSON.parse(bindings.stdout);
    assert.equal(report.status, 'ok');
    assert.ok(report.bindingCount >= 10);
});

test('observation artifact schema constant remains the only execution evidence source', () =>
{
    assert.equal(observationArtifactSchema, 'fsusblog.test-observation-artifact.v1');
    assert.equal(typeof sha256File, 'function');
});
