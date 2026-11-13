import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { generateFixtureInventory } = await import(new URL('../../tools/testing/generate-fixture-catalog-artifacts.mjs', import.meta.url));
const { fixtureCatalogFiles, validateFixtureCatalogs, observeFixtureConsumerSource } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));

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


function rejects(change, pattern)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-inventory-negative-'));
    try
    {
        const names = ['capability', 'profile', 'producer', 'inventory', 'variant'];
        const files = Object.fromEntries(names.map((name) => [name, path.join(directory, `${name}.json`)]));
        const data = Object.fromEntries(names.map((name) => [name, JSON.parse(fs.readFileSync(fixtureCatalogFiles[name], 'utf8'))]));
        change(data);
        for (const name of names)
        {
            fs.writeFileSync(files[name], JSON.stringify(data[name]));
        }
        assert.match(validateFixtureCatalogs({ files, validateRepositoryAuthority: false }).join('\n'), pattern);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('inventory cannot forge scale source or matrix-derived profile', () =>
{
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === 'matrix:acceptance'
        );
        consumer.source = 'tools/test/lanes/data-scale.sh';
    }, /matrix tier acceptance and generated inventory source differ/);
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === 'source:data-scale-lane'
        );
        consumer.profileIds = ['none'];
        consumer.profileId = 'none';
    }, /fixture source data-scale-lane and generated inventory profile binding differ/);
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === 'matrix:acceptance'
        );
        consumer.producerOwners = ['scale-data'];
    }, /matrix tier acceptance and generated inventory producer owners differ/);
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === 'matrix:acceptance'
        );
        consumer.profileIds = ['acceptance-representative', 'auth-basic'];
    }, /matrix tier acceptance and generated inventory declaration differ/);
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === 'source:acceptance-bootstrap'
        );
        consumer.executionClass = 'runtime';
    }, /fixture source acceptance-bootstrap and generated inventory profile binding differ/);
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === 'matrix:acceptance'
        );
        consumer.executionClass = 'runtime';
    }, /matrix tier acceptance and generated inventory declaration differ/);
    for (const field of ['implicitSource', 'requiredBusinessFact'])
    {
        rejects((data) =>
        {
            const consumer = data.inventory.consumers.find(
                (item) => item.consumerId === 'matrix:acceptance'
            );
            consumer[field] = 'forged';
        }, /matrix tier acceptance and generated inventory facts differ/);
    }
});
