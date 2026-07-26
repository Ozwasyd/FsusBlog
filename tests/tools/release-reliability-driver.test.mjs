import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { loadCatalog } = await import(
    pathToFileURL(path.join(root, 'tools/test/run-release-reliability-scenarios.mjs')).href
);

test('release reliability catalog contains exactly 7 scenarios matching expected IDs 1:1', () => {
    const catalog = loadCatalog();
    assert.equal(catalog.catalogScenarioCount, 7);
    assert.equal(catalog.scenarios.length, 7);

    const expectedIds = [
        'release-soak-min',
        'release-load-peak',
        'release-load-burst',
        'release-data-scale-m',
        'release-mutation-critical-slice',
        'release-memory-leak-budget',
        'release-open-handle-budget'
    ];
    const actualIds = catalog.scenarios.map((s) => s.id);
    assert.deepEqual(actualIds, expectedIds);
});

test('release reliability catalog declares structured executable commands and evidence contracts', () => {
    const catalog = loadCatalog();
    for (const scenario of catalog.scenarios) {
        assert.equal(typeof scenario.command.executable, 'string');
        assert.ok(Array.isArray(scenario.command.args));
        assert.equal(typeof scenario.command.cwd, 'string');
        assert.equal(typeof scenario.authoritativeEvidence.path, 'string');
        assert.ok(Array.isArray(scenario.authoritativeEvidence.expectedSchema.required));
    }
    assert.equal(
        catalog.scenarios.find((scenario) => scenario.id === 'release-soak-min').authoritativeEvidence.path,
        '.tmp/soak/short/summary.json'
    );
});
