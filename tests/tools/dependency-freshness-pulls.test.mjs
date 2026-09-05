import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRenovatePullRequests, readFreshnessPullPages } from '../../tools/governance/dependency-freshness-pulls.mjs';

const catalog = { items: [{ id: 'a', packageName: 'package-a', group: 'runtime' }] };

test('shared producer mapping preserves bot, dependency, group and exact target identity', () => {
    const pulls = [{ number: 1, state: 'open', title: 'Update package-a to v2.0.0', user: { login: 'renovate[bot]' } }];
    assert.deepEqual(parseRenovatePullRequests(pulls, catalog), [{
        number: 1, state: 'open', dependencyId: 'a', packageName: 'package-a', group: 'runtime', targetVersion: '2.0.0'
    }]);
    pulls[0].user = { login: 'human', type: 'User' };
    assert.deepEqual(parseRenovatePullRequests(pulls, catalog), []);
});

test('open PR beyond the first page is included in canonical mapping', async () => {
    const pages = [];
    const pulls = await readFreshnessPullPages(async (page) => {
        pages.push(page);
        return page === 1
            ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))
            : [{ number: 101, state: 'open', title: 'Update package-a to v2.0.0', user: { login: 'renovate[bot]' } }];
    });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(parseRenovatePullRequests(pulls, catalog)[0].number, 101);
});

test('late API errors and duplicate pages are not accepted as partial snapshots', async () => {
    await assert.rejects(readFreshnessPullPages(async (page) => {
        if (page === 2)
        {
            throw new Error('permission failure');
        }
        return Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
    }), /permission failure/);
    await assert.rejects(readFreshnessPullPages(async () => Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))), /repeated identities/);
});
