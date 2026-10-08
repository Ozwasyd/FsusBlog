import assert from 'node:assert/strict';
import test from 'node:test';

const { appendWorkflowNeedToJob } = await import(new URL('../../tools/test-matrix/workflow-fixture-needs.mjs', import.meta.url));
const { parseWorkflowJobNeeds } = await import(new URL('../../tools/yaml/workflow-structure.mjs', import.meta.url));
const shape = { fieldIndent: 8, jobIndent: 4 };

for (const needs of [
    '        needs: [validate-matrix, production-build-artifacts]',
    '        needs:\n            - validate-matrix\n            - production-build-artifacts'
])
{
    test(`workflow denial fixture retains ${needs.includes('[') ? 'flow' : 'block'} dependencies and injects the forbidden edge`, () =>
    {
        const source = `    production-summary:\n${needs}\n        if: always()\n        steps:\n            - run: echo summary\n`;
        const updated = appendWorkflowNeedToJob(source, shape, 'browser-contract');
        const prefix = 'jobs:\n    validate-matrix:\n        runs-on: ubuntu-latest\n    production-build-artifacts:\n        needs: [validate-matrix]\n';
        const suffix = '    unrelated:\n        needs: [validate-matrix]\n';
        const before = parseWorkflowJobNeeds(prefix + source + suffix);
        const after = parseWorkflowJobNeeds(prefix + updated + suffix);
        assert.deepEqual([...after.get('production-summary')].sort(), [
            'browser-contract', 'production-build-artifacts', 'validate-matrix'
        ]);
        assert.deepEqual(after.get('production-build-artifacts'), before.get('production-build-artifacts'));
        assert.deepEqual(after.get('unrelated'), before.get('unrelated'));
        assert.ok(updated.endsWith('        if: always()\n        steps:\n            - run: echo summary\n'));
    });
}

test('workflow denial fixture handles an empty flow sequence without inventing existing edges', () =>
{
    const updated = appendWorkflowNeedToJob('    production-summary:\n        needs: []\n', shape, 'browser-contract');
    assert.deepEqual([...parseWorkflowJobNeeds('jobs:\n' + updated).get('production-summary')], ['browser-contract']);
});

for (const field of ['', '        needs: [validate-matrix\n', '        needs: validate-matrix\n'])
{
    test(`workflow denial fixture refuses missing or unsupported needs ${JSON.stringify(field)}`, () =>
    {
        assert.throws(() => appendWorkflowNeedToJob(`    production-summary:\n${field}`, shape, 'browser-contract'),
            /missing needs|must use a block or flow sequence/u);
    });
}
