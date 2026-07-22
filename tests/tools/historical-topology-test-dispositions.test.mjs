import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const ledger = JSON.parse(readFileSync(
    path.join(root, 'tests/governance/historical-topology-test-dispositions.json'),
    'utf8'
));

function testTitles(source)
{
    return [...source.matchAll(/\btest\(\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]);
}

test('historical topology ledger classifies every baseline test exactly once', () =>
{
    assert.equal(ledger.schema, 'fsusblog.historical-topology-test-dispositions.v1');
    assert.match(ledger.baselineCommit, /^[0-9a-f]{40}$/u);
    assert.ok(ledger.sources.length > 0);

    for (const source of ledger.sources)
    {
        const baseline = spawnSync('git', ['show', `${ledger.baselineCommit}:${source.path}`], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(baseline.status, 0, baseline.stderr || source.path);
        const expected = testTitles(baseline.stdout).toSorted();
        const decisions = [
            ...source.keep,
            ...source.rewrite.map((entry) => entry.before),
            ...source.delete.map((entry) => entry.before)
        ];
        assert.equal(new Set(decisions).size, decisions.length, `${source.path} has duplicate decisions`);
        assert.deepEqual(decisions.toSorted(), expected, `${source.path} ledger drift`);
    }
});

test('rewritten and deleted tests declare semantic replacement owners', () =>
{
    for (const source of ledger.sources)
    {
        for (const entry of [...source.rewrite, ...source.delete])
        {
            assert.ok(entry.replacementTestIds.length > 0, `${source.path}: ${entry.before}`);
            for (const replacement of entry.replacementTestIds)
            {
                assert.doesNotMatch(replacement, /issue-\d+|#\d+/iu, replacement);
            }
        }
    }
});
