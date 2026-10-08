import assert from 'node:assert/strict';
import test from 'node:test';

const {assertPublicShellLocaleHydration} = await import(new URL('../browser-contract/public-shell-locale-hydration.mjs', import.meta.url));
const {createPublicShellLocaleMatrix, resolvePublicShellLocaleCopy} = await import(new URL('../browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
const matrix = await createPublicShellLocaleMatrix();
const scene = matrix.scenes.find((item) => item.issue === 2084
    && item.stage === 'interactive-ready'
    && item.route === 'Home'
    && item.authActionContext === 'anonymous'
    && item.viewport.width === 390);
assert.ok(scene, 'hydration Home scene is missing');
const copy = await resolvePublicShellLocaleCopy(matrix, scene.id);

function box(x)
{
    return { x, y: 0, width: 48, height: 48, overflow: false };
}

function snapshot(overrides = {}, caseScene = scene, caseCopy = copy)
{
    const auth = caseScene.authActionContext === 'anonymous' ? 'login'
        : caseScene.authActionContext === 'admin' ? 'dashboard' : 'account';
    const authKey = `public.shell.${auth}`;
    return {
        language: caseScene.document.language,
        direction: caseScene.document.direction,
        copy: { ...caseCopy },
        metadata: {
            title: caseCopy['layout.siteHeader.fallbackTitle'],
            description: caseCopy['layout.siteHeader.fallbackDescription'],
            openGraphLocale: caseScene.document.openGraphLocale
        },
        selector: {
            active: caseScene.locale,
            items: caseScene.selectorItems.map((item) => ({ code: item.code, selected: item.selected, hidden: false }))
        },
        authAction: { key: authKey, text: caseCopy[authKey] },
        geometry: {
            header: box(0),
            brand: box(48),
            nav: box(96),
            auth: box(144),
            selector: box(192),
            hitTargets: [{ name: 'selector', width: 44, height: 44, hidden: false }]
        },
        accessibleNames: caseScene.selectorItems.map((item) => item.nativeName),
        sourceOrder: caseScene.selectorItems.map((item) => item.code),
        mixedLanguage: false,
        selectorHidden: false,
        ...overrides
    };
}

function snapshots(mutateStage = null, mutate = null, caseScene = scene, caseCopy = copy)
{
    const value = {
        'first-html': snapshot({}, caseScene, caseCopy),
        'hydration-start': snapshot({}, caseScene, caseCopy),
        'interactive-ready': snapshot({}, caseScene, caseCopy),
        'selector-open': snapshot({}, caseScene, caseCopy)
    };
    if (mutateStage)
    {
        value[mutateStage] = mutate(value[mutateStage]);
    }
    return value;
}

test('hydration keeps typed copy, selector, auth action and geometry across first-frame stages', () =>
{
    const evidence = assertPublicShellLocaleHydration({ scene, copy, snapshots: snapshots() });
    assert.equal(evidence.schema, 'fsusblog.public-shell-locale-hydration.v1');
    assert.equal(evidence.observed.consoleErrors, 0);
    assert.equal(JSON.stringify(evidence).includes(copy['public.shell.archive']), false);
});

for (const [label, mutate] of [
    ['initial locale flash', (value) => ({ ...value, language: 'zh-CN' === scene.document.language ? 'en-US' : 'zh-CN' })],
    ['server and hydrated copy drift', (value) => ({ ...value, copy: { ...value.copy, 'public.shell.archive': 'wrong-copy' } })],
    ['selector count', (value) => ({ ...value, selector: { ...value.selector, items: value.selector.items.slice(0, 2) } })],
    ['auth action language', (value) => ({ ...value, authAction: { ...value.authAction, text: 'wrong-auth' } })],
    ['390 overlap', (value) => ({
        ...value,
        geometry: { ...value.geometry, brand: { ...value.geometry.brand, x: 96 } }
    })],
    ['geometry shift', (value) => ({
        ...value,
        geometry: { ...value.geometry, header: { ...value.geometry.header, height: 96 } }
    })],
    ['hidden selector', (value) => ({ ...value, selectorHidden: true })],
    ['small hit target', (value) => ({
        ...value,
        geometry: { ...value.geometry, hitTargets: [{ name: 'selector', width: 20, height: 20, hidden: false }] }
    })],
    ['metadata drift', (value) => ({ ...value, metadata: { ...value.metadata, openGraphLocale: 'en_US' } })],
    ['accessible name change', (value) => ({ ...value, accessibleNames: ['drift'] })]
])
{
    test(`hydration rejects ${label}`, () =>
    {
        const stage = label === 'geometry shift' || label === 'accessible name change' ? 'interactive-ready' : 'first-html';
        assert.throws(
            () => assertPublicShellLocaleHydration({ scene, copy, snapshots: snapshots(stage, mutate) }),
            /hydration/u
        );
    });
}

test('hydration rejects console errors even when labeled as warnings', () =>
{
    assert.throws(
        () => assertPublicShellLocaleHydration({
            scene, copy, snapshots: snapshots(), consoleIssues: [{ type: 'warning', text: 'hydration mismatch' }]
        }),
        /cannot be filtered/u
    );
});

test('1440px header geometry stays stable and above the desktop hit-area floor', async () =>
{
    const wide = matrix.scenes.find((item) => item.issue === 2084
        && item.stage === 'interactive-ready'
        && item.route === 'Home'
        && item.authActionContext === 'anonymous'
        && item.viewport.width === 1440);
    assert.ok(wide, '1440 hydration scene is missing');
    const wideCopy = await resolvePublicShellLocaleCopy(matrix, wide.id);
    const wideSnapshot = {
        language: wide.document.language,
        direction: wide.document.direction,
        copy: { ...wideCopy },
        metadata: {
            title: wideCopy['layout.siteHeader.fallbackTitle'],
            description: wideCopy['layout.siteHeader.fallbackDescription'],
            openGraphLocale: wide.document.openGraphLocale
        },
        selector: {
            active: wide.locale,
            items: wide.selectorItems.map((item) => ({ code: item.code, selected: item.selected, hidden: false }))
        },
        authAction: { key: 'public.shell.login', text: wideCopy['public.shell.login'] },
        geometry: {
            header: box(0),
            brand: box(48),
            nav: box(96),
            auth: box(144),
            selector: box(192),
            hitTargets: [{ name: 'selector', width: 40, height: 40, hidden: false }]
        },
        accessibleNames: wide.selectorItems.map((item) => item.nativeName),
        sourceOrder: wide.selectorItems.map((item) => item.code),
        mixedLanguage: false,
        selectorHidden: false
    };
    const evidence = assertPublicShellLocaleHydration({
        scene: wide,
        copy: wideCopy,
        snapshots: {
            'first-html': wideSnapshot,
            'hydration-start': structuredClone(wideSnapshot),
            'interactive-ready': structuredClone(wideSnapshot),
            'selector-open': structuredClone(wideSnapshot)
        }
    });
    assert.equal(evidence.observed.locale, wide.locale);
});

for (const [index, locale] of matrix.locales.entries())
{
    test(`hydration preserves catalog-derived ${locale.code} semantic facts`, async () =>
    {
        const route = index % 2 === 0 ? 'Home' : 'ArticleDetail';
        const auth = ['anonymous', 'authenticated', 'admin'][index % 3];
        const caseScene = matrix.scenes.find((item) => item.issue === 2084
            && item.stage === 'interactive-ready' && item.locale === locale.code
            && item.route === route && item.authActionContext === auth && item.viewport.width === 390);
        assert.ok(caseScene, 'catalog hydration representative is missing');
        const caseCopy = await resolvePublicShellLocaleCopy(matrix, caseScene.id);
        const evidence = assertPublicShellLocaleHydration({ scene: caseScene, copy: caseCopy,
            snapshots: snapshots(null, null, caseScene, caseCopy) });
        assert.equal(evidence.observed.locale, locale.code);
        assert.equal(evidence.qualificationEligible, false);
    });
}

for (const field of ['title', 'description'])
{
    test(`hydration rejects post-hydration ${field} drift`, () =>
    {
        assert.throws(() => assertPublicShellLocaleHydration({ scene, copy,
            snapshots: snapshots('interactive-ready', (value) => ({ ...value,
                metadata: { ...value.metadata, [field]: 'wrong-metadata' } })) }), /hydration/u);
    });
}

test('hydration rejects unregistered visible-copy facts', () =>
{
    assert.throws(() => assertPublicShellLocaleHydration({ scene, copy,
        snapshots: snapshots('first-html', (value) => ({ ...value,
            copy: { ...value.copy, 'unregistered.copy': 'wrong-copy' } })) }), /hydration/u);
});
