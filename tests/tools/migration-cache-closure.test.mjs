import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');

test('matrix fast lanes track the independent Migration implementation and keep the summary a consumer', () =>
{
    const matrix = parseMatrix(fs.readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8'));
    const unit = matrix.tiers.find((tier) => tier.id === 'backend-unit');
    const fast = matrix.tiers.find((tier) => tier.id === 'backend-fast');
    for (const input of [
        'tools/test/build-migration-tests.mjs', 'tools/test/run-migration-tests.mjs',
        'tools/test/migration-build-binding.mjs', 'tools/test/migration-execution-evidence.mjs',
        'tools/test-inventory', 'tests/tools/migration-lane-consumption.test.mjs'
    ])
    {
        assert.ok(unit.cacheInputs.includes(input), input);
    }
    assert.ok(fast.executionDependsOn.includes('backend-unit'));
    assert.ok(fast.cacheInputs.includes('tools/test/lanes/_suite-support.sh'));
    assert.ok(fast.cacheInputs.includes('tools/test/run-migration-tests.mjs'));
    assert.equal(fast.requiresNode, true);
    assert.equal(fast.requiresDotnet, false);
    assert.equal(fast.executionKey, 'backend-fast-summary');
});

test('Migration cache closure includes sealed fixture and split regression owners without deleting Redis inputs', () =>
{
    const matrix = parseMatrix(fs.readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8'));
    const unit = matrix.tiers.find((tier) => tier.id === 'backend-unit');
    const fast = matrix.tiers.find((tier) => tier.id === 'backend-fast');
    const fixtureInputs = [
        'config/testing/test-execution-service-catalog.json',
        'config/schemas/test-execution-service-catalog.schema.json',
        'tools/test-fixtures/services/mysql.mjs', 'tools/test/mysql-fixture-admission.mjs',
        'tools/test-matrix/mysql-fixture-recovery.mjs', 'tools/test/execution-envelope-services.mjs'
    ];
    const regressionInputs = [
        'tests/tools/migration-build-binding.test.mjs',
        'tests/tools/migration-discovery-evidence.test.mjs',
        'tests/tools/migration-operational-execution.test.mjs',
        'tests/tools/migration-lane-consumption.test.mjs',
        'tests/tools/migration-production-producer.test.mjs',
        'tests/tools/migration-cache-closure.test.mjs'
    ];
    for (const input of [...fixtureInputs, ...regressionInputs])
    {
        assert.ok(unit.cacheInputs.includes(input), input);
        const stat = fs.lstatSync(path.join(root, input));
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), input);
    }
    for (const input of ['tools/test/perception-redis-producer.mjs', 'tools/dotnet-affected-tests.sh'])
    {
        assert.ok(unit.cacheInputs.includes(input), input);
    }
    for (const input of ['tools/test/mysql-fixture-admission.mjs', 'tests/tools/migration-lane-consumption.test.mjs'])
    {
        assert.ok(fast.cacheInputs.includes(input), input);
    }
    assert.deepEqual(unit.services, ['mysql']);
    assert.deepEqual(fast.services, []);
});
