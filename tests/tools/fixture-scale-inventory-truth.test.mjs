import assert from 'node:assert/strict';
import test from 'node:test';

const { generateFixtureInventory } = await import(new URL('../../tools/testing/generate-fixture-catalog-artifacts.mjs', import.meta.url));
const { observeFixtureConsumerSource } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));

const scaleObservation = /(?:observed source references a scale-data execution path|sealed profile plans scale data through the scale-data producer)/u;

test('shared bootstrap does not attribute scale data to unrelated consumers', () =>
{
    const { consumers } = generateFixtureInventory();
    for (const id of ['matrix:acceptance', 'matrix:current-schema-bootstrap-integration', 'source:acceptance-bootstrap'])
    {
        const consumer = consumers.find((item) => item.consumerId === id);
        assert.ok(consumer, id);
        assert.doesNotMatch(consumer.currentFallback, scaleObservation, id);
    }
});

test('a comment reference is not reported as executed scale production', () =>
{
    const observed = observeFixtureConsumerSource('tools/test/lanes/acceptance-playwright.sh',
        '# Never run tools/data-scale/seed.sh from this bootstrap.\n');
    assert.doesNotMatch(observed, /scale data is produced/u);
    assert.match(observed, /observed source references a scale-data execution path/u);
});

test('a direct scale seed in the observed bootstrap remains visible', () =>
{
    const entry = 'source "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"\n';
    for (const command of [
        'bash "$ROOT_DIR/tools/data-scale/seed.sh" scale-s',
        'node "$ROOT_DIR/tools/data-scale/runtime-provisioner.mjs" provision --mode full',
        'cd "$ROOT_DIR/tools/data-scale" && node runtime-provisioner.mjs provision --mode full',
        'node scale-generator.mjs --capability scale.article-comment.s --seed',
        'node scale-generator.mjs --capability scale.article-comment.s \\\n  --seed',
        'bash "$ROOT_DIR/tools/data-\\\nscale/seed.sh" scale-s'
    ])
    {
        assert.match(observeFixtureConsumerSource('tools/test/lanes/acceptance-playwright.sh', `${entry}${command}\n`, {
            directContent: entry,
            plannedProducerOwners: []
        }), scaleObservation);
    }
});

test('a direct scale seed call remains observable for an unrelated source', () =>
{
    for (const content of [
        'bash tools/data-scale/seed.sh scale-s\n',
        'node scale-generator.mjs --capability scale.article-comment.s --seed\n',
        'node tools/data-scale/runtime-provisioner.mjs --seed\n',
        'node tools/data-scale/runtime-provisioner.mjs provision --mode full --tier scale-m --emit-env /tmp/result.env\n',
        'cd tools/data-scale && node runtime-provisioner.mjs provision --mode full --tier scale-m\n',
        'bash tools/test/lanes/data-scale.sh cleanup\n'
    ])
    {
        assert.match(observeFixtureConsumerSource('tools/test/lanes/acceptance-playwright.sh', content), scaleObservation);
    }
});

test('scale profile and direct scale lane retain scale-data attribution', () =>
{
    const { consumers } = generateFixtureInventory();
    for (const id of ['matrix:soak-short-runtime', 'matrix:data-scale-s'])
    {
        const consumer = consumers.find((item) => item.consumerId === id);
        assert.ok(consumer, id);
        assert.match(consumer.currentFallback, scaleObservation, id);
    }
});
