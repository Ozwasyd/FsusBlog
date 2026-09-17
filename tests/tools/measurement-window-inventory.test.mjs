import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { parseMatrix } = await import(new URL("../../tools/test-matrix/parse-matrix.mjs", import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/measurement-window-inventory.json'),
    'utf8'
));

function selectedTier(tier)
{
    return tier.resourceClass === 'benchmark'
    || /(perf|performance|load|soak|resource-budget)/iu.test(tier.id)
    || ['release-memory-leak-budget', 'release-open-handle-budget'].includes(tier.id);
}

test('every matrix performance, load, soak, benchmark, and resource-budget owner has an explicit disposition', () =>
{
    assert.equal(inventory.schema, 'fsusblog.measurement-window-inventory.v1');
    const selected = matrix.tiers.filter(selectedTier).map((tier) => tier.id).sort();
    const declared = inventory.tiers.map((tier) => tier.tierId).sort();
    assert.deepEqual(declared, selected);
    assert.equal(new Set(declared).size, declared.length);

    const byId = new Map(matrix.tiers.map((tier) => [tier.id, tier]));
    for (const declaration of inventory.tiers)
    {
        const tier = byId.get(declaration.tierId);
        assert.ok(tier, declaration.tierId);
        if (['enveloped', 'delegated-to-enveloped-producer'].includes(declaration.disposition))
        {
            assert.ok(declaration.receipts.length > 0, declaration.tierId);
            for (const receipt of declaration.receipts)
            {
                assert.ok(tier.evidence.includes(receipt), `${declaration.tierId} must publish ${receipt}`);
            }
        }
        else
        {
            assert.ok(declaration.reason?.length > 0, `${declaration.tierId} must explain ${declaration.disposition}`);
        }

        if (declaration.disposition === 'enveloped')
        {
            assert.equal(tier.parallelizable, false, `${declaration.tierId} must not share a matrix execution wave`);
            assert.equal(tier.maxParallel, 1, `${declaration.tierId} must have one physical measurement owner`);
            assert.ok(
                tier.exclusiveResources.includes('benchmark-window'),
                `${declaration.tierId} must reserve the benchmark window`
            );
        }
    }
});

test('production bundle dynamically owns every step declared as a measurement phase', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    assert.match(source, /step\.evidencePhase === 'measurement'/u);
    assert.match(source, /wrapTaskScopedMeasurementCommand\(\{/u);
    assert.match(source, /measurementAuthorityRootFor\(step\.id\)/u);
    assert.match(source, /measurementAuthorityManifestRootFor\(step\.id\)/u);
    assert.match(source, /priorMeasurementAuthorityRootsFor\(step\.id\)/u);
    assert.match(source, /readMeasurementNoiseAuthoritySequence\(measurementEvidenceFile/u);
    assert.doesNotMatch(source, /createMeasurementNoiseEnvelope\(\{/u);
    assert.doesNotMatch(source, /FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER/u);
});
