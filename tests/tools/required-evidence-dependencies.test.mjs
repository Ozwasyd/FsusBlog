import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const { buildReleaseFinalizerPlan } = await import(new URL('../../tools/test-matrix/release-final-evidence-contract.mjs', import.meta.url));
const {
    entryContentDigest,
    ledgerContentDigest,
    loadCanonicalRequiredEvidenceCatalog,
    producerContractDigest
} = await import(new URL('../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));
const {
    createRequiredEvidenceDependencies,
    recordRequiredEvidenceExecution,
    requiredEvidencePlanDigest,
    requiredEvidencePlanIdentity,
    validateRequiredEvidenceDependencies,
    validateRequiredEvidenceMatrix,
    validateRequiredEvidenceResults,
    validateRequiredEvidenceTestPlan
} = await import(new URL('../../tools/test-matrix/required-evidence-dependencies.mjs', import.meta.url));
const { effectiveCacheInputs, tierInputFingerprint } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { tierResourceUnits } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {
    buildCiPlan,
    buildCiJobMatrix,
    buildEvidencePlan,
    logicalTierPlanningResources,
    logicalTierSystemResources,
    printPlan,
    projectLogicalTierPlanningMetadata
} = await import(new URL('../../tools/run-test-matrix.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const ledger = loadCanonicalRequiredEvidenceCatalog();
const identity = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
    runId: 'catalog-projection-test', attempt: '1', namespace: 'catalog-projection-test', mode: 'current-run',
    candidateIdentity: { id: 'candidate-test', digest: `sha256:${'c'.repeat(64)}` } };
const seal = (document) => ({ ...document, contentDigest: governanceContentDigest(document) });
const sealPlan = (plan) => ({ ...plan, contentDigest: requiredEvidencePlanDigest(plan) });

function testPlan(planIdentity = identity)
{
    return sealPlan({ schema: 'fsusblog.release-evidence.test-plan.v1',
        commit: planIdentity.sourceCommit, runId: planIdentity.runId, namespace: planIdentity.namespace,
        tiers: structuredClone(matrix.tiers).sort((left, right) => left.id.localeCompare(right.id)),
        requiredEvidenceDependencies: createRequiredEvidenceDependencies(matrix, planIdentity) });
}

function completeResult(plan = testPlan())
{
    let result = null;
    for (const id of [...new Set(ledger.entries.flatMap((entry) => entry.producerTierIds))].sort())
    {
        result = recordRequiredEvidenceExecution(plan, id, 'success', result, plan.requiredEvidenceDependencies.identity);
    }
    return result;
}

test('current catalog projects every authority contract into a deterministic finalizer plan', () =>
{
    const plan = buildReleaseFinalizerPlan(matrix, 'release-final', undefined, { identity });
    assert.deepEqual(plan.errors, []);
    const projection = plan.requiredEvidenceDependencies;
    assert.deepEqual(projection.dependencies.map((entry) => entry.authorityId), projection.catalog.authorityIds);
    for (const entry of ledger.entries)
    {
        const projected = projection.dependencies.find((item) => item.authorityId === entry.authorityId);
        for (const [key, value] of Object.entries(entry))
        {
            assert.deepEqual(projected[key], value, `${entry.authorityId}.${key}`);
        }
        assert.equal(projected.verificationOwner, entry.producerVerifier);
        assert.equal(projected.expectedLocatorBinding.receiptRefSlot, entry.outputBindingKey);
        assert.equal(projected.affectsCorrectness, !entry.allowDiagnostic);
        assert.equal(projected.schedulesProducer, false);
    }
    const reversedMatrix = { ...matrix, tiers: [...matrix.tiers].reverse() };
    assert.deepEqual(createRequiredEvidenceDependencies(reversedMatrix, identity), projection);
    assert.equal(plan.contentDigest, governanceContentDigest(plan));
    assert.deepEqual(validateRequiredEvidenceTestPlan(testPlan(), identity), []);
    assert.equal(requiredEvidencePlanDigest({ ...testPlan(), generatedAt: 'yesterday' }), testPlan().contentDigest);
    assert.deepEqual(validateRequiredEvidenceResults(testPlan(), [completeResult()], identity), []);
});

test('matrix/catalog exact validation rejects either-sided missing, extra and duplicate authorities', async (t) =>
{
    for (const [name, mutate] of [
        ['matrix authority absent from catalog', (target) => target.requiresEvidenceFrom.push('unknown-authority')],
        ['catalog authority absent from matrix', (target) => target.requiresEvidenceFrom.pop()],
        ['duplicate authority', (target) => target.requiresEvidenceFrom.push(target.requiresEvidenceFrom[0])]
    ])
    {
        await t.test(name, () =>
        {
            const changed = structuredClone(matrix);
            mutate(changed.tiers.find((tier) => tier.id === 'release-final'));
            assert.notDeepEqual(validateRequiredEvidenceMatrix(changed), []);
            assert.throws(() => createRequiredEvidenceDependencies(changed, identity));
        });
    }
    const missingCatalog = structuredClone(ledger);
    missingCatalog.entries.pop();
    missingCatalog.contentDigest = ledgerContentDigest(missingCatalog);
    assert.throws(() => createRequiredEvidenceDependencies(matrix, identity, missingCatalog), /missing/u);
});

test('planner and test-plan refuse independently resealed contract drift', async (t) =>
{
    for (const [name, mutate] of [
        ['missing producer', (entry) => delete entry.producerTierIds],
        ['missing output binding', (entry) => delete entry.outputBindingKey],
        ['missing required test IDs', (entry) => delete entry.requiredTestIds],
        ['missing required coverage IDs', (entry) => delete entry.requiredCoverageIds],
        ['missing required artifact IDs', (entry) => delete entry.requiredArtifactIds],
        ['missing verifier', (entry) => delete entry.verificationOwner],
        ['missing local command', (entry) => delete entry.localProducerCommand],
        ['wrong owner', (entry) => entry.canonicalOwner = 'some-other-owner'],
        ['job-name inferred authority', (entry) => entry.authorityId = 'frontend-unit'],
        ['locator slot drift', (entry) => entry.expectedLocatorBinding.receiptRefSlot = 'other-slot'],
        ['fallback spawning', (entry) => entry.schedulesProducer = true],
        ['diagnostic replaces correctness', (entry) =>
        {
            entry.allowDiagnostic = true;
            entry.affectsCorrectness = false;
        }]
    ])
    {
        await t.test(name, () =>
        {
            const plan = testPlan();
            mutate(plan.requiredEvidenceDependencies.dependencies[0]);
            plan.requiredEvidenceDependencies = seal(plan.requiredEvidenceDependencies);
            const resealed = sealPlan(plan);
            assert.match(validateRequiredEvidenceTestPlan(resealed, identity).join('; '), /exactly project catalog/u);
            assert.notDeepEqual(validateRequiredEvidenceDependencies(plan.requiredEvidenceDependencies, matrix, identity), []);
        });
    }
});

test('catalog digest/version and any duplicated authority roster invalidate old projections and results', async (t) =>
{
    const plan = testPlan();
    for (const [name, mutate] of [
        ['version', (projection) => projection.catalogVersion += 1],
        ['catalog digest', (projection) => projection.catalog.contentDigest = `sha256:${'d'.repeat(64)}`],
        ['file digest', (projection) => projection.catalog.fileDigest = `sha256:${'e'.repeat(64)}`],
        ['second authority list', (projection) => projection.catalog.authorityIds.pop()],
        ['duplicate dependency', (projection) => projection.dependencies.push(projection.dependencies[0])],
        ['deleted dependency', (projection) => projection.dependencies.pop()]
    ])
    {
        await t.test(name, () =>
        {
            const changed = structuredClone(plan);
            mutate(changed.requiredEvidenceDependencies);
            changed.requiredEvidenceDependencies = seal(changed.requiredEvidenceDependencies);
            assert.notDeepEqual(validateRequiredEvidenceResults(sealPlan(changed), [completeResult(plan)], identity), []);
        });
    }
    const nextLedger = structuredClone(ledger);
    nextLedger.entries[0].localProducerCommand += ' --changed-contract';
    nextLedger.entries[0].producerDigest = producerContractDigest(nextLedger.entries[0]);
    nextLedger.entries[0].contentDigest = entryContentDigest(nextLedger.entries[0]);
    nextLedger.contentDigest = ledgerContentDigest(nextLedger);
    assert.notDeepEqual(validateRequiredEvidenceDependencies(plan.requiredEvidenceDependencies, matrix, identity, nextLedger), []);
});

test('source, worktree, run and candidate changes invalidate plan and current-run result reuse', async (t) =>
{
    for (const [name, mutate] of [
        ['source', (value) => value.sourceCommit = 'd'.repeat(40)],
        ['worktree', (value) => value.worktreeFingerprint = `sha256:${'d'.repeat(64)}`],
        ['run', (value) => value.runId = 'another-run'],
        ['candidate', (value) => value.candidateIdentity.digest = `sha256:${'d'.repeat(64)}`]
    ])
    {
        await t.test(name, () =>
        {
            const next = structuredClone(identity);
            mutate(next);
            assert.notDeepEqual(validateRequiredEvidenceTestPlan(testPlan(), next), []);
            assert.notDeepEqual(validateRequiredEvidenceResults(testPlan(next), [completeResult()], next), []);
        });
    }
    assert.throws(() => createRequiredEvidenceDependencies(matrix, {}), /complete.*identity/u);
});

test('current-run explicit receipt slots satisfy dependency accounting without reading receipt contents', () =>
{
    const plan = testPlan();
    const result = completeResult(plan);
    for (const record of result.dependencies)
    {
        record.executions = [];
        record.receiptRef = { bindingKey: record.outputBindingKey, locatorBindingKey: record.locatorBindingKey,
            schema: record.receiptSchema, path: `.tmp/current-run/${record.authorityId}.json`,
            identity, contentDigest: `sha256:${'e'.repeat(64)}` };
    }
    assert.deepEqual(validateRequiredEvidenceResults(plan, [seal(result)], identity), []);
    result.dependencies[0].receiptRef.identity = { ...identity, runId: 'old-run' };
    assert.match(validateRequiredEvidenceResults(plan, [seal(result)], identity).join('; '), /ref binding\/identity mismatch/u);
    const sourceIdentity = { ...identity, mode: 'source-plan' };
    const sourcePlan = testPlan(sourceIdentity);
    const sourceResult = { ...result, identity: sourceIdentity, planDigest: sourcePlan.contentDigest,
        projectionDigest: sourcePlan.requiredEvidenceDependencies.contentDigest };
    assert.notDeepEqual(validateRequiredEvidenceResults(sourcePlan, [seal(sourceResult)], sourceIdentity), []);
});

test('failed, repeated, duplicate and interrupted execution results fail closed and recover only after current success', () =>
{
    const plan = testPlan();
    const id = ledger.entries[0].producerTierIds[0];
    let result = completeResult(plan);
    result = recordRequiredEvidenceExecution(plan, id, 'failure', result, identity);
    assert.notDeepEqual(validateRequiredEvidenceResults(plan, [result], identity), []);
    result = recordRequiredEvidenceExecution(plan, id, 'cancelled', result, identity);
    assert.notDeepEqual(validateRequiredEvidenceResults(plan, [result], identity), []);
    result = recordRequiredEvidenceExecution(plan, id, 'success', result, identity);
    assert.deepEqual(validateRequiredEvidenceResults(plan, [result], identity), []);
    assert.deepEqual(recordRequiredEvidenceExecution(plan, id, 'success', result, identity), result);
    result.dependencies.push(result.dependencies[0]);
    assert.match(validateRequiredEvidenceResults(plan, [seal(result)], identity).join('; '), /duplicate evidence authority/u);
});

test('catalog changes invalidate scheduler cache fingerprints even with narrow declared inputs', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-evidence-cache-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const catalogFile = path.join(directory, 'config/testing/required-evidence-authority-ledger.json');
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    fs.writeFileSync(catalogFile, JSON.stringify(ledger));
    const tier = { id: 'narrow-producer', command: 'node producer.mjs', cacheInputs: ['producer.mjs'] };
    assert.ok(effectiveCacheInputs(tier).includes('config/testing/required-evidence-authority-ledger.json'));
    const before = tierInputFingerprint(tier, directory);
    fs.writeFileSync(catalogFile, JSON.stringify({ ...ledger, version: 2 }));
    assert.notEqual(tierInputFingerprint(tier, directory), before);
});

test('real checker rejects job success and existing files with zero fallback producer spawns', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-evidence-checker-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const actualIdentity = requiredEvidencePlanIdentity(root, { FSUSBLOG_TEST_RUN_ID: '1686-negative',
        FSUSBLOG_TEST_NAMESPACE: '1686-negative' });
    const plan = testPlan(actualIdentity);
    fs.mkdirSync(path.join(directory, 'jobs'));
    fs.mkdirSync(path.join(directory, 'bin'));
    fs.writeFileSync(path.join(directory, 'test-plan.json'), JSON.stringify(plan));
    const spawnLog = path.join(directory, 'spawn.log');
    for (const command of ['dotnet', 'npm', 'pnpm', 'playwright', 'docker', 'bash'])
    {
        const shim = path.join(directory, 'bin', command);
        fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${spawnLog}'\nexit 97\n`);
        fs.chmodSync(shim, 0o755);
    }
    const stages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary'];
    const documents = ledger.entries.map((entry) => ({ schema: 'fsusblog.ci.job-result.v1',
        jobId: entry.authorityId, ciJob: entry.authorityId, status: 'success', tierIds: entry.producerTierIds,
        localReproduction: entry.localProducerCommand, commit: actualIdentity.sourceCommit,
        runId: actualIdentity.runId, attempt: 1, durationMs: 1, stageDurationsMs: Object.fromEntries(stages.map((stage) => [stage, 0])),
        artifacts: [`${entry.authorityId}.json`] }));
    documents.forEach((document, index) =>
    {
        fs.writeFileSync(path.join(directory, 'jobs', `${index}.json`), JSON.stringify(document));
        fs.writeFileSync(path.join(directory, `${ledger.entries[index].authorityId}.json`), '{}');
    });
    const execute = (extra = []) => spawnSync(process.execPath,
        [path.join(root, 'tools/ci/check-job-summaries.mjs'), '--require-plan', '--tier', 'release-final', ...extra],
        { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`,
            FSUSBLOG_RELEASE_EVIDENCE_DIR: directory, FSUSBLOG_TEST_RUN_ID: actualIdentity.runId,
            FSUSBLOG_TEST_NAMESPACE: actualIdentity.namespace, FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: '' } });
    const rejected = execute();
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /missing current-run producer execution or explicit receipt dependency/u);
    for (const entry of ledger.entries)
    {
        assert.ok(rejected.stderr.includes(entry.localProducerCommand));
    }
    assert.equal(fs.existsSync(spawnLog), false);
    const resultFile = path.join(directory, 'dependency-result.json');
    fs.writeFileSync(resultFile, JSON.stringify(completeResult(plan)));
    const accepted = execute(['--dependency-result', resultFile]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(fs.existsSync(spawnLog), false);
    fs.unlinkSync(path.join(directory, 'test-plan.json'));
    assert.match(execute().stderr, /required test plan is missing/u);
});

test('the three read-only planning modes project actual topology without reading headroom', () =>
{
    const observed = logicalTierPlanningResources();
    assert.deepEqual(observed, {
        availableCpuUnits: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
        totalMemoryGiB: Math.max(Number.EPSILON, os.totalmem() / (1024 ** 3))
    });
    let headroomReads = 0;
    const resources = { ...observed,
        get availableMemoryGiB()
        {
            headroomReads++;
            throw new Error('planning must not require a runnable headroom grant');
        } };
    const metadata = projectLogicalTierPlanningMetadata(matrix.tiers, resources);
    const cpu = Math.floor(observed.availableCpuUnits);
    const ci = buildCiPlan(matrix, 'github-actions', metadata);
    const plan = buildEvidencePlan(matrix, identity, metadata);
    assert.deepEqual(validateRequiredEvidenceTestPlan(plan, identity), []);
    assert.equal(plan.schema, 'fsusblog.release-evidence.test-plan.v1');
    assert.equal(plan.tiers.length, matrix.tiers.length);
    const browserContract = metadata.get('browser-contract');
    assert.equal(browserContract.playwrightWorkers, 1);
    for (const tier of matrix.tiers)
    {
        const entry = metadata.get(tier.id);
        assert.equal(entry.maxParallel, tier.parallelizable ? cpu : 1);
        if (!tier.shardable)
        {
            assert.equal(entry.defaultShards, 1);
        }
        if (tier.requiresPlaywright === 'none')
        {
            assert.equal(entry.playwrightWorkers, null);
        }
        else if (tier.id !== 'browser-contract')
        {
            assert.equal(entry.playwrightWorkers, cpu);
        }
        assert.equal(plan.tiers.find((item) => item.id === tier.id).playwrightWorkers, entry.playwrightWorkers);
    }
    for (const job of ci.jobs)
    {
        assert.equal(job.maxParallel, Math.max(...job.tiers.map((id) => metadata.get(id).maxParallel)));
        assert.deepEqual(job.playwrightWorkers, [...new Set(job.tiers.map((id) => metadata.get(id).playwrightWorkers)
            .filter((workers) => workers !== null))].sort((left, right) => left - right));
    }
    const messages = [];
    const originalLog = console.log;
    try
    {
        console.log = (message) => messages.push(message);
        printPlan([matrix.tiers.find((tier) => tier.id === 'release-final')], matrix, metadata);
    }
    finally
    {
        console.log = originalLog;
    }
    assert.match(messages.join('\n'), /requiredEvidenceDependencies=.*"schedulesProducer":false/u);
    assert.match(messages[0], /timeout=\d+m/u);
    assert.equal(headroomReads, 0);
    const repeat = buildEvidencePlan(matrix, identity, projectLogicalTierPlanningMetadata(matrix.tiers, resources));
    assert.equal(repeat.contentDigest, plan.contentDigest);
});

test('planning annotations cannot become a runnable resource grant or an evidence receipt', () =>
{
    const metadata = projectLogicalTierPlanningMetadata(matrix.tiers);
    for (const [id, entry] of metadata)
    {
        assert.deepEqual(Object.keys(entry).sort(), ['defaultShards', 'maxParallel', 'playwrightWorkers']);
        assert.throws(() => tierResourceUnits({ id, ...entry }), /has no resolved resource grant/u);
    }
    const plan = buildEvidencePlan(matrix, identity, metadata);
    assert.match(validateRequiredEvidenceResults(plan, [...metadata.values()], identity).join('; '),
        /stale plan\/catalog\/identity or invalid digest/u);
    assert.match(validateRequiredEvidenceResults(plan, [], identity).join('; '),
        /missing current-run producer execution or explicit receipt dependency/u);
    for (const tier of [
        { id: 'no-grant' },
        { id: 'no-memory', cpuUnits: 1 },
        { id: 'invalid-memory', cpuUnits: 1, memoryGiB: Number.NaN }
    ])
    {
        assert.throws(() => tierResourceUnits(tier), /has no resolved resource grant/u);
    }
    assert.throws(() => projectLogicalTierPlanningMetadata(matrix.tiers, {}), /requires observed CPU/u);
});

test('planning modes remain usable while grant-bearing paths refuse unavailable physical headroom',
    { skip: process.platform !== 'linux' }, () =>
    {
        const originalRead = fs.readFileSync;
        const originalLog = console.log;
        let headroomReads = 0;
        try
        {
            fs.readFileSync = (file, ...args) =>
            {
                if (String(file) === '/proc/self/cgroup')
                {
                    headroomReads++;
                    throw new Error('negative control: physical headroom authority is unavailable');
                }
                return originalRead(file, ...args);
            };
            syncBuiltinESMExports();
            const messages = [];
            console.log = (message) => messages.push(message);
            buildCiPlan(matrix, 'github-actions');
            buildEvidencePlan(matrix, identity);
            const target = matrix.tiers.find((tier) => tier.id === 'release-final');
            printPlan([target], matrix, projectLogicalTierPlanningMetadata([target]));
            assert.match(messages[0], /release-final/u);
            assert.equal(headroomReads, 0);
            assert.throws(() => buildCiJobMatrix(matrix, 'browser-contract'),
                /Linux cgroup memory cannot read \/proc\/self\/cgroup/u);
            assert.throws(() => logicalTierSystemResources(),
                /Linux cgroup memory cannot read \/proc\/self\/cgroup/u);
            assert.equal(headroomReads, 2);
        }
        finally
        {
            fs.readFileSync = originalRead;
            syncBuiltinESMExports();
            console.log = originalLog;
        }
    });
