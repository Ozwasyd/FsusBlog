/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { bindPublicShellLocaleResourceBarrier, createPublicShellLocaleResourceBarrier } from './public-shell-locale-harness.mjs';
import {
    assertPublicShellLocaleFaultBinding,
    assertPublicShellLocaleFontIdentity,
    assertPublicShellLocalePreferenceOutcome,
    bindPublicShellLocaleFault,
    observePublicShellLocaleFont,
    publicShellLocaleInertDigestSuffix,
    readPublicShellLocalePreference,
    waitForPublicShellLocaleResourceEntry
} from './public-shell-locale-lifecycle-evidence.mjs';
import { mutatePublicShellLocaleDomainResource, readPublicShellLocaleForeignBuildResource } from './public-shell-locale-runtime-bindings.mjs';
import { openPublicShellLocaleSelector, readPublicShellLocaleDom } from './public-shell-locale-scene-driver.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Build only auditable HTTP actions. Unsupported semantics fail before installing a route.
 * Transport timeout is ERR_TIMED_OUT, not proof of a product-owned deadline expiring.
 * Cross-version needs explicit immutable foreign-build authority; there is no old-tree fallback.
 */
export async function createPublicShellLocaleFailureAction({ bindings, scene, url, beforePreference, replacementUrl, foreignBuild,
    delivery = null })
{
    assert.equal(scene.issue, 2087, 'failure matrix scene required');
    const mode = scene.transition?.failureMode;
    let action;
    if (scene.stage === 'superseded-failure' || (scene.stage === 'revision-conflict' && mode === 'stale-response')
        || delivery === 'server-committed-response-loss')
    {
        if (mode === 'late-resource')
        {
            const target = bindings.resources.find((resource) => resource.url === url);
            assert.ok(target, 'admitted late resource required');
            const body = new Uint8Array(await bindings.readResource(url));
            assert.equal(sha256(body), target.digest, 'late resource sealed bytes changed');
            action = { kind: 'resource-replacement', contentType: 'text/javascript', body,
                mutation: { mode, targetDigest: target.digest, recipe: 'hold-sealed-response' } };
        }
        else
        {
            assert.ok(beforePreference?.snapshot, 'real pre-click preference GET required');
            action = { kind: 'preference-response', delivery: delivery === 'server-committed-response-loss' ? 'lost'
                : mode === 'stale-response' ? 'stale' : 'late', targetLocale: mode === 'late-preference'
                    ? scene.transition.rapidTargets[0] : scene.locale,
            currentRevision: beforePreference.snapshot.revision, authActionContext: scene.authActionContext };
        }
    }
    else if (scene.stage === 'domain-failure' && ['invalid-content', 'invalid-schema', 'invalid-digest'].includes(mode))
    {
        const target = bindings.resources.find((resource) => resource.url === url);
        const owners = target?.identities.filter((identity) => identity.kind === 'domain'
            && identity.locale === scene.locale && scene.requiredDomains.includes(identity.domain)) ?? [];
        assert.equal(owners.length, 1, 'sealed domain mutation owner required');
        const original = await bindings.readResource(url);
        assert.equal(sha256(original), target.digest, 'domain source changed after admission');
        const mutated = await mutatePublicShellLocaleDomainResource({ body: original, identity: owners[0], mode, domains: bindings.domains });
        action = { kind: 'resource-replacement', contentType: 'text/javascript', ...mutated };
    }
    else if (scene.stage === 'font-failure' && ['wrong-face', 'wrong-script'].includes(mode))
    {
        const target = bindings.resources.find((resource) => resource.url === url);
        const replacement = bindings.resources.find((resource) => resource.url === replacementUrl);
        assert.ok(target && replacement, 'explicit sealed font target/replacement required');
        const body = new Uint8Array(await bindings.readResource(replacementUrl));
        assert.equal(sha256(body), replacement.digest, 'font source changed after admission');
        action = { kind: 'resource-replacement', contentType: 'font/woff2', body,
            mutation: { mode, targetDigest: target.digest, replacement: { url: replacementUrl, digest: replacement.digest } } };
    }
    else if (scene.stage === 'retry' && mode === 'complete-preparation')
    {
        // The injected first attempt fails; only the real Retry UI can restore the sealed resource.
        action = { kind: 'http-error', status: 503 };
    }
    else if (scene.stage === 'revision-conflict')
    {
        assert.equal(mode, 'conflict', 'stale-response action is not implemented');
        assert.ok(beforePreference?.snapshot, 'real pre-click preference GET required');
        action = { kind: 'revision-conflict', targetLocale: scene.locale, currentRevision: beforePreference.snapshot.revision };
    }
    else if (scene.stage === 'artifact-invalid')
    {
        const target = bindings.resources.find((resource) => resource.url === url);
        const owners = target?.identities.filter((identity) => identity.kind === 'domain' && identity.locale === scene.locale
            && scene.requiredDomains.includes(identity.domain)) ?? [];
        assert.equal(owners.length, 1, 'sealed target locale/domain owner required');
        let body;
        let mutation;
        if (mode === 'content-digest')
        {
            const original = await bindings.readResource(url);
            assert.equal(sha256(original), target.digest, 'sealed target bytes changed');
            body = new Uint8Array(Buffer.concat([original, Buffer.from(publicShellLocaleInertDigestSuffix)]));
            mutation = { mode, recipe: 'append-inert-comment', originalLength: original.length, targetDigest: target.digest };
        }
        else if (mode === 'cross-version')
        {
            const foreign = await readPublicShellLocaleForeignBuildResource({ foreignBuild, currentIdentity: bindings.identity,
                locale: owners[0].locale, domain: owners[0].domain });
            body = new Uint8Array(foreign.body);
            mutation = { mode, targetDigest: target.digest, replacement: foreign.proof };
        }
        else
        {
            assert.ok(['cross-locale', 'cross-domain'].includes(mode), 'artifact mode is not implemented');
            const replacement = bindings.resources.find((resource) => resource.url === replacementUrl);
            assert.ok(replacement, 'explicit sealed replacement resource required');
            body = new Uint8Array(await bindings.readResource(replacementUrl));
            assert.equal(sha256(body), replacement.digest, 'sealed replacement bytes changed');
            mutation = { mode, targetDigest: target.digest, replacement: { url: replacement.url, digest: replacement.digest } };
        }
        action = { kind: 'resource-replacement', contentType: 'text/javascript', body, mutation };
    }
    else if (mode === 'timeout')
    {
        action = { kind: 'abort', errorCode: 'timedout' };
    }
    else if (mode === 'cancel')
    {
        action = { kind: 'abort', errorCode: 'aborted' };
    }
    else if (['network-failure', 'load-failure'].includes(mode))
    {
        action = { kind: 'abort', errorCode: 'failed' };
    }
    else
    {
        assert.equal(mode, 'non-2xx', 'failure mode has no implemented HTTP action');
        action = { kind: 'http-error', status: 503 };
    }
    assertPublicShellLocaleFaultBinding({ bindings, scene, url, action });
    return Object.freeze(action);
}

/** A compensating write is observed, never sent by this test helper. Monotonic revisions are
 * retained as facts: compensation does NOT satisfy #2087's stricter no-revision-increase rule.
 */
export function assertPublicShellLocaleResponseLossCompensation({ before, after, injection, writes, scene })
{
    assert.equal(injection.kind, 'preference-response');
    assert.equal(injection.delivery, 'lost');
    assert.equal(injection.status, 200, 'no native committed PUT was observed');
    const compensation = writes.filter((write) => write.status === 200 && write.command
        && write.command.mode === before.snapshot.mode && write.command.fixedLocale === before.snapshot.fixedLocale);
    assert.equal(compensation.length, 1, 'exactly one real product compensating PUT required');
    const write = compensation[0];
    assert.equal(write.command.expectedRevision, injection.preference.revision, 'compensation used old revision');
    assert.equal(write.preference.mode, before.snapshot.mode, 'compensation response mode');
    assert.equal(write.preference.fixedLocale, before.snapshot.fixedLocale, 'compensation response target');
    assert.equal(write.preference.revision, scene.authActionContext === 'anonymous' ? 0 : injection.preference.revision + 1,
        'compensation native revision semantics');
    assert.equal(after.snapshot.mode, before.snapshot.mode, 'lost response persisted failed target');
    assert.equal(after.snapshot.fixedLocale, before.snapshot.fixedLocale, 'lost response persisted failed target');
    if (scene.authActionContext !== 'anonymous')
    {
        assert.deepEqual(after.snapshot, write.preference, 'compensation GET disagrees with native PUT');
    }
    assert.deepEqual(after.cookies, before.cookies, 'compensation did not restore device cookie');
    return { originalRevision: before.snapshot.revision, committedRevision: injection.preference.revision,
        compensatedRevision: write.preference.revision, compensationResponseDigest: write.contentDigest };
}

/** Checkpoints read real DOM/HTTP and are handed to the runner's private evidence sink. */
export async function capturePublicShellLocaleCheckpoint({ page, context, bindings, font, observer, stage })
{
    const business = await page.evaluate(async () =>
    {
        const main = window.document.querySelector('#main-content');
        if (!main)
        {
            throw new Error('public business root was not observed');
        }
        const digest = async (value) => [...new Uint8Array(await window.crypto.subtle.digest(
            'SHA-256', new window.TextEncoder().encode(value)
        ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const inputs = [];
        for (const input of main.querySelectorAll('input:not([type="password"]):not([type="hidden"]),textarea,select'))
        {
            inputs.push({ nameDigest: await digest(input.name), valueDigest: await digest(input.value),
                checked: typeof input.checked === 'boolean' ? input.checked : null });
        }
        return {
            documentIdentity: window.performance.timeOrigin,
            nodeIdentity: window.__fsusblogLocaleLifecycleEvidence.identityFor(main),
            textDigest: await digest(main.textContent), inputs, scroll: { x: window.scrollX, y: window.scrollY }
        };
    });
    return {
        stage, dom: await page.evaluate(readPublicShellLocaleDom), business,
        preference: await readPublicShellLocalePreference(context, bindings, { rawCapture: observer.rawCapture }),
        font: await observePublicShellLocaleFont(page, font), evidence: await observer.capture(page)
    };
}

function localeCopy(dom)
{
    return [...new Set(dom.copyNodes.map((node) => JSON.stringify({ key: node.key, text: node.text })))].sort();
}

/** Disclosure visibility can legitimately change; locale-facing values and business identity cannot. */
export function assertPublicShellLocaleRollback({ before, after })
{
    assert.equal(after.dom.language, before.dom.language, 'failed target changed document locale');
    assert.equal(after.dom.direction, before.dom.direction, 'failed target changed direction');
    assert.deepEqual(after.dom.metadata, before.dom.metadata, 'failed target changed metadata');
    assert.deepEqual(localeCopy(after.dom), localeCopy(before.dom), 'failed target changed typed shell copy');
    assert.deepEqual(after.dom.selectors.map((selector) => selector.active), before.dom.selectors.map((selector) => selector.active),
        'failed target changed selector active');
    assert.deepEqual(after.business, before.business, 'failed target rebuilt or reset business state');
    for (const control of before.dom.geometry.filter((item) => item.visible))
    {
        assert.ok(after.dom.geometry.some((item) => item.name === control.name && item.fontFamily === control.fontFamily),
            'failed target changed committed font family');
    }
}

async function waitForPublicShell(page)
{
    await page.waitForFunction(() => window.document.querySelector('#fsus-aot-shell')
        ?.getAttribute('data-public-hydrated') === 'true' && window.document.fonts.status === 'loaded');
    await page.evaluate(() => new Promise((resolve) =>
    {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    }));
}

/** Called on the existing page after a real successful selector transaction. No extra context. */
export async function drivePublicShellLocalePersistence({ page, checkpoint })
{
    const initialUrl = page.url();
    const snapshots = [await checkpoint('post-commit')];
    let link = page.locator('[data-public-nav="archive"]:visible');
    if (await link.count() === 0)
    {
        const trigger = page.locator('[data-mobile-nav-menu-trigger]:visible');
        assert.equal(await trigger.count(), 1, 'one public mobile navigation trigger required');
        await trigger.click();
        link = page.locator('[data-public-nav="archive"]:visible');
    }
    assert.equal(await link.count(), 1, 'one public Archive navigation link required');
    const targetUrl = new URL(await link.getAttribute('href'), initialUrl);
    assert.equal(targetUrl.origin, new URL(initialUrl).origin, 'navigation leaves the formal runtime');
    await Promise.all([page.waitForURL((url) => url.href === targetUrl.href), link.click()]);
    await waitForPublicShell(page);
    snapshots.push(await checkpoint('spa-navigation'));
    assert.equal(snapshots[1].business.documentIdentity, snapshots[0].business.documentIdentity,
        'public link made a document navigation, not the required SPA transition');
    await page.goBack({ waitUntil: 'domcontentloaded' });
    assert.equal(page.url(), initialUrl, 'back navigation route identity');
    await waitForPublicShell(page);
    snapshots.push(await checkpoint('back'));
    await page.goForward({ waitUntil: 'domcontentloaded' });
    assert.equal(page.url(), targetUrl.href, 'forward navigation route identity');
    await waitForPublicShell(page);
    snapshots.push(await checkpoint('forward'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPublicShell(page);
    snapshots.push(await checkpoint('refresh'));
    for (const snapshot of snapshots.slice(1))
    {
        assert.equal(snapshot.dom.language, snapshots[0].dom.language, 'navigation lost locale');
        assert.equal(snapshot.dom.direction, snapshots[0].dom.direction, 'navigation lost direction');
        assert.equal(snapshot.dom.metadata.openGraphLocale, snapshots[0].dom.metadata.openGraphLocale, 'navigation lost OG locale');
        assert.deepEqual(localeCopy(snapshot.dom), localeCopy(snapshots[0].dom), 'navigation lost locale-facing shell copy');
        assert.deepEqual(snapshot.preference.snapshot, snapshots[0].preference.snapshot, 'navigation lost authoritative preference');
        assert.deepEqual(snapshot.preference.cookies, snapshots[0].preference.cookies, 'navigation lost device cookie');
    }
    return snapshots;
}

/** Real HTTP fault and real retry button. Caller supplies a scene-bound, auditable mutation action. */
export async function drivePublicShellLocaleRollbackRetry({ page, context, bindings, scene, faultUrl,
    action: suppliedAction = null, replacementUrl, foreignBuild, delivery, checkpoint, saveCheckpoint, observer })
{
    assert.ok(observer?.rawCapture, 'original capture capability required');
    const rawCapture = observer.rawCapture;
    rawCapture.requireContext(context, bindings);
    const save = (evidence) => saveCheckpoint(evidence,
        { privateOriginals: rawCapture.snapshot(evidence.evidence?.captureCut) });
    assert.equal(scene.issue, 2087, 'failure scene required');
    assert.equal(scene.transition.injectionBoundary, 'http-resource', 'formal resource boundary required');
    const target = bindings.locales.find((locale) => locale.code === scene.locale);
    assert.ok(target, 'target locale descriptor required');
    const before = await checkpoint('before-fault');
    await save(before);
    const action = suppliedAction ?? await createPublicShellLocaleFailureAction({ bindings, scene, url: faultUrl,
        beforePreference: before.preference, replacementUrl, foreignBuild, delivery });
    assertPublicShellLocaleFaultBinding({ bindings, scene, url: faultUrl, action });
    const fault = await bindPublicShellLocaleFault({ context, bindings, url: faultUrl, action, scene, rawCapture });
    let firstError;
    let result;
    try
    {
        const selector = await openPublicShellLocaleSelector(page);
        await selector.locator(`[data-locale-selector-item][data-locale-code="${scene.locale}"]:visible`).click();
        await waitForPublicShellLocaleResourceEntry(fault.entered);
        fault.release();
        const injection = await fault.completed;
        await page.locator('[data-locale-selector-error]:visible').first().waitFor({ state: 'visible' });
        const after = await checkpoint('rollback');
        after.injection = injection;
        await save(after);
        assertPublicShellLocaleRollback({ before, after });
        assert.equal(after.evidence.browser.recorder.events.slice(before.evidence.browser.recorder.events.length)
            .filter((event) => event.name === 'locale_runtime_committed').length, 0, 'failed target produced a production commit');
        const writes = after.evidence.responses.slice(before.evidence.responses.length).filter((response) => response.url === bindings.preferenceUrl
            && response.method === 'PUT');
        if (action.delivery === 'lost')
        {
            const compensation = assertPublicShellLocaleResponseLossCompensation({ before: before.preference, after: after.preference,
                injection, writes, scene });
            await save({ stage: 'native-compensation-facts', compensation, injection });
            // Keep the original no-preference/revision-change acceptance; this fact is not a waiver.
        }
        assertPublicShellLocalePreferenceOutcome({ scene, before: before.preference, after: after.preference, writes, outcome: 'rollback' });
        await fault.dispose();
        const offset = await page.evaluate(() => window.__fsusblogLocaleLifecycleEvidence.state.events.length);
        const responseOffset = after.evidence.responses.length;
        const retry = page.locator('[data-locale-selector-retry]:visible');
        assert.equal(await retry.count(), 1, 'one visible real retry control required');
        await retry.click();
        await page.waitForFunction(({ locale, language, offset }) =>
        {
            const selectors = [...window.document.querySelectorAll('#fsus-aot-shell [data-locale-selector]')];
            return window.document.documentElement.lang === language && selectors.length > 0
                && selectors.every((selector) => selector.getAttribute('data-active-locale') === locale
                    && !selector.getAttribute('data-pending-locale')
                    && selector.querySelectorAll('[data-locale-selector-item][aria-checked="true"]').length === 1
                    && selector.querySelector('[data-locale-selector-item][aria-checked="true"]')?.getAttribute('data-locale-code') === locale)
                && window.__fsusblogLocaleLifecycleEvidence.state.events.slice(offset)
                    .some((event) => event.name === 'locale_runtime_committed' && event.locale === locale);
        }, { locale: scene.locale, language: target.documentLanguage, offset });
        await waitForPublicShell(page);
        const recovered = await checkpoint('retry-commit');
        await save(recovered);
        assert.equal(recovered.dom.language, target.documentLanguage,
            'retry did not commit the real target');
        const commits = recovered.evidence.browser.recorder.events.slice(offset).filter((event) => event.name === 'locale_runtime_committed');
        assert.equal(commits.length, 1, 'retry must produce exactly one production commit');
        const retryResponses = recovered.evidence.responses.slice(responseOffset);
        const retryWrites = retryResponses.filter((response) => response.url === bindings.preferenceUrl
            && response.method === 'PUT' && response.status === 200);
        assertPublicShellLocalePreferenceOutcome({ scene, before: before.preference, after: recovered.preference, writes: retryWrites, outcome: 'commit' });
        if (faultUrl !== bindings.preferenceUrl)
        {
            assert.ok(retryResponses.some((response) => response.url === faultUrl && response.status === 200
                && response.contentDigest === bindings.resources.find((resource) => resource.url === faultUrl).digest),
            'retry did not observe the restored immutable resource');
        }
        for (const domain of scene.requiredDomains)
        {
            assert.ok(recovered.evidence.responses.some((response) => response.status === 200 && !response.observationError
                && response.contentDigest === response.resource?.digest
                && response.resource.identities.some((identity) => identity.kind === 'domain'
                    && identity.locale === scene.locale && identity.domain === domain)), 'retry lacks a complete sealed required domain');
        }
        assertPublicShellLocaleFontIdentity({ font: scene.requiredFont, observation: recovered.font,
            responses: recovered.evidence.responses });
        result = { before, after, recovered };
    }
    catch (error)
    {
        firstError = error;
        try
        {
            await save({ stage: 'first-failure', failure: { name: error.name, message: error.message }, injection: fault.trace() });
        }
        catch
        {
            // Outer canonical lifecycle also preserves the original failure and raw observer state.
        }
    }
    try
    {
        await fault.dispose();
    }
    catch (error)
    {
        firstError ??= error;
    }
    if (firstError)
    {
        throw firstError;
    }
    return result;
}

/** Supersede through public selector clicks, then release the actual first-target response.
 * A native preference PUT holds the commit mutex: release only after latest pending is visible,
 * not after latest commit (which would deadlock). The same is true when the last locale repeats
 * the first: native import() deduplication may join the same held module request.
 */
export async function drivePublicShellLocaleSupersededFailure({ page, context, bindings, scene, faultUrl, checkpoint, saveCheckpoint, observer })
{
    assert.ok(observer?.rawCapture, 'original capture capability required');
    const rawCapture = observer.rawCapture;
    rawCapture.requireContext(context, bindings);
    const save = (evidence) => saveCheckpoint(evidence,
        { privateOriginals: rawCapture.snapshot(evidence.evidence?.captureCut) });
    assert.equal(scene.issue, 2087);
    assert.equal(scene.stage, 'superseded-failure');
    const before = await checkpoint('before-superseded');
    await save(before);
    const action = await createPublicShellLocaleFailureAction({ bindings, scene, url: faultUrl, beforePreference: before.preference });
    const fault = await bindPublicShellLocaleFault({ context, bindings, scene, url: faultUrl, action, rawCapture });
    let firstError;
    let result;
    const intermediate = new Map();
    const disposers = [];
    const click = async (locale) =>
    {
        const selector = await openPublicShellLocaleSelector(page);
        await selector.locator(`[data-locale-selector-item][data-locale-code="${locale}"]:visible`).click();
    };
    const waitCommitted = async () =>
    {
        await page.waitForFunction(({ locale, offset }) => window.__fsusblogLocaleLifecycleEvidence.state.events.slice(offset)
            .some((event) => event.name === 'locale_runtime_committed' && event.locale === locale),
        { locale: scene.locale, offset: before.evidence.browser.recorder.events.length });
        await waitForPublicShell(page);
    };
    try
    {
        for (const locale of new Set(scene.transition.rapidTargets.slice(1, -1)))
        {
            if (locale === scene.transition.rapidTargets[0])
            {
                continue;
            }
            const resource = bindings.resources.find((candidate) => candidate.identities.some((identity) => identity.kind === 'domain'
                && identity.locale === locale && scene.requiredDomains.includes(identity.domain)));
            assert.ok(resource, 'intermediate target needs a real required-domain hold to prevent sampling races');
            const barrier = createPublicShellLocaleResourceBarrier();
            disposers.push(await bindPublicShellLocaleResourceBarrier(context, resource.url, barrier));
            intermediate.set(locale, barrier);
        }
        await click(scene.transition.rapidTargets[0]);
        await waitForPublicShellLocaleResourceEntry(fault.entered);
        const held = await checkpoint('old-response-held');
        await save(held);
        assertPublicShellLocaleRollback({ before, after: held });
        if (action.kind === 'preference-response')
        {
            await save({ stage: 'native-old-put-held', injection: await fault.serverObserved });
        }
        for (const [index, locale] of scene.transition.rapidTargets.slice(1).entries())
        {
            await click(locale);
            if (index < scene.transition.rapidTargets.length - 2 && intermediate.has(locale))
            {
                await waitForPublicShellLocaleResourceEntry(intermediate.get(locale).entered);
            }
        }
        await page.waitForFunction((locale) => [...window.document.querySelectorAll('[data-locale-selector]')]
            .some((selector) => selector.getAttribute('data-pending-locale') === locale), scene.locale);
        const latestPending = await checkpoint('latest-pending-all-intermediate-responses-held');
        await save(latestPending);
        for (const barrier of intermediate.values())
        {
            barrier.release();
        }
        if (action.kind !== 'preference-response' && scene.transition.rapidTargets[0] !== scene.locale)
        {
            await waitCommitted();
        }
        const superseded = await checkpoint('latest-selected-before-old-release');
        await save(superseded);
        fault.release();
        const injection = await fault.completed;
        await save({ stage: 'late-native-response', injection });
        await waitCommitted();
        const after = await checkpoint('latest-after-old-release');
        await save(after);
        assertPublicShellLocaleSupersededOutcome({ bindings, scene, before, latestPending, superseded, after, injection });
        assert.equal(await page.locator('[data-locale-selector-error]:visible').count(), 0, 'old failure polluted latest error UI');
        result = { before, superseded, after, injection };
    }
    catch (error)
    {
        firstError = error;
        try
        {
            await save({ stage: 'first-failure', failure: { name: error.name, message: error.message }, injection: fault.trace() });
        }
        catch
        {
            // Preserve the first native/scene error if the canonical evidence sink also fails.
        }
    }
    for (const dispose of disposers.reverse())
    {
        try
        {
            await dispose();
        }
        catch (error)
        {
            firstError ??= error;
        }
    }
    try
    {
        await fault.dispose();
    }
    catch (error)
    {
        firstError ??= error;
    }
    if (firstError)
    {
        throw firstError;
    }
    return result;
}

/** Raw commits, DOM and native preference receipts decide latest-wins, not a checked flag. */
export function assertPublicShellLocaleSupersededOutcome({ bindings, scene, before, latestPending, superseded, after, injection })
{
    const target = bindings.locales.find((locale) => locale.code === scene.locale);
    assert.ok(target, 'current target descriptor missing');
    assert.equal(after.dom.language, target.documentLanguage, 'late response replaced latest document locale');
    assert.ok(after.dom.selectors.every((selector) => selector.active === scene.locale && !selector.pending), 'late response changed selector');
    assert.deepEqual(after.business, before.business, 'superseded failure rebuilt business state');
    const events = after.evidence.browser.recorder.events.slice(before.evidence.browser.recorder.events.length);
    const commits = events.filter((event) => event.name === 'locale_runtime_committed');
    assert.equal(commits.length, 1, 'rapid failure produced intermediate/duplicate commits');
    assert.equal(commits[0].locale, scene.locale, 'old target committed');
    assert.ok(Number.isSafeInteger(commits[0].generation), 'real production generation required');
    assert.ok(latestPending.dom.selectors.some((selector) => selector.pending === scene.locale), 'last clicked target was not actually pending');
    const afterLatestSelection = after.evidence.browser.recorder.events.slice(latestPending.evidence.browser.recorder.events.length)
        .filter((event) => event.name === 'locale_runtime_committed');
    assert.deepEqual(afterLatestSelection, commits, 'commit preceded the actual latest selection checkpoint');
    const writes = after.evidence.responses.slice(before.evidence.responses.length)
        .filter((response) => response.url === bindings.preferenceUrl && response.method === 'PUT' && response.status === 200);
    assert.equal(writes.length, injection.kind === 'preference-response' ? 2 : 1, 'extra or missing native rapid-sequence PUT');
    assert.equal(new Set(writes.map((write) => write.requestOrdinal)).size, writes.length, 'duplicate native request identity');
    assert.ok(writes.every((write) => write.command && write.preference && !write.observationError
        && Number.isSafeInteger(write.requestOrdinal)), 'rapid PUT decoder/request evidence incomplete');
    const requestOffset = latestPending.evidence.requests.length;
    assert.ok(Number.isSafeInteger(requestOffset), 'actual latest-selection request cursor missing');
    const winner = writes.filter((write) => write.command?.fixedLocale === scene.locale
        && Number.isSafeInteger(write.requestOrdinal) && write.requestOrdinal >= requestOffset);
    assert.equal(winner.length, 1, 'latest target lacks an exact native PUT response');
    assert.ok(winner[0].preference && !winner[0].observationError, 'latest response decoder evidence missing');
    assert.equal(winner[0].preference.fixedLocale, scene.locale, 'latest PUT response target');
    if (scene.authActionContext !== 'anonymous')
    {
        assert.deepEqual(after.preference.snapshot, winner[0].preference, 'old server response overwrote latest account state');
    }
    assert.equal(after.preference.cookies.length, 1, 'latest device cookie missing');
    assert.equal(after.preference.cookies[0].locale, scene.locale, 'old response overwrote latest cookie');
    assert.equal(after.preference.cookies[0].httpOnly, true);
    if (injection.kind === 'preference-response')
    {
        assert.equal(injection.status, 200, 'late preference was not a real successful response');
        assert.equal(injection.preference.fixedLocale, scene.transition.rapidTargets[0], 'late native target');
        assert.equal(injection.deliveredDigest, injection.contentDigest, 'late preference was forged/replaced');
        assert.equal(winner[0].command.expectedRevision, injection.preference.revision, 'latest reused pre-supersession revision');
        const original = writes.filter((write) => write.requestOrdinal < requestOffset && write.commandDigest === injection.commandDigest
            && write.contentDigest === injection.contentDigest);
        assert.equal(original.length, 1, 'held native old response lost its real request/body identity');
    }
    else
    {
        assert.equal(injection.contentDigest, bindings.resources.find((resource) => resource.urlDigest === injection.urlDigest
            || sha256(resource.url) === injection.urlDigest)?.digest, 'late resource was not sealed');
        if (superseded.dom.language === target.documentLanguage && superseded.dom.selectors.every((selector) => selector.active === scene.locale && !selector.pending))
        {
            assert.deepEqual(after.dom, superseded.dom, 'late resource changed the already committed latest DOM');
        }
    }
}
