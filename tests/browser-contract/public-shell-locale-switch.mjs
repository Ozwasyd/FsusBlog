import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const stages = Object.freeze(['preparing', 'commit', 'post-commit', 'spa-navigation', 'refresh', 'back-forward', 'latest-wins']);

function equal(actual, expected, label)
{
    assert.ok(actual === expected, `switch ${label} mismatch`);
}

function exactKeys(value, allowed, label)
{
    assert.deepEqual(Object.keys(value ?? {}).sort(), [...allowed].sort(), `switch ${label} has an unregistered field`);
}

/** Inspect one selector-driven transaction scene. Internal commit/phase APIs are forbidden. */
export function assertPublicShellLocaleSwitch({ scene, copy, record, requests = [] })
{
    assert.ok(scene.issue === 2086, 'switch requires its matrix scene');
    assert.ok(stages.includes(scene.stage), 'switch requires a transaction stage');
    assert.equal(scene.transition?.driver, 'selector-ui', 'switch must be driven by selector UI');
    exactKeys(record, [
        'uiLocale', 'selectorActive', 'copy', 'commitGeneration', 'preference',
        'mixedLanguage', 'driver', 'geometryStable', 'supersededCommitted'
    ], 'record');
    const expectedUi = scene.transition.expectedUiLocale;
    const preparing = scene.stage === 'preparing';
    equal(record.driver, 'selector-ui', 'driver');
    equal(record.mixedLanguage, false, 'mixed language');
    equal(record.geometryStable, true, 'geometry');
    equal(record.uiLocale, expectedUi, 'ui locale');
    equal(record.selectorActive, expectedUi, 'selector active');
    equal(record.preference, preparing ? scene.transition.sourceLocale : scene.locale, 'preference');
    equal(record.commitGeneration, preparing ? 0 : 1, 'commit generation');
    equal(record.supersededCommitted, false, 'superseded result');
    exactKeys(record.copy, Object.keys(copy), 'typed copy');
    for (const [key, value] of Object.entries(copy))
    {
        equal(record.copy[key], value, `typed copy ${key}`);
    }
    if (scene.stage === 'latest-wins')
    {
        assert.ok([3, 4].includes(scene.transition.rapidTargets.length), 'latest-wins rapid targets');
        equal(scene.transition.rapidTargets.at(-1), scene.locale, 'latest-wins final clicked target');
        equal(record.uiLocale, scene.locale, 'latest-wins target');
    }
    for (const request of requests)
    {
        exactKeys(request, ['kind', 'locale', 'count'], 'switch request');
        if (request.kind === 'route-data' || request.kind === 'article-data')
        {
            equal(request.count, 0, 'route or article data re-request');
        }
        if (request.kind === 'internal-commit')
        {
            assert.fail('internal commit hook is forbidden');
        }
    }
    return {
        schema: 'fsusblog.public-shell-locale-switch.v1',
        evidenceKind: 'diagnostic-probe',
        qualificationEligible: false,
        observed: {
            source: scene.transition.sourceLocale,
            target: scene.locale,
            uiLocale: expectedUi,
            commitGenerations: record.commitGeneration,
            preferenceDigest: sha256(record.preference)
        }
    };
}
