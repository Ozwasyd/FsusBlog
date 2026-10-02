import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {BUDGETED_LEASE_TEST, BUDGET_CASE_IDS, CANONICAL_LOCAL_REDIS_TESTS, CUTOVER_TEST, LOCAL_REDIS_FILTER, LOCAL_REDIS_PLANNED_TESTS, MANDATORY_BURN_TEST, REDIS_LUA_CASE_IDS, REDIS_LUA_TEST, planOrdinaryLocalRedisMembership, reconcileLocalRedisOutcome, reconcileOrdinaryLocalRedisOutcome} = await import(new URL('../../tools/test/perception-redis-producer.mjs', import.meta.url));
const {projectBackendPlatformPlan, reconcileBackendPlatformOutcome} = await import(new URL('../../tools/test/backend-platform-selection.mjs', import.meta.url));
const {projectProductionPlatformPlan} = await import(new URL('../../tools/test/run-backend-production-shards.mjs', import.meta.url));
const {buildStaticGovernanceExecutionPlan, loadStaticGovernanceRegistry} = await import(new URL('../../tools/test/static-governance-host.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function burnEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.perception-character-v3-burn-redis-calls.v1',
        testId: MANDATORY_BURN_TEST,
        runId: 'test-run',
        sourceCommit: 'test-commit',
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        endpoint: '127.0.0.1:6379',
        prefixNamespace: 'test:perception-v3-local-redis:test-run:artifact-burn:',
        commandCount: 50,
        luaCalls: 40,
        ...overrides
    };
}

function budgetEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.perception-character-v3-budget-cases.v1',
        testId: BUDGETED_LEASE_TEST,
        runId: 'test-run',
        prefixNamespace: 'test:perception-v3-local-redis:test-run:budgeted-lease:',
        endpoint: '127.0.0.1:6379',
        cases: BUDGET_CASE_IDS.map((id, index) => ({
            id, outcome: 'passed', leases: index < 4 ? 1 : 2,
            bytes: index < 4 ? 123 : 245, burnedBytes: index < 4 ? 123 : 245
        })),
        ...overrides
    };
}

test('budgeted lease requires its own exact outcome and current run accounting evidence', () =>
{
    const results = LOCAL_REDIS_PLANNED_TESTS.map((id) =>
        `<UnitTestResult testId="${id}" testName="${id}" outcome="Passed" duration="00:00:00.1" />`);
    const common = {
        trxContent: `<TestRun><Results>${results.join('')}</Results></TestRun>`,
        container: 'budget-test', endpoint: '127.0.0.1:6379',
        testAssembly: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
        testAssemblyDigest: `sha256:${'a'.repeat(64)}`, filter: LOCAL_REDIS_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true, redisLuaCallsBefore: 1, redisLuaCallsAfter: 2,
        redisLuaCaseEvidence: redisLuaCaseEvidence(), redisBudgetEvidence: budgetEvidence(),
        redisCutoverEvidence: cutoverEvidence(),
        redisBurnEvidence: burnEvidence(),
        runId: 'test-run', sourceCommit: 'test-commit', sourceFingerprint: `sha256:${'b'.repeat(64)}`
    };
    assert.equal(reconcileLocalRedisOutcome(common).status, 'passed');
    const variants = [
        { trxContent: `<TestRun>${results.filter((result) => !result.includes(BUDGETED_LEASE_TEST)).join('')}</TestRun>` },
        { trxContent: `<TestRun>${results.join('')}${results.find((result) => result.includes(BUDGETED_LEASE_TEST))}</TestRun>` },
        { trxContent: `<TestRun>${results.map((result) => result.includes(BUDGETED_LEASE_TEST) ? result.replace('Passed', 'Failed') : result).join('')}</TestRun>` },
        { redisBudgetEvidence: null },
        { redisBudgetEvidence: budgetEvidence({ runId: 'old-run' }) },
        { redisBudgetEvidence: budgetEvidence({ prefixNamespace: 'test:perception-v3-local-redis:other:budgeted-lease:' }) },
        { redisBudgetEvidence: budgetEvidence({ endpoint: '127.0.0.1:1' }) },
        { redisBudgetEvidence: budgetEvidence({ cases: [] }) },
        { redisCutoverEvidence: null },
        { redisCutoverEvidence: cutoverEvidence({ runId: 'stale-run' }) },
        { redisCutoverEvidence: cutoverEvidence({ endpoint: '127.0.0.1:1' }) },
        { redisCutoverEvidence: cutoverEvidence({ status: 'failed' }) },
        {
            redisCutoverEvidence: cutoverEvidence({
                namespaceRetirement: { ...cutoverEvidence().namespaceRetirement, envelopeRevoked: false }
            })
        },
        {
            redisCutoverEvidence: cutoverEvidence({
                databaseRevoke: { commandCount: 2, rowsRevoked: 2 }
            })
        },
        {
            redisCutoverEvidence: cutoverEvidence({
                idempotency: { ...cutoverEvidence().idempotency, mutationStable: false }
            })
        },
        {
            redisCutoverEvidence: cutoverEvidence({
                first: { ...cutoverEvidence().first, mutation: { ...cutoverEvidence().first.mutation, deviceKeysRetired: 1 } }
            })
        },
        { cleanupVerified: false }
    ];
    for (const testId of [BUDGETED_LEASE_TEST, CUTOVER_TEST])
    {
        const ownResult = results.find((result) => result.includes(testId));
        assert.ok(ownResult);
        const otherResults = results.filter((result) => !result.includes(testId));
        for (const ownResults of [[], [ownResult, ownResult], [ownResult.replace('Passed', 'Failed')]])
        {
            assert.equal(reconcileLocalRedisOutcome({
                ...common, trxContent: `<TestRun>${[...otherResults, ...ownResults].join('')}</TestRun>`
            }).status, 'failed');
        }
    }
    for (const variant of variants)
    {
        assert.equal(reconcileLocalRedisOutcome({ ...common, ...variant }).status, 'failed');
    }
    for (let index = 0; index < BUDGET_CASE_IDS.length; index += 1)
    {
        for (const field of ['leases', 'bytes', 'burnedBytes'])
        {
            const evidence = budgetEvidence();
            evidence.cases[index][field] += 1;
            assert.equal(reconcileLocalRedisOutcome({ ...common, redisBudgetEvidence: evidence }).status, 'failed');
        }
    }
    assert.throws(() => reconcileLocalRedisOutcome({
        ...common, prefixNamespace: 'test:perception-v3-local-redis:old-run:'
    }), /current run/u);
    assert.throws(() => reconcileLocalRedisOutcome({
        ...common, plannedTestIds: [MANDATORY_BURN_TEST, REDIS_LUA_TEST]
    }), /exact producer filter/u);
});

test('burn Passed with zero own Redis calls fails even when every other test and aggregate pass', () =>
{
    const common = {
        trxContent: `<TestRun>${LOCAL_REDIS_PLANNED_TESTS.map((id) =>
            `<UnitTestResult testId="${id}" testName="${id}" outcome="Passed" />`).join('')}</TestRun>`,
        container: 'burn-test', endpoint: '127.0.0.1:6379',
        testAssembly: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
        testAssemblyDigest: `sha256:${'a'.repeat(64)}`, filter: LOCAL_REDIS_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true, redisLuaCallsBefore: 0, redisLuaCallsAfter: 100,
        redisLuaCaseEvidence: redisLuaCaseEvidence(), redisBudgetEvidence: budgetEvidence(),
        redisCutoverEvidence: cutoverEvidence(), redisBurnEvidence: burnEvidence(),
        runId: 'test-run', sourceCommit: 'test-commit', sourceFingerprint: `sha256:${'b'.repeat(64)}`
    };
    assert.equal(reconcileLocalRedisOutcome(common).status, 'passed');
    for (const evidence of [null, burnEvidence({ commandCount: 0, luaCalls: 0 }),
        burnEvidence({ luaCalls: 0 }), burnEvidence({ runId: 'old-run' }),
        burnEvidence({ sourceCommit: 'old-commit' }), burnEvidence({ sourceFingerprint: `sha256:${'c'.repeat(64)}` }),
        burnEvidence({ testId: BUDGETED_LEASE_TEST }), burnEvidence({ endpoint: '127.0.0.1:1' }),
        burnEvidence({ prefixNamespace: 'test:perception-v3-local-redis:other:artifact-burn:' })])
    {
        const receipt = reconcileLocalRedisOutcome({ ...common, redisBurnEvidence: evidence });
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.mandatoryTestOutcome, 'Passed');
        assert.equal(receipt.redisObservation.observed, true);
        assert.ok(receipt.failureCodes.some((code) => code.startsWith('burn-')));
    }
});

test('ordinary full and production plans record four exact not-selected IDs and reject execution or plan tampering', () =>
{
    const record = { id: 'portable', fullyQualifiedName: 'Example.Portable', traits: {} };
    for (const lane of ['backend-unit', 'backend-production'])
    {
        const plan = projectBackendPlatformPlan([record], 'linux', {
            lane, baseFilter: 'Category!=Integration&Fixture!=LocalRedis'
        });
        assert.deepEqual(plan.localRedisTests.map((test) => test.fullyQualifiedName), LOCAL_REDIS_PLANNED_TESTS);
        assert.ok(plan.localRedisTests.every((test) => test.result === 'not-selected' && test.planned === false));
        assert.deepEqual(reconcileBackendPlatformOutcome(plan, []).localRedisTests, plan.localRedisTests);
        for (const testName of LOCAL_REDIS_PLANNED_TESTS)
        {
            assert.throws(() => reconcileBackendPlatformOutcome(plan, [{ testId: 'unexpected', testName, outcome: 'Passed' }]), /not-selected LocalRedis/u);
        }
        assert.throws(() => reconcileBackendPlatformOutcome({ ...plan, localRedisTests: [] }, []), /all four/u);
    }
    assert.throws(() => planOrdinaryLocalRedisMembership('Category!=Integration'), /conjunctively/u);
    assert.throws(() => planOrdinaryLocalRedisMembership('Fixture!=LocalRedis|Fixture=LocalRedis'), /conjunctively/u);
    const expected = planOrdinaryLocalRedisMembership('Fixture!=LocalRedis');
    for (const filter of ['(FullyQualifiedName=x|FullyQualifiedName=y)&Fixture!=LocalRedis',
        'Fixture!=LocalRedis&(FullyQualifiedName=x|FullyQualifiedName=y)',
        '(Fixture!=LocalRedis&FullyQualifiedName=x)|(Fixture!=LocalRedis&FullyQualifiedName=y)'])
    {
        assert.deepEqual(planOrdinaryLocalRedisMembership(filter), expected);
    }
    for (const filter of ['(Fixture!=LocalRedis&FullyQualifiedName=x)|FullyQualifiedName=y',
        'FullyQualifiedName~Fixture!=LocalRedis', 'Fixture!=LocalRedis|Fixture=LocalRedis',
        'Fixture!=LocalRedis&(FullyQualifiedName=x|FullyQualifiedName=y', 'Fixture!=LocalRedis&',
        '(Fixture!=LocalRedis)FullyQualifiedName=x'])
    {
        assert.throws(() => planOrdinaryLocalRedisMembership(filter));
    }
    const productionRecords = [record, { id: 'integration', traits: { Category: ['Integration'] } },
        ...LOCAL_REDIS_PLANNED_TESTS.map((fullyQualifiedName) => ({
            id: fullyQualifiedName, fullyQualifiedName, traits: { Fixture: ['LocalRedis'] }
        }))];
    for (const platform of ['linux', 'darwin', 'win32'])
    {
        const actualProductionPlan = projectProductionPlatformPlan(productionRecords, platform);
        assert.equal(actualProductionPlan.plannedTestCaseCount, 1);
        assert.deepEqual(actualProductionPlan.localRedisTests, planOrdinaryLocalRedisMembership('Fixture!=LocalRedis'));
    }
});

test('ordinary affected CLI emits a source-bound exact exclusion plan before test execution', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-local-redis-membership-'));
    const output = path.join(directory, 'plan.json');
    const args = [path.join(root, 'tools/test/perception-redis-producer.mjs'), '--ordinary-plan',
        '--lane', 'backend-unit-affected', '--filter', 'Category!=Integration&Fixture!=LocalRedis',
        '--run-id', 'ordinary-test', '--source-commit', 'test-commit',
        '--source-fingerprint', `sha256:${'b'.repeat(64)}`, '--output', output];
    try
    {
        const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(plan.runId, 'ordinary-test');
        assert.equal(plan.sourceCommit, 'test-commit');
        assert.deepEqual(plan.tests.map((test) => test.fullyQualifiedName), LOCAL_REDIS_PLANNED_TESTS);
        assert.ok(plan.tests.every((test) => test.result === 'not-selected' && test.planned === false));
        const ordinaryTrx = '<TestRun><UnitTestResult testId="ordinary" testName="Example.Portable" outcome="Passed" /></TestRun>';
        assert.equal(reconcileOrdinaryLocalRedisOutcome(plan, ordinaryTrx).status, 'passed');
        assert.throws(() => reconcileOrdinaryLocalRedisOutcome(plan, '<TestRun/>'), /executed/u);
        for (const testName of LOCAL_REDIS_PLANNED_TESTS)
        {
            assert.throws(() => reconcileOrdinaryLocalRedisOutcome(plan,
                `<TestRun><UnitTestResult testId="redis" testName="${testName}" outcome="Passed" /></TestRun>`), /not-selected/u);
        }
        const invalid = [...args];
        invalid[invalid.indexOf('--filter') + 1] = 'Category!=Integration';
        assert.notEqual(spawnSync(process.execPath, invalid).status, 0);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function redisLuaCaseEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.perception-character-v3-redis-lua-cases.v1',
        testId: REDIS_LUA_TEST,
        runId: 'test-run',
        prefixNamespace: 'test:perception-v3-local-redis:test-run:redis-lua:',
        cases: REDIS_LUA_CASE_IDS.map((id) => ({ id, outcome: 'passed' })),
        ...overrides
    };
}

function cutoverEvidence(overrides = {})
{
    const mutation = {
        challengeRowsRevoked: 2,
        stateKeysRetired: 1,
        activeIdentityKeysRetired: 1,
        deviceKeysRetired: 2,
        oldPoolGenerationsRevoked: 1,
        envelopesExamined: 1,
        envelopesRevoked: 1,
        retiredStateDigest: 'c'.repeat(64)
    };
    return {
        schema: 'fsusblog.security.perception-character-v3-cutover-fixture.v1',
        testId: CUTOVER_TEST,
        status: 'passed',
        runId: 'test-run',
        prefixNamespace: 'test:perception-v3-local-redis:test-run:cutover:',
        endpoint: '127.0.0.1:6379',
        sourceCommit: 'test-commit',
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        namespaceRetirement: {
            stateKeysRetired: true,
            activeIdentityKeysRetired: true,
            deviceKeysRetired: true,
            oldPoolGenerationsRevoked: true,
            activeGenerationRetained: true,
            envelopeRevoked: true
        },
        databaseRevoke: { commandCount: 1, rowsRevoked: 2 },
        idempotency: {
            repeatedAccepted: true,
            repeatedIdempotent: true,
            receiptFingerprintStable: true,
            mutationStable: true,
            poolLeaseCount: 0
        },
        first: {
            accepted: true,
            idempotent: false,
            receiptFingerprint: 'a'.repeat(64),
            targetFingerprint: 'b'.repeat(64),
            mutation
        },
        second: {
            accepted: true,
            idempotent: true,
            receiptFingerprint: 'a'.repeat(64),
            targetFingerprint: 'b'.repeat(64),
            mutation: { ...mutation }
        },
        ...overrides
    };
}

function assertFixtureClosure(fixture)
{
    for (const file of fixture.closure)
    {
        assert.deepEqual(fs.readFileSync(path.join(fixture.directory, file)), fs.readFileSync(path.join(root, file)), file);
    }
}

function createIsolatedFixtureRoot()
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-local-redis-repository-'));
    const closure = [
        'tools/test/perception-character-v3-redis-fixture.sh',
        'tools/test/perception-redis-producer.mjs',
        'tools/test/execution-envelope-services.mjs',
        'tools/test/process-identity.mjs',
        'tools/test-matrix/execution-envelope-policy.mjs',
        'config/testing/test-execution-service-catalog.json'
    ];
    try
    {
        for (const file of closure)
        {
            const destination = path.join(directory, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(root, file), destination);
        }
        const fixture = { directory, closure };
        assertFixtureClosure(fixture);
        return fixture;
    }
    catch (error)
    {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}

function fixtureEnvironment(directory, inherited = {})
{
    // Hermetic checker fixtures are diagnostic, never qualified runtime evidence.
    return {
        PATH: `${path.join(directory, 'stubs')}:/usr/bin:/bin`,
        LANG: inherited.LANG ?? 'C', LC_ALL: inherited.LC_ALL ?? 'C', TMPDIR: directory,
        FSUSBLOG_NODE: process.execPath,
        FSUSBLOG_TEST_REDIS_HOST: '127.0.0.1',
        FSUSBLOG_TEST_CONFIGURATION: 'Release',
        FSUSBLOG_TEST_RUN_ID: 'hermetic-fixture',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'hermetic-fixture-source',
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'c'.repeat(64)}`,
        FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT: path.join(directory, '.tmp/test-results/backend/cutover.json')
    };
}

function createDockerStubs(fixture, cleanupScanFails)
{
    const stubDirectory = path.join(fixture.directory, 'stubs');
    fs.mkdirSync(stubDirectory);
    fs.symlinkSync(process.execPath, path.join(stubDirectory, 'node'));
    const dockerStub = path.join(stubDirectory, 'docker');
    const sleepStub = path.join(stubDirectory, 'sleep');
    fs.writeFileSync(dockerStub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FSUSBLOG_FAKE_DOCKER_TRACE"
if [[ "$1" == "info" || "$1" == "run" || "$1 $2" == "image inspect" || "$1" == "rm" ]]; then exit 0; fi
if [[ "$1" == "port" ]]; then printf '%s\\n' "$FSUSBLOG_FAKE_DOCKER_PORT"; exit 0; fi
if [[ "$1 $3" == "exec redis-cli" && "$4" == "ping" ]]; then [[ "$FSUSBLOG_FAKE_DOCKER_PING" == "ready" ]] && echo PONG && exit 0; exit 1; fi
if [[ "$FSUSBLOG_FAKE_CLEANUP_SCAN" == true && "$1 $3 $4 $5" == "exec redis-cli --raw --scan" ]]; then
    if [[ -f "$FSUSBLOG_FAKE_SCAN_MARKER" ]]; then exit 1; fi
    touch "$FSUSBLOG_FAKE_SCAN_MARKER"; exit 0
fi
if [[ "$FSUSBLOG_FAKE_CLEANUP_SCAN" == true && "$1 $3 $4 $5" == "exec redis-cli --raw info" ]]; then echo 'cmdstat_eval:calls=1'; exit 0; fi
exit 1
`, { mode: 0o755 });
    fs.writeFileSync(sleepStub, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const producerObserver = path.join(stubDirectory, 'producer-observer');
    fs.writeFileSync(path.join(stubDirectory, 'dotnet'), `#!/usr/bin/env bash
printf 'cwd=%s\\nargs=%s\\ncutover=%s\\n' "$PWD" "$*" "$FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT" > "$FSUSBLOG_FAKE_DOTNET_TRACE"
exit 0
`, { mode: 0o755 });
    if (cleanupScanFails)
    {
        fs.writeFileSync(producerObserver, `#!/usr/bin/env bash
if [[ "$1" == *perception-redis-producer.mjs && "$2" != --print-filter ]]; then
    printf 'observed producer arguments: %s\\n' "$*" >&2
    exit 1
fi
exec "$FSUSBLOG_REAL_NODE" "$@"
`, { mode: 0o755 });
    }
    return { stubDirectory, producerObserver };
}

function runFixtureWithDockerStub({ port = '127.0.0.1:6379', pingReady = false, cleanupScanFails = false, environment = {} } = {})
{
    const fixture = createIsolatedFixtureRoot();
    try
    {
        const { stubDirectory, producerObserver } = createDockerStubs(fixture, cleanupScanFails);
        assertFixtureClosure(fixture);
        const result = spawnSync('/bin/bash', [path.join(fixture.directory, 'tools/test/perception-character-v3-redis-fixture.sh')], {
            cwd: fixture.directory,
            encoding: 'utf8',
            env: {
                ...fixtureEnvironment(fixture.directory, environment),
                FSUSBLOG_FAKE_DOCKER_PORT: port,
                FSUSBLOG_FAKE_DOCKER_PING: pingReady ? 'ready' : 'not-ready',
                FSUSBLOG_FAKE_CLEANUP_SCAN: String(cleanupScanFails),
                FSUSBLOG_FAKE_SCAN_MARKER: path.join(stubDirectory, 'scan-observed'),
                FSUSBLOG_FAKE_DOCKER_TRACE: path.join(stubDirectory, 'docker-trace'),
                FSUSBLOG_FAKE_DOTNET_TRACE: path.join(stubDirectory, 'dotnet-trace'),
                ...(cleanupScanFails ? {
                    FSUSBLOG_NODE: producerObserver,
                    FSUSBLOG_REAL_NODE: process.execPath
                } : {})
            }
        });
        const readTrace = (name) => fs.existsSync(path.join(stubDirectory, name))
            ? fs.readFileSync(path.join(stubDirectory, name), 'utf8') : '';
        return {
            ...result,
            fixtureRoot: fixture.directory,
            outputDirectoryExists: fs.existsSync(path.join(fixture.directory, '.tmp/test-results/backend')),
            dotnetTrace: readTrace('dotnet-trace'),
            dockerTrace: readTrace('docker-trace')
        };
    }
    finally
    {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}

test('canonical shell stubs use byte-exact owned repository closure and confine inherited outputs', (context) =>
{
    assert.equal(typeof createIsolatedFixtureRoot, 'function');
    const fixture = createIsolatedFixtureRoot();
    try
    {
        assert.notEqual(fixture.directory, root);
        for (const file of fixture.closure)
        {
            assert.deepEqual(fs.readFileSync(path.join(fixture.directory, file)), fs.readFileSync(path.join(root, file)));
        }
    }
    finally
    {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
    const result = runFixtureWithDockerStub({
        pingReady: true, cleanupScanFails: true,
        environment: {
            FSUSBLOG_NODE: '/not-owned/node', FSUSBLOG_TEST_REDIS_HOST: 'not-local',
            FSUSBLOG_TEST_SOURCE_COMMIT: 'inherited-source', FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'inherited-fingerprint',
            FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT: path.join(root, '.tmp/test-results/backend/not-owned.json')
        }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test_status=0 producer_status=1/u);
    assert.ok(result.outputDirectoryExists);
    assert.equal(fs.existsSync(result.fixtureRoot), false, 'only the owned temporary repository must be cleaned');
    assert.ok(result.dotnetTrace.includes(result.fixtureRoot));
    assert.ok(result.stderr.includes(path.join(result.fixtureRoot, 'tools/test/perception-redis-producer.mjs')));
    assert.ok(result.stderr.includes(path.join(result.fixtureRoot, '.tmp/test-results/backend/cutover.json')));
    assert.ok(result.stderr.includes('--source-commit hermetic-fixture-source'));
    assert.ok(result.stderr.includes('--cleanup-verified false'));
    assert.equal(result.stderr.includes(root), false, 'producer arguments must not address the current checkout');
    assert.equal(result.dotnetTrace.includes(root), false);
    assert.match(result.dockerTrace, /rm -f fsusblog-perception-v3-redis-hermetic-fixture-/u);
    context.diagnostic(JSON.stringify({
        fixtureRoot: result.fixtureRoot, status: result.status,
        stdout: result.stdout, stderr: result.stderr,
        dockerTrace: result.dockerTrace, dotnetTrace: result.dotnetTrace,
        cleanupVerified: !fs.existsSync(result.fixtureRoot),
        scope: 'hermetic checker orchestration, not LocalRedis qualification'
    }));
});

test('isolated canonical fixture rejects missing or altered copied support bytes', () =>
{
    for (const mutation of ['missing', 'altered'])
    {
        const fixture = createIsolatedFixtureRoot();
        try
        {
            const target = path.join(fixture.directory, 'tools/test/perception-redis-producer.mjs');
            if (mutation === 'missing')
            {
                fs.unlinkSync(target);
            }
            else
            {
                fs.appendFileSync(target, '\n// changed fixture support\n');
            }
            assert.throws(() => assertFixtureClosure(fixture));
        }
        finally
        {
            fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
    }
});

test('canonical registry plans the isolated LocalRedis checker suite exactly once on the existing temporary host', () =>
{
    const registryPath = path.join(root, 'tests/governance/test-lifecycle-registry.json');
    const file = 'tests/tools/perception-character-v3-redis-fixture.test.mjs';
    const entries = JSON.parse(fs.readFileSync(registryPath, 'utf8')).nodeTests.filter((entry) => entry.file === file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].owner, 'repository-governance:static-node-contracts');
    assert.equal(entries[0].executionCategory, 'repository-governance');
    assert.equal(entries[0].lifecycle, 'canonical-execution');
    assert.equal(entries[0].physicalExecutionCount, 1);
    const plan = buildStaticGovernanceExecutionPlan(loadStaticGovernanceRegistry(registryPath, root));
    const hosts = plan.hosts.filter((host) => host.checks.some((check) => check.file === file));
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].category, 'isolated-temporary-repository-fixture');
    assert.equal(hosts[0].id, 'host:temporary-repository');
    assert.equal(hosts[0].checks.filter((check) => check.file === file).length, 1);
});

test('canonical LocalRedis producer registers all four Perception V3 tests under single shared owner', () =>
{
    assert.equal(CANONICAL_LOCAL_REDIS_TESTS.length, 4);
    assert.ok(CANONICAL_LOCAL_REDIS_TESTS.includes(MANDATORY_BURN_TEST));
    assert.ok(
        CANONICAL_LOCAL_REDIS_TESTS.includes(
            'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.BudgetedLeaseAtomicallyAccountsExactBytesQuotasAndRetryIdentity'
        )
    );
    assert.ok(
        CANONICAL_LOCAL_REDIS_TESTS.includes(
            'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3ContractCutoverTests.RedisStore_RetiresAllV3NamespacesAndEnvelopeIdempotently'
        )
    );
    assert.ok(
        CANONICAL_LOCAL_REDIS_TESTS.includes(
            REDIS_LUA_TEST
        )
    );
    assert.deepEqual(
        LOCAL_REDIS_PLANNED_TESTS,
        [MANDATORY_BURN_TEST, REDIS_LUA_TEST, BUDGETED_LEASE_TEST, CUTOVER_TEST]
    );
    assert.equal(
        LOCAL_REDIS_FILTER,
        `Fixture=LocalRedis&(FullyQualifiedName=${MANDATORY_BURN_TEST}|FullyQualifiedName=${REDIS_LUA_TEST}|FullyQualifiedName=${BUDGETED_LEASE_TEST}|FullyQualifiedName=${CUTOVER_TEST})`
    );
});

test('simulated post-test Docker scan failure reaches producer as unverified cleanup without a forged receipt', () =>
{
    const failed = runFixtureWithDockerStub({ pingReady: true, cleanupScanFails: true });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /observed producer arguments:.*--cleanup-verified false/u);
    assert.match(failed.stderr, /test_status=0 producer_status=1/u);
});

test('ordinary backend test filter excludes Fixture=LocalRedis to prevent false-green unit runs', () =>
{
    const suiteSupport = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    const productionRunner = fs.readFileSync(path.join(root, 'tools/test/run-backend-production-shards.mjs'), 'utf8');
    const affectedRunner = fs.readFileSync(path.join(root, 'tools/dotnet-affected-tests.sh'), 'utf8');
    assert.match(affectedRunner, /ordinaryFilter="\$\{FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-Category!=Integration&Fixture!=LocalRedis\}"/u);
    assert.match(affectedRunner, /--filter "\$ordinaryFilter"/u);
    assert.match(affectedRunner, /--ordinary-plan/u);
    assert.match(
        suiteSupport,
        /BACKEND_ORDINARY_TEST_FILTER="[^"]*Fixture!=LocalRedis[^"]*"/u,
        'suite support must exclude Fixture=LocalRedis from ordinary backend test filter'
    );
    assert.match(
        productionRunner,
        /productionBaseFilter = '[^']*Fixture!=LocalRedis[^']*'/u,
        'production union must exclude Fixture=LocalRedis for the canonical Redis producer'
    );
});

test('BudgetedLease test fails closed and contains no early return on missing FSUSBLOG_TEST_REDIS', () =>
{
    const testFile = fs.readFileSync(
        path.join(root, 'tests/backend/Unit/PerceptionCharacterV3ArtifactPoolTests.cs'),
        'utf8'
    );
    const methodIndex = testFile.indexOf('BudgetedLeaseAtomicallyAccountsExactBytesQuotasAndRetryIdentity');
    assert.ok(methodIndex > 0, 'BudgetedLease test method must exist');

    const methodBody = testFile.slice(
        methodIndex,
        testFile.indexOf('private static PerceptionCharacterV3LeaseBudget Budget', methodIndex)
    );
    assert.doesNotMatch(
        methodBody,
        /if\s*\(\s*string\.IsNullOrWhiteSpace\s*\(\s*connectionString\s*\)\s*\)\s*return\s*;/u,
        'BudgetedLease test must not return early on empty connection string'
    );
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS environment variable is not set/u);
    assert.match(methodBody, /LocalRedis run identity is required/u);
    assert.match(methodBody, /LocalRedis prefix is required/u);
    assert.match(methodBody, /LocalRedis budget evidence path is required/u);
    assert.match(methodBody, /redisPrefixRoot \+ "budgeted-lease:"/u);
    assert.match(methodBody, /fsusblog\.perception-character-v3-budget-cases\.v1/u);
});

test('ArtifactPoolBurn test fails closed and contains no early return on missing FSUSBLOG_TEST_REDIS', () =>
{
    const testFile = fs.readFileSync(
        path.join(root, 'tests/backend/Unit/PerceptionCharacterV3ArtifactPoolTests.cs'),
        'utf8'
    );
    const methodIndex = testFile.indexOf('ArtifactPoolBurnSurvivesCancellationProcessInterruptionAndAmbiguousReply');
    assert.ok(methodIndex > 0, 'ArtifactPoolBurn test method must exist');

    const methodBody = testFile.slice(methodIndex, testFile.indexOf('public async Task BudgetedLease', methodIndex));
    assert.doesNotMatch(
        methodBody,
        /if\s*\(\s*string\.IsNullOrWhiteSpace\s*\(\s*connectionString\s*\)\s*\)\s*return\s*;/u,
        'ArtifactPoolBurn test must not return early on empty connection string'
    );
    assert.match(
        methodBody,
        /throw new InvalidOperationException/u,
        'ArtifactPoolBurn test must throw when FSUSBLOG_TEST_REDIS is not set'
    );
    assert.match(methodBody, /RegisterProfiler/u);
    assert.match(methodBody, /FinishProfiling/u);
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS_BURN_EVIDENCE/u);
});

test('RedisLua state and device authority test fails closed and binds canonical prefix and case evidence', () =>
{
    const testFile = fs.readFileSync(
        path.join(root, 'tests/backend/Unit/PerceptionCharacterV3Tests.cs'),
        'utf8'
    );
    const methodIndex = testFile.indexOf('RedisLua_IsLinearizableBoundedBindingAwareAndFailClosed');
    assert.ok(methodIndex > 0, 'RedisLua test method must exist');

    const methodBody = testFile.slice(methodIndex, testFile.indexOf('private static SecurityChallengeKind Parse', methodIndex));
    assert.doesNotMatch(
        methodBody,
        /if\s*\(\s*string\.IsNullOrWhiteSpace\s*\(\s*connectionString\s*\)\s*\)\s*return\s*;/u,
        'RedisLua test must not return early on empty connection string'
    );
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS environment variable is not set/u);
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS_PREFIX environment variable is not set/u);
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS_CASE_EVIDENCE environment variable is not set/u);
    assert.match(methodBody, /redisPrefixRoot \+ "redis-lua:"/u);
    assert.match(methodBody, /fsusblog\.perception-character-v3-redis-lua-cases\.v1/u);
});

test('cutover RedisStore test fails closed and binds the canonical current-run evidence identity', () =>
{
    const testFile = fs.readFileSync(
        path.join(root, 'tests/backend/Unit/PerceptionCharacterV3ContractCutoverTests.cs'),
        'utf8'
    );
    const methodIndex = testFile.indexOf('RedisStore_RetiresAllV3NamespacesAndEnvelopeIdempotently');
    assert.ok(methodIndex > 0, 'cutover RedisStore test method must exist');
    const methodBody = testFile.slice(
        methodIndex,
        testFile.indexOf('public async Task ProtectedEndpoint', methodIndex)
    );
    assert.doesNotMatch(
        methodBody,
        /if\s*\(\s*string\.IsNullOrWhiteSpace\s*\(\s*connectionString\s*\)\s*\)[\s\S]{0,80}?return\s*;/u
    );
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS environment variable is not set/u);
    assert.match(methodBody, /FSUSBLOG_TEST_REDIS_PREFIX/u);
    assert.match(methodBody, /FSUSBLOG_TEST_LOCAL_REDIS_RUN_ID/u);
    assert.match(methodBody, /FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT/u);
    assert.match(methodBody, /FSUSBLOG_TEST_SOURCE_COMMIT/u);
    assert.match(methodBody, /FSUSBLOG_TEST_SOURCE_FINGERPRINT/u);
    assert.match(methodBody, /fsusblog\.security\.perception-character-v3-cutover-fixture\.v1/u);
    assert.match(methodBody, /activeGenerationRetained/u);
    assert.match(methodBody, /envelopeRevoked/u);
    assert.match(methodBody, /update\.Received\(1\)/u);
    assert.match(methodBody, /DidNotReceive\(\)\.LeaseAsync/u);
});

test('perception-character-v3-redis-fixture.sh binds fail-closed container lifecycle and outcome reconciliation', () =>
{
    const script = fs.readFileSync(
        path.join(root, 'tools/test/perception-character-v3-redis-fixture.sh'),
        'utf8'
    );
    assert.match(script, /command -v docker/u);
    assert.match(script, /docker info/u);
    assert.match(script, /trap Cleanup EXIT/u);
    assert.match(script, /redis-cli ping/u);
    assert.match(script, /FSUSBLOG_TEST_REDIS=/u);
    assert.match(script, /FSUSBLOG_TEST_REDIS_PREFIX=/u);
    assert.match(script, /FSUSBLOG_TEST_REDIS_CASE_EVIDENCE=/u);
    assert.match(script, /FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT=/u);
    assert.match(script, /redis_cutover_evidence="\$\{FSUSBLOG_V3_CUTOVER_EVIDENCE_OUT:-/u);
    assert.match(script, /--print-filter/u);
    assert.match(script, /redis-cli --raw --scan --pattern/u);
    assert.match(script, /RedisLuaCalls/u);
    assert.match(script, /snapshotGitWorktree/u);
    assert.match(script, /perception-redis-producer\.mjs/u);
});

test('LocalRedis runner fails closed when Docker is unavailable, port parsing fails, or PING is not ready', () =>
{
    const unavailableFixture = createIsolatedFixtureRoot();
    const unavailableDirectory = path.join(unavailableFixture.directory, 'stubs');
    fs.mkdirSync(unavailableDirectory);
    fs.symlinkSync('/usr/bin/dirname', path.join(unavailableDirectory, 'dirname'));
    try
    {
        const unavailable = spawnSync(
            '/bin/bash',
            [path.join(unavailableFixture.directory, 'tools/test/perception-character-v3-redis-fixture.sh')],
            {
                cwd: unavailableFixture.directory,
                encoding: 'utf8',
                env: { ...fixtureEnvironment(unavailableFixture.directory), PATH: unavailableDirectory }
            }
        );
        assert.notEqual(unavailable.status, 0);
        assert.match(unavailable.stderr, /docker is required/u);
    }
    finally
    {
        fs.rmSync(unavailableFixture.directory, { recursive: true, force: true });
    }

    const invalidPort = runFixtureWithDockerStub({ port: 'invalid' });
    assert.notEqual(invalidPort.status, 0);
    assert.match(invalidPort.stderr, /failed to resolve published port/u);

    const pingNotReady = runFixtureWithDockerStub({ port: '127.0.0.1:6379' });
    assert.notEqual(pingNotReady.status, 0);
    assert.match(pingNotReady.stderr, /failed to respond to PING/u);

    const scanFailed = runFixtureWithDockerStub({ pingReady: true });
    assert.notEqual(scanFailed.status, 0);
    assert.match(scanFailed.stderr, /failed to inspect the Redis prefix/u);

    const nonlocalFixture = createIsolatedFixtureRoot();
    try
    {
        const nonlocalHost = spawnSync('/bin/bash', [path.join(nonlocalFixture.directory, 'tools/test/perception-character-v3-redis-fixture.sh')], {
            cwd: nonlocalFixture.directory,
            encoding: 'utf8',
            env: { ...fixtureEnvironment(nonlocalFixture.directory), FSUSBLOG_TEST_REDIS_HOST: 'not-local' }
        });
        assert.notEqual(nonlocalHost.status, 0);
        assert.match(nonlocalHost.stderr, /local Docker host/u);
    }
    finally
    {
        fs.rmSync(nonlocalFixture.directory, { recursive: true, force: true });
    }
});

test('reconcileLocalRedisOutcome parses passing TRX and produces conforming receipt', () =>
{
    const sampleTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="00000000-0000-0000-0000-000000000000" name="LocalRedis" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="11111111-1111-1111-1111-111111111111" testId="ad61e41f-0cd3-9308-0db2-3b9922d07109" testName="${MANDATORY_BURN_TEST}" outcome="Passed" duration="00:00:00.4200000" />
    <UnitTestResult executionId="22222222-2222-2222-2222-222222222222" testId="bd61e41f-0cd3-9308-0db2-3b9922d07109" testName="${REDIS_LUA_TEST}" outcome="Passed" duration="00:00:00.8400000" />
    <UnitTestResult testId="budget" testName="${BUDGETED_LEASE_TEST}" outcome="Passed" duration="00:00:00.8400000" />
    <UnitTestResult testId="cutover" testName="${CUTOVER_TEST}" outcome="Passed" duration="00:00:00.8400000" />
  </Results>
</TestRun>`;

    const receipt = reconcileLocalRedisOutcome({
        trxContent: sampleTrx,
        container: 'fsusblog-perception-v3-redis-test',
        endpoint: '127.0.0.1:6379',
        testAssembly: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
        testAssemblyDigest: `sha256:${'a'.repeat(64)}`,
        filter: LOCAL_REDIS_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true,
        redisLuaCallsBefore: 1,
        redisLuaCallsAfter: 2,
        redisLuaCaseEvidence: redisLuaCaseEvidence(),
        redisBudgetEvidence: budgetEvidence(),
        redisCutoverEvidence: cutoverEvidence(),
        redisBurnEvidence: burnEvidence(),
        runId: 'test-run',
        sourceCommit: 'test-commit',
        sourceFingerprint: `sha256:${'b'.repeat(64)}`
    });

    assert.equal(receipt.schema, 'fsusblog.perception-character-v3-redis-fixture.v1');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.totalExecuted, 4);
    assert.deepEqual(receipt.plannedTestIds, [MANDATORY_BURN_TEST, REDIS_LUA_TEST, BUDGETED_LEASE_TEST, CUTOVER_TEST]);
    assert.equal(receipt.mandatoryTestOutcome, 'Passed');
    assert.equal(receipt.tests[0].executionStatus, 'executed');
    assert.equal(receipt.tests[0].fullyQualifiedName, MANDATORY_BURN_TEST);
    assert.equal(receipt.tests[0].outcome, 'Passed');
    assert.equal(receipt.tests[1].fullyQualifiedName, REDIS_LUA_TEST);
    assert.equal(receipt.tests[1].outcome, 'Passed');
    assert.equal(receipt.tests[2].fullyQualifiedName, BUDGETED_LEASE_TEST);
    assert.equal(receipt.tests[2].outcome, 'Passed');
    assert.equal(receipt.tests[3].fullyQualifiedName, CUTOVER_TEST);
    assert.equal(receipt.tests[3].outcome, 'Passed');
    assert.equal(receipt.redisLuaCaseEvidence.identityMatches, true);
    assert.equal(receipt.redisLuaCaseEvidence.cases.length, REDIS_LUA_CASE_IDS.length);
    assert.equal(receipt.redisCutoverEvidence.identityMatches, true);
    assert.equal(receipt.container, 'fsusblog-perception-v3-redis-test');
    assert.equal(receipt.endpoint, '127.0.0.1:6379');
});

test('reconcileLocalRedisOutcome records missing, failed, no-Redis-call and cleanup outcomes as failed', () =>
{
    const emptyTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="00000000-0000-0000-0000-000000000000" name="LocalRedis" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
  </Results>
</TestRun>`;

    const common = {
        container: 'test',
        endpoint: '127.0.0.1:6379',
        testAssembly: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
        testAssemblyDigest: `sha256:${'a'.repeat(64)}`,
        filter: LOCAL_REDIS_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true,
        redisLuaCallsBefore: 1,
        redisLuaCallsAfter: 2,
        redisLuaCaseEvidence: redisLuaCaseEvidence(),
        redisBudgetEvidence: budgetEvidence(),
        runId: 'test-run',
        sourceCommit: 'test-commit',
        sourceFingerprint: `sha256:${'b'.repeat(64)}`
    };

    const emptyReceipt = reconcileLocalRedisOutcome({ trxContent: emptyTrx, ...common });
    assert.equal(emptyReceipt.status, 'failed');
    assert.ok(emptyReceipt.failureCodes.includes('zero-tests-executed'));
    assert.ok(emptyReceipt.failureCodes.includes('planned-test-not-executed'));
    assert.equal(emptyReceipt.tests[0].executionStatus, 'not-executed');

    const failedTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="00000000-0000-0000-0000-000000000000" name="LocalRedis" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="11111111-1111-1111-1111-111111111111" testId="ad61e41f-0cd3-9308-0db2-3b9922d07109" testName="${MANDATORY_BURN_TEST}" outcome="Failed" duration="00:00:00.4200000" />
  </Results>
</TestRun>`;

    const failedReceipt = reconcileLocalRedisOutcome({ trxContent: failedTrx, ...common });
    assert.equal(failedReceipt.status, 'failed');
    assert.ok(failedReceipt.failureCodes.includes('test-outcome-not-passed'));

    const noCallsReceipt = reconcileLocalRedisOutcome({
        trxContent: failedTrx.replace('outcome="Failed"', 'outcome="Passed"'),
        ...common,
        redisLuaCallsAfter: 1
    });
    assert.equal(noCallsReceipt.status, 'failed');
    assert.ok(noCallsReceipt.failureCodes.includes('no-test-redis-lua-calls'));

    const cleanupFailureReceipt = reconcileLocalRedisOutcome({
        trxContent: failedTrx.replace('outcome="Failed"', 'outcome="Passed"'),
        ...common,
        cleanupVerified: false
    });
    assert.equal(cleanupFailureReceipt.status, 'failed');
    assert.ok(cleanupFailureReceipt.failureCodes.includes('prefix-cleanup-not-verified'));
});

test('reconcileLocalRedisOutcome rejects missing, partial, failed and cross-run RedisLua case evidence', () =>
{
    const passingTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>
  <UnitTestResult testId="1" testName="${MANDATORY_BURN_TEST}" outcome="Passed" duration="00:00:00.1" />
  <UnitTestResult testId="2" testName="${REDIS_LUA_TEST}" outcome="Passed" duration="00:00:00.2" />
</Results></TestRun>`;
    const common = {
        trxContent: passingTrx,
        container: 'test',
        endpoint: '127.0.0.1:6379',
        testAssembly: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
        testAssemblyDigest: `sha256:${'a'.repeat(64)}`,
        filter: LOCAL_REDIS_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true,
        redisLuaCallsBefore: 1,
        redisLuaCallsAfter: 2,
        runId: 'test-run',
        sourceCommit: 'test-commit',
        sourceFingerprint: `sha256:${'b'.repeat(64)}`
    };

    const missing = reconcileLocalRedisOutcome({ ...common, redisLuaCaseEvidence: null });
    assert.equal(missing.status, 'failed');
    assert.ok(missing.failureCodes.includes('redis-lua-case-evidence-missing'));

    const partial = reconcileLocalRedisOutcome({
        ...common,
        redisLuaCaseEvidence: redisLuaCaseEvidence({ cases: redisLuaCaseEvidence().cases.slice(0, -1) })
    });
    assert.equal(partial.status, 'failed');
    assert.ok(partial.failureCodes.includes('redis-lua-case-inventory-mismatch'));

    const failedCases = redisLuaCaseEvidence().cases.map((entry, index) =>
        index === 0 ? { ...entry, outcome: 'failed' } : entry);
    const failed = reconcileLocalRedisOutcome({
        ...common,
        redisLuaCaseEvidence: redisLuaCaseEvidence({ cases: failedCases })
    });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.failureCodes.includes('redis-lua-case-not-passed'));

    const crossRun = reconcileLocalRedisOutcome({
        ...common,
        redisLuaCaseEvidence: redisLuaCaseEvidence({ runId: 'stale-run' })
    });
    assert.equal(crossRun.status, 'failed');
    assert.ok(crossRun.failureCodes.includes('redis-lua-case-identity-mismatch'));
});
