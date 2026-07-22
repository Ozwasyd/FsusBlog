import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(root, 'tools/governance/check-article-core-test-api.mjs');
const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/governance/article-core-compatibility-retirement.json'),
    'utf8'
));

function runChecker(...args)
{
    return spawnSync(process.execPath, [checker, ...args], {
        cwd: root,
        encoding: 'utf8'
    });
}

test('retirement inventory binds the complete helper and 71 call sites', () =>
{
    assert.equal(inventory.schema, 'fsusblog.article-core-compatibility-retirement.v1');
    assert.match(inventory.baselineCommit, /^[0-9a-f]{40}$/u);
    assert.equal(inventory.retiredMethods.length, 26);
    assert.equal(inventory.retiredMethods.reduce((sum, method) => sum + method.sourceCallCount, 0), 71);
    assert.equal(inventory.callSiteInventory.reduce((sum, file) => sum + file.sourceCallCount, 0), 71);
    assert.deepEqual(inventory.callSiteInventory.map(({ path: file }) => file).sort(), [
        'tests/backend/Unit/ArticleEndpointServiceTests.cs',
        'tests/backend/Unit/ArticleRevisionConcurrencyTests.cs',
        'tests/backend/Unit/ArticleRightsWritePathTests.cs',
        'tests/backend/Unit/CoreServiceTests.cs'
    ]);
    assert.equal(inventory.testUniverseDelta.removedTestIds.length, 5);
    assert.equal(inventory.testUniverseDelta.addedTestIds.length, 19);
    assert.equal(inventory.testUniverseDelta.movedTestIds.length, 5);
    assert.deepEqual(
        inventory.testUniverseDelta.movedTestIds.map((entry) => entry.before).sort(),
        [...inventory.testUniverseDelta.removedTestIds].sort()
    );
    for (const entry of inventory.testUniverseDelta.movedTestIds)
    {
        assert.ok(inventory.testUniverseDelta.addedTestIds.includes(entry.after));
    }

    const currentTestSources = inventory.callSiteInventory
        .map((entry) => fs.readFileSync(path.join(root, entry.path), 'utf8'))
        .concat([
            fs.readFileSync(path.join(root, 'tests/backend/Unit/ArticleCoreServiceCurrentApiTests.cs'), 'utf8'),
            fs.readFileSync(path.join(root, 'tests/backend/Unit/ArticleEndpointServiceCurrentApiTests.cs'), 'utf8'),
            fs.readFileSync(path.join(root, 'tests/backend/Unit/ArticleDestructiveMutationBehaviorTests.cs'), 'utf8'),
            fs.readFileSync(path.join(root, 'tests/backend/Unit/ArticleServiceValidationTests.cs'), 'utf8'),
            fs.readFileSync(path.join(root, 'tests/backend/Unit/PublicAotBootstrapProviderTests.cs'), 'utf8')
        ])
        .join('\n');
    for (const entry of inventory.testUniverseDelta.movedTestIds)
    {
        const method = entry.after.split('.').at(-1);
        assert.match(currentTestSources, new RegExp(`\\b${method}\\b`, 'u'), entry.after);
    }
    for (const id of inventory.testUniverseDelta.addedTestIds.filter((value) => value.startsWith('xunit:')))
    {
        const method = id.split('.').at(-1);
        assert.match(currentTestSources, new RegExp(`\\b${method}\\b`, 'u'), id);
    }
    assert.equal(
        inventory.testUniverseDelta.addedTestIds.filter((value) => value.startsWith('node-test:')).length,
        3
    );
    assert.deepEqual(Object.keys(inventory.assertionMapping).sort(), [
        'business-behavior-retained',
        'cancellation',
        'context-actor-permission',
        'defaults',
        'field-mapping',
        'pagination-filter-order',
        'validation-error-boundary'
    ]);
    for (const owners of Object.values(inventory.assertionMapping))
    {
        assert.ok(owners.length > 0);
        for (const owner of owners)
        {
            assert.match(currentTestSources, new RegExp(`\\b${owner.split('.').at(-1)}\\b`, 'u'), owner);
        }
    }

    for (const entry of inventory.callSiteInventory)
    {
        for (const owner of entry.replacementAssertionOwners)
        {
            assert.match(currentTestSources, new RegExp(`\\b${owner.split('.').at(-1)}\\b`, 'u'), owner);
        }
    }
});

test('governance fixtures accept current model calls and reject renamed primitive wrappers', () =>
{
    const fixtureRoot = path.join(root, 'tests/fixtures/article-core-test-api');
    const current = fs.readFileSync(path.join(fixtureRoot, 'current-command-query.cs'), 'utf8');

    assert.equal(current.includes('ArticlePageQuery'), true);
    const accepted = runChecker('--source', path.join(fixtureRoot, 'current-command-query.cs'));
    assert.equal(accepted.status, 0, accepted.stderr);

    const rejectedExtension = runChecker('--source', path.join(fixtureRoot, 'retired-primitive-extension.cs'));
    assert.equal(rejectedExtension.status, 1);
    assert.match(rejectedExtension.stderr, /retired-primitive-extension\.cs:3: retired-primitive-wrapper-shape/u);

    const rejectedStatic = runChecker('--source', path.join(fixtureRoot, 'retired-static-wrapper.cs'));
    assert.equal(rejectedStatic.status, 1);
    assert.match(rejectedStatic.stderr, /retired-static-wrapper\.cs:3: retired-primitive-wrapper-shape/u);
});

test('backend test tree has no retired Article Core wrapper', () =>
{
    const result = runChecker();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[article-core-test-api\] ok/u);
    assert.equal(fs.existsSync(path.join(root, inventory.retiredHelperPath)), false);
    const globalUsings = fs.readFileSync(path.join(root, 'tests/backend/GlobalUsings.cs'), 'utf8');
    assert.doesNotMatch(globalUsings, /FsusBlog\.Server\.Tests\.Compatibility/u);
});
