import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { produceRetryDispositionRegistry } from '../../tools/test/generate-retry-disposition-registry.mjs';

const {readRetryPolicyRegistry, sealContentDigest} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const {hiddenRetryScannerVersion, resolveReviewedRetryDispositions, scanHiddenRetries, sourceDigest, validateRetryDispositionRegistry} = await import(new URL('../../tools/test/hidden-retry-scanner.mjs', import.meta.url));
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

test('repository hidden retry inventory is exact, stable and requires an independent prior', () =>
{
    const first = scanHiddenRetries(root);
    const second = scanHiddenRetries(root);
    assert.equal(first.contentDigest, second.contentDigest);
    assert.equal(first.findings.length, 6);
    assert.equal(new Set(first.findings.map((item) => item.findingId)).size, first.findings.length);
    const registry = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/retry-disposition-registry.json'),
        'utf8'
    ));
    assert.throws(() => validateRetryDispositionRegistry(root, registry, first, readRetryPolicyRegistry()),
        /independent prior retry disposition entries are required/u);
    assert.equal(first.findings.some((item) => (
        item.location.path === 'ops/docker/FsusBlog.Server.Dockerfile'
    )), false);
    assert.equal(registry.entries.some((entry) => entry.action === 'remove'), false);
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
        readRetryPolicyRegistry(),
        { priorEntries: structuredClone(complete.entries) }
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

const sourcePath = 'tests/migration/ReviewedFixture.cs';
const sourceText = 'for (int attempt = 0; attempt < 2; attempt++)\n{\n    ExecuteAsync("probe");\n}\n';
const review = Object.freeze({
    producerId: 'csharp-reviewedfixture',
    path: sourcePath,
    ruleId: 'retry.csharp-attempt-loop',
    classification: 'non-retry',
    policyId: null,
    action: 'restore-only',
    owner: 'test-governance',
    sourceText,
    syntaxText: 'for (int attempt = 0; attempt < 2; attempt++) { ExecuteAsync('
});
const policyRegistry = { policies: new Map() };
const tempParent = path.resolve(import.meta.dirname, '../../.tmp');

function withReviewedFixture(run, source = sourceText)
{
    fs.mkdirSync(tempParent, { recursive: true });
    const root = fs.mkdtempSync(path.join(tempParent, 'reviewed-retry-'));
    const file = path.join(root, sourcePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    try
    {
        const scan = scanHiddenRetries(root, { files: [sourcePath] });
        run({ root, file, scan, finding: scan.findings[0] });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function resolve(root, findings, options = {})
{
    return resolveReviewedRetryDispositions(root, findings, { reviewedSources: [review], ...options });
}

function entry(root, finding, overrides = {})
{
    const { sourceText: raw, syntaxText: syntax, path: source, ...semantics } = review;
    return { ...finding, ...semantics, sourceDigest: sourceDigest(path.join(root, sourcePath)), ...overrides };
}

function registry(entries)
{
    return sealContentDigest({
        schema: 'fsusblog.retry-disposition-registry.v1',
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries
    });
}

test('raw review resolves the actual original scanner finding without generated authority fields', () => withReviewedFixture(({ root, scan, finding }) =>
{
    assert.equal(scan.findings.length, 1);
    const [resolved] = resolve(root, scan.findings);
    assert.deepEqual(resolved.finding, finding);
    assert.deepEqual(resolved.disposition, {
        producerId: review.producerId, ruleId: review.ruleId, classification: 'non-retry',
        policyId: null, action: 'restore-only', owner: review.owner
    });
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(resolved.disposition));
    assert.equal(Object.keys(review).some((key) => ['findingId', 'sourceDigest', 'syntaxDigest', 'location'].includes(key)), false);
}));

test('raw review accepts its unchanged prior generated disposition', () => withReviewedFixture(({ root, scan, finding }) =>
{
    assert.equal(resolve(root, scan.findings, { priorEntries: [entry(root, finding)] }).length, 1);
}));

test('raw review rejects missing or duplicate scanner findings', () => withReviewedFixture(({ root, finding }) =>
{
    for (const findings of [[], [finding, finding]])
    {
        assert.throws(() => resolve(root, findings), /exactly one original scanner finding/u);
    }
}));

test('raw review refuses wrong producer path rule syntax and resealed caller finding fields', () => withReviewedFixture(({ root, finding }) =>
{
    for (const forged of [
        { ...finding, producerId: 'another-producer' },
        { ...finding, location: { ...finding.location, path: 'tests/Other.cs' } },
        { ...finding, ruleId: 'retry.csharp-catch-reinvoke' },
        { ...finding, syntaxDigest: `sha256:${'0'.repeat(64)}` },
        { ...finding, findingId: `sha256:${'0'.repeat(64)}` },
        { ...finding, location: { ...finding.location, start: { line: 100, column: 1 } } }
    ])
    {
        assert.throws(() => resolve(root, [forged]), /exactly one original scanner finding/u);
    }
}));

test('raw review rejects an absent physical source', () => withReviewedFixture(({ root, file, scan }) =>
{
    fs.rmSync(file);
    assert.throws(() => resolve(root, scan.findings), /missing reviewed retry source/u);
}));

test('raw review rejects command comment and line-ending source drift', () =>
{
    for (const drifted of [
        sourceText.replace('probe', 'different-command'),
        `${sourceText}// unrelated edit requires new source review\n`,
        sourceText.replaceAll('\n', '\r\n')
    ])
    {
        withReviewedFixture(({ root, scan }) =>
        {
            assert.throws(() => resolve(root, scan.findings), /reviewed retry source drift/u);
        }, drifted);
    }
});

test('raw review rejects duplicate authored sources', () => withReviewedFixture(({ root, scan }) =>
{
    assert.throws(() => resolve(root, scan.findings, { reviewedSources: [review, review] }), /duplicate reviewed retry source/u);
}));

test('raw review rejects wildcard escape and caller-computed identity fields', () => withReviewedFixture(({ root, scan, finding }) =>
{
    for (const invalid of [
        { ...review, path: 'tests/migration/*' },
        { ...review, path: 'tests/migration/../ReviewedFixture.cs' },
        { ...review, path: 'tests/../../outside.cs' },
        { ...review, findingId: finding.findingId },
        { ...review, syntaxDigest: finding.syntaxDigest },
        { ...review, location: finding.location },
        { ...review, sourceDigest: entry(root, finding).sourceDigest }
    ])
    {
        assert.throws(() => resolve(root, scan.findings, { reviewedSources: [invalid] }), /exact raw source and explicit non-retry semantics/u);
    }
}));

test('raw review refuses a conflicting existing disposition', () => withReviewedFixture(({ root, scan, finding }) =>
{
    for (const override of [
        { classification: 'correctness' }, { policyId: 'another-policy' },
        { action: 'remove' }, { owner: 'another-owner' }
    ])
    {
        assert.throws(() => resolve(root, scan.findings, { priorEntries: [entry(root, finding, override)] }), /conflicting prior reviewed retry disposition/u);
    }
}));

test('raw review refuses duplicate prior semantic owners even when finding ids differ', () => withReviewedFixture(({ root, scan, finding }) =>
{
    const prior = entry(root, finding);
    assert.throws(() => resolve(root, scan.findings, {
        priorEntries: [prior, { ...prior, findingId: `sha256:${'1'.repeat(64)}` }]
    }), /duplicate prior reviewed retry disposition/u);
}));

test('literal source admission rejects file and parent symlinks plus nonregular files', () => withReviewedFixture(({ root, file, scan }) =>
{
    const retained = path.join(root, 'retained.cs');
    fs.renameSync(file, retained);
    fs.symlinkSync(retained, file);
    assert.throws(() => resolve(root, scan.findings), /literal regular file/u);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(() => resolve(root, scan.findings), /literal regular file/u);
    fs.rmSync(file, { recursive: true });
    const parent = path.dirname(file);
    const moved = `${parent}-retained`;
    fs.renameSync(parent, moved);
    fs.copyFileSync(retained, path.join(moved, path.basename(file)));
    fs.symlinkSync(moved, parent);
    assert.throws(() => resolve(root, scan.findings), /literal regular file/u);
}));

test('literal read detects replacement during read and closes its descriptor', () => withReviewedFixture(({ root, file, scan }) =>
{
    const original = fs.readFileSync;
    let descriptor;
    fs.readFileSync = (input, ...options) =>
    {
        const bytes = original(input, ...options);
        if (typeof input === 'number')
        {
            descriptor = input;
            fs.renameSync(file, `${file}.retained`);
            fs.writeFileSync(file, sourceText);
        }
        return bytes;
    };
    try
    {
        assert.throws(() => resolve(root, scan.findings), /source changed during literal read/u);
        assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    }
    finally
    {
        fs.readFileSync = original;
    }
}));

test('producer does not approve a new finding with or without an explicit raw review', () => withReviewedFixture(({ root }) =>
{
    for (const reviewedSources of [[], [review]])
    {
        assert.throws(() => produceRetryDispositionRegistry(root, registry([]), {
            reviewedSources, policyRegistry
        }), /new retry finding requires an explicit disposition/u);
    }
}));

test('producer preserves a prior disposition and validates exact raw source before generating', () => withReviewedFixture(({ root, finding }) =>
{
    const prior = registry([entry(root, finding)]);
    const generated = produceRetryDispositionRegistry(root, prior, {
        reviewedSources: [review], policyRegistry
    });
    assert.deepEqual(generated, prior);
    assert.deepEqual(produceRetryDispositionRegistry(root, prior, {
        policyRegistry
    }), prior);
}));

test('producer default refuses changed bytes and finding coordinates despite a unique prior disposition', () =>
{
    for (const changed of [`${sourceText}// new comment\n`, `// new first line\n${sourceText}`])
    {
        withReviewedFixture(({ root, file, finding }) =>
        {
            const prior = registry([entry(root, finding)]);
            fs.writeFileSync(file, changed);
            assert.throws(() => produceRetryDispositionRegistry(root, prior, {
                policyRegistry
            }), /changed retry source or finding requires an exact raw source review/u);
        });
    }
});

test('producer accepts changed bytes and coordinates only with exact raw review and unchanged prior semantics', () => withReviewedFixture(({ root, file, finding }) =>
{
    const prior = registry([entry(root, finding)]);
    const changed = `// explicitly reviewed source change\n${sourceText}`;
    fs.writeFileSync(file, changed);
    const generated = produceRetryDispositionRegistry(root, prior, {
        reviewedSources: [{ ...review, sourceText: changed }], policyRegistry
    });
    const next = generated.entries[0];
    assert.notEqual(next.findingId, prior.entries[0].findingId);
    assert.notEqual(next.sourceDigest, prior.entries[0].sourceDigest);
    for (const field of ['classification', 'policyId', 'action', 'owner'])
    {
        assert.equal(next[field], prior.entries[0][field]);
    }
    assert.equal(next.sourceDigest, sourceDigest(file));
}));

test('producer raw review cannot approve an unknown syntax identity', () => withReviewedFixture(({ root, file, finding }) =>
{
    const prior = registry([entry(root, finding)]);
    const changed = sourceText.replace('attempt < 2', 'attempt < 3');
    fs.writeFileSync(file, changed);
    assert.throws(() => produceRetryDispositionRegistry(root, prior, {
        reviewedSources: [{
            ...review, sourceText: changed, syntaxText: review.syntaxText.replace('attempt < 2', 'attempt < 3')
        }], policyRegistry
    }), /new retry finding requires an explicit disposition/u);
}));

test('producer rejects semantic conflict and duplicate prior owners', () => withReviewedFixture(({ root, finding }) =>
{
    const prior = entry(root, finding);
    assert.throws(() => produceRetryDispositionRegistry(root, registry([{ ...prior, owner: 'another-owner' }]), {
        reviewedSources: [review], policyRegistry
    }), /conflicting prior reviewed retry disposition/u);
    assert.throws(() => produceRetryDispositionRegistry(root, registry([prior, prior]), {
        reviewedSources: [review], policyRegistry
    }), /duplicate prior finding identities/u);
}));

test('freshly resealed source digests cannot bypass producer or validator raw source review', () => withReviewedFixture(({ root, file, finding }) =>
{
    const prior = registry([entry(root, finding)]);
    fs.appendFileSync(file, '// source review has not approved this change\n');
    const scan = scanHiddenRetries(root, { files: [sourcePath] });
    const resealed = registry([entry(root, scan.findings[0])]);
    assert.throws(() => validateRetryDispositionRegistry(root, resealed, scan, policyRegistry, {
        priorEntries: prior.entries
    }), /changed retry source or finding requires an exact raw source review/u);
    assert.throws(() => produceRetryDispositionRegistry(root, prior, {
        reviewedSources: [review], policyRegistry
    }), /reviewed retry source drift/u);
    assert.throws(() => validateRetryDispositionRegistry(root, resealed, scan, policyRegistry, {
        reviewedSources: [review], priorEntries: prior.entries
    }), /reviewed retry source drift/u);
}));

test('validator raw source input cannot approve a new classification or disposition owner', () => withReviewedFixture(({ root, scan, finding }) =>
{
    const prior = entry(root, finding);
    for (const override of [{ owner: 'another-owner' }, { action: 'remove' }])
    {
        const changed = registry([{ ...prior, ...override }]);
        assert.throws(() => validateRetryDispositionRegistry(root, changed, scan, policyRegistry, {
            reviewedSources: [review], priorEntries: [prior]
        }), /conflicting prior reviewed retry disposition/u);
    }
}));

test('registry validator refuses digest-matching symlink and outside-root source aliases', () => withReviewedFixture(({ root, file, scan, finding }) =>
{
    const document = registry([entry(root, finding)]);
    const retained = `${file}.retained`;
    fs.renameSync(file, retained);
    fs.symlinkSync(retained, file);
    assert.throws(() => validateRetryDispositionRegistry(root, document, scan, policyRegistry), /literal regular file/u);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.cs`);
    fs.writeFileSync(outside, sourceText);
    try
    {
        const alias = registry([{ ...document.entries[0], location: {
            ...finding.location, path: `../${path.basename(outside)}`
        } }]);
        assert.throws(() => validateRetryDispositionRegistry(root, alias, scan, policyRegistry), /literal repository-relative path/u);
    }
    finally
    {
        fs.rmSync(outside);
    }
}));

test('raw review cannot weaken the current non-retry shell command-loop restriction', () => withReviewedFixture(({ root, scan }) =>
{
    assert.throws(() => resolve(root, scan.findings, {
        reviewedSources: [{ ...review, ruleId: 'retry.shell-command-loop' }]
    }), /explicit non-retry semantics/u);
}));

test('validator default refuses candidate self-prior for exact and resealed changed source', () => withReviewedFixture(({ root, file, scan, finding }) =>
{
    const originalFixtureSnapshot = registry([entry(root, finding)]);
    assert.throws(() => validateRetryDispositionRegistry(root, originalFixtureSnapshot, scan, policyRegistry),
        /independent prior retry disposition entries are required/u);
    assert.throws(() => validateRetryDispositionRegistry(root, originalFixtureSnapshot, scan, policyRegistry, {
        priorEntries: originalFixtureSnapshot.entries
    }), /cannot serve as their own independent prior/u);
    const independentFixtureData = structuredClone(originalFixtureSnapshot.entries);
    const diagnostic = validateRetryDispositionRegistry(root, originalFixtureSnapshot, scan, policyRegistry, {
        priorEntries: independentFixtureData
    });
    assert.equal(diagnostic.qualificationEligible, false);
    assert.equal(diagnostic.status, 'source-validation-only');
    fs.appendFileSync(file, '// resealed candidate is not independent prior approval\n');
    const nextScan = scanHiddenRetries(root, { files: [sourcePath] });
    const resealed = registry([entry(root, nextScan.findings[0])]);
    assert.throws(() => validateRetryDispositionRegistry(root, resealed, nextScan, policyRegistry),
        /independent prior retry disposition entries are required/u);
}));

test('producer and validator refuse global semantic duplicate before an exact finding-id match', () => withReviewedFixture(({ root, scan, finding }) =>
{
    const prior = entry(root, finding);
    const conflict = { ...prior, findingId: `sha256:${'1'.repeat(64)}`, owner: 'conflicting-stale-owner' };
    assert.throws(() => produceRetryDispositionRegistry(root, registry([prior, conflict]), { policyRegistry }),
        /duplicate prior retry semantic owner/u);
    assert.throws(() => validateRetryDispositionRegistry(root, registry([prior]), scan, policyRegistry, {
        priorEntries: [prior, conflict]
    }), /duplicate prior retry semantic owner/u);
}));

test('full registry producer refuses partial scope and preserves both bindings during a complete scan', () => withReviewedFixture(({ root }) =>
{
    const otherPath = 'tests/migration/OtherFixture.cs';
    fs.writeFileSync(path.join(root, otherPath), sourceText);
    const scan = scanHiddenRetries(root);
    assert.equal(scan.findings.length, 2);
    const prior = registry(scan.findings.map((finding) => ({
        ...finding, classification: 'non-retry', policyId: null, action: 'restore-only',
        owner: 'test-governance', sourceDigest: sourceDigest(path.join(root, finding.location.path))
    })));
    for (const files of [[sourcePath], []])
    {
        assert.throws(() => produceRetryDispositionRegistry(root, prior, { files, policyRegistry }),
            /full retry disposition registry producer refuses partial scan scope/u);
    }
    assert.deepEqual(produceRetryDispositionRegistry(root, prior, { policyRegistry }), prior);
}));
