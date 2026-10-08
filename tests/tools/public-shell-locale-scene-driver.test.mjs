import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const { Window } = createRequire(new URL('../../src/frontend/package.json', import.meta.url))('happy-dom');
const {
    createPublicShellLocaleMatrix, publicShellLocaleContentDigest, publicShellLocaleRapidTargets,
    validatePublicShellLocaleMatrix
} = await import(new URL('../browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
const { assertPublicShellLocaleHydration } = await import(new URL('../browser-contract/public-shell-locale-hydration.mjs', import.meta.url));
const { assertPublicShellLocaleSwitch } = await import(new URL('../browser-contract/public-shell-locale-switch.mjs', import.meta.url));
const {
    assertPublicShellLocaleDom, clickPublicShellLocaleTargets, drivePublicShellLocaleSwitchScene, drivePublicShellLocaleSwitchInContext,
    installPublicShellLocaleTelemetry, publicShellLocaleCommitReady, readPublicShellLocaleDom
} = await import(new URL('../browser-contract/public-shell-locale-scene-driver.mjs', import.meta.url));
const catalog = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url)));
let currentMatrix = await createPublicShellLocaleMatrix();
const locales = catalog.locales.filter((item) => item.status === 'enabled');
const descriptor = locales[0];
const items = currentMatrix.scenes.find((scene) => scene.issue === 2084 && scene.locale === descriptor.code).selectorItems;
const copy = { 'public.shell.login': 'test auth copy' };
const viewport = { width: 390, height: 900 };

function box(x, width = 44, height = 44)
{
    return { x, y: 0, width, height, overflow: false };
}

function hydrationInput()
{
    const snapshot = {
        language: descriptor.documentLanguage, direction: descriptor.direction,
        copy, metadata: { title: 'configured site title', description: 'configured description', openGraphLocale: descriptor.openGraphLocale },
        selector: { active: descriptor.code, items: items.map((item) => ({ ...item, hidden: false })) },
        authAction: { key: 'public.shell.login', text: copy['public.shell.login'] },
        geometry: { header: box(0, 390, 96), brand: box(0), nav: box(50), auth: box(100), selector: box(150),
            hitTargets: [{ name: 'selector', width: 44, height: 44, hidden: false }] },
        accessibleNames: ['test label'], sourceOrder: ['test node'], mixedLanguage: false, selectorHidden: false
    };
    return {
        scene: { issue: 2084, stage: 'interactive-ready', locale: descriptor.code,
            document: { language: descriptor.documentLanguage, direction: descriptor.direction, openGraphLocale: descriptor.openGraphLocale },
            selectorItems: items, authActionContext: 'anonymous', viewport },
        copy,
        snapshots: Object.fromEntries(['first-html', 'hydration-start', 'interactive-ready', 'selector-open']
            .map((stage) => [stage, structuredClone(snapshot)]))
    };
}

for (const locale of locales)
{
    test(`rapid plan preserves required race prefix and ends at ${locale.code}`, async () =>
    {
        const targets = publicShellLocaleRapidTargets(locales, locale.code);
        assert.deepEqual(targets.slice(0, 3), ['ja', 'de', 'ru'].map((alias) => locales.find((item) => item.aliases.includes(alias)).code));
        assert.equal(targets.at(-1), locale.code);
        assert.equal(targets.length, locale.aliases.includes('ru') ? 3 : 4);
        const clicked = [];
        const observed = [];
        const trigger = { count: async () => 1, getAttribute: async () => 'true' };
        const selector = { locator: (query) => ({
            count: async () => 1,
            click: async () => clicked.push(query.match(/data-locale-code="([^"]+)"/u)[1])
        }) };
        const page = { locator: (query) => query === '[data-locale-selector-trigger]:visible' ? trigger : selector };
        await clickPublicShellLocaleTargets(page, { stage: 'latest-wins', locale: locale.code,
            transition: { driver: 'selector-ui', rapidTargets: targets }, selectorItems: items },
        async (target) => observed.push(target));
        assert.deepEqual(clicked, targets);
        assert.deepEqual(observed, targets);
    });
}

test('rapid plan rejects unknown target and missing/ambiguous required alias', () =>
{
    assert.throws(() => publicShellLocaleRapidTargets(locales, 'unknown'), /enabled catalog/u);
    assert.throws(() => publicShellLocaleRapidTargets(locales.filter((item) => !item.aliases.includes('ja')), descriptor.code), /exactly once/u);
    assert.throws(() => publicShellLocaleRapidTargets([...locales, locales.find((item) => item.aliases.includes('ja'))], descriptor.code), /exactly once/u);
});

// Explicit Node operation models. These contexts/DOM fixtures are not actual browser qualification.
async function enteredSwitchModel({ stage = 'commit', route = 'Home', captureResources } = {})
{
    const { resolvePublicShellLocaleCopy } = await import(new URL('../browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
    const { bindPublicShellLocaleContextEvidence } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-evidence.mjs', import.meta.url));
    const { loadPublicShellLocalePreferenceBindings } = await import(new URL('../browser-contract/public-shell-locale-runtime-bindings.mjs', import.meta.url));
    const matrix = await createPublicShellLocaleMatrix();
    const scene = matrix.scenes.find((item) => item.issue === 2086 && item.stage === stage && item.route === route
        && item.authActionContext === 'anonymous' && item.viewport.width === 390);
    const source = matrix.scenes.find((item) => item.issue === 2084 && item.locale === scene.transition.sourceLocale
        && item.route === scene.route && item.authActionContext === 'anonymous' && item.viewport.width === 390);
    const copies = {
        source: await resolvePublicShellLocaleCopy(matrix, source.id),
        target: await resolvePublicShellLocaleCopy(matrix, scene.id)
    };
    const calls = [];
    const pages = [];
    const listeners = new Map();
    const events = [];
    let committed = false;
    const targets = stage === 'latest-wins' ? scene.transition.rapidTargets : [scene.locale];
    const resourceHolds = targets.map((locale, index) => ({ locale, url: `http://runtime.invalid/domain-${index}.js`,
        barrier: { entered: Promise.resolve(), release: () => calls.push(`release:${locale}`), wait: async () => ({ kind: 'continue' }),
            close: () => calls.push(`barrier-close:${locale}`) } }));
    const identity = { matrixDigest: matrix.contentDigest, sourceState: {
        commit: matrix.identity.sourceCommit, worktreeFingerprint: matrix.identity.worktreeFingerprint
    }, buildDigest: `sha256:${'a'.repeat(64)}`, namespace: 'explicit-node-operation-model', preparationId: 'node-model' };
    const preference = await loadPublicShellLocalePreferenceBindings(matrix.identity.worktree);
    const bindings = { identity, preference, preferenceUrl: new URL(preference.operations[0].path, 'http://runtime.invalid').href, resources: resourceHolds.map((hold) => ({
        url: hold.url, digest: `sha256:${'b'.repeat(64)}`, identities: [{ kind: 'domain', locale: hold.locale, domain: scene.requiredDomains[0] }]
    })) };
    const dom = () =>
    {
        const selected = committed ? scene : source;
        const locale = matrix.locales.find((item) => item.code === selected.locale);
        return {
            language: locale.documentLanguage, direction: locale.direction,
            metadata: { title: 'Node fixture title', description: 'Node fixture description', openGraphLocale: locale.openGraphLocale },
            viewport: scene.viewport,
            copyNodes: Object.entries(committed ? copies.target : copies.source).map(([key, value]) => ({ key, text: value, visible: true })),
            selectors: [{ active: locale.code, expanded: true, visible: true, disabled: false,
                items: selected.selectorItems.map((item) => ({ ...item, englishName: item.englishName !== item.nativeName ? item.englishName : null,
                    disabled: false, visible: true })) }],
            geometry: [{ name: 'header', visible: true, box: { x: 0, y: 0, width: 390, height: 96 } }], containment: []
        };
    };
    const trigger = { count: async () => 1, getAttribute: async () => 'true' };
    const selector = { locator: (query) => ({ count: async () => 1,
        click: async () => calls.push(`click:${query.match(/data-locale-code="([^"]+)"/u)[1]}`) }) };
    const pageListeners = new Map();
    const page = {
        on: (name, callback) => pageListeners.set(name, [...(pageListeners.get(name) ?? []), callback]),
        off: (name, callback) => pageListeners.set(name, (pageListeners.get(name) ?? []).filter((item) => item !== callback)),
        isClosed: () => false,
        goto: async (url) => calls.push(`navigate:${url}`),
        locator: (query) => query === '[data-locale-selector-trigger]:visible' ? trigger : selector,
        waitForFunction: async (callback) =>
        {
            if (callback === publicShellLocaleCommitReady)
            {
                committed = true;
                events.push({ name: 'locale_runtime_committed', locale: scene.locale, generation: 7 });
            }
        },
        evaluate: async (callback, argument) =>
        {
            if (callback === readPublicShellLocaleDom)
            {
                return dom();
            }
            if (callback.toString().includes('performance:'))
            {
                return { recorder: { frames: [], marks: [], events: [...events], errors: [], overflow: false }, performance: [], preloads: [] };
            }
            if (callback.toString().includes('events.length'))
            {
                return events.length;
            }
            if (callback.toString().includes('events.slice'))
            {
                return events.slice(argument);
            }
            return null;
        }
    };
    const context = {
        on: (name, callback) => listeners.set(name, callback), off: (name) => listeners.delete(name),
        pages: () => pages, addInitScript: async () =>
        {},
        route: async () => calls.push('route'), unroute: async () => calls.push('unroute'),
        close: async () => assert.fail('entered operation must not close its lease'),
        async newPage()
        {
            calls.push('page');
            pages.push(page);
            listeners.get('page')?.(page);
            return page;
        }
    };
    const capturedBindings = captureResources ? { ...bindings, resources: captureResources(bindings.resources, scene) } : bindings;
    const observer = await bindPublicShellLocaleContextEvidence({ context, bindings: capturedBindings, scene });
    const saved = [];
    const options = { context, fixture: { baseUrl: 'http://runtime.invalid', publicArticle: { id: '101', url: 'http://runtime.invalid/article/101' } },
        matrix, scene, bindings, observer, resourceHolds,
        saveStage: async (input) => saved.push(input) };
    const emitRequest = (request) =>
    {
        listeners.get('request')(request);
        for (const callback of pageListeners.get('request') ?? [])
        {
            callback(request);
        }
    };
    return { options, calls, saved, page, observer, identity, listeners, selector, emitRequest };
}

for (const [stage, route] of [['commit', 'Home'], ['post-commit', 'ArticleDetail'], ['latest-wins', 'Home']])
{
    test(`entered switch ${stage}/${route} reuses original context and captures every actual stage without body batch duplication`, async () =>
    {
        const model = await enteredSwitchModel({ stage, route });
        try
        {
            const evidence = await drivePublicShellLocaleSwitchInContext(model.options);
            assert.equal(model.options.context.pages()[0], model.page);
            assert.equal(model.calls.filter((call) => call === 'page').length, 1);
            assert.equal(model.calls.filter((call) => call.startsWith('navigate:')).length, 1);
            const targets = stage === 'latest-wins' ? model.options.scene.transition.rapidTargets : [model.options.scene.locale];
            assert.deepEqual(model.saved.map((input) => input.evidence.stage), ['before-click', ...targets.map(() => 'pending'), 'after-commit', 'post-commit']);
            for (const input of model.saved)
            {
                assert.equal(input.page, model.page);
                assert.equal(input.evidence.evidence.sceneId, model.options.scene.id);
                assert.deepEqual(input.evidence.evidence.identity, model.identity);
                assert.equal(input.evidence.evidence.captureCut, model.observer.rawCapture.cut());
                assert.equal(Object.hasOwn(input, 'privateOriginals'), false, 'outer lifecycle owns the raw body batch');
                assert.equal(Object.hasOwn(input.evidence, 'qualified'), false);
                assert.equal(Object.hasOwn(input.evidence, 'checked'), false);
            }
            assert.equal(new Set(model.saved.map((input) => input.evidence.evidence.captureCut)).size, 1, 'same actual cuts are not renumbered');
            assert.equal(evidence.telemetry.filter((event) => event.name === 'locale_runtime_committed').length, 1);
            assert.ok(evidence.remainingContracts.includes('atomic painted-frame continuity'));
            assert.equal(model.calls.filter((call) => call === 'unroute').length, targets.length);
        }
        finally
        {
            await model.observer.dispose();
        }
    });
}

test('entered switch rejects missing/cross-owner inputs before page creation, route binding or navigation', async () =>
{
    const model = await enteredSwitchModel();
    try
    {
        for (const change of [
            { observer: undefined }, { saveStage: undefined }, { bindings: undefined },
            { bindings: { ...model.options.bindings, identity: { ...model.identity, matrixDigest: 'wrong' } } },
            { context: { ...model.options.context } },
            { scene: { ...model.options.scene, authActionContext: 'admin' } },
            { scene: { ...model.options.scene, route: 'Filter' } },
            { scene: { ...model.options.scene, stage: 'refresh' } },
            { resourceHolds: [] },
            { resourceHolds: [{ ...model.options.resourceHolds[0], url: 'http://runtime.invalid/not-in-build.js' }] }
        ])
        {
            await assert.rejects(drivePublicShellLocaleSwitchInContext({ ...model.options, ...change }));
        }
        assert.deepEqual(model.calls, []);
    }
    finally
    {
        await model.observer.dispose();
    }
});

for (const mutation of ['url', 'locale', 'domain', 'digest'])
{
    test(`entered switch rejects same-identity hold ${mutation} substitution against original collector admission before any operation`, async () =>
    {
        const captureResources = ['locale', 'domain'].includes(mutation) ? (resources, scene) => resources.map((resource) => ({
            ...resource, identities: resource.identities.map((identity) => ({ ...identity,
                [mutation]: mutation === 'locale' ? scene.transition.sourceLocale : 'unprepared-domain' }))
        })) : undefined;
        const model = await enteredSwitchModel({ captureResources });
        const { bindings, resourceHolds } = model.options;
        const supplied = {
            ...bindings,
            resources: bindings.resources.map((resource) => ({ ...resource, identities: resource.identities.map((identity) => ({ ...identity })) }))
        };
        const holds = resourceHolds.map((hold) => ({ ...hold }));
        if (mutation === 'url')
        {
            supplied.resources[0].url = 'http://runtime.invalid/not-in-captured-build.js';
            holds[0].url = supplied.resources[0].url;
        }
        if (mutation === 'digest')
        {
            supplied.resources[0].digest = `sha256:${'c'.repeat(64)}`;
        }
        try
        {
            assert.equal(supplied.identity, bindings.identity, 'replacement preserves the admitted identity reference');
            const original = model.observer.rawCapture.admittedResource(supplied.resources[0].url);
            assert.notDeepEqual(supplied.resources[0], original, 'negative actually differs from frozen collector authority');
            await assert.rejects(drivePublicShellLocaleSwitchInContext({ ...model.options, bindings: supplied, resourceHolds: holds }),
                /original capture (?:admission|resource)/u);
            assert.deepEqual(model.calls, [], 'no routes, page creation or navigation before original admission proof');
            assert.equal(model.options.context.pages().length, 0);
            assert.equal(model.saved.length, 0, 'no fabricated stage from rejected preflight');
        }
        finally
        {
            await model.observer.dispose();
        }
    });
}

test('entered switch retains first product error when stage storage fails and leaves context lifetime outside the driver', async () =>
{
    const model = await enteredSwitchModel();
    const first = new Error('original Node navigation failure');
    model.page.goto = async () =>
    {
        throw first;
    };
    model.options.saveStage = async () =>
    {
        throw new Error('stage sink failure');
    };
    try
    {
        await assert.rejects(drivePublicShellLocaleSwitchInContext(model.options),
            (error) => error === first && error.evidenceFailure.message === 'stage sink failure');
        assert.equal(model.options.context.pages()[0], model.page);
        assert.equal(model.calls.filter((call) => call === 'unroute').length, 1);
    }
    finally
    {
        await model.observer.dispose();
    }
});

test('entered switch legacy wrapper delegates the same operation with exactly one original lease and unchanged final sink', async () =>
{
    const model = await enteredSwitchModel();
    let leaseCalls = 0;
    let factories = 0;
    let closes = 0;
    const retained = [];
    model.options.context.close = async () => closes++;
    const harness = { identity: model.identity, async withScene(sceneId, factory, observe)
    {
        leaseCalls++;
        assert.equal(sceneId, model.options.scene.id);
        const context = await factory();
        assert.equal(context, model.options.context);
        try
        {
            return await observe({ context, fixture: model.options.fixture });
        }
        finally
        {
            await context.close();
        }
    } };
    try
    {
        const evidence = await drivePublicShellLocaleSwitchScene({ harness, matrix: model.options.matrix,
            sceneId: model.options.scene.id, resourceHolds: model.options.resourceHolds,
            createContext: async () =>
            {
                factories++;
                return model.options.context;
            },
            saveEvidence: async (input) => retained.push(input) });
        assert.equal(leaseCalls, 1);
        assert.equal(factories, 1);
        assert.equal(closes, 1);
        assert.equal(retained.length, 1);
        assert.equal(retained[0].page, model.page);
        assert.equal(retained[0].evidence, evidence);
        assert.deepEqual(evidence.observations.map((item) => item.stage), ['before-click', 'pending', 'after-commit']);
        assert.equal(evidence.telemetry[0].generation, 7);
        assert.equal(model.saved.length, 0, 'legacy wrapper does not pretend it had a lifecycle capture sink');
    }
    finally
    {
        await model.observer.dispose();
    }
});

test('entered switch keeps the old pending-language assertion and saves the actually failed stage before cleanup', async () =>
{
    const model = await enteredSwitchModel();
    let domReads = 0;
    const original = model.page.evaluate;
    model.page.evaluate = async (callback, argument) =>
    {
        const value = await original(callback, argument);
        if (callback === readPublicShellLocaleDom && ++domReads === 2)
        {
            value.language = model.options.scene.document.language;
        }
        return value;
    };
    try
    {
        await assert.rejects(drivePublicShellLocaleSwitchInContext(model.options), /observed document language/u);
        assert.deepEqual(model.saved.map((input) => input.evidence.stage), ['before-click', 'pending', 'first-failure']);
        assert.equal(model.saved[1].evidence.dom.language, model.options.scene.document.language);
        assert.match(model.saved[2].evidence.trace.failure.message, /observed document language/u);
        assert.equal(model.calls.filter((call) => call === 'unroute').length, 1);
    }
    finally
    {
        await model.observer.dispose();
    }
});

test('entered switch stage cuts advance only with actual observer request records, not stage numbers', async () =>
{
    const model = await enteredSwitchModel();
    let domReads = 0;
    const evaluate = model.page.evaluate;
    model.page.evaluate = async (callback, argument) =>
    {
        const value = await evaluate(callback, argument);
        if (callback === readPublicShellLocaleDom && ++domReads === 2)
        {
            const url = model.options.bindings.preferenceUrl;
            model.listeners.get('request')({ url: () => url, method: () => 'GET', resourceType: () => 'fetch',
                postDataBuffer: () => null, headersArray: async () => [] });
        }
        return value;
    };
    try
    {
        await drivePublicShellLocaleSwitchInContext(model.options);
        assert.deepEqual(model.saved.map((input) => input.evidence.evidence.captureCut), [0, 1, 1, 1]);
        const originals = model.observer.rawCapture.snapshot();
        assert.equal(originals.originals.length, 1);
        assert.equal(originals.originals[0].requestOrdinal, 0);
        assert.equal(model.saved.some((input) => Object.hasOwn(input, 'privateOriginals')), false);
    }
    finally
    {
        await model.observer.dispose();
    }
});

for (const field of ['title', 'description', 'openGraphLocale'])
{
    test(`switch transaction rejects pending ${field} drift from actual before-click metadata`, async () =>
    {
        const model = await enteredSwitchModel();
        const evaluate = model.page.evaluate;
        let reads = 0;
        model.page.evaluate = async (callback, argument) =>
        {
            const value = await evaluate(callback, argument);
            if (callback === readPublicShellLocaleDom && ++reads === 2)
            {
                value.metadata[field] = 'early target metadata';
            }
            return value;
        };
        try
        {
            await assert.rejects(drivePublicShellLocaleSwitchInContext(model.options), /pending metadata changed/u);
            assert.equal(model.saved.find((input) => input.evidence.stage === 'pending').evidence.dom.metadata[field], 'early target metadata');
            assert.equal(model.saved.at(-1).evidence.stage, 'first-failure');
            assert.equal(model.calls.filter((call) => call === 'unroute').length, 1);
        }
        finally
        {
            await model.observer.dispose();
        }
    });
}

function modelSwitchRequest(url, { type = 'fetch', method = 'GET', bytes = null } = {})
{
    let bodyReads = 0;
    return { url: () => url, method: () => method, resourceType: () => type, headersArray: async () => [],
        postDataBuffer: () =>
        {
            bodyReads += 1;
            return bytes;
        }, bodyReads: () => bodyReads };
}

function emitOnFirstSelectorClick(model, requests)
{
    const locator = model.selector.locator;
    let clicked = false;
    model.selector.locator = (query) =>
    {
        const item = locator(query);
        return { ...item, click: async () =>
        {
            await item.click();
            if (!clicked)
            {
                clicked = true;
                requests.forEach(model.emitRequest);
            }
        } };
    };
}

for (const kind of ['document', 'article', 'unknown', 'unrelated-domain', 'other-locale', 'static', 'resource-write', 'wrong-command', 'invalid-command'])
{
    test(`switch transaction rejects ${kind} request after the actual selector click`, async () =>
    {
        const extra = 'http://runtime.invalid/explicit-node-extra.js';
        const captureResources = (resources, scene) => [...resources, { url: extra, digest: `sha256:${'d'.repeat(64)}`,
            identities: [{ kind: kind === 'static' ? 'static' : 'domain', locale: kind === 'other-locale' ? scene.transition.sourceLocale : scene.locale,
                domain: kind === 'unrelated-domain' ? 'unrequired-domain' : scene.requiredDomains[0] }] }];
        const model = await enteredSwitchModel({ captureResources });
        const { scene, bindings, fixture } = model.options;
        let request;
        if (['wrong-command', 'invalid-command'].includes(kind))
        {
            request = modelSwitchRequest(bindings.preferenceUrl, { method: 'PUT', bytes: kind === 'invalid-command' ? Buffer.from('bad')
                : Buffer.from(bindings.preference.encodeRequest('fixed', scene.transition.sourceLocale, 0)) });
        }
        else
        {
            const url = kind === 'document' ? new URL('/', fixture.baseUrl).href
                : kind === 'article' ? fixture.publicArticle.url : kind === 'unknown' ? 'http://runtime.invalid/unknown-business' : extra;
            request = modelSwitchRequest(url, { type: kind === 'document' ? 'document' : 'fetch', method: kind === 'resource-write' ? 'POST' : 'GET' });
        }
        emitOnFirstSelectorClick(model, [request]);
        try
        {
            await assert.rejects(drivePublicShellLocaleSwitchInContext(model.options), /switch transaction request/u);
            assert.equal(model.saved.at(-1).evidence.stage, 'first-failure');
            assert.equal(request.bodyReads(), kind.endsWith('command') ? 1 : 0, 'only the original preference PUT command is read');
            assert.equal(model.calls.filter((call) => call === 'unroute').length, 1);
        }
        finally
        {
            await model.observer.dispose();
        }
    });
}

test('switch transaction accepts only frozen planned domains/fonts/styles and typed GET/PUT originals, ignoring pre-click requests', async () =>
{
    const font = 'http://runtime.invalid/explicit-node-font';
    const style = 'http://runtime.invalid/explicit-node-font-style';
    const captureResources = (resources, scene) => [...resources, ...[[font, 'font'], [style, 'font-style']].map(([url, kind]) => ({
        url, digest: `sha256:${'e'.repeat(64)}`, identities: [{ kind, locale: scene.locale }] }))];
    const model = await enteredSwitchModel({ captureResources, stage: 'latest-wins' });
    const { bindings, scene } = model.options;
    const before = modelSwitchRequest(model.options.fixture.publicArticle.url);
    const goto = model.page.goto;
    model.page.goto = async (...args) =>
    {
        await goto(...args);
        model.emitRequest(before);
    };
    const requests = [
        ...model.options.resourceHolds.map((hold) => modelSwitchRequest(hold.url, { type: 'script' })),
        modelSwitchRequest(font, { type: 'font' }), modelSwitchRequest(style, { type: 'stylesheet' }),
        modelSwitchRequest(bindings.preferenceUrl),
        modelSwitchRequest(bindings.preferenceUrl, { method: 'PUT', bytes: Buffer.from(bindings.preference.encodeRequest('fixed', scene.locale, 2)) })
    ];
    emitOnFirstSelectorClick(model, requests);
    try
    {
        const evidence = await drivePublicShellLocaleSwitchInContext(model.options);
        assert.equal(evidence.telemetry.filter((event) => event.name === 'locale_runtime_committed').length, 1);
        assert.equal(evidence.telemetry[0].generation, 7, 'transaction intent generation is not invented baseline plus one');
        assert.equal(evidence.requests.length, requests.length + 1);
        assert.equal(requests.at(-1).bodyReads(), 1, 'original collector command is reused, not re-read');
        assert.equal([...requests.slice(0, -1), before].every((request) => request.bodyReads() === 0), true);
        assert.deepEqual(Object.keys(evidence.requests[0]).sort(), ['identity', 'method', 'type']);
        assert.ok(evidence.remainingContracts.includes('atomic painted-frame continuity'));
    }
    finally
    {
        await model.observer.dispose();
    }
});

test('canonical matrix wires per-target races for switch and superseded-failure and rejects resealed old plan', async () =>
{
    const matrix = await createPublicShellLocaleMatrix();
    currentMatrix = matrix;
    const rapidScenes = matrix.scenes.filter((scene) => ['latest-wins', 'superseded-failure'].includes(scene.stage));
    for (const locale of matrix.locales)
    {
        for (const stage of ['latest-wins', 'superseded-failure'])
        {
            assert.ok(rapidScenes.some((scene) => scene.locale === locale.code && scene.stage === stage));
        }
    }
    for (const scene of rapidScenes)
    {
        assert.deepEqual(scene.transition.rapidTargets, publicShellLocaleRapidTargets(matrix.locales, scene.locale));
    }
    const candidate = structuredClone(matrix);
    const scene = candidate.scenes.find((item) => item.stage === 'latest-wins' && item.transition.rapidTargets.length === 4);
    scene.transition.rapidTargets.pop();
    delete candidate.contentDigest;
    candidate.contentDigest = publicShellLocaleContentDigest(candidate);
    await assert.rejects(validatePublicShellLocaleMatrix(candidate), /does not match current authority/u);
});

test('switch rejects fixed ru ending for a different target despite a forged matching record', () =>
{
    const locale = locales.find((item) => !item.aliases.includes('ru')).code;
    const targets = publicShellLocaleRapidTargets(locales, locale).slice(0, 3);
    assert.throws(() => assertPublicShellLocaleSwitch({
        scene: { issue: 2086, stage: 'latest-wins', locale,
            transition: { driver: 'selector-ui', rapidTargets: targets, sourceLocale: descriptor.code, expectedUiLocale: locale } },
        copy: {}, record: { uiLocale: locale, selectorActive: locale, copy: {}, commitGeneration: 1,
            preference: locale, mixedLanguage: false, driver: 'selector-ui', geometryStable: true, supersededCommitted: false }
    }), /final clicked target/u);
});

test('switch does not admit arbitrary extra clicks after allowing the per-target fourth click', () =>
{
    const locale = locales.find((item) => !item.aliases.includes('ru')).code;
    assert.throws(() => assertPublicShellLocaleSwitch({
        scene: { issue: 2086, stage: 'latest-wins', locale,
            transition: { driver: 'selector-ui', rapidTargets: [...publicShellLocaleRapidTargets(locales, locale), locale],
                sourceLocale: descriptor.code, expectedUiLocale: locale } },
        copy: {}, record: { uiLocale: locale, selectorActive: locale, copy: {}, commitGeneration: 1,
            preference: locale, mixedLanguage: false, driver: 'selector-ui', geometryStable: true, supersededCommitted: false }
    }), /rapid targets/u);
});

test('hydration permits real enclosing header geometry at all four stages', () =>
{
    const evidence = assertPublicShellLocaleHydration(hydrationInput());
    assert.equal(evidence.qualificationEligible, false);
});

for (const [name, mutate] of [
    ['sibling overlap', (geometry) => geometry.brand.x = geometry.nav.x],
    ['overflow', (geometry) => geometry.nav.overflow = true],
    ['hidden box', (geometry) => geometry.selector.width = 0],
    ['NaN position', (geometry) => geometry.nav.x = NaN],
    ['infinite width', (geometry) => geometry.auth.width = Infinity]
])
{
    test(`hydration still rejects ${name}`, () =>
    {
        const input = hydrationInput();
        mutate(input.snapshots['first-html'].geometry);
        assert.throws(() => assertPublicShellLocaleHydration(input), /hydration/u);
    });
}

function domInput()
{
    return {
        descriptor, copy, selectorItems: items, viewport,
        observation: {
            language: descriptor.documentLanguage, direction: descriptor.direction,
            metadata: { openGraphLocale: descriptor.openGraphLocale }, viewport,
            copyNodes: [{ key: 'public.shell.login', text: copy['public.shell.login'], visible: true }],
            selectors: [{ active: descriptor.code, expanded: false, visible: true, disabled: false,
                items: items.map((item) => ({ ...item, englishName: item.englishName !== item.nativeName ? item.englishName : null, disabled: false, visible: false })) }],
            geometry: [
                { name: 'header', visible: true, box: box(0, 390, 96) },
                { name: 'brand', visible: true, box: box(0) },
                { name: 'selector', visible: true, box: box(150) }
            ],
            containment: [[0, 1], [0, 2]]
        }
    };
}

test('DOM projection preserves closed items and reports absent fallback copy, never fills it', () =>
{
    const input = domInput();
    input.copy = { ...copy, 'layout.siteHeader.fallbackTitle': 'not observed' };
    assert.deepEqual(assertPublicShellLocaleDom(input), {
        unobservedKeys: ['layout.siteHeader.fallbackTitle'], hiddenControls: []
    });
});

for (const [name, mutate] of [
    ['wrong language', (value) => value.language = 'unknown'],
    ['missing dir', (value) => value.direction = ''],
    ['wrong copy', (value) => value.copyNodes[0].text = 'wrong'],
    ['native label drift', (value) => value.selectors[0].items[0].nativeName = 'wrong'],
    ['English label drift', (value) => value.selectors[0].items[0].englishName = 'wrong'],
    ['direction drift', (value) => value.selectors[0].items[0].direction = 'invalid'],
    ['disabled projection drift', (value) => value.selectors[0].items[0].disabled = true],
    ['missing disabled fact', (value) => delete value.selectors[0].disabled],
    ['missing selected locale', (value) => value.selectors[0].items.forEach((item) => item.selected = false)],
    ['duplicate selector key', (value) => value.selectors[0].items.push(value.selectors[0].items[0])],
    ['opened hidden items', (value) => value.selectors[0].expanded = true],
    ['sibling collision', (value) => value.geometry[2].box.x = 0],
    ['unproven containment', (value) => value.containment = []],
    ['horizontal overflow', (value) => value.geometry[2].box.x = 389],
    ['small hit target', (value) => value.geometry[2].box.width = 43],
    ['nonfinite box', (value) => value.geometry[2].box.width = Infinity]
])
{
    test(`DOM projection rejects ${name}`, () =>
    {
        const input = domInput();
        mutate(input.observation);
        assert.throws(() => assertPublicShellLocaleDom(input));
    });
}

test('DOM reader records actual containment, hidden state, metadata and text without product writes', () =>
{
    const window = new Window();
    window.document.write(`<html lang="${descriptor.documentLanguage}" dir="${descriptor.direction}"><head>
        <title>real configured title</title><meta property="og:locale" content="${descriptor.openGraphLocale}">
        </head><body><div id="fsus-aot-shell" data-public-auth-message-key="public.shell.login">
        <header data-public-shell-header><a data-public-nav="home">actual brand</a>
        <a data-public-nav="home">actual home</a><a data-public-nav="auth">actual auth</a>
        <div data-locale-selector data-active-locale="${descriptor.code}">
        <button data-locale-selector-trigger aria-expanded="false">actual trigger</button>
        <div hidden data-locale-selector-menu><button data-locale-selector-item
        data-locale-code="${descriptor.code}" aria-checked="true" dir="ltr" aria-disabled="true"><span class="locale-selector__item-native">actual native</span><span class="locale-selector__item-english">actual English</span></button></div></div>
        </header></div></body></html>`);
    for (const element of window.document.querySelectorAll('*'))
    {
        element.getClientRects = () => [element.getBoundingClientRect()];
    }
    const before = window.document.documentElement.outerHTML;
    const observed = runInNewContext(`(${readPublicShellLocaleDom.toString()})()`, { window });
    assert.equal(observed.metadata.title, 'real configured title');
    assert.equal(observed.copyNodes.find((item) => item.key === 'public.shell.home').text, 'actual home');
    assert.equal(observed.selectors[0].items[0].visible, false);
    assert.equal(observed.selectors[0].items[0].nativeName, 'actual native');
    assert.equal(observed.selectors[0].items[0].englishName, 'actual English');
    assert.equal(observed.selectors[0].items[0].direction, 'ltr');
    assert.equal(observed.selectors[0].items[0].disabled, true);
    assert.equal(observed.selectors[0].disabled, false);
    assert.ok(observed.containment.some(([parent, child]) => parent === 0 && child === 1));
    assert.equal(window.document.documentElement.outerHTML, before);
    assert.equal(observed.copyNodes.some((item) => item.key.startsWith('layout.')), false);
    window.document.documentElement.removeAttribute('dir');
    const missingDirection = runInNewContext(`(${readPublicShellLocaleDom.toString()})()`, { window });
    assert.equal(missingDirection.direction, '');
    window.happyDOM.abort();
});

test('telemetry listener captures genuine bus events without calling or dispatching product hooks', () =>
{
    const window = new Window();
    runInNewContext(`(${installPublicShellLocaleTelemetry.toString()})()`, { window });
    assert.equal(window.__fsusblogLocaleSceneObservation.events.length, 0);
    window.dispatchEvent(new window.CustomEvent('fsus:telemetry', { detail: {
        name: 'locale_runtime_committed', level: 'info', detail: { generation: 19, locale: descriptor.code }
    } }));
    assert.equal(window.__fsusblogLocaleSceneObservation.events[0].generation, 19);
    assert.equal(window.__fsusblogLocaleSceneObservation.events[0].locale, descriptor.code);
    window.happyDOM.abort();
});

test('commit readiness rejects stale events, missing fonts, pending selection and unflushed DOM', () =>
{
    const window = new Window();
    window.document.documentElement.lang = descriptor.documentLanguage;
    window.document.body.innerHTML = `<div id="fsus-aot-shell"><div data-locale-selector
        data-active-locale="${descriptor.code}"><button data-locale-selector-item
        data-locale-code="${descriptor.code}" aria-checked="true"></button></div></div>`;
    const selector = window.document.querySelector('[data-locale-selector]');
    window.__fsusblogLocaleSceneObservation = { events: [{ name: 'locale_runtime_committed', locale: descriptor.code }] };
    const target = { code: descriptor.code, language: descriptor.documentLanguage, eventOffset: 0 };
    const ready = () => runInNewContext(`(${publicShellLocaleCommitReady.toString()})(target)`, { window, target });
    assert.equal(ready(), false);
    Object.defineProperty(window.document, 'fonts', { value: { status: 'loaded' }, configurable: true });
    assert.equal(ready(), true);
    target.eventOffset = 1;
    assert.equal(ready(), false);
    target.eventOffset = 0;
    selector.setAttribute('data-pending-locale', descriptor.code);
    assert.equal(ready(), false);
    selector.removeAttribute('data-pending-locale');
    selector.setAttribute('data-active-locale', 'not flushed');
    assert.equal(ready(), false);
    selector.setAttribute('data-active-locale', descriptor.code);
    selector.querySelector('[data-locale-selector-item]').setAttribute('aria-checked', 'false');
    assert.equal(ready(), false);
    window.happyDOM.abort();
});

test('unsupported scene fails before requesting any browser context', async () =>
{
    let contexts = 0;
    await assert.rejects(drivePublicShellLocaleSwitchScene({
        matrix: { scenes: [{ id: 'unsupported', issue: 2086, stage: 'refresh' }] }, sceneId: 'unsupported',
        createContext: () => contexts++
    }), /unsupported scene slice/u);
    assert.equal(contexts, 0);
});

test('scene preserves first failure and attempts evidence before owned teardown even when sink fails', async () =>
{
    const matrix = currentMatrix;
    const scene = matrix.scenes.find((item) => item.issue === 2086 && item.stage === 'commit' && item.route === 'Home');
    const order = [];
    const firstError = new Error('first production observation failed');
    const page = {
        on: () =>
        {},
        goto: async () =>
        {
            throw firstError;
        }
    };
    const context = {
        addInitScript: async () =>
        {},
        route: async () =>
        {},
        newPage: async () => page,
        unroute: async () => order.push('unroute'), close: async () => order.push('close')
    };
    const harness = {
        identity: { matrixDigest: matrix.contentDigest, sourceState: {
            commit: matrix.identity.sourceCommit, worktreeFingerprint: matrix.identity.worktreeFingerprint
        } },
        withScene: async (id, createContext, observe) =>
        {
            assert.equal(id, scene.id);
            const ownedContext = await createContext();
            try
            {
                return await observe({ context: ownedContext, fixture: { baseUrl: 'http://runtime.invalid', publicArticle: {} } });
            }
            finally
            {
                await ownedContext.close();
            }
        }
    };
    await assert.rejects(drivePublicShellLocaleSwitchScene({
        harness, matrix, sceneId: scene.id, createContext: async () => context,
        resourceHolds: [{ locale: scene.locale, url: 'http://runtime.invalid/immutable-domain.js', barrier: { close: () => order.push('barrier-close') } }],
        saveEvidence: async ({ evidence, page: ownedPage }) =>
        {
            assert.equal(ownedPage, page);
            assert.equal(evidence.failure.message, firstError.message);
            assert.equal(evidence.qualificationEligible, undefined);
            order.push('save');
            throw new Error('evidence sink failed');
        }
    }), (error) => error === firstError && error.evidenceFailure.message === 'evidence sink failed');
    assert.deepEqual(order, ['save', 'barrier-close', 'unroute', 'close']);
});
