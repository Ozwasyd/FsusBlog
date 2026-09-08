import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicShellLocaleFailure } from '../browser-contract/public-shell-locale-failure.mjs';
import { createPublicShellLocaleMatrix } from '../browser-contract/public-shell-locale-matrix.mjs';

const matrix = await createPublicShellLocaleMatrix();
const domain = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'domain-failure'
    && item.transition.failureMode === 'timeout' && item.route === 'Home');
const font = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'font-failure'
    && item.requiredFont.script === 'Hant' && item.route === 'Home');
const preference = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'preference-failure'
    && item.route === 'Home');
const revision = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'revision-conflict'
    && item.route === 'Home');
const artifact = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'artifact-invalid'
    && item.route === 'Home');
const retry = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'retry'
    && item.locale === domain.locale && item.route === 'Home');
assert.ok(domain && font && preference && revision && artifact && retry, 'failure scenes are missing');

function before(scene)
{
    return {
        uiLocale: scene.transition.sourceLocale,
        selectorActive: scene.transition.sourceLocale,
        preference: scene.transition.sourceLocale,
        revision: 4,
        businessState: 'article:kept',
        fontScript: matrix.locales.find((item) => item.code === scene.transition.sourceLocale).script
    };
}

function after(scene, extras = {})
{
    const source = scene.transition.sourceLocale;
    return {
        uiLocale: source,
        selectorActive: source,
        preference: source,
        revision: 4,
        businessState: 'article:kept',
        fontScript: before(scene).fontScript,
        mixedLanguage: false,
        errorRetryable: true,
        committed: false,
        ...extras
    };
}

function injection(scene, extras = {})
{
    return {
        kind: scene.transition.failureMode,
        target: scene.locale,
        boundary: 'http-resource',
        status: extras.status ?? 503,
        artifactIdentity: extras.artifactIdentity ?? null
    };
}

test('required domain, font, preference, revision and artifact failures keep the old locale', () =>
{
    for (const scene of [domain, font, preference, revision, artifact])
    {
        const evidence = assertPublicShellLocaleFailure({
            scene, before: before(scene), after: after(scene), injection: injection(scene),
            logs: [{
                kind: scene.transition.failureMode, target: scene.locale, resourceRef: 'resource:1',
                preferenceRef: 'preference:1', revision: 4, requestCount: 1
            }]
        });
        assert.equal(evidence.observed.committed, false);
        assert.equal(evidence.observed.source, scene.transition.sourceLocale);
    }
});

test('successful retry commits once with a new revision', () =>
{
    const evidence = assertPublicShellLocaleFailure({
        scene: retry,
        before: before(retry),
        after: {
            uiLocale: retry.locale,
            selectorActive: retry.locale,
            preference: retry.locale,
            revision: 5,
            businessState: 'article:kept',
            fontScript: retry.requiredFont.script,
            mixedLanguage: false,
            errorRetryable: false,
            committed: true
        },
        injection: injection(retry)
    });
    assert.equal(evidence.observed.committed, true);
});

for (const [label, scene, mutate] of [
    ['lang already changed', domain, () => ({ after: after(domain, { uiLocale: domain.locale }) })],
    ['SC font committed', font, () => ({ after: after(font, { fontScript: 'Hans', committed: true }) })],
    ['preference cookie written', preference, () => ({ after: after(preference, { preference: preference.locale }) })],
    ['revision last-write-wins', revision, () => ({ after: after(revision, { revision: 9, committed: true }) })],
    ['invalid artifact fallback', artifact, () => ({
        injection: injection(artifact, { artifactIdentity: artifact.locale }),
        after: after(artifact, { uiLocale: artifact.locale, committed: true })
    })],
    ['error UI not retryable', domain, () => ({ after: after(domain, { errorRetryable: false }) })],
    ['business state reset', domain, () => ({ after: after(domain, { businessState: 'article:rebuilt' }) })],
    ['secret leak', domain, () => ({
        logs: [{
            kind: 'timeout', target: domain.locale, resourceRef: 'token=secret',
            preferenceRef: 'preference:1', revision: 4, requestCount: 1
        }]
    })]
])
{
    test(`failure rejects ${label}`, () =>
    {
        const base = {
            scene, before: before(scene), after: after(scene), injection: injection(scene), logs: []
        };
        assert.throws(() => assertPublicShellLocaleFailure({ ...base, ...mutate(base) }), /failure|secret/u);
    });
}

test('late superseded responses cannot commit after a new selection', () =>
{
    const superseded = matrix.scenes.find((item) => item.issue === 2087 && item.stage === 'superseded-failure'
        && item.route === 'Home');
    assert.throws(
        () => assertPublicShellLocaleFailure({
            scene: superseded,
            before: before(superseded),
            after: after(superseded, { uiLocale: superseded.locale, committed: true, preference: superseded.locale }),
            injection: injection(superseded)
        }),
        /failure/u
    );
});
