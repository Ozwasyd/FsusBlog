/* global window */
import assert from 'node:assert/strict';

import { bindPublicShellLocaleResourceBarrier, createPublicShellLocaleResourceBarrier } from './public-shell-locale-harness.mjs';
import {
    assertPublicShellLocaleHydrationMark,
    bindPublicShellLocaleContextEvidence,
    waitForPublicShellLocaleResourceEntry
} from './public-shell-locale-lifecycle-evidence.mjs';
import { openPublicShellLocaleSelector, readPublicShellLocaleDom } from './public-shell-locale-scene-driver.mjs';

/** Integration boundaries for tests/browser-contract/run.mjs's owner:
 * Admit runtime bindings after the existing harness and before the only browser launch.
 * Enumerate matrix.scenes, never a helper-owned locale/scenario list. Run contexts serially.
 * Keep #2083 JS-disabled first-response consumption on the original HTTP-only capture.
 * For #2084 use the entry/domain barrier slice; #2085 consumes real initial-network evidence.
 * For #2086 consume selector, preference, fonts and persistence on the same existing page.
 * The frozen drivePublicShellLocaleSwitchScene already owns harness.withScene: do not nest
 * it inside this wrapper. Instrument its existing factory/sink, or use its public UI primitives
 * in one caller-owned withScene operation when pre-click lifecycle checkpoints are required.
 * For #2087 build the HTTP action from the pre-click checkpoint, retain injection receipts,
 * then drive the real Retry control. Unsupported modes are failures, not generic substitutions.
 * Save raw refs in the canonical private run directory before closing each context. Convert
 * to the existing #2667 schema only after applicable assertions actually ran; no copied flags,
 * cloned expected copy/face IDs, private runtime generations or padded empty observations.
 * Dispatch superseded-failure to drivePublicShellLocaleSupersededFailure, not the rollback
 * driver (its real native old PUT may hold the product commit mutex). complete-preparation
 * uses the required-resource failure plus the real Retry path. A lost-success secondary
 * case uses delivery: 'server-committed-response-loss' on preference network-failure;
 * retain native commit/compensation facts and the original #2087 revision assertions.
 */

/** OWNER PROPOSAL ONLY — no implementation, schema, private runner or fabricated counters.
 * #2082 fixture owner (prepare-fixture.mjs/default-fixture-provider.mjs/fixture.mjs):
 * provide acquireLocaleSceneActor({ sceneId, matrixDigest, namespace, preparationId,
 * sourceState, buildDigest, runtimeReceiptDigest, semanticRole, capabilities }) through
 * the existing official fixture composition/admission. Return an exact scene-bound lease,
 * actor identity digest, private storageState ref+digest, native baseline preference
 * response ref+digest and owned service-generation refs; authenticated/admin actors must
 * not reuse another scene's mutable account preference. Anonymous uses an empty fresh jar.
 * Creation/cleanup remains the official provider's responsibility, no DB/reset hook here.
 * Harness withScene must consume that lease before createContext; validate all identities,
 * exact role/capabilities and initial native GET against the lease. Reject missing/reused
 * leases before product navigation, not by patching context options behind the harness.
 * Fixture manifest/lifecycle/receipt owners must bind the new lease set together; secrets
 * remain in private files, not aggregate evidence. This API must be reviewed by its owner.
 *
 * Root topology owner (tools/release/browser-contract-receipt-contract.mjs): keep exact
 * contextCount equality; record the real base and locale scene IDs in a versioned exact
 * topology closure (or an explicitly counted nested locale section), deriving required
 * locale IDs only from matrix.scenes. Update producer, schema, verifier and negatives
 * together. Do not hide locale contexts, loosen counts, or count intended contexts as run.
 *
 * #2666 owner: public-shell-locale-legacy-governance.mjs currently scans only two removed
 * legacy paths. Traverse active gate import/command roots in config/testing/public-shell-
 * locale-gate.json plus local/CI/matrix/coverage/lifecycle bindings. Parse imports/exports,
 * runner launches and authority consumers; reject renamed wrappers/second schemas,
 * internal hooks, copy tables, sleeps/retries/filters and fixture fallbacks by structure.
 * Add renamed/moved wrapper and command-graph tamper negatives in its existing Node suite.
 *
 * #2667 owner: tools/test-matrix/public-shell-locale-evidence.mjs validateObserved currently
 * requires every stage to have persistence/recovery and four numeric generations. Define
 * applicability from the canonical scene stage, not producer-supplied checked flags:
 * #2083 raw first response/AOT identity, no hydration/switch/recovery; #2084 true mark/DOM
 * stages; #2085 complete initial waterfall; #2086 actual transaction and only applicable
 * navigation/persistence; #2087 fault/rollback/retry or supersession raw causal chain.
 * Inapplicable fields need an explicit owner-reviewed shape, not checked:true or zero
 * generations. Unsupported stages and missing applicable observations still fail closed.
 * verify-public-shell-locale.mjs must open each explicit regular current-run raw ref,
 * rehash bytes and independently derive observations and identity closure before comparing
 * aggregate summaries. Bound paths to owned private run root, reject symlink/path escape,
 * duplicate/cross-run/digest tamper and missing files. aggregate-public-shell-locale.mjs
 * and existing public-shell-locale-aggregate.test.mjs migrate together; browser spawn=0.
 * Retain injected console/network faults as raw causal records; no warning/error filter.
 */

/** Canonical runner hook: admitted harness owns the only context and fixture lifecycle.
 * observe and both sinks retain the actual callback lease reference unchanged. observe receives
 * the real context, observer, bindings and formal fixture. It must use
 * the runner's evidence sink; this function supplies no CLI, browser launch or pass flag.
 */
export async function withPublicShellLocaleLifecycleScene({ harness, matrix, bindings, sceneId, createContext, observe, saveEvidence })
{
    assert.deepEqual(bindings.identity, harness.identity, 'runtime binding belongs to another admission');
    assert.equal(matrix.contentDigest, harness.identity.matrixDigest, 'scene matrix belongs to another admission');
    const scene = matrix.scenes.find((item) => item.id === sceneId);
    assert.ok(scene, 'unknown lifecycle scene');
    assert.equal(typeof createContext, 'function', 'canonical context factory required');
    assert.equal(typeof observe, 'function', 'scene operation required');
    assert.equal(typeof saveEvidence, 'function', 'canonical raw evidence sink required');
    return await harness.withScene(sceneId, createContext, async ({ context, fixture, negotiation, lease, readPublishedArtifact }) =>
    {
        const observer = await bindPublicShellLocaleContextEvidence({ context, bindings, scene });
        let result;
        let firstError;
        try
        {
            result = await observe({ context, fixture, negotiation, lease, readPublishedArtifact, scene, observer, bindings });
        }
        catch (error)
        {
            firstError = error;
        }
        // Save and detach before withScene closes the context, including a failed observation.
        try
        {
            const pages = context.pages();
            if (pages.length !== 1)
            {
                firstError ??= new Error('scene must own exactly one real page');
            }
            const page = pages[0];
            let evidence;
            if (!page)
            {
                evidence = { identity: bindings.identity, sceneId, pageCount: pages.length,
                    observationFailure: { name: firstError.name, message: firstError.message } };
            }
            else
            {
                try
                {
                    evidence = scene.issue === 2083 && scene.stage === 'first-response'
                        ? await observer.captureFirstResponse() : await observer.capture(page);
                }
                catch (error)
                {
                    firstError ??= error;
                    evidence = error.evidence ?? { identity: bindings.identity, sceneId,
                        observationFailure: { name: error.name, message: error.message } };
                }
            }
            await saveEvidence({ page, lease, evidence, privateOriginals: observer.rawCapture.snapshot(evidence.captureCut),
                failure: firstError ? { name: firstError.name, message: firstError.message } : null });
        }
        catch (error)
        {
            firstError ??= error;
        }
        try
        {
            await observer.dispose();
        }
        catch (error)
        {
            firstError ??= error;
        }
        // This is observer drain evidence only. Actual context terminal/ledger stays with the harness/Root.
        try
        {
            await saveEvidence({ page: context.pages()[0], lease, evidence: { identity: bindings.identity, sceneId,
                captureCut: observer.rawCapture.cut(), phase: 'observer-disposal' },
            privateOriginals: observer.rawCapture.snapshot(),
            failure: firstError ? { name: firstError.name, message: firstError.message } : null });
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
    });
}

/** Initial hydration slice, inside withScene. Immutable entry/domain URL barriers let
 * the actual production mark be observed before mount. No phase hook or DOM override.
 * Save each raw stage immediately; legacy final-DOM helpers must not fill missing stages.
 */
export async function drivePublicShellLocaleInitialHydration({ context, fixture, scene, bindings, observer, saveStage })
{
    assert.equal(scene.issue, 2084, 'initial-hydration scene required');
    assert.equal(typeof saveStage, 'function', 'runner-owned stage evidence sink required');
    const entryResources = bindings.resources.filter((resource) => resource.file.endsWith('.js')
        && resource.identities.some((identity) => identity.kind === 'static' && identity.entry === 'entry-runtime'));
    assert.equal(entryResources.length, 1, 'one receipted production entry-runtime module required');
    const domain = bindings.resources.find((resource) => resource.identities.some((identity) => identity.kind === 'domain'
        && identity.locale === scene.locale && scene.requiredDomains.includes(identity.domain)));
    assert.ok(domain, 'initial locale required-domain artifact missing');
    const entryBarrier = createPublicShellLocaleResourceBarrier();
    const domainBarrier = createPublicShellLocaleResourceBarrier();
    const disposers = [];
    const stages = [];
    let firstError;
    try
    {
        disposers.push(await bindPublicShellLocaleResourceBarrier(context, entryResources[0].url, entryBarrier));
        disposers.push(await bindPublicShellLocaleResourceBarrier(context, domain.url, domainBarrier));
        const page = await context.newPage();
        const url = scene.route === 'Home' ? new URL('/', fixture.baseUrl)
            : scene.route === 'ArticleDetail' ? new URL(fixture.publicArticle.url, fixture.baseUrl) : null;
        assert.ok(url && url.origin === new URL(fixture.baseUrl).origin, 'official public route fixture required');
        await page.goto(url.href, { waitUntil: 'commit' });
        await waitForPublicShellLocaleResourceEntry(entryBarrier.entered);
        await page.waitForFunction(() => window.document.readyState !== 'loading'
            && window.document.querySelector('#fsus-aot-shell [data-public-shell-header]'));
        const first = { stage: 'first-html', dom: await page.evaluate(readPublicShellLocaleDom), evidence: await observer.capture(page) };
        stages.push(first);
        await saveStage({ page, evidence: first, privateOriginals: observer.rawCapture.snapshot(first.evidence.captureCut) });
        assert.equal(first.dom.hydrated, false, 'entry barrier did not preserve first HTML');
        assert.equal(first.evidence.browser.recorder.marks.some((mark) => mark.name.endsWith(':hydrate:start')), false,
            'hydration started before the held production entry');
        entryBarrier.release();
        await waitForPublicShellLocaleResourceEntry(domainBarrier.entered);
        await page.waitForFunction(() => window.__fsusblogLocaleLifecycleEvidence.state.marks
            .some((mark) => mark.name === 'fsus:start:public-hydrate:hydrate:start'));
        const hydration = await observer.capture(page);
        const start = { stage: 'hydration-start', observation: assertPublicShellLocaleHydrationMark(hydration), evidence: hydration };
        stages.push(start);
        await saveStage({ page, evidence: start, privateOriginals: observer.rawCapture.snapshot(hydration.captureCut) });
        domainBarrier.release();
        await page.waitForFunction(() => window.document.querySelector('#fsus-aot-shell')
            ?.getAttribute('data-public-hydrated') === 'true' && window.document.fonts.status === 'loaded');
        await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        for (const stage of ['interactive-ready', 'selector-open'])
        {
            if (stage === 'selector-open')
            {
                await openPublicShellLocaleSelector(page);
            }
            const observation = { stage, dom: await page.evaluate(readPublicShellLocaleDom), evidence: await observer.capture(page) };
            stages.push(observation);
            await saveStage({ page, evidence: observation, privateOriginals: observer.rawCapture.snapshot(observation.evidence.captureCut) });
        }
    }
    catch (error)
    {
        firstError = error;
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
    if (firstError)
    {
        throw firstError;
    }
    return stages;
}
