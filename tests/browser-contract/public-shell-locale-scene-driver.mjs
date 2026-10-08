/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { bindPublicShellLocaleResourceBarrier } from './public-shell-locale-harness.mjs';
import { resolvePublicShellLocaleCopy } from './public-shell-locale-matrix.mjs';
import { loadPublicShellLocalePreferenceBindings } from './public-shell-locale-runtime-bindings.mjs';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const supportedStages = Object.freeze(['commit', 'post-commit', 'latest-wins']);

async function waitForResourceEntry(barrier)
{
    let deadline;
    try
    {
        await Promise.race([
            barrier.entered,
            new Promise((resolve, reject) =>
            {
                deadline = setTimeout(() => reject(new Error('planned production resource was not intercepted')), 10_000);
            })
        ]);
    }
    finally
    {
        clearTimeout(deadline);
    }
}

/** Read public DOM hooks, including closed disclosure state; never substitute expected text. */
export function readPublicShellLocaleDom()
{
    const document = window.document;
    const shell = document.querySelector('#fsus-aot-shell');
    if (!shell)
    {
        throw new Error('public AOT shell was not observed');
    }
    const visible = (element) =>
    {
        if (!element || element.getClientRects().length === 0)
        {
            return false;
        }
        for (let parent = element; parent; parent = parent.parentElement)
        {
            const style = window.getComputedStyle(parent);
            if (parent.hidden || style.display === 'none' || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0)
            {
                return false;
            }
        }
        return true;
    };
    const text = (element) => element.textContent.trim();
    const controls = [];
    const copyNodes = [];
    const add = (element, name, key = null) =>
    {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        controls.push({ element, name, box: {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height
        }, visible: visible(element), ariaLabelOrText: element.getAttribute('aria-label') ?? text(element),
        fontFamily: style.fontFamily });
        if (key)
        {
            copyNodes.push({ key, text: text(element), visible: visible(element) });
        }
    };
    const header = shell.querySelector('[data-public-shell-header]');
    if (header)
    {
        add(header, 'header');
    }
    const homeLinks = [...shell.querySelectorAll('[data-public-nav="home"]')];
    for (const [index, element] of homeLinks.entries())
    {
        add(element, index === 0 ? 'brand' : 'home', index === 0 ? null : 'public.shell.home');
    }
    for (const name of ['archive', 'about', 'auth'])
    {
        for (const element of shell.querySelectorAll(`[data-public-nav="${name}"]`))
        {
            const key = name === 'auth' ? shell.getAttribute('data-public-auth-message-key') : `public.shell.${name}`;
            add(element, name, key);
        }
    }
    for (const element of shell.querySelectorAll('a[href="#main-content"]'))
    {
        copyNodes.push({ key: 'public.shell.skipToMain', text: text(element), visible: visible(element) });
    }
    for (const element of shell.querySelectorAll('a[href="/search"]'))
    {
        add(element, 'search');
        copyNodes.push({ key: 'public.shell.search', text: element.getAttribute('aria-label') ?? text(element),
            visible: visible(element) });
    }
    for (const element of shell.querySelectorAll('[data-mobile-nav-menu-trigger]'))
    {
        add(element, 'mobile-menu');
    }
    const selectors = [...shell.querySelectorAll('[data-locale-selector]')].map((element) =>
    {
        const trigger = element.querySelector('[data-locale-selector-trigger]');
        if (trigger)
        {
            add(trigger, 'selector');
        }
        return {
            active: element.getAttribute('data-active-locale'),
            pending: element.getAttribute('data-pending-locale'),
            visible: visible(trigger),
            expanded: trigger?.getAttribute('aria-expanded') === 'true',
            disabled: Boolean(trigger?.disabled || trigger?.getAttribute('aria-disabled') === 'true'),
            items: [...element.querySelectorAll('[data-locale-selector-item]')].map((item) => ({
                code: item.getAttribute('data-locale-code'),
                selected: item.getAttribute('aria-checked') === 'true',
                visible: visible(item),
                nativeName: item.querySelector('.locale-selector__item-native')?.textContent ?? null,
                englishName: item.querySelector('.locale-selector__item-english')?.textContent ?? null,
                direction: item.getAttribute('dir'),
                disabled: Boolean(item.disabled || item.getAttribute('aria-disabled') === 'true'),
                ariaLabelOrText: item.getAttribute('aria-label') ?? text(item)
            }))
        };
    });
    const containment = [];
    for (const [parent, left] of controls.entries())
    {
        for (const [child, right] of controls.entries())
        {
            if (parent !== child && left.element.contains(right.element))
            {
                containment.push([parent, child]);
            }
        }
    }
    return {
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        hydrationKind: shell.getAttribute('data-public-hydration-kind'),
        hydrated: shell.getAttribute('data-public-hydrated') === 'true',
        metadata: {
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.content ?? null,
            openGraphLocale: document.querySelector('meta[property="og:locale"]')?.content ?? null,
            viewportMetaCount: document.querySelectorAll('meta[name="viewport"]').length
        },
        copyNodes,
        selectors,
        geometry: controls.map((control) => ({
            name: control.name, box: control.box, visible: control.visible,
            ariaLabelOrText: control.ariaLabelOrText, fontFamily: control.fontFamily
        })),
        containment,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        fonts: document.fonts ? [...document.fonts].map((font) => ({
            family: font.family, weight: font.weight, status: font.status
        })) : null
    };
}

/** Validate observed leaves, not bounding-box intersections between a parent and descendants. */
export function assertPublicShellLocaleDom({ observation, descriptor, copy, selectorItems, viewport })
{
    assert.equal(observation.language, descriptor.documentLanguage, 'observed document language');
    assert.equal(observation.direction, descriptor.direction, 'observed document direction');
    assert.equal(observation.metadata.openGraphLocale, descriptor.openGraphLocale, 'observed OG locale');
    assert.equal(observation.metadata.viewportMetaCount, 1, 'observed viewport meta must be unique');
    assert.deepEqual(observation.viewport, viewport, 'observed viewport');
    const unobservedKeys = [];
    for (const [key, value] of Object.entries(copy))
    {
        const nodes = observation.copyNodes.filter((node) => node.key === key);
        if (nodes.length === 0)
        {
            unobservedKeys.push(key);
        }
        for (const node of nodes)
        {
            assert.equal(node.text, value, `observed typed copy ${key}`);
        }
    }
    for (const selector of observation.selectors)
    {
        assert.equal(selector.active, descriptor.code, 'observed selector locale');
        assert.deepEqual(selector.items.map((item) => item.code), selectorItems.map((item) => item.code),
            'observed selector exact catalog order');
        assert.deepEqual(selector.items.filter((item) => item.selected).map((item) => item.code), [descriptor.code],
            'observed selector selected keyset');
        assert.equal(typeof selector.disabled, 'boolean', 'observed selector disabled fact missing');
        for (const [index, item] of selector.items.entries())
        {
            const projected = selectorItems[index];
            assert.equal(item.nativeName, projected.nativeName, 'observed selector native label');
            assert.equal(item.englishName, projected.englishName !== projected.nativeName ? projected.englishName : null,
                'observed selector English label');
            assert.equal(item.direction, projected.direction, 'observed selector direction');
            assert.equal(item.disabled, selector.disabled, 'observed selector item disabled projection');
        }
        if (selector.expanded && selector.visible)
        {
            assert.ok(selector.items.every((item) => item.visible), 'opened selector item visibility');
        }
    }
    assert.ok(observation.selectors.length > 0, 'selector must be observed');
    const controls = observation.geometry;
    assert.ok(controls.some((control) => control.name === 'header' && control.visible), 'visible header required');
    for (const [index, control] of controls.entries())
    {
        if (!control.visible)
        {
            continue;
        }
        const { x, y, width, height } = control.box;
        assert.ok([x, y, width, height].every(Number.isFinite), 'observed geometry must be finite');
        assert.ok(width > 0 && height > 0, 'visible control must have a positive box');
        assert.ok(x >= 0 && x + width <= viewport.width, 'observed horizontal overflow');
        if (control.name !== 'header')
        {
            const floor = viewport.width <= 390 ? 44 : 40;
            assert.ok(width >= floor && height >= floor, `observed ${control.name} hit target below ${floor}px`);
        }
        for (let other = index + 1; other < controls.length; other += 1)
        {
            const right = controls[other];
            if (!right.visible || observation.containment.some(([parent, child]) =>
                (parent === index && child === other) || (parent === other && child === index)))
            {
                continue;
            }
            const box = right.box;
            assert.equal(x < box.x + box.width && x + width > box.x
                && y < box.y + box.height && y + height > box.y, false, 'observed sibling collision');
        }
    }
    // Missing fallback text, hidden controls and unavailable font observations are
    // retained as gaps, never filled with expected values or promoted to acceptance.
    return { unobservedKeys, hiddenControls: controls.filter((control) => !control.visible).map((control) => control.name) };
}

/** Only listen to the public production telemetry bus; do not invoke runtime phase APIs. */
export function installPublicShellLocaleTelemetry()
{
    const events = [];
    window.__fsusblogLocaleSceneObservation = { events };
    window.addEventListener('fsus:telemetry', (event) =>
    {
        const payload = event.detail;
        if (['locale_runtime_phase', 'locale_runtime_committed', 'locale_runtime_failed'].includes(payload?.name))
        {
            events.push({
                name: payload.name,
                level: payload.level,
                generation: payload.detail?.generation,
                locale: payload.detail?.locale ?? payload.detail?.target,
                from: payload.detail?.from ?? null,
                to: payload.detail?.to ?? null
            });
        }
    });
}

/** A production commit event alone may precede Vue's DOM flush. Wait on public observations. */
export function publicShellLocaleCommitReady({ code, language, eventOffset })
{
    const document = window.document;
    const selectors = [...document.querySelectorAll('#fsus-aot-shell [data-locale-selector]')];
    return document.documentElement.lang === language
        && document.fonts?.status === 'loaded'
        && selectors.length > 0
        && selectors.every((selector) => selector.getAttribute('data-active-locale') === code
            && !selector.getAttribute('data-pending-locale')
            && selector.querySelectorAll('[data-locale-selector-item][aria-checked="true"]').length === 1
            && selector.querySelector('[data-locale-selector-item][aria-checked="true"]')
                ?.getAttribute('data-locale-code') === code)
        && window.__fsusblogLocaleSceneObservation.events.slice(eventOffset).some((event) =>
            event.name === 'locale_runtime_committed' && event.locale === code);
}

export async function openPublicShellLocaleSelector(page)
{
    let trigger = page.locator('[data-locale-selector-trigger]:visible');
    if (await trigger.count() === 0)
    {
        const menu = page.locator('[data-mobile-nav-menu-trigger]:visible');
        assert.equal(await menu.count(), 1, 'one native mobile menu trigger required');
        await menu.click();
        trigger = page.locator('[data-locale-selector-trigger]:visible');
    }
    assert.equal(await trigger.count(), 1, 'one visible locale selector trigger required');
    if (await trigger.getAttribute('aria-expanded') !== 'true')
    {
        await trigger.click();
    }
    return page.locator('[data-locale-selector]:has([data-locale-selector-trigger]:visible)');
}

/** Preserve every planned click, including the final per-scene target. No direct commit calls. */
export async function clickPublicShellLocaleTargets(page, scene, afterClick)
{
    assert.equal(scene.transition?.driver, 'selector-ui', 'selector UI plan required');
    const targets = scene.stage === 'latest-wins' ? scene.transition.rapidTargets : [scene.locale];
    assert.ok(targets.length > 0 && targets.at(-1) === scene.locale, 'final clicked locale must match scene target');
    for (const locale of targets)
    {
        assert.ok(scene.selectorItems.some((item) => item.code === locale), 'click target must belong to scene catalog');
        const selector = await openPublicShellLocaleSelector(page);
        const item = selector.locator(`[data-locale-selector-item][data-locale-code="${locale}"]:visible`);
        assert.equal(await item.count(), 1, 'exact visible locale item required');
        await item.click();
        await afterClick(locale);
    }
}

/** Existing canonical runner supplies its admitted harness/context factory and immutable resource holds.
 * This is a bounded scene slice, not a second runner or a qualified submatrix result.
 * resourceHolds: [{ locale, url, barrier }], derived by the owner from its build inventory.
 * saveEvidence({ evidence, page }) saves raw JSON/screenshots before the owned context closes,
 * including the first failed observation. It must not turn this partial record into a gate pass.
 */
function assertSwitchScene(scene)
{
    assert.ok(scene?.issue === 2086 && supportedStages.includes(scene.stage), 'unsupported scene slice');
    assert.equal(scene.authActionContext, 'anonymous', 'switch actor authority missing for this role');
    assert.ok(['Home', 'ArticleDetail'].includes(scene.route), 'unsupported switch route authority');
}

async function prepareSwitchScene({ identity, matrix, scene, resourceHolds })
{
    assertSwitchScene(scene);
    assert.deepEqual(scene, matrix.scenes.find((item) => item.id === scene.id), 'switch scene differs from matrix');
    assert.equal(identity.matrixDigest, matrix.contentDigest, 'admitted scene matrix identity');
    assert.equal(identity.sourceState.commit, matrix.identity.sourceCommit, 'admitted scene source identity');
    assert.equal(identity.sourceState.worktreeFingerprint, matrix.identity.worktreeFingerprint, 'admitted scene worktree identity');
    const root = matrix.identity.worktree;
    const targetCopy = await resolvePublicShellLocaleCopy(matrix, scene.id, root);
    const sourceScene = matrix.scenes.find((item) => item.issue === 2084 && item.locale === scene.transition.sourceLocale
        && item.route === scene.route && item.authActionContext === scene.authActionContext
        && item.viewport.width === scene.viewport.width);
    assert.ok(sourceScene, 'source locale authority scene required');
    const sourceCopy = await resolvePublicShellLocaleCopy(matrix, sourceScene.id, root);
    const targets = scene.stage === 'latest-wins' ? scene.transition.rapidTargets : [scene.locale];
    for (const locale of new Set(targets))
    {
        assert.ok(resourceHolds.some((hold) => hold.locale === locale), 'scene requires a real resource hold per target');
    }
    const preference = await loadPublicShellLocalePreferenceBindings(root);
    return { identity, targetCopy, sourceScene, sourceCopy, targets, preference };
}

/** Entered-lease operation: the caller already owns the context/observer lifetime.
 * Save stage metadata with its actual observer cut, never copy/emit a body batch here.
 * The outer lifecycle retains originals once in its normal/disposal sinks. This partial
 * operation keeps the old explicit remainingContracts; it is not native qualification.
 */
export async function drivePublicShellLocaleSwitchInContext({ context, fixture, scene, matrix, bindings, observer, saveStage, resourceHolds })
{
    assertSwitchScene(scene);
    assert.ok(bindings?.identity && Array.isArray(bindings.resources), 'immutable runtime bindings required');
    assert.equal(typeof saveStage, 'function', 'runner-owned stage sink required');
    assert.equal(typeof observer?.capture, 'function', 'entered lifecycle observer required');
    assert.equal(typeof observer.rawCapture?.requireContext, 'function', 'original capture capability required');
    assert.equal(typeof observer.rawCapture.admittedResource, 'function', 'original resource admission capability required');
    observer.rawCapture.requireContext(context, bindings);
    assert.equal(observer.rawCapture.sceneId, scene.id, 'observer belongs to another scene');
    assert.equal(typeof context?.pages, 'function', 'entered context inventory required');
    assert.equal(context.pages().length, 0, 'switch operation must start before the only page');
    assert.ok(Array.isArray(resourceHolds), 'immutable resource holds required');
    const runtime = new URL(fixture.baseUrl);
    const route = scene.route === 'Home' ? new URL('/', runtime) : new URL(fixture.publicArticle.url, runtime);
    assert.equal(route.origin, runtime.origin, 'official public route fixture required');
    const urls = new Set();
    for (const hold of resourceHolds)
    {
        const url = new URL(hold.url);
        assert.equal(url.origin, runtime.origin, 'hold must target the prepared runtime');
        assert.equal(url.username + url.password + url.hash, '', 'hold URL must be canonical');
        assert.equal(urls.has(url.href), false, 'duplicate resource hold');
        urls.add(url.href);
        const resources = bindings.resources.filter((resource) => resource.url === url.href);
        assert.equal(resources.length, 1, 'hold resource is not uniquely bound to the immutable build');
        const admitted = observer.rawCapture.admittedResource(url.href);
        assert.ok(admitted, 'hold has no original capture resource admission');
        assert.deepEqual(resources[0], admitted, 'hold resource differs from original capture admission');
        assert.ok(resources[0].identities.some((identity) => identity.locale === hold.locale
            && (identity.kind === 'domain' && scene.requiredDomains.includes(identity.domain)
                || ['font', 'font-style'].includes(identity.kind))), 'hold has no planned locale resource owner');
        assert.ok(hold.barrier?.entered && typeof hold.barrier.entered.then === 'function', 'real resource entry promise required');
        for (const method of ['wait', 'release', 'close'])
        {
            assert.equal(typeof hold.barrier[method], 'function', 'real resource barrier required');
        }
    }
    const authority = await prepareSwitchScene({ identity: bindings.identity, matrix, scene, resourceHolds });
    assert.ok(resourceHolds.every((hold) => authority.targets.includes(hold.locale)), 'hold locale must be a planned click');
    const captureStage = async (page, observation) =>
    {
        const evidence = await observer.capture(page);
        assert.deepEqual(evidence.identity, bindings.identity, 'stage observer admission differs');
        assert.equal(evidence.sceneId, scene.id, 'stage observer scene differs');
        assert.ok(Number.isSafeInteger(evidence.captureCut) && evidence.captureCut >= 0, 'actual stage capture cut required');
        await saveStage({ page, evidence: { ...observation, evidence } });
    };
    return await performPublicShellLocaleSwitch({ context, fixture, scene, matrix, resourceHolds, authority, captureStage, rawCapture: observer.rawCapture,
        saveEvidence: async ({ page, evidence }) =>
        {
            if (page)
            {
                await captureStage(page, { stage: evidence.failure ? 'first-failure' : 'post-commit', trace: evidence });
            }
        } });
}

/** Backward-compatible lease-owning wrapper. Both public boundaries delegate to the
 * same operation; the wrapper alone requests a lease and retains its legacy final sink.
 */
export async function drivePublicShellLocaleSwitchScene({ harness, matrix, sceneId, createContext, resourceHolds = [], saveEvidence })
{
    const scene = matrix.scenes.find((item) => item.id === sceneId);
    assertSwitchScene(scene);
    assert.equal(typeof createContext, 'function', 'runner-owned context factory required');
    assert.equal(typeof saveEvidence, 'function', 'runner-owned raw evidence sink required');
    const authority = await prepareSwitchScene({ identity: harness.identity, matrix, scene, resourceHolds });
    return await harness.withScene(sceneId, createContext, async ({ context, fixture }) =>
        await performPublicShellLocaleSwitch({ context, fixture, scene, matrix, resourceHolds, authority, saveEvidence }));
}

function assertSwitchTransactionRequests({ requests, rawCapture, preference, scene, targets, baseUrl })
{
    for (const request of requests)
    {
        try
        {
            assert.ok(rawCapture, 'original request capture authority required');
            const original = rawCapture.requestData(request);
            assert.notEqual(request.resourceType(), 'document', 'document/route reload forbidden');
            const resource = rawCapture.admittedResource(request.url());
            if (resource)
            {
                assert.equal(request.method(), 'GET', 'locale resource write forbidden');
                assert.ok(resource.identities.some((identity) => targets.includes(identity.locale)
                    && (identity.kind === 'domain' && scene.requiredDomains.includes(identity.domain)
                        || ['font', 'font-style'].includes(identity.kind))), 'unrelated frozen build resource forbidden');
                continue;
            }
            const operations = preference.operations.filter((operation) => operation.method === request.method()
                && new URL(operation.path, baseUrl).href === request.url());
            assert.equal(operations.length, 1, 'request has no permitted typed preference operation');
            const operation = operations[0];
            if (operation.requestFrame)
            {
                assert.ok(original.commandBytes, 'original preference command bytes required');
                const command = preference.inspectRequest(original.commandBytes);
                assert.equal(command.mode, 'fixed', 'selector requires fixed preference command');
                assert.ok(targets.includes(command.fixedLocale), 'preference command locale is not a planned selection');
            }
            else
            {
                assert.equal(operation.method, 'GET', 'unknown preference companion request');
            }
        }
        catch (error)
        {
            throw new Error(`switch transaction request rejected: ${error.message}`, { cause: error });
        }
    }
}

async function performPublicShellLocaleSwitch({ context, fixture, scene, matrix, resourceHolds, authority, saveEvidence, captureStage, rawCapture })
{
    const { targetCopy, sourceScene, sourceCopy, targets, preference } = authority;
    const evidence = { identity: authority.identity, sceneId: scene.id, observations: [], telemetry: [], requests: [], issues: [], failedRequests: [] };
    return await (async () =>
    {
        const disposers = [];
        let page;
        let firstError;
        let beforeClickRequestIndex;
        let requestFailure;
        const transactionRequests = [];
        const assertTransactionRequests = () =>
        {
            if (requestFailure)
            {
                throw requestFailure;
            }
            assertSwitchTransactionRequests({ requests: transactionRequests, rawCapture, preference, scene, targets, baseUrl: fixture.baseUrl });
        };
        try
        {
            await context.addInitScript(installPublicShellLocaleTelemetry);
            const urls = new Set();
            for (const hold of resourceHolds)
            {
                assert.ok(targets.includes(hold.locale), 'hold locale must be a planned click');
                const url = new URL(hold.url);
                assert.equal(url.origin, new URL(fixture.baseUrl).origin, 'hold must target the prepared runtime');
                assert.equal(urls.has(url.href), false, 'duplicate resource hold');
                urls.add(url.href);
                disposers.push(await bindPublicShellLocaleResourceBarrier(context, url.href, hold.barrier));
            }
            page = await context.newPage();
            page.on('request', (request) =>
            {
                evidence.requests.push({ identity: sha256(request.url()), type: request.resourceType(), method: request.method() });
                if (beforeClickRequestIndex !== undefined)
                {
                    if (!rawCapture || transactionRequests.length >= rawCapture.limits.records)
                    {
                        requestFailure ??= new Error('switch transaction request capture unavailable or original record limit exceeded');
                        return;
                    }
                    transactionRequests.push(request);
                }
            });
            page.on('console', (message) =>
            {
                if (['warning', 'error'].includes(message.type()))
                {
                    evidence.issues.push({ kind: message.type(), digest: sha256(message.text()) });
                }
            });
            page.on('pageerror', (error) => evidence.issues.push({ kind: 'pageerror', digest: sha256(error) }));
            page.on('requestfailed', (request) => evidence.failedRequests.push({
                digest: sha256(request.url()), error: request.failure()?.errorText ?? null
            }));
            const url = scene.route === 'Home' ? new URL('/', fixture.baseUrl)
                : scene.route === 'ArticleDetail' ? new URL(fixture.publicArticle.url, fixture.baseUrl) : null;
            assert.ok(url && url.origin === new URL(fixture.baseUrl).origin, 'official public route fixture required');
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.document.querySelector('#fsus-aot-shell')
                ?.getAttribute('data-public-hydrated') === 'true');
            await openPublicShellLocaleSelector(page);
            const before = await page.evaluate(readPublicShellLocaleDom);
            const beforeMetadata = Object.freeze({ ...before.metadata });
            evidence.observations.push({ stage: 'before-click', dom: before });
            await captureStage?.(page, evidence.observations.at(-1));
            const sourceDescriptor = matrix.locales.find((item) => item.code === scene.transition.sourceLocale);
            assertPublicShellLocaleDom({ observation: before, descriptor: sourceDescriptor, copy: sourceCopy,
                selectorItems: sourceScene.selectorItems, viewport: scene.viewport });
            const baselineEvents = await page.evaluate(() => window.__fsusblogLocaleSceneObservation.events.length);
            beforeClickRequestIndex = evidence.requests.length;
            await clickPublicShellLocaleTargets(page, scene, async (locale) =>
            {
                for (const hold of resourceHolds.filter((item) => item.locale === locale))
                {
                    await waitForResourceEntry(hold.barrier);
                }
                await page.waitForFunction((target) => [...window.document.querySelectorAll('[data-locale-selector]')]
                    .some((selector) => selector.getAttribute('data-pending-locale') === target), locale);
                const dom = await page.evaluate(readPublicShellLocaleDom);
                evidence.observations.push({ stage: 'pending', target: locale, dom });
                await captureStage?.(page, evidence.observations.at(-1));
                assert.deepEqual(dom.metadata, beforeMetadata, 'pending metadata changed before transaction commit');
                if (resourceHolds.length > 0)
                {
                    assertPublicShellLocaleDom({ observation: dom, descriptor: sourceDescriptor, copy: sourceCopy,
                        selectorItems: sourceScene.selectorItems, viewport: scene.viewport });
                }
                assertTransactionRequests();
            });
            // Every cold request was observed while held before advancing clicks.
            // Release those actual interceptions, never a fabricated phase flag.
            for (const hold of resourceHolds)
            {
                hold.barrier.release();
            }
            await page.waitForFunction(publicShellLocaleCommitReady, {
                code: scene.locale, language: scene.document.language, eventOffset: baselineEvents
            });
            await page.evaluate(() => new Promise((resolve) =>
            {
                window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
            }));
            await openPublicShellLocaleSelector(page);
            const after = await page.evaluate(readPublicShellLocaleDom);
            evidence.observations.push({ stage: 'after-commit', dom: after });
            await captureStage?.(page, evidence.observations.at(-1));
            evidence.telemetry = await page.evaluate((offset) => window.__fsusblogLocaleSceneObservation.events.slice(offset), baselineEvents);
            const committed = evidence.telemetry.filter((event) => event.name === 'locale_runtime_committed');
            assert.equal(committed.length, 1, 'exactly one production commit event required');
            assert.equal(committed[0].locale, scene.locale, 'last selection must win in production');
            assert.ok(Number.isSafeInteger(committed[0].generation) && committed[0].generation > 0,
                'production generation must be observed');
            evidence.domGaps = assertPublicShellLocaleDom({ observation: after,
                descriptor: matrix.locales.find((item) => item.code === scene.locale), copy: targetCopy,
                selectorItems: scene.selectorItems, viewport: scene.viewport });
            assertTransactionRequests();
            assert.equal(evidence.issues.length, 0, 'browser issues cannot be filtered');
            evidence.remainingContracts = [
                'first-html/hydration-start frames', 'product Intl projection', 'preference HTTP/revision',
                'business-data request classification', 'font artifact identities', 'SPA/refresh/history',
                'negative rollback/retry', 'atomic painted-frame continuity',
                'metadata title/description authority binding', 'resource URL/artifact digest cross-check',
                'request failure/cancellation adjudication', 'accessible-name/source-order continuity'
            ];
        }
        catch (error)
        {
            firstError = error;
            evidence.failure = { name: error.name, message: error.message };
        }
        let cleanupError;
        try
        {
            await saveEvidence({ evidence, page });
            if (!firstError)
            {
                assertTransactionRequests();
            }
        }
        catch (error)
        {
            cleanupError = error;
        }
        for (const dispose of disposers.reverse())
        {
            try
            {
                await dispose();
            }
            catch (error)
            {
                cleanupError ??= error;
            }
        }
        if (firstError)
        {
            if (cleanupError)
            {
                firstError.evidenceFailure = cleanupError;
            }
            throw firstError;
        }
        if (cleanupError)
        {
            throw cleanupError;
        }
        return evidence;
    })();
}
