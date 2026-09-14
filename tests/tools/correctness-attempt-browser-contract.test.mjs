import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { inventoryByDomain } = await import(new URL('../../tools/test/correctness-attempt-producers.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/correctness-attempt-producers.json'),
    'utf8'
));

test('Browser Contract producers are exact and use zero retry policy', () =>
{
    const entries = inventoryByDomain(inventory).get('browser-contract');
    assert.deepEqual(entries.map((item) => item.producerId), [
        'matrix:browser-contract',
        'matrix:production-xss-release'
    ]);
    for (const item of entries)
    {
        assert.equal(item.allowedRetries, 0);
        assert.equal(item.frameworkRetrySetting, 0);
        assert.equal(item.policyId, 'correctness-first-attempt');
        assert.equal(item.migrationState, 'migrated');
        assert.equal(item.qualificationEligible, true);
        assert.equal(item.attemptAdapter, 'tools/test/attempt-runner.mjs#runProducerAttempts');
    }
});

test('Playwright correctness settings cannot enable retries', () =>
{
    const config = fs.readFileSync(path.join(root, 'src/frontend/playwright.config.ts'), 'utf8');
    const diagnostics = fs.readFileSync(path.join(root, 'src/frontend/playwright.diagnostics.config.ts'), 'utf8');
    assert.doesNotMatch(config, /retries\s*:\s*[1-9]/u);
    assert.match(diagnostics, /retries\s*:\s*0/u);
    const runner = fs.readFileSync(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
    assert.doesNotMatch(runner, /FSUSBLOG_PLAYWRIGHT_RETRIES[^\n]*[1-9]/u);
});
