import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { loadCatalog, aggregateSummary } = await import(
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

test('aggregateSummary creates structured release-reliability-summary evidence file', () => {
    const catalog = loadCatalog();
    const mockResults = catalog.scenarios.map((s) => ({
        id: s.id,
        owner: s.owner,
        status: 'ok',
        evidencePath: s.evidencePath
    }));

    const tmpOut = path.join(root, '.tmp/test-reliability-summary-test.json');
    try {
        const summary = aggregateSummary(catalog, mockResults, tmpOut);
        assert.equal(summary.schema, 'fsusblog.release-reliability-summary.v1');
        assert.equal(summary.status, 'ok');
        assert.equal(summary.totalScenarios, 7);
        assert.equal(summary.executedScenarios, 7);
        assert.ok(fs.existsSync(tmpOut));
    } finally {
        if (fs.existsSync(tmpOut)) {
            fs.unlinkSync(tmpOut);
        }
    }
});
