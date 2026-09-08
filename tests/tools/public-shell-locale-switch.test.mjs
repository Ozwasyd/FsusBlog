import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPublicShellLocaleMatrix,
    resolvePublicShellLocaleCopy
} from '../browser-contract/public-shell-locale-matrix.mjs';
import { assertPublicShellLocaleSwitch } from '../browser-contract/public-shell-locale-switch.mjs';

const matrix = await createPublicShellLocaleMatrix();
const preparing = matrix.scenes.find((item) => item.issue === 2086 && item.stage === 'preparing' && item.route === 'Home');
const commit = matrix.scenes.find((item) => item.issue === 2086 && item.stage === 'commit' && item.route === 'Home'
    && item.locale === preparing.locale);
const latest = matrix.scenes.find((item) => item.issue === 2086 && item.stage === 'latest-wins' && item.route === 'Home');
assert.ok(preparing && commit && latest, 'switch scenes are missing');
const preparingCopy = await resolvePublicShellLocaleCopy(matrix, preparing.id);
const commitCopy = await resolvePublicShellLocaleCopy(matrix, commit.id);

function record(scene, copy, extras = {})
{
    const preparingStage = scene.stage === 'preparing';
    return {
        uiLocale: scene.transition.expectedUiLocale,
        selectorActive: scene.transition.expectedUiLocale,
        copy: { ...copy },
        commitGeneration: preparingStage ? 0 : 1,
        preference: preparingStage ? scene.transition.sourceLocale : scene.locale,
        mixedLanguage: false,
        driver: 'selector-ui',
        geometryStable: true,
        supersededCommitted: false,
        ...extras
    };
}

test('preparing keeps the old locale until resources are ready', () =>
{
    const evidence = assertPublicShellLocaleSwitch({
        scene: preparing, copy: preparingCopy, record: record(preparing, preparingCopy)
    });
    assert.equal(evidence.observed.uiLocale, preparing.transition.sourceLocale);
    assert.equal(evidence.observed.commitGenerations, 0);
});

test('successful commit happens once and persists through refresh and SPA navigation', async () =>
{
    const evidence = assertPublicShellLocaleSwitch({
        scene: commit, copy: commitCopy, record: record(commit, commitCopy),
        requests: [{ kind: 'route-data', locale: commit.locale, count: 0 }]
    });
    assert.equal(evidence.observed.commitGenerations, 1);
    const refresh = matrix.scenes.find((item) => item.issue === 2086 && item.stage === 'refresh'
        && item.locale === commit.locale && item.route === 'Home');
    const refreshCopy = await resolvePublicShellLocaleCopy(matrix, refresh.id);
    assertPublicShellLocaleSwitch({ scene: refresh, copy: refreshCopy, record: record(refresh, refreshCopy) });
});

test('latest-wins keeps only the final target', async () =>
{
    const copy = await resolvePublicShellLocaleCopy(matrix, latest.id);
    const evidence = assertPublicShellLocaleSwitch({ scene: latest, copy, record: record(latest, copy) });
    assert.equal(evidence.observed.target, latest.locale);
});

for (const [label, mutate] of [
    ['ui changed while preparing', (value) => ({ ...value, uiLocale: preparing.locale })],
    ['selector active first', (value) => ({ ...value, selectorActive: preparing.locale })],
    ['mixed language commit', (value) => ({ ...value, mixedLanguage: true })],
    ['commit generation twice', (value) => ({ ...value, commitGeneration: 2 })],
    ['geometry drift', (value) => ({ ...value, geometryStable: false })],
    ['internal driver', (value) => ({ ...value, driver: 'internal-commit' })]
])
{
    test(`switch rejects ${label}`, () =>
    {
        const scene = label.includes('preparing') || label.includes('selector') ? preparing : commit;
        const copy = scene === preparing ? preparingCopy : commitCopy;
        assert.throws(
            () => assertPublicShellLocaleSwitch({ scene, copy, record: mutate(record(scene, copy)) }),
            /switch/u
        );
    });
}

test('switch rejects route data re-requests and internal commit hooks', () =>
{
    assert.throws(
        () => assertPublicShellLocaleSwitch({
            scene: commit, copy: commitCopy, record: record(commit, commitCopy),
            requests: [{ kind: 'article-data', locale: commit.locale, count: 1 }]
        }),
        /re-request/u
    );
    assert.throws(
        () => assertPublicShellLocaleSwitch({
            scene: commit, copy: commitCopy, record: record(commit, commitCopy),
            requests: [{ kind: 'internal-commit', locale: commit.locale, count: 1 }]
        }),
        /internal commit/u
    );
});

test('switch rejects a superseded preference write', async () =>
{
    const copy = await resolvePublicShellLocaleCopy(matrix, latest.id);
    assert.throws(
        () => assertPublicShellLocaleSwitch({
            scene: latest, copy, record: { ...record(latest, copy), supersededCommitted: true }
        }),
        /superseded/u
    );
});
