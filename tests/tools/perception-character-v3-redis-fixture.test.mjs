import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    CANONICAL_LOCAL_REDIS_TESTS,
    MANDATORY_BURN_FILTER,
    MANDATORY_BURN_TEST,
    parseTrxResults,
    reconcileLocalRedisOutcome
} from '../../tools/test/perception-redis-producer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
            'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.ProviderRejectsCrossNamespaceReplay'
        )
    );
});

test('ordinary backend test filter excludes Fixture=LocalRedis to prevent false-green unit runs', () =>
{
    const suiteSupport = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    assert.match(
        suiteSupport,
        /BACKEND_ORDINARY_TEST_FILTER="[^"]*Fixture!=LocalRedis[^"]*"/u,
        'suite support must exclude Fixture=LocalRedis from ordinary backend test filter'
    );
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
});

test('reconcileLocalRedisOutcome parses passing TRX and produces conforming receipt', () =>
{
    const sampleTrx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="00000000-0000-0000-0000-000000000000" name="LocalRedis" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="11111111-1111-1111-1111-111111111111" testId="ad61e41f-0cd3-9308-0db2-3b9922d07109" testName="${MANDATORY_BURN_TEST}" outcome="Passed" duration="00:00:00.4200000" />
  </Results>
</TestRun>`;

    const receipt = reconcileLocalRedisOutcome({
        trxContent: sampleTrx,
        container: 'fsusblog-perception-v3-redis-test',
        endpoint: '127.0.0.1:6379',
        testAssembly: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
        testAssemblyDigest: `sha256:${'a'.repeat(64)}`,
        filter: MANDATORY_BURN_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true,
        redisLuaCallsBefore: 1,
        redisLuaCallsAfter: 2,
        runId: 'test-run',
        sourceCommit: 'test-commit',
        sourceFingerprint: `sha256:${'b'.repeat(64)}`
    });

    assert.equal(receipt.schema, 'fsusblog.perception-character-v3-redis-fixture.v1');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.totalExecuted, 1);
    assert.deepEqual(receipt.plannedTestIds, [MANDATORY_BURN_TEST]);
    assert.equal(receipt.mandatoryTestOutcome, 'Passed');
    assert.equal(receipt.tests[0].executionStatus, 'executed');
    assert.equal(receipt.tests[0].fullyQualifiedName, MANDATORY_BURN_TEST);
    assert.equal(receipt.tests[0].outcome, 'Passed');
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
        filter: MANDATORY_BURN_FILTER,
        prefixNamespace: 'test:perception-v3-local-redis:test-run:',
        cleanupVerified: true,
        redisLuaCallsBefore: 1,
        redisLuaCallsAfter: 2,
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
