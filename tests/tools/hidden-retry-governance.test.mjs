import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {readRetryPolicyRegistry, sealContentDigest} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const {hiddenRetryScannerVersion, scanHiddenRetries, sourceDigest, validateRetryDispositionRegistry} = await import(new URL('../../tools/test/hidden-retry-scanner.mjs', import.meta.url));
const {retryDispositionSeeds, resolveRetryDispositionSeeds} = await import(new URL('../../tools/test/retry-disposition-seeds.mjs', import.meta.url));
const {parseMatrix} = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
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
    assert.equal(first.findings.length, 7);
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

    const mysqlFixturePath = 'tests/migration/MySqlDdlFixture.cs';
    const mysqlEntry = registry.entries.filter((entry) => entry.location.path === mysqlFixturePath);
    assert.equal(mysqlEntry.length, 1);
    assert.equal(mysqlEntry[0].classification, 'non-retry');
    assert.equal(mysqlEntry[0].policyId, null);
    assert.equal(mysqlEntry[0].owner, 'schema-migration');
    const mysqlFixture = fs.readFileSync(path.join(root, mysqlFixturePath), 'utf8');
    const initialize = mysqlFixture.slice(
        mysqlFixture.indexOf('public async Task InitializeAsync()'),
        mysqlFixture.indexOf('public async Task DisposeAsync()')
    );
    assert.equal((initialize.match(/ExecuteAsync\(/gu) ?? []).length, 1);
    assert.match(initialize, /ExecuteAsync\(null, "SELECT VERSION\(\);", startupTimeout\.Token\)/u);
    assert.match(initialize, /startupTimeout = new CancellationTokenSource\(TimeSpan\.FromSeconds\(30\)\)/u);
    assert.match(initialize, /Task\.Delay\(500, startupTimeout\.Token\)/u);
    const execute = mysqlFixture.slice(
        mysqlFixture.indexOf('public Task<SqlResult> ExecuteAsync('),
        mysqlFixture.indexOf('private static Dictionary<string, string> CreateLabels()')
    );
    assert.doesNotMatch(execute, /\b(?:for|while)\s*\(|Task\.Delay/u);
    assert.match(execute, /return DockerAsync\(\[\.\. args\], cancellationToken\);/u);
});

test('MySQL startup source authority is registered in matrix cache and physical producer inputs', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const tier = matrix.tiers.find((entry) => entry.id === 'validate-matrix');
    assert.equal(tier.command, 'tools/test/run-matrix-governance-once.sh validate-matrix');
    const script = fs.readFileSync(path.join(root, 'tools/test/run-matrix-governance-once.sh'), 'utf8');
    const declaredPhysicalInputs = [...script.matchAll(/^ {4}--path ([^\s]+) \\/gmu)].map((match) => match[1]);
    for (const source of ['tools/test/retry-disposition-seeds.mjs', 'tests/migration/MySqlDdlFixture.cs'])
    {
        assert.equal(tier.cacheInputs.filter((input) => input === source).length, 1, source);
        assert.equal(declaredPhysicalInputs.filter((input) => input === source).length, 1, source);
    }
});

test('MySQL startup disposition resolves one actual scanner finding without generated seed fields', () =>
{
    const [seed] = retryDispositionSeeds;
    assert.equal(retryDispositionSeeds.length, 1);
    assert.deepEqual(Object.keys(seed).sort(), [
        'action', 'classification', 'owner', 'path', 'policyId',
        'producerId', 'ruleId', 'sourceText', 'syntaxText'
    ]);
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    const registry = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/retry-disposition-registry.json'), 'utf8'
    ));
    const before = structuredClone(registry.entries);
    const resolved = resolveRetryDispositionSeeds(root, findings, { priorEntries: registry.entries });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].finding, findings[0]);
    assert.deepEqual(resolved[0].disposition, {
        producerId: 'csharp-mysqlddlfixture',
        ruleId: 'retry.csharp-attempt-loop',
        classification: 'non-retry',
        policyId: null,
        action: 'restore-only',
        owner: 'schema-migration'
    });
    assert.deepEqual(registry.entries, before);
    assert.equal(registry.entries.filter((entry) => entry.location.path !== seed.path).length, 6);
});

test('MySQL startup source seed accepts its unchanged prior generated disposition', () =>
{
    const [seed] = retryDispositionSeeds;
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    const [first] = resolveRetryDispositionSeeds(root, findings);
    const prior = {
        ...first.finding, ...first.disposition,
        sourceDigest: sourceDigest(path.join(root, seed.path))
    };
    const [again] = resolveRetryDispositionSeeds(root, findings, { priorEntries: [prior] });
    assert.deepEqual(again, first);
});

test('MySQL startup source seed rejects missing and duplicate scanner findings', () =>
{
    const [seed] = retryDispositionSeeds;
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    assert.equal(findings.length, 1);
    for (const invalid of [[], [findings[0], findings[0]]])
    {
        assert.throws(() => resolveRetryDispositionSeeds(root, invalid), /exactly one scanner finding/u);
    }
});

test('MySQL startup source seed refuses wrong producer path rule or syntax identity', () =>
{
    const [seed] = retryDispositionSeeds;
    const [finding] = scanHiddenRetries(root, { files: [seed.path] }).findings;
    for (const wrong of [
        { ...finding, producerId: 'csharp-otherfixture' },
        { ...finding, location: { ...finding.location, path: 'tests/migration/OtherFixture.cs' } },
        { ...finding, ruleId: 'retry.csharp-catch-reinvoke' },
        { ...finding, syntaxDigest: 'sha256:' + '0'.repeat(64) }
    ])
    {
        assert.throws(() => resolveRetryDispositionSeeds(root, [wrong]), /exactly one scanner finding/u);
    }
});

test('MySQL startup source seed rejects an absent physical source', () => withFixture({}, (directory) =>
{
    assert.throws(() => resolveRetryDispositionSeeds(directory, []), /Missing retry disposition seed source/u);
}));

test('MySQL startup source seed rejects command comment and line-ending source drift', () =>
{
    const [seed] = retryDispositionSeeds;
    for (const drifted of [
        seed.sourceText.replace('SELECT VERSION();', 'SELECT 1;'),
        seed.sourceText + '// unrelated change still requires explicit source review\n',
        seed.sourceText.replaceAll('\n', '\r\n')
    ])
    {
        assert.notEqual(drifted, seed.sourceText);
        withFixture({ [seed.path]: drifted }, (directory) =>
        {
            const findings = scanHiddenRetries(directory).findings;
            assert.throws(() => resolveRetryDispositionSeeds(directory, findings), /seed source drift/u);
        });
    }
});

test('MySQL startup source seed rejects duplicate authored seeds', () =>
{
    const [seed] = retryDispositionSeeds;
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    assert.throws(() => resolveRetryDispositionSeeds(root, findings, {
        seeds: [seed, seed]
    }), /Duplicate retry disposition seed/u);
});

test('MySQL startup source seed rejects wildcards and caller-computed finding fields', () =>
{
    const [seed] = retryDispositionSeeds;
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    for (const invalid of [
        { ...seed, path: 'tests/migration/*' },
        { ...seed, path: 'tests/migration/../MySqlDdlFixture.cs' },
        { ...seed, findingId: findings[0].findingId },
        { ...seed, syntaxDigest: findings[0].syntaxDigest },
        { ...seed, location: findings[0].location },
        { ...seed, sourceDigest: sourceDigest(path.join(root, seed.path)) }
    ])
    {
        assert.throws(() => resolveRetryDispositionSeeds(root, findings, {
            seeds: [invalid]
        }), /exact raw source and explicit non-retry semantics/u);
    }
});

test('MySQL startup source seed refuses a conflicting existing disposition', () =>
{
    const [seed] = retryDispositionSeeds;
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    const [resolved] = resolveRetryDispositionSeeds(root, findings);
    for (const override of [
        { classification: 'correctness' },
        { policyId: 'correctness-first-attempt' },
        { action: 'remove' },
        { owner: 'another-owner' }
    ])
    {
        assert.throws(() => resolveRetryDispositionSeeds(root, findings, {
            priorEntries: [{ ...resolved.finding, ...resolved.disposition, ...override }]
        }), /Conflicting prior retry disposition seed/u);
    }
});

test('MySQL startup source seed refuses duplicate prior disposition owners', () =>
{
    const [seed] = retryDispositionSeeds;
    const findings = scanHiddenRetries(root, { files: [seed.path] }).findings;
    const [resolved] = resolveRetryDispositionSeeds(root, findings);
    const prior = { ...resolved.finding, ...resolved.disposition };
    assert.throws(() => resolveRetryDispositionSeeds(root, findings, {
        priorEntries: [prior, prior]
    }), /Duplicate prior retry disposition seed/u);
});

test('dev container selection is an exact non-retry disposition', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/dev/start.sh'), 'utf8');
    const findings = scanHiddenRetries(root).findings.filter((item) => (
        item.location.path === 'tools/dev/start.sh'
    ));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'retry.shell-or-reinvoke');
    assert.equal((source.match(/docker inspect fsusblog-dev-postgres/gu) ?? []).length, 1);
    assert.equal((source.match(/docker inspect fsusblog-dev-redis/gu) ?? []).length, 1);
    assert.match(
        source,
        /if docker inspect fsusblog-dev-postgres[^\n]+ \|\| docker inspect fsusblog-dev-redis[^\n]+; then[\s\S]*?else\n\s+docker compose[^\n]+ up -d postgres redis\nfi/u
    );

    const registry = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/retry-disposition-registry.json'),
        'utf8'
    ));
    const dispositionEntry = registry.entries.find((entry) => (
        entry.findingId === findings[0].findingId
    ));
    assert.equal(dispositionEntry?.classification, 'non-retry');
    assert.equal(dispositionEntry?.policyId, null);
    assert.equal(dispositionEntry?.action, 'restore-only');
    assert.equal(dispositionEntry?.owner, 'development');
});

test('public preview stages the WASM envelope once and has no recovered qualification path', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/docs/run-public-preview-capture.sh'), 'utf8');
    assert.match(source, /^set -euo pipefail$/mu);
    assert.equal((source.match(/wasm-build-receipt\.mjs" stage-envelope/gu) ?? []).length, 1);
    assert.doesNotMatch(source, /for\s+attempt[\s\S]{0,800}stage-envelope/u);
    assert.doesNotMatch(source, /wasmStaged/u);
    assert.doesNotMatch(source, /sleep 2/u);
    assert.doesNotMatch(source, /if\s+node[^\n]+wasm-build-receipt\.mjs" stage-envelope/u);
    assert.equal(scanHiddenRetries(root).findings.some((item) => (
        item.location.path === 'tools/docs/run-public-preview-capture.sh'
    )), false);
});

test('reintroducing the public preview producer loop is an unregistered retry', () => withFixture({
    'tools/docs/run-public-preview-capture.sh': [
        'for attempt in 1 2 3; do',
        '  node tools/frontend/wasm-build-receipt.mjs stage-envelope || true',
        'done'
    ].join('\n')
}, (directory) =>
{
    const scan = scanHiddenRetries(directory);
    assert.equal(scan.findings.length, 1);
    assert.equal(scan.findings[0].ruleId, 'retry.shell-command-loop');
    const empty = sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries: []
    });
    assert.throws(
        () => validateRetryDispositionRegistry(directory, empty, scan, readRetryPolicyRegistry()),
        /unregistered retry\.shell-command-loop/u
    );

    const disguised = sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries: [{
            ...disposition(directory, scan.findings[0]),
            classification: 'non-retry',
            policyId: null,
            action: 'restore-only'
        }]
    });
    assert.throws(
        () => validateRetryDispositionRegistry(directory, disguised, scan, readRetryPolicyRegistry()),
        /shell command loop cannot be classified as non-retry/u
    );
}));

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
