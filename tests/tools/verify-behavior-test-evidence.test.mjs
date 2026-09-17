import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const { root } = await import(new URL('../../tools/contracts/behavior-contract-catalog.mjs', import.meta.url));
const { scanBehaviorTestBindings } = await import(new URL('../../tools/contracts/behavior-test-binding.mjs', import.meta.url));
const { produceBehaviorTestEvidence } = await import(new URL('../../tools/test-matrix/produce-behavior-test-evidence.mjs', import.meta.url));
const { verifyBehaviorTestEvidence, verifyBehaviorTestEvidenceCommand } = await import(new URL('../../tools/test-matrix/verify-behavior-test-evidence.mjs', import.meta.url));
const { createObservationArtifact } = await import(new URL('../../tools/test-observations/ledger.mjs', import.meta.url));
const verifierCli = path.join(root, 'tools/test-matrix/verify-behavior-test-evidence.mjs');

function tempDir()
{
    return mkdtempSync(path.join(os.tmpdir(), 'fsusblog-verify-bte-'));
}

function fixtureRoot()
{
    const directory = tempDir();
    for (const relative of [
        'config/contracts/behavior-contracts.json',
        'config/contracts/generated-fact-sections.json',
        'config/schemas/behavior-contract-catalog.schema.json',
        'config/schemas/behavior-test-evidence.schema.json',
        'tests/coverage-registry.json',
        'config/development/document-lifecycle.json'
    ])
    {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(root, relative), target);
    }
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
        writeFileSync(target, '// seed\nexport function seed() {}\n');
    }
    for (const [relative, source] of [
        ['tools/contracts/behavior-test.mjs', path.join(root, 'tools/contracts/behavior-test.mjs')],
        ['tools/contracts/behavior-contract-catalog.mjs', path.join(root, 'tools/contracts/behavior-contract-catalog.mjs')]
    ])
    {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(source, target);
    }
    return directory;
}

function makeTap(suite, cases)
{
    const lines = ['TAP version 13'];
    let index = 1;
    for (const entry of cases)
    {
        lines.push(`ok ${index} - ${entry.name}`);
        lines.push(`# duration_ms ${entry.durationMs ?? 1}`);
        index += 1;
    }
    lines.push(`1..${cases.length}`);
    return `${lines.join('\n')}\n`;
}

function seedAllRequiredBindings(repositoryRoot, catalog)
{
    let index = 0;
    for (const contract of catalog.contracts)
    {
        if (contract.status !== 'active')
        {
            continue;
        }
        for (const kind of contract.requiredTestKinds)
        {
            const args = kind === 'negative' || kind === 'migration'
                ? `{ title: 'seed ${index}', invariantIds: ['seed-${index}-inv'] }`
                : kind === 'concurrency'
          ? `{ title: 'seed ${index}', concurrencyHarness: 'fsusblog.real-concurrency.v1' }`
          : `'seed ${index}'`;
            const file = path.join(repositoryRoot, `tests/tools/seed-${index}.test.mjs`);
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'\nbehaviorTest('${contract.id}', '${kind}', ${args}, () => {})\n`);
            index += 1;
        }
    }
}

function observationsFromScan(repositoryRoot, scan, {
    runId = 'round-1',
    commit = 'a'.repeat(40),
    fingerprint = `sha256:${'b'.repeat(64)}`,
    closure = `sha256:${'c'.repeat(64)}`
} = {})
{
    const bySuite = new Map();
    for (const binding of scan.bindings)
    {
        if (!bySuite.has(binding.sourcePath))
        {
            bySuite.set(binding.sourcePath, []);
        }
        bySuite.get(binding.sourcePath).push({ name: binding.fullyQualifiedName });
    }
    const artifacts = [];
    let ordinal = 0;
    for (const [suite, cases] of bySuite)
    {
        ordinal += 1;
        const evidenceDir = path.join(repositoryRoot, '.tmp/observations');
        mkdirSync(evidenceDir, { recursive: true });
        const fileName = `suite-${ordinal}.tap`;
        const reportFile = path.join(evidenceDir, fileName);
        writeFileSync(reportFile, makeTap(suite, cases));
        artifacts.push(createObservationArtifact({
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
        }));
    }
    return artifacts;
}

function writeArtifact(repositoryRoot, artifact, name = 'artifact.json')
{
    const p = path.join(repositoryRoot, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(artifact, null, 2));
    return p;
}

function writePlan(repositoryRoot, scan, { commit = 'a'.repeat(40), tiers = null } = {})
{
    const files = [...new Set(scan.bindings.map((binding) => binding.sourcePath))].sort();
    const plan = {
        schema: 'fsusblog.release-evidence.test-plan.v1',
        generatedAt: '2026-07-28T00:00:00.000Z',
        commit,
        namespace: null,
        tiers: tiers ?? [{ id: 'fixture-tier', evidence: files }]
    };
    const planPath = path.join(repositoryRoot, 'test-plan.json');
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    return planPath;
}

function sealedFixture(directory, { runId = 'round-1' } = {})
{
    const catalog = JSON.parse(readFileSync(path.join(directory, 'config/contracts/behavior-contracts.json'), 'utf8'));
    seedAllRequiredBindings(directory, catalog);
    const scan = scanBehaviorTestBindings({ repositoryRoot: directory, catalog });
    assert.equal(scan.errors.length, 0, scan.errors.join('\n'));
    const artifacts = observationsFromScan(directory, scan, { runId });
    const paths = artifacts.map((artifact, index) => writeArtifact(directory, artifact, `artifact-${index}.json`));
    const planPath = writePlan(directory, scan);
    const { receipt, errors } = produceBehaviorTestEvidence({
        repositoryRoot: directory,
        observations: paths,
        plan: planPath,
        evidenceRoot: directory,
        expectedSourceCommit: 'a'.repeat(40),
        expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        expectedClosureDigest: `sha256:${'c'.repeat(64)}`
    });
    assert.deepEqual(errors, [], errors.join('\n'));
    const receiptPath = path.join(directory, 'receipt.json');
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return { catalog, scan, artifacts, paths, receipt, receiptPath, planPath };
}

// =============================================================================
// Tests
// =============================================================================

test('verifier accepts a sealed receipt that matches this-round observations', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, planPath } = sealedFixture(directory);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory,
            expectedSourceCommit: 'a'.repeat(40),
            expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`,
            expectedClosureDigest: `sha256:${'c'.repeat(64)}`
        });
        assert.deepEqual(errors, [], errors.join('\n'));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects tampered receipt content', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, receipt, planPath } = sealedFixture(directory);
        receipt.evidence[0].outcome = 'failed';
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('contentDigest mismatch')), 'tamper must break content digest');
        assert.ok(errors.some((e) => e.includes('independent re-join')), 'tamper must break re-join');
        assert.ok(errors.some((e) => e.includes('not discovered+executed+passed')), 'failed outcome must be rejected');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects tampered raw result artifacts', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, receipt, planPath } = sealedFixture(directory);
        const artifactPath = paths[0];
        const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
        artifact.producer.digest = `sha256:${'d'.repeat(64)}`;
        writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('content digest mismatch')), 'artifact digest tamper must fail');
        assert.ok(errors.some((e) => e.includes('rawResultDigest')), 'raw result digest drift must fail');
        void receipt;
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects cross-run observation substitution', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, scan, planPath } = sealedFixture(directory, { runId: 'round-current' });
        const staleArtifacts = observationsFromScan(directory, scan, { runId: 'round-previous' });
        const stalePaths = staleArtifacts.map((artifact, index) => writeArtifact(directory, artifact, `stale-${index}.json`));
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: stalePaths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('run identity')), 'cross-run evidence must fail closed');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects missing required evidence and prints canonical producer command', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { scan, planPath } = sealedFixture(directory);
        const incomplete = observationsFromScan(directory, scan);
        // Drop the first suite's observations (its sourcePath is the first binding source).
        const firstSource = scan.bindings[0].sourcePath;
        const remaining = incomplete.filter((artifact) => artifact.observations[0].suite !== firstSource);
        const paths = remaining.map((artifact, index) => writeArtifact(directory, artifact, `partial-${index}.json`));
        const { receipt, errors } = produceBehaviorTestEvidence({
            repositoryRoot: directory,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory,
            expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
        });
        assert.ok(errors.length > 0, 'missing required test must fail the producer');
        const receiptPath = path.join(directory, 'missing-receipt.json');
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const result = spawnSync(process.execPath, [
            verifierCli,
            ...paths.flatMap((item) => ['--observations', item]),
            '--plan', planPath,
            '--receipt', receiptPath,
            '--evidence-root', directory,
            '--repository-root', directory
        ], { encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr);
        assert.ok(result.stderr.includes('canonical producer command: node tools/test-matrix/produce-behavior-test-evidence.mjs'),
            'verifier must report the canonical producer command for missing evidence');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects a second receipt producer', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, receipt, planPath } = sealedFixture(directory);
        receipt.producer.command = 'node tools/test-matrix/second-producer.mjs';
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('not the canonical producer')), 'second producer must fail closed');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects default success fields anywhere in the receipt', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, receipt, planPath } = sealedFixture(directory);
        receipt.defaultPass = true;
        receipt.evidence[0].warnings = [];
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('forbidden join field')), 'default success field must fail closed');
        assert.ok(errors.some((e) => e.includes('receipt schema:')), 'schema must also reject unknown fields');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects historical TRX paths and never reads default-branch results', () =>
{
    const directory = fixtureRoot();
    try
    {
        const trx = path.join(directory, 'TestResults', 'latest', 'run.trx');
        mkdirSync(path.dirname(trx), { recursive: true });
        writeFileSync(trx, '<ResultSummary outcome="Passed" />');
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: path.join(directory, 'receipt.json'),
            observations: [trx],
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('historical raw result path')), 'TRX path must fail closed');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects retry evidence sealed inside a receipt (#1603)', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, receipt, planPath } = sealedFixture(directory);
        receipt.evidence[0].run = { id: 'round-1', attemptKind: 'retry', evidenceClass: 'correctness' };
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('retry evidence')), 'retry evidence must fail closed');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier requires the explicit test plan input and fails closed', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths } = sealedFixture(directory);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('test plan input is required')),
            'missing plan must fail closed instead of silently skipping exact-match');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects a tampered test plan', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { receiptPath, paths, planPath } = sealedFixture(directory);
        const plan = JSON.parse(readFileSync(planPath, 'utf8'));
        plan.commit = 'b'.repeat(40);
        writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
        const { errors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(errors.some((e) => e.includes('testPlanDigest')), 'plan digest tamper must fail closed');
        assert.ok(errors.some((e) => e.includes('testPlanCommit')), 'plan commit drift must fail closed');
        assert.ok(errors.some((e) => e.includes('test plan commit does not match current-run observations')),
            'plan/source identity drift must fail closed');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects a plan that omits required bound tests', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { scan } = sealedFixture(directory);
        const files = [...new Set(scan.bindings.map((binding) => binding.sourcePath))].sort();
        const planPath = writePlan(directory, scan, {
            tiers: [{ id: 'fixture-tier', evidence: files.slice(0, Math.max(1, files.length - 1)) }]
        });
        const incomplete = observationsFromScan(directory, scan);
        const paths = incomplete.map((artifact, index) => writeArtifact(directory, artifact, `incomplete-${index}.json`));
        const { receipt, errors } = produceBehaviorTestEvidence({
            repositoryRoot: directory,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory,
            expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
        });
        assert.ok(errors.some((e) => e.includes('not planned by test plan')),
            'producer must fail on a plan that omits bound tests');
        const receiptPath = path.join(directory, 'gap-receipt.json');
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const { errors: verifyErrors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(verifyErrors.some((e) => e.includes('not planned by test plan')),
            'verifier must independently reject the plan gap');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier rejects extra executed tests beyond the plan closure', () =>
{
    const directory = fixtureRoot();
    try
    {
        const { scan, planPath } = sealedFixture(directory);
        const overrun = observationsFromScan(directory, scan);
        const extraDir = path.join(directory, '.tmp/observations');
        mkdirSync(extraDir, { recursive: true });
        const extraReport = path.join(extraDir, 'unplanned-extra.tap');
        writeFileSync(extraReport, makeTap('tests/tools/unplanned-extra.test.mjs', [{ name: 'unplanned extra test' }]));
        const extraArtifact = createObservationArtifact({
            framework: 'node-tap',
            reportFile: extraReport,
            evidenceReference: '.tmp/observations/unplanned-extra.tap',
            suite: 'tests/tools/unplanned-extra.test.mjs',
            partition: 'fixture',
            metadata: {
                sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
                sourceClosureDigest: `sha256:${'c'.repeat(64)}`,
                runner: { os: 'linux', arch: 'x64', runtime: 'node-test', browser: null, project: null },
                run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' }
            },
            observedAt: '2026-07-28T00:00:00.000Z'
        });
        overrun.push(extraArtifact);
        const paths = overrun.map((artifact, index) => writeArtifact(directory, artifact, `overrun-${index}.json`));
        const { receipt, errors } = produceBehaviorTestEvidence({
            repositoryRoot: directory,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory,
            expectedWorktreeFingerprint: `sha256:${'b'.repeat(64)}`
        });
        assert.ok(errors.some((e) => e.includes('extra executed test(s) beyond plan closure')),
            'producer must fail on overrun executed tests');
        const receiptPath = path.join(directory, 'overrun-receipt.json');
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const { errors: verifyErrors } = verifyBehaviorTestEvidence({
            repositoryRoot: directory,
            receipt: receiptPath,
            observations: paths,
            plan: planPath,
            evidenceRoot: directory
        });
        assert.ok(verifyErrors.some((e) => e.includes('extra executed test(s) beyond plan closure')),
            'verifier must independently reject overrun executed tests');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verifier exports the canonical command', async () =>
{
    const mod = await import('../../tools/test-matrix/verify-behavior-test-evidence.mjs');
    assert.equal(mod.verifyBehaviorTestEvidenceCommand, verifyBehaviorTestEvidenceCommand);
    assert.ok(verifyBehaviorTestEvidenceCommand.endsWith('verify-behavior-test-evidence.mjs'));
});
