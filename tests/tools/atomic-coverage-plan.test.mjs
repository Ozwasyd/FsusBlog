import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { coverageProducerIds, createCoveragePlan, validateCoveragePlan } from '../../tools/coverage/atomic-coverage-plan.mjs';
import { coverageFixture } from './support/atomic-coverage-fixtures.mjs';

function variables(producer)
{
    return Object.fromEntries(producer.command.slice(1, -2).map((item) => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
}

test('collection and threshold declarations preserve only real hard edges and projection has no command', (t) =>
{
    const { plan } = coverageFixture(t);
    assert.deepEqual(plan.producers.map((item) => item.id), coverageProducerIds);
    assert.deepEqual(plan.producers.map((item) => item.dependsOn), [[], [], ['coverage-backend', 'coverage-frontend'],
        ['coverage-merge'], ['coverage-merge'], ['coverage-backend'], ['coverage-frontend']]);
    for (const producer of plan.producers)
    {
        assert.equal(producer.allowedRetries, 0);
        assert.equal(producer.attemptNumber, 1);
        assert.equal(producer.command.filter((item) => item === 'bash').length, 1);
        assert.equal(variables(producer).FSUSBLOG_COVERAGE_SKIP_TESTS, '0');
    }
    assert.ok(plan.projections.every((item) => !('command' in item)));
    assert.equal(plan.qualificationEligible, false);
});

test('active threshold defaults and inherited global function override match the existing lane', (t) =>
{
    const { root, plan, identity } = coverageFixture(t);
    assert.deepEqual(plan.producers.slice(4).map((producer) =>
    {
        const env = variables(producer);
        return [env.FSUSBLOG_COVERAGE_LINE_THRESHOLD, env.FSUSBLOG_COVERAGE_BRANCH_THRESHOLD, env.FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD];
    }), [['35', '20', '30'], ['75', '55', '95'], ['0', '0', '0']]);
    const custom = createCoveragePlan({ root, identity, environment: {
        FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD: '82', FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD: '77',
        FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD: '12', FSUSBLOG_COVERAGE_LINE_THRESHOLD: ''
    } });
    assert.equal(variables(custom.producers[4]).FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD, '82');
    assert.equal(variables(custom.producers[5]).FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD, '82');
    assert.equal(variables(custom.producers[5]).FSUSBLOG_COVERAGE_LINE_THRESHOLD, '77');
    assert.equal(variables(custom.producers[6]).FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD, '12');
    assert.equal(variables(custom.producers[4]).FSUSBLOG_COVERAGE_LINE_THRESHOLD, '35');
});

test('identical local/CI inputs have one digest and source/path/policy mutations are rejected', (t) =>
{
    const { root, plan, identity } = coverageFixture(t);
    assert.deepEqual(createCoveragePlan({ root, identity }), plan);
    const changed = structuredClone(plan);
    changed.producers[2].dependsOn.pop();
    assert.throws(() => validateCoveragePlan(changed, root), /plan or command\/policy source drift/u);
    assert.throws(() => createCoveragePlan({ root, identity, environment: { FSUSBLOG_COVERAGE_SKIP_TESTS: '1' } }), /unknown policy/u);
    assert.throws(() => createCoveragePlan({ root, identity, coverageRoot: '.tmp/coverage/../old' }), /coverage root/u);
    fs.appendFileSync(path.join(root, 'tools/coverage/check-threshold.sh'), '\n# source drift\n');
    assert.throws(() => validateCoveragePlan(plan, root), /source drift/u);
});
