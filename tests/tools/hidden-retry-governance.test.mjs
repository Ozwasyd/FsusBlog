import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { readRetryPolicyRegistry, sealContentDigest } from '../../tools/test/attempt-provenance.mjs';
import {
    hiddenRetryScannerVersion,
    scanHiddenRetries,
    sourceDigest,
    validateRetryDispositionRegistry
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/hidden-retry-scanner.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function fixture(files)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-hidden-retry-'));
    for (const [relative, source] of Object.entries(files))
    {
        const file = path.join(directory, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
    }
    return directory;
}

function withFixture(files, run)
{
    const directory = fixture(files);
    try
    {
        run(directory);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function disposition(rootDirectory, finding)
{
    return {
        producerId: finding.producerId,
        findingId: finding.findingId,
        location: finding.location,
        ruleId: finding.ruleId,
        classification: 'correctness',
        policyId: 'correctness-first-attempt',
        action: 'remove',
        owner: 'test-governance',
        sourceDigest: sourceDigest(path.join(rootDirectory, finding.location.path)),
        syntaxDigest: finding.syntaxDigest
    };
}

test('repository hidden retry inventory is exact, stable and warning free', () =>
{
    const first = scanHiddenRetries(root);
    const second = scanHiddenRetries(root);
    assert.equal(first.contentDigest, second.contentDigest);
    assert.equal(first.findings.length, 5);
    assert.equal(new Set(first.findings.map((item) => item.findingId)).size, first.findings.length);
    const registry = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/retry-disposition-registry.json'),
        'utf8'
    ));
    const verified = validateRetryDispositionRegistry(root, registry, first, readRetryPolicyRegistry());
    assert.deepEqual(verified.warnings, []);
    assert.equal(first.findings.some((item) => (
        item.location.path === 'ops/docker/FsusBlog.Server.Dockerfile'
    )), false);
    assert.equal(registry.entries.some((entry) => entry.action === 'remove'), false);
});

test('scanner detects shell, Node, C#, Docker, framework, CI, timeout and resume retry shapes', () => withFixture({
    'ops/docker/Test.Dockerfile': "RUN sh -lc 'for i in 1 2; do dotnet build app.csproj && exit 0; echo retry; done; exit 1'\n",
    'tools/runner.sh': 'for attempt in 1 2; do node producer.mjs || true; done\n',
    'tools/recursive.sh': 'Retry() { if ! node producer.mjs; then Retry; fi; }\n',
    'tools/runner.mjs': [
        'for (let attemptNumber = 1; attemptNumber <= policy.allowedRetries + 1; attemptNumber += 1) { runCommand(); }',
        'try { await runProducer(); } catch { await runProducer(); }',
        "if (argv.includes('--resume-failed') && prior.status === 'failed') spawn('node', ['producer.mjs']);",
        "timeout(() => node('producer')); node('producer');"
    ].join('\n'),
    'tools/Runner.cs': 'for (var attempt = 0; attempt < 2; attempt++) { Process.Start("producer"); }\n',
    'playwright.config.ts': 'export default { retries: 2 };\n',
    '.github/workflows/quality.yml': 'steps:\n  - continue-on-error: true\n    run: npm test\n'
}, (directory) =>
{
    const scan = scanHiddenRetries(directory);
    const rules = new Set(scan.findings.map((item) => item.ruleId));
    for (const rule of [
        'retry.docker-command-loop',
        'retry.shell-command-loop',
        'retry.shell-self-reentry',
        'retry.node-attempt-loop',
        'retry.node-catch-reinvoke',
        'retry.csharp-attempt-loop',
        'retry.framework-config',
        'retry.ci-continue-second-run',
        'retry.timeout-rerun',
        'retry.resume-failed-reexecution'
    ])
    {
        assert.ok(rules.has(rule), `missing ${rule}`);
    }
}));

test('legal business loops, readiness polling and zero framework retries are not hidden retry findings', () => withFixture({
    'tools/business.mjs': 'for (const article of articles) { await save(article); }\n',
    'tools/readiness.sh': 'until curl -fsS http://127.0.0.1/health; do sleep 1; done\n',
    'playwright.config.ts': 'export default { retries: 0 };\n'
}, (directory) =>
{
    assert.deepEqual(scanHiddenRetries(directory).findings, []);
}));

test('new retry and stale source identities fail exact-one governance', () => withFixture({
    'tools/runner.mjs': 'for (let attemptNumber = 1; attemptNumber <= policy.allowedRetries + 1; attemptNumber += 1) { runCommand(); }\n'
}, (directory) =>
{
    const scan = scanHiddenRetries(directory);
    assert.equal(scan.findings.length, 1);
    const empty = sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries: []
    });
    assert.throws(
        () => validateRetryDispositionRegistry(directory, empty, scan, readRetryPolicyRegistry()),
        /unregistered/u
    );
    const complete = sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries: [disposition(directory, scan.findings[0])]
    });
    assert.doesNotThrow(() => validateRetryDispositionRegistry(
        directory,
        complete,
        scan,
        readRetryPolicyRegistry()
    ));
    fs.appendFileSync(path.join(directory, 'tools/runner.mjs'), '// source drift\n');
    assert.throws(
        () => validateRetryDispositionRegistry(
            directory,
            complete,
            scanHiddenRetries(directory),
            readRetryPolicyRegistry()
        ),
        /source digest is stale/u
    );
}));

test('wildcard and duplicate dispositions are rejected', () => withFixture({
    'tools/runner.mjs': 'for (let attemptNumber = 1; attemptNumber <= policy.allowedRetries + 1; attemptNumber += 1) { runCommand(); }\n'
}, (directory) =>
{
    const scan = scanHiddenRetries(directory);
    const entry = disposition(directory, scan.findings[0]);
    const wildcard = sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries: [{ ...entry, location: { ...entry.location, path: 'tools/*' } }]
    });
    assert.throws(() => validateRetryDispositionRegistry(
        directory,
        wildcard,
        scan,
        readRetryPolicyRegistry()
    ), /exact file:line location/u);

    const duplicate = sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries: [entry, entry]
    });
    assert.throws(() => validateRetryDispositionRegistry(
        directory,
        duplicate,
        scan,
        readRetryPolicyRegistry()
    ), /duplicate/u);
}));
