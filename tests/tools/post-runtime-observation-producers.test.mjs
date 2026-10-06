import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const { writeReceipt, explicitJson, produceCandidatePlan, produceClassReceipt } = await import(new URL('../../tools/fact-extractors/post-runtime/adapter.mjs', import.meta.url));
const { runCurrentRunCli } = await import(new URL('../../tools/fact-extractors/post-runtime/current-run.mjs', import.meta.url));
const { root } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));

const bundlePath = path.join(root, 'tools/test/bundles/post-runtime-observation-producers.sh');
const candidatePlanLanePath = path.join(root, 'tools/test/lanes/post-runtime-candidate-plan.sh');

test('shared producer bundle invokes and independently verifies all seven canonical classes', () =>
{
    const source = fs.readFileSync(bundlePath, 'utf8');
    for (const producer of [
        'aot-spa-hydration-raw.mjs',
        'blue-green-containment-raw.mjs',
        'browser-contract-observation-raw.mjs',
        'release-readiness-raw.mjs',
        'runtime-observation-raw.mjs'
    ])
    {
        assert.match(source, new RegExp(producer.replaceAll('.', '\\.')));
    }
    for (const classId of [
        'aot-spa-hydration', 'blue-green-containment', 'browser-behavior-contract',
        'cache-search-outbox-convergence', 'release-identity-readiness',
        'route-response-error', 'session-cookie-runtime'
    ])
    {
        assert.match(source, new RegExp(classId));
    }
    assert.match(source, /application-runtime\.mjs verify/u);
    assert.match(source, /release-deployment\.mjs verify/u);
});

test('shared producer bundle fails closed instead of fabricating missing current-run inputs', () =>
{
    const result = spawnSync('bash', [bundlePath], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_TEST_RUN_ID: 'missing-current-run', FSUSBLOG_TEST_ATTEMPT_ID: 'attempt-0001',
            FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: '' }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required current-run input is missing/u);
});

test('candidate and observation outputs preserve each run attempt while accepted claims remain run-level', () =>
{
    const candidateLane = fs.readFileSync(candidatePlanLanePath, 'utf8');
    const producerBundle = fs.readFileSync(bundlePath, 'utf8');
    for (const source of [candidateLane, producerBundle])
    {
        assert.match(source, /post-runtime-plan\/\$RUN_ID/u);
        assert.match(source, /\$CLAIMS_DIR\/\$ATTEMPT_ID/u);
        assert.match(source, /post-runtime-raw\/\$RUN_ID\/\$ATTEMPT_ID/u);
    }
    assert.match(candidateLane, /\$CLAIMS_DIR\/accepted-claims\.json/u);
    assert.doesNotMatch(candidateLane, /\$OUT_DIR\/accepted-claims\.json/u);
    assert.match(candidateLane, /if \[\[ -e "\$CLAIMS_DIR\/accepted-claims\.json" \]\]/u);
    assert.match(candidateLane, /verify-accepted-claims/u);
    assert.match(candidateLane, /FSUSBLOG_DOCS_GLOBAL_CLAIM_EXACTNESS_FINAL_EVIDENCE_PATH/u);
    assert.doesNotMatch(candidateLane, /FSUSBLOG_GLOBAL_CLAIM_EXACTNESS_RECEIPT/u);
    assert.match(candidateLane, /--run-id "\$RUN_ID"/u);
    assert.match(producerBundle, /verify-accepted-claims --receipt "\$CLAIMS" --run-id "\$RUN_ID"/u);
    assert.match(candidateLane, /FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID/u);
    assert.match(producerBundle, /post-runtime-observations\/\$RUN_ID\/\$ATTEMPT_ID/u);
    assert.match(producerBundle, /post-runtime-sources\/\$RUN_ID\/\$ATTEMPT_ID/u);
    assert.match(producerBundle, /runtime-observation-probes\/\$RUN_ID\/\$ATTEMPT_ID/u);
    assert.match(producerBundle, /verify-class-receipt --receipt/u);
    const adapter = ['common.mjs', 'observation.mjs'].map((owner) => fs.readFileSync(path.join(root, 'tools/fact-extractors/post-runtime', owner), 'utf8')).join('\n');
    assert.match(adapter, /post-runtime-source-receipts\/\$\{plan\.candidate\.runId\}\/\$\{plan\.candidate\.attemptId\}/u);
    assert.match(adapter, /production requires an explicit current-run output path/u);
    assert.match(adapter, /!path\.isAbsolute\(value\)/u);
});

test('post-runtime writers never overwrite retained attempt evidence', (context) =>
{
    const tempRoot = path.join(root, '.tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(tempRoot, 'post-runtime-no-overwrite-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.relative(root, path.join(directory, 'receipt.json')).replaceAll(path.sep, '/');
    writeReceipt(output, { schema: 'fsusblog.test.v1', status: 'diagnostic' }, root);
    assert.throws(
        () => writeReceipt(output, { schema: 'fsusblog.test.v1', status: 'qualified' }, root),
        /must not overwrite an existing current-run record/u);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, output), 'utf8')).status, 'diagnostic');
});


test('current-run CLI rejects ambiguous options and absent current parent identity before any production', () =>
{
    const cli = path.join(root, 'tools/fact-extractors/post-runtime/current-run.mjs');
    for (const [args, expected] of [
        [['candidate-context', '--run-id', 'first', '--run-id', 'second'], /duplicate option/u],
        [['candidate-context', '--observation', 'browser=x', '--observation', 'browser=y'], /bind each class exactly once/u],
        [['candidate-context', '--run-id', '--attempt-id'], /requires a value/u],
        [['candidate-context', '--run-id', 'run'], /explicit.*--attempt-id/u],
        [['accepted-claims', '--terminal', 'missing.json'], /explicit --run-id/u],
        [['verify-accepted-claims', '--receipt', 'missing.json'], /explicit --run-id/u]
    ])
    {
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, expected);
        assert.equal(result.stdout, '');
    }
});

test('all seven current-run CLI commands keep missing or unqualified inputs closed', () =>
{
    const cli = path.join(root, 'tools/fact-extractors/post-runtime/current-run.mjs');
    for (const args of [
        ['accepted-claims', '--terminal', 'missing.json', '--run-id', 'run'],
        ['candidate-context', '--pre-runtime', 'missing.json', '--run-id', 'run', '--attempt-id', 'attempt-0001'],
        ['candidate-plan', '--run-id', 'run', '--attempt-id', 'attempt-0001', '--pre-runtime', 'missing.json', '--out', '.tmp/post-runtime-plan/run/attempt-0001/candidate-plan.json'],
        ['class-receipt', '--run-id', 'run', '--attempt-id', 'attempt-0001', '--receipt', 'missing.json', '--class', 'browser-behavior-contract', '--result', 'missing.json'],
        ['verify-accepted-claims', '--receipt', 'missing.json', '--run-id', 'run'],
        ['verify-candidate-plan', '--run-id', 'run', '--attempt-id', 'attempt-0001', '--receipt', 'missing.json'],
        ['verify-class-receipt', '--run-id', 'run', '--attempt-id', 'attempt-0001', '--receipt', 'missing.json']
    ])
    {
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.notEqual(result.stderr, '');
    }
});


test('candidate CLI compares the explicit current parent before any output', (context) =>
{
    const directory = fs.mkdtempSync(path.join(root, '.tmp/post-runtime-parent-binding-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const input = path.relative(root, path.join(directory, 'input.json'));
    const output = path.relative(root, path.join(directory, 'output.json'));
    fs.writeFileSync(path.join(root, input), JSON.stringify({ candidate: { runId: 'another-run', attemptId: 'attempt-0002' } }));
    for (const command of ['candidate-plan', 'class-receipt', 'verify-candidate-plan', 'verify-class-receipt'])
    {
        const result = spawnSync(process.execPath, [path.join(root, 'tools/fact-extractors/post-runtime/current-run.mjs'), command, '--run-id', 'current-run', '--attempt-id', 'attempt-0001', command === 'candidate-plan' ? '--context' : '--receipt', input, '--out', output], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /explicit current parent run\/attempt/u);
        assert.equal(result.stdout, '');
        assert.equal(fs.existsSync(path.join(root, output)), false);
    }
});


test('current producer consumes bind the actual replacement input before any output', (context) =>
{
    const directory = fs.mkdtempSync(path.join(root, '.tmp/post-runtime-consumed-parent-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const input = path.relative(root, path.join(directory, 'input.json'));
    const absolute = path.join(root, input);
    const current = { candidate: { runId: 'current-run', attemptId: 'attempt-0001' } };
    const foreign = { candidate: { runId: 'foreign-run', attemptId: 'attempt-0002' } };
    for (const produce of [produceCandidatePlan, produceClassReceipt])
    {
        fs.writeFileSync(absolute, JSON.stringify(current));
        const compared = explicitJson(input, 'compared current parent', root);
        assert.equal(compared.value.candidate.runId, 'current-run');
        const replacement = path.join(directory, 'replacement.json');
        fs.writeFileSync(replacement, JSON.stringify(foreign));
        fs.renameSync(replacement, absolute);
        assert.throws(() => produce({ context: input, candidatePlan: input,
            preRuntimeReceipt: 'must-not-read.json', result: 'must-not-read.json',
            identityAuthorityDirectory: path.relative(root, path.join(directory, 'identity-authorities')),
            repositoryRoot: root, expectedRunId: 'current-run', expectedAttemptId: 'attempt-0001' }), /explicit current parent run\/attempt/u);
        assert.equal(fs.existsSync(path.join(directory, 'identity-authorities')), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(absolute, 'utf8')), foreign);
    }
});

test('pure CLI verification uses one compared physical input even after an actual replacement', (context) =>
{
    const directory = fs.mkdtempSync(path.join(root, '.tmp/post-runtime-pinned-parent-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const absolute = path.join(directory, 'input.json');
    const input = path.relative(root, absolute);
    const output = path.relative(root, path.join(directory, 'output.json'));
    const first = { schema: 'deliberately-invalid-source-counterfixture', candidate: { runId: 'current-run', attemptId: 'attempt-0001' } };
    const foreign = { schema: 'another-invalid-source-counterfixture', candidate: { runId: 'foreign-run', attemptId: 'attempt-0002' } };
    // The hook performs an actual owned rename after the original physical read.
    // Both counterfixtures remain unqualified; no production verifier is replaced.
    const originalRead = fs.readFileSync;
    for (const command of ['verify-candidate-plan', 'verify-class-receipt'])
    {
        fs.writeFileSync(absolute, JSON.stringify(first));
        let reads = 0;
        try
        {
            fs.readFileSync = function (file, ...args)
            {
                const bytes = originalRead.call(this, file, ...args);
                if (file === absolute)
                {
                    reads += 1;
                    if (reads === 1)
                    {
                        const replacement = path.join(directory, 'replacement.json');
                        fs.writeFileSync(replacement, JSON.stringify(foreign));
                        fs.renameSync(replacement, absolute);
                    }
                }
                return bytes;
            };
            syncBuiltinESMExports();
            assert.throws(() => runCurrentRunCli([command, '--receipt', input, '--run-id', 'current-run', '--attempt-id', 'attempt-0001', '--out', output], root), /schema\/status mismatch/u);
            assert.equal(reads, 1);
        }
        finally
        {
            fs.readFileSync = originalRead;
            syncBuiltinESMExports();
        }
        assert.deepEqual(JSON.parse(fs.readFileSync(absolute, 'utf8')), foreign);
        assert.equal(fs.existsSync(path.join(root, output)), false);
    }
});

test('the actual thin producer lane reaches the executable bundle and fails closed on absent parent input', () =>
{
    const lane = path.join(root, 'tools/test/lanes/post-runtime-observation-producers.sh');
    const result = spawnSync(lane, [], { cwd: root, encoding: 'utf8', env: { ...process.env, FSUSBLOG_TEST_RUN_ID: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FSUSBLOG_TEST_RUN_ID is required/u);
    assert.doesNotMatch(result.stderr, /Permission denied/u);
    assert.equal(result.stdout, '');
});
