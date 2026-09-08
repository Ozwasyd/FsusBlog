import assert from 'node:assert/strict';
import test from 'node:test';

import { collectDependencySupersession } from '../../tools/governance/dependency-pull-supersession.mjs';

const catalog = { items: [{ id: 'a', packageName: 'package-a', group: 'runtime' }, { id: 'b', packageName: 'package-b', group: 'runtime' }] };
const pull = (number, body, packageName = 'package-a') => ({ number, body, title: `Update ${packageName} to v2.0.0`, state: number === 1 ? 'closed' : 'open', user: { login: 'renovate[bot]' } });

test('reciprocal successor resolves closed predecessor without changing freshness state', async () => {
    const result = await collectDependencySupersession({
        pulls: [pull(2, 'Supersedes: #1')], catalog,
        readPullRequest: async (number) => { assert.equal(number, 1); return pull(1, 'Superseded by: #2'); }
    });
    assert.deepEqual(result.relations, [{ dependencyId: 'a', predecessor: 1, successor: 2 }]);
    assert.equal(result.pullRequests.find((item) => item.number === 1).state, 'closed');
});

test('same-package PRs alone never imply a superseding relation', async () => {
    const result = await collectDependencySupersession({ pulls: [pull(1, ''), pull(2, '')], catalog });
    assert.deepEqual(result.relations, []);
});

test('unrelated human PR supersession does not enter dependency governance', async () => {
    const result = await collectDependencySupersession({
        pulls: [{ ...pull(3, 'Supersedes: #99'), user: { login: 'human', type: 'User' } }], catalog,
        readPullRequest: async () => { throw new Error('unrelated PR must not be fetched'); }
    });
    assert.deepEqual(result, { pullRequests: [], relations: [] });
});

test('one-sided references and cross-dependency references fail closed', async () => {
    for (const predecessor of [pull(1, ''), pull(1, 'Superseded by: #2', 'package-b')])
    {
        await assert.rejects(collectDependencySupersession({
            pulls: [pull(2, 'Supersedes: #1'), predecessor], catalog
        }), /missing_backlink|dependency_mismatch/);
    }
});

test('reciprocal cycles are rejected', async () => {
    await assert.rejects(collectDependencySupersession({
        pulls: [pull(1, 'Supersedes: #2\nSuperseded by: #2'), pull(2, 'Supersedes: #1\nSuperseded by: #1')], catalog
    }), /cycle/);
});

test('permission failure while resolving a predecessor rejects the entire snapshot', async () => {
    await assert.rejects(collectDependencySupersession({
        pulls: [pull(2, 'Supersedes: #1')], catalog,
        readPullRequest: async () => { throw new Error('permission failure'); }
    }), /permission failure/);
});
