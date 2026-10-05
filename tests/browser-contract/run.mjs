#!/usr/bin/env node
// fixture-catalog: consumer browser-contract-run acceptance-representative
/* global window */

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/* eslint-disable import-x/no-relative-parent-imports */
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
import {
    projectBrowserContractLocaleTopology,
    validateBrowserContractLocaleTopology
} from '../../tools/release/browser-contract-receipt-contract.mjs';
import { requireCleanAttemptConsumerAdmission } from '../../tools/release/browser-release-clean-attempt-consumers.mjs';
import {
    sealBrowserContractReceipt,
    sha256File,
    validateBrowserContractReceipt
} from '../../tools/release/test-evidence-receipts.mjs';
import {
    bindBrowserRenderingObservation,
    createCorrectnessBrowserPlan,
    observeBrowserRendering,
    observeCorrectnessBrowser,
    serializableBrowserPlan
} from '../../tools/test/playwright-browser-identity.mjs';
import { loadTemporalContext } from '../../tools/test/temporal-context.mjs';
import {
    bindCorrectnessProducerTemporalArtifacts,
    observeBrowserTemporalContext
} from '../../tools/test/temporal-producer-bindings.mjs';
import { readPrivateFile, readPrivateJson, writePrivateJson } from '../../tools/test-fixtures/receipt/private-io.mjs';
import { derivePublicShellLocaleRootIdentity } from '../../tools/test-matrix/public-shell-locale-evidence.mjs';
import { readPublicShellLocaleSceneOriginalArtifact } from '../../tools/test-matrix/verify-public-shell-locale.mjs';

import {
    BrowserContractFailure,
    classifyBrowserContractFailure,
    createBrowserContractReceipt,
    finalizeBrowserContractReceipt,
    persistFinalBrowserContractReceipt,
    selectBrowserContractScenarios,
    serializeBrowserContractError,
    writeBrowserContractReceipt
} from './contract.mjs';
import { validatePublicShellLocalePublishedArtifactResponse } from './default-fixture-provider.mjs';
import { readPublicShellLocaleSceneBindings } from './fixture-lifecycle.mjs';
import { fixtureReceiptView, loadBrowserContractFixture, readPublicShellLocaleRootAuthority } from './fixture.mjs';
import {
    cleanupSingleBrowserContractFixture,
    prepareSingleBrowserContractFixture,
    resolveBrowserContractRunIdentity
} from './prepare-fixture.mjs';
import { capturePublicPreviewGallery } from './public-preview-gallery.mjs';
import {
    assertPublicShellLocaleFirstResponse,
    readPublicShellLocalePublishedArtifact
} from './public-shell-locale-first-response.mjs';
import {
    admitPublicShellLocaleHarness,
    createPublicShellLocaleResourceBarrier,
    observePublicShellLocaleProbe
} from './public-shell-locale-harness.mjs';
import {
    drivePublicShellLocaleInitialHydration,
    withPublicShellLocaleLifecycleScene
} from './public-shell-locale-lifecycle-binding.mjs';
import {
    assertPublicShellLocaleResourceWaterfall,
    observePublicShellLocaleFont,
    originalCaptureLimits
} from './public-shell-locale-lifecycle-evidence.mjs';
import { createPublicShellLocaleMatrix, resolvePublicShellLocaleCopy } from './public-shell-locale-matrix.mjs';
import {
    admitPublicShellLocaleRuntimeBindings,
    resolvePublicShellLocalePublishedRoute
} from './public-shell-locale-runtime-bindings.mjs';
import { drivePublicShellLocaleSwitchInContext } from './public-shell-locale-scene-driver.mjs';
import {
    browserContractAppReadyTimeoutMs,
    browserContractScenarioRunners,
    createPageAudit
} from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const frontendRoot = path.join(root, 'src/frontend');
const outputRoot = path.resolve(process.env.FSUSBLOG_BROWSER_CONTRACT_OUTPUT || path.join(root, '.tmp/browser-contract'));
const receiptFile = path.resolve(process.env.FSUSBLOG_BROWSER_CONTRACT_RECEIPT || path.join(outputRoot, 'receipt.json'));
let traceRoot = null;
let screenshotRoot = null;
const buildReceiptFile = path.resolve(
    process.env.FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT || path.join(root, '.tmp/ci-production-build/receipt.json')
);
const startedAtEpochMs = Date.now();
const startedAtMonotonicMs = performance.now();
let browser = null;
let browserDisconnected = false;
let closingBrowser = false;
let receivedSignal = null;
let activeScenario = null;
let preparedFixture = null;
let verifiedBuild = null;
let plannedRunIdentity = null;
let outputValidated = false;
let browserTemporalObservation = null;
let temporalContext = null;
const terminationController = new AbortController();

function relative(value)
{
    return path.relative(root, value).replaceAll(path.sep, '/');
}

function snapshotReceiptEvidence(value)
{
    return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function writeAuditedBrowserContractReceipt(file, receipt)
{
    if (file !== receiptFile)
    {
        throw new BrowserContractFailure('browser contract receipt target changed during sealing', 'contract');
    }
    const sealed = sealBrowserContractReceipt(receipt);
    if (sealed.status !== 'running')
    {
        const errors = validateBrowserContractReceipt(sealed, { requireSuccess: false });
        if (errors.length > 0)
        {
            throw new BrowserContractFailure(
                `browser contract produced an invalid receipt: ${errors.join('; ')}`,
                'contract',
                { errors }
            );
        }
    }
    Object.assign(receipt, sealed);
    await writeBrowserContractReceipt(receiptFile, receipt);
}

async function preparePrivateDirectory(directory)
{
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
    {
        throw new BrowserContractFailure(`browser contract private directory is unsafe: ${relative(directory)}`, 'contract');
    }
    await chmod(directory, 0o700);
}

function assertRunOwnedPath(value, label)
{
    const canonicalRoot = path.join(root, '.tmp', 'browser-contract');
    const resolved = path.resolve(value);
    if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`))
    {
        throw new BrowserContractFailure(`${label} must stay under .tmp/browser-contract`, 'contract');
    }
    let current = root;
    for (const segment of path.relative(root, resolved).split(path.sep))
    {
        current = path.join(current, segment);
        if (!existsSync(current))
        {
            continue;
        }
        const stat = lstatSync(current);
        if (stat.isSymbolicLink())
        {
            throw new BrowserContractFailure(`${label} contains a symlink`, 'contract');
        }
    }
    return resolved;
}

async function resetRunOutput()
{
    const ownedOutputRoot = assertRunOwnedPath(outputRoot, 'browser contract output root');
    const ownedReceiptFile = assertRunOwnedPath(receiptFile, 'browser contract receipt');
    if (existsSync(ownedOutputRoot) && !lstatSync(ownedOutputRoot).isDirectory())
    {
        throw new BrowserContractFailure('browser contract output root must be a directory', 'contract');
    }
    if (existsSync(ownedReceiptFile) && !lstatSync(ownedReceiptFile).isFile())
    {
        throw new BrowserContractFailure('browser contract receipt must be a regular file', 'contract');
    }
    await preparePrivateDirectory(ownedOutputRoot);
    await rm(ownedReceiptFile, { force: true });
    outputValidated = true;
}

function assertLocaleRootActive()
{
    if (terminationController.signal.aborted)
    {
        throw new BrowserContractFailure('locale Root operation was cancelled', 'infra');
    }
}

function readLocaleOriginalEnvelopeData(envelope, fields)
{
    if (!envelope || typeof envelope !== 'object'
        || ![Object.prototype, null].includes(Object.getPrototypeOf(envelope)))
    {
        throw new BrowserContractFailure('locale scene originals require a plain data envelope', 'contract');
    }
    const selected = {};
    for (const field of fields)
    {
        const descriptor = Object.getOwnPropertyDescriptor(envelope, field);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined)
        {
            throw new BrowserContractFailure('locale scene originals require own defined data descriptors', 'contract');
        }
        // Keep selected live references intact; never enumerate page or other opaque fields.
        selected[field] = descriptor.value;
    }
    return selected;
}

function snapshotLocaleOriginalJson(value, ancestors = new Set())
{
    if (value === null || ['string', 'boolean'].includes(typeof value)
        || (typeof value === 'number' && Number.isFinite(value)))
    {
        return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)
        || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
    {
        throw new BrowserContractFailure('locale scene originals require serializable JSON inputs', 'contract');
    }
    ancestors.add(value);
    const copy = Array.isArray(value) ? [] : {};
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    if (Array.isArray(value) && !isDeepStrictEqual(Object.keys(value), keys))
    {
        throw new BrowserContractFailure('locale scene originals JSON array is incomplete', 'contract');
    }
    for (const key of keys)
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        {
            throw new BrowserContractFailure('locale scene originals cannot serialize a JSON accessor', 'contract');
        }
        Object.defineProperty(copy, key, { value: snapshotLocaleOriginalJson(descriptor.value, ancestors),
            enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(value);
    return copy;
}

function snapshotLocaleOriginalLease(lease)
{
    const fields = ['leaseId', 'actorId', 'contextId', 'sceneId', 'role', 'owner', 'authority', 'status'];
    const identity = {};
    for (const field of fields)
    {
        const descriptor = Object.getOwnPropertyDescriptor(lease, field);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        {
            throw new BrowserContractFailure('locale scene original lease JSON identity is missing', 'contract');
        }
        identity[field] = snapshotLocaleOriginalJson(descriptor.value);
    }
    return identity;
}

/** Bind only the caller's actual prepared lease and frozen Root. This private storage boundary
 * neither executes a scene nor qualifies its observations. Missing normal cuts are rejected;
 * a disposal tail is a separate input, not a replacement or a context-close assertion.
 */
export function createPublicShellLocaleOriginalSink(options)
{
    assertLocaleRootActive();
    const { matrix, scene, lease, rootBinding } = readLocaleOriginalEnvelopeData(options, ['matrix', 'scene', 'lease', 'rootBinding']);
    const admittedMatrix = snapshotLocaleOriginalJson(matrix);
    const admittedScene = snapshotLocaleOriginalJson(scene);
    const callerRoot = snapshotLocaleOriginalJson(rootBinding);
    const matches = admittedMatrix.scenes.filter((item) => item.id === admittedScene.id);
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], admittedScene)
        || typeof admittedScene.id !== 'string' || !admittedScene.id)
    {
        throw new BrowserContractFailure('locale original scene differs from its current matrix', 'contract');
    }
    const expectedArtifact = `.tmp/browser-contract/runs/${callerRoot.binding.identity.namespace}/bindings/${callerRoot.binding.preparation.id}/root-binding.json`;
    if (callerRoot.artifact !== expectedArtifact || !/^sha256:[a-f0-9]{64}$/u.test(callerRoot.digest))
    {
        throw new BrowserContractFailure('locale scene original Root path or digest is invalid', 'contract');
    }
    const bindingFile = assertRunOwnedPath(path.join(root, callerRoot.artifact), 'locale scene original Root');
    const readRoot = () =>
    {
        assertLocaleRootActive();
        assertRunOwnedPath(bindingFile, 'locale scene original Root');
        const current = readPrivateJson(bindingFile, { label: 'locale scene original Root' });
        if (current.contentDigest !== callerRoot.digest || sha256File(bindingFile) !== callerRoot.digest
            || !isDeepStrictEqual(current.document, callerRoot.binding)
            || !isDeepStrictEqual(derivePublicShellLocaleRootIdentity(admittedMatrix, current.document), callerRoot.identity))
        {
            throw new BrowserContractFailure('locale scene original Root bytes or identity changed', 'contract');
        }
        return current.document;
    };
    const binding = readRoot();
    const identity = {
        matrixDigest: binding.matrixDigest, sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        namespace: binding.identity.namespace, preparationId: binding.preparation.id
    };
    const admittedLease = snapshotLocaleOriginalLease(lease);
    const owner = { identity: binding.identity, preparation: binding.preparation, sourceState: binding.sourceState,
        buildDigest: binding.buildDigest, fixtureRoot: binding.resources.fixtureRoot, resources: binding.resources };
    const originalRoles = new Map([
        ['provider-state', 'provider-state.json'], ['fixture-manifest', 'contract-fixture.json'],
        ['prepare-state', 'prepare-state.json'], ['fixture-receipt', 'fixture-receipt.json'],
        ['cookie-source', 'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs']
    ]);
    const expectedRefs = binding.refs.filter((ref) => originalRoles.has(ref.role))
        .map((ref) => ({ path: originalRoles.get(ref.role), digest: ref.digest }));
    const providerRef = binding.refs.find((ref) => ref.role === 'provider-state');
    const providerFile = assertRunOwnedPath(path.join(root, providerRef.path), 'locale scene original Root provider');
    const provider = readPrivateJson(providerFile, { label: 'locale scene original Root provider' });
    if (provider.contentDigest !== providerRef.digest || provider.document.runtimeRunId !== binding.runtimeId
        || ['leaseId', 'actorId', 'contextId'].some((field) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(admittedLease[field]))
        || admittedLease.sceneId !== admittedScene.id || admittedLease.role !== admittedScene.authActionContext
        || admittedLease.status !== 'prepared' || !isDeepStrictEqual(admittedLease.owner, owner)
        || admittedLease.authority.matrixDigest !== binding.matrixDigest
        || admittedLease.authority.runtimeRunId !== binding.runtimeId
        || admittedLease.authority.fixtureReceiptDigest !== binding.fixtureReceiptDigest
        || !isDeepStrictEqual(admittedLease.authority.runtime, {
            frontendUrl: provider.document.runtime?.frontendUrl, backendUrl: provider.document.runtime?.backendUrl
        })
        || !Array.isArray(admittedLease.authority.rawRefs)
        || admittedLease.authority.rawRefs.length !== expectedRefs.length
        || expectedRefs.some((ref) => admittedLease.authority.rawRefs.filter((item) => isDeepStrictEqual(item, ref)).length !== 1))
    {
        throw new BrowserContractFailure('locale scene original lease crosses its Root owner or authority', 'contract');
    }
    const directory = assertRunOwnedPath(path.join(path.dirname(bindingFile), 'scene-originals',
        `scene-${encodeURIComponent(admittedScene.id)}`), 'locale scene originals directory');
    return async (input) =>
    {
        assertLocaleRootActive();
        const { lease: actualLease, evidence, privateOriginals, failure } = readLocaleOriginalEnvelopeData(input,
            ['lease', 'evidence', 'privateOriginals', 'failure']);
        if (actualLease !== lease || !isDeepStrictEqual(snapshotLocaleOriginalLease(actualLease), admittedLease))
        {
            throw new BrowserContractFailure('locale scene original lease is not the actual callback lease', 'contract');
        }
        // Snapshot JSON data before the first await; never visit page/context or invoke toJSON.
        const original = snapshotLocaleOriginalJson({ scene: admittedScene, lease: admittedLease, evidence,
            privateOriginals, failure, rootBinding: { artifact: callerRoot.artifact, digest: callerRoot.digest } });
        if (original.evidence.sceneId !== admittedScene.id || original.privateOriginals.binding?.sceneId !== admittedScene.id
            || !isDeepStrictEqual(original.evidence.identity, identity)
            || !isDeepStrictEqual(original.privateOriginals.binding.identity, identity))
        {
            throw new BrowserContractFailure('locale scene original observation identity or scene differs', 'contract');
        }
        const cut = original.evidence.captureCut;
        if (!Number.isSafeInteger(cut) || cut < 0 || cut !== original.privateOriginals.captureCut)
        {
            throw new BrowserContractFailure('locale scene original observation cut is missing or mismatched', 'contract');
        }
        const role = original.evidence.phase === 'observer-disposal' ? 'tail' : 'normal';
        const target = assertRunOwnedPath(path.join(directory, `cut-${cut}-${role}.json`), 'locale scene original leaf');
        await preparePrivateDirectory(directory);
        assertLocaleRootActive();
        assertRunOwnedPath(target, 'locale scene original leaf');
        if (!isDeepStrictEqual(snapshotLocaleOriginalLease(lease), admittedLease))
        {
            throw new BrowserContractFailure('locale scene original lease changed during publication', 'contract');
        }
        readRoot();
        const currentProvider = readPrivateJson(providerFile, { label: 'locale scene original Root provider' });
        if (currentProvider.contentDigest !== provider.contentDigest)
        {
            throw new BrowserContractFailure('locale scene original Root provider changed during publication', 'contract');
        }
        const published = writePrivateJson(target, original, { label: 'locale scene original leaf', overwrite: false });
        const retained = readPrivateJson(target, { label: 'locale scene original leaf' });
        if (retained.contentDigest !== published.contentDigest || sha256File(target) !== published.contentDigest)
        {
            throw new BrowserContractFailure('locale scene original leaf bytes changed after publication', 'contract');
        }
        readRoot();
        assertLocaleRootActive();
        return { path: relative(target), digest: retained.contentDigest };
    };
}

/** One cold domain barrier per planned target, from the admitted build, not observed requests.
 * This enables the existing partial switch driver; it does not cover its remaining contracts.
 */
export function createPublicShellLocaleSwitchResourceHolds({ scene, bindings })
{
    const targets = scene.stage === 'latest-wins' ? scene.transition?.rapidTargets : [scene.locale];
    const domain = scene.requiredDomains?.[0];
    if (!Array.isArray(targets) || targets.length === 0 || targets.at(-1) !== scene.locale
        || targets.some((locale) => typeof locale !== 'string' || !scene.selectorItems?.some((item) => item.code === locale))
        || typeof domain !== 'string' || !domain || !Array.isArray(bindings.resources))
    {
        throw new BrowserContractFailure('locale switch planned resource authority is unavailable', 'contract');
    }
    const urls = new Set();
    return [...new Set(targets)].map((locale) =>
    {
        const resources = bindings.resources.filter((resource) => resource.identities?.some((identity) =>
            identity.kind === 'domain' && identity.locale === locale && identity.domain === domain));
        if (resources.length !== 1 || typeof resources[0].url !== 'string' || urls.has(resources[0].url))
        {
            throw new BrowserContractFailure('locale switch cold domain is missing, shared or ambiguous', 'contract');
        }
        urls.add(resources[0].url);
        return { locale, url: resources[0].url, barrier: createPublicShellLocaleResourceBarrier() };
    });
}

/** Retain exact provider bytes under the admitted preparation, independently of fixture cleanup.
 * Root admission and the caller's entered capability remain separate from browser acceptance.
 */
export function readPublicShellLocalePublishedArtifactRef({ matrix, lease, rootBinding, result, scene, owner, route })
{
    const requireRoot = () => createPublicShellLocaleOriginalSink({ matrix, scene, lease, rootBinding });
    requireRoot();
    if (scene.issue !== 2083 || scene.stage !== 'first-response'
        || result.sceneId !== scene.id || result.matrixDigest !== matrix.contentDigest
        || result.runtimeRunId !== owner.runtimeRunId
        || owner.namespace !== lease.owner.identity.namespace || owner.runtimeRunId !== lease.authority.runtimeRunId
        || owner.sourceCommit !== lease.owner.sourceState.commit
        || owner.worktreeFingerprint !== lease.owner.sourceState.worktreeFingerprint
        || owner.buildDigest !== lease.owner.buildDigest || owner.runtimeScope !== ''
        || !/^sha256:[a-f0-9]{64}$/u.test(result.artifact?.digest ?? '')
        || !/^published-artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/u.test(result.artifact?.path ?? ''))
    {
        throw new BrowserContractFailure('first-response published reference differs from its owner', 'contract');
    }
    const fixtureRoot = assertRunOwnedPath(lease.owner.fixtureRoot, 'first-response provider fixture root');
    if (!lstatSync(fixtureRoot).isDirectory() || (lstatSync(fixtureRoot).mode & 0o777) !== 0o700)
    {
        throw new BrowserContractFailure('first-response published reference fixture root differs', 'contract');
    }
    const source = assertRunOwnedPath(path.join(fixtureRoot, result.artifact.path), 'first-response provider artifact');
    const { bytes, contentDigest } = readPrivateJson(source, {
        label: 'first-response provider artifact', maximumBytes: originalCaptureLimits.totalBytes
    });
    assertRunOwnedPath(source, 'first-response provider artifact');
    if (contentDigest !== result.artifact.digest)
    {
        throw new BrowserContractFailure('first-response provider artifact byte digest differs', 'contract');
    }
    const observation = validatePublicShellLocalePublishedArtifactResponse(bytes, {
        body: { ...owner, path: route.path, locale: scene.locale }
    }, scene);
    requireRoot();
    const prefix = `.tmp/browser-contract/runs/${owner.namespace}/bindings/${lease.owner.preparation.id}/published-artifacts/scene-${encodeURIComponent(scene.id)}/`;
    const directory = assertRunOwnedPath(path.join(root, prefix), 'first-response retained directory');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertRunOwnedPath(directory, 'first-response retained directory');
    for (let current = directory; current !== path.dirname(path.join(root, rootBinding.artifact)); current = path.dirname(current))
    {
        if (!lstatSync(current).isDirectory() || (lstatSync(current).mode & 0o777) !== 0o700)
        {
            throw new BrowserContractFailure('first-response retained directory is not private', 'contract');
        }
    }
    const ref = { path: `${prefix}${result.artifact.path}`, digest: result.artifact.digest };
    const target = assertRunOwnedPath(path.join(root, ref.path), 'first-response retained artifact');
    writePrivateJson(target, bytes.toString('utf8'), { label: 'first-response retained artifact',
        expectedContentDigest: result.artifact.digest, overwrite: false });
    const retained = readPublicShellLocaleSceneOriginalArtifact({ root, ref, prefix,
        remainingBytes: originalCaptureLimits.totalBytes });
    if (!retained.bytes.equals(bytes)
        || !readPrivateFile(source, { label: 'first-response provider artifact', maximumBytes: originalCaptureLimits.totalBytes }).bytes.equals(bytes))
    {
        throw new BrowserContractFailure('first-response original bytes changed during retention', 'contract');
    }
    assertRunOwnedPath(source, 'first-response provider artifact');
    requireRoot();
    return { ref, observation };
}

/** Admit the independent cache read before navigation; expectations never come from that response. */
export async function readPublicShellLocaleFirstResponsePublishedInput({ matrix, scene, fixture, lease, rootBinding, readPublishedArtifact })
{
    const requireRoot = () => createPublicShellLocaleOriginalSink({ matrix, scene, lease, rootBinding });
    requireRoot();
    if (scene.issue !== 2083 || scene.stage !== 'first-response'
        || lease.authority.inputs.javaScriptEnabled !== false || fixture.transport.testSessionHeader !== false
        || typeof readPublishedArtifact !== 'function')
    {
        throw new BrowserContractFailure('first-response authority requires its JS-disabled entered fixture', 'contract');
    }
    const route = await resolvePublicShellLocalePublishedRoute({ root, scene, fixture });
    const result = await readPublishedArtifact(route.path);
    requireRoot();
    const owner = {
        namespace: lease.owner.identity.namespace, runtimeRunId: lease.authority.runtimeRunId,
        sourceCommit: lease.owner.sourceState.commit, worktreeFingerprint: lease.owner.sourceState.worktreeFingerprint,
        buildDigest: lease.owner.buildDigest,
        // The formal host has no X-Fsus-Test-Session header; namespace is not a key-scope substitute.
        runtimeScope: ''
    };
    const { ref, observation } = readPublicShellLocalePublishedArtifactRef({ matrix, lease, rootBinding,
        result, scene, owner, route });
    const published = await readPublicShellLocalePublishedArtifact({ publishedArtifact: observation, scene,
        expectedOwner: owner, expectedRoute: route });
    if (typeof observation.publication.effectiveCacheControl !== 'string' || !observation.publication.effectiveCacheControl)
    {
        throw new BrowserContractFailure('first-response published serving policy is unavailable', 'contract');
    }
    const copy = await resolvePublicShellLocaleCopy(matrix, scene.id, root);
    requireRoot();
    return {
        ref, route, copy,
        expected: {
            identity: { sourceCommit: owner.sourceCommit, worktreeFingerprint: owner.worktreeFingerprint,
                matrixDigest: matrix.contentDigest, buildDigest: owner.buildDigest,
                runtimeId: owner.runtimeRunId, namespace: owner.namespace },
            metadata: { title: published.seoHead.title, description: published.seoHead.description,
                canonicalUrl: published.seoHead.canonicalUrl },
            bootstrap: published.bootstrap, frontendBuildIdentity: published.bootConfig.frontendBuildIdentity,
            cacheControl: observation.publication.effectiveCacheControl
        }
    };
}

async function observePublicShellLocaleScene(input)
{
    const { context, fixture, scene, bindings, observer, saveStage } = input;
    if (scene.issue === 2083)
    {
        const published = await readPublicShellLocaleFirstResponsePublishedInput(input);
        const page = await context.newPage();
        const response = await page.goto(new URL(published.route.path, fixture.baseUrl).href, { waitUntil: 'commit' });
        if (!response || response.request().frame() !== page.mainFrame()
            || response.url() !== new URL(published.route.path, fixture.baseUrl).href)
        {
            throw new BrowserContractFailure('first-response navigation has no exact main-frame document', 'contract');
        }
        const evidence = await observer.captureFirstResponse();
        const ordinal = observer.rawCapture.requestData(response.request()).requestOrdinal;
        const originals = observer.rawCapture.snapshot(evidence.captureCut);
        const documents = originals.originals.filter((item) => item.kind === 'response' && item.source === 'browser'
            && item.requestOrdinal === ordinal && item.url === response.url());
        if (documents.length !== 1 || documents[0].captureState !== 'observed')
        {
            throw new BrowserContractFailure('first-response original document is missing or ambiguous', 'contract');
        }
        const original = documents[0];
        const firstResponse = await assertPublicShellLocaleFirstResponse({ scene, copy: published.copy,
            expected: published.expected, response: { status: original.status, headers: original.headersArray.map(({ name, value }) => [name, value]),
                body: Buffer.from(original.bodyBase64, 'base64'), identity: published.expected.identity } });
        await saveStage({ evidence: { stage: scene.stage, publishedArtifactRef: published.ref, firstResponse, evidence } });
        return firstResponse;
    }
    if (scene.issue === 2084)
    {
        return await drivePublicShellLocaleInitialHydration(input);
    }
    if (scene.issue === 2086)
    {
        return await drivePublicShellLocaleSwitchInContext({ ...input,
            resourceHolds: createPublicShellLocaleSwitchResourceHolds({ scene, bindings }) });
    }
    if (scene.issue !== 2085 || scene.stage !== 'initial-network')
    {
        const gap = scene.issue === 2083 ? 'first-response independent expected authority'
            : scene.issue === 2086 ? 'switch driver lifecycle/checkpoint boundary'
            : scene.issue === 2087 ? 'fault driver scene-bound resource/replacement authority'
            : 'scene driver';
        throw new BrowserContractFailure(`PublicShell locale ${gap} is not wired`, 'contract', { sceneId: scene.id });
    }
    const url = scene.route === 'Home' ? new URL('/', fixture.baseUrl)
        : scene.route === 'ArticleDetail' ? new URL(fixture.publicArticle.url, fixture.baseUrl) : null;
    if (!url || url.origin !== new URL(fixture.baseUrl).origin)
    {
        throw new BrowserContractFailure('PublicShell locale official route is unavailable', 'contract');
    }
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.document.querySelector('#fsus-aot-shell')
        ?.getAttribute('data-public-hydrated') === 'true' && window.document.fonts.status === 'loaded');
    await page.evaluate(() => new Promise((resolve) =>
    {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    }));
    const fontObservation = await observePublicShellLocaleFont(page, scene.requiredFont);
    const evidence = await observer.capture(page);
    await saveStage({ evidence: { stage: scene.stage, fontObservation, evidence },
        privateOriginals: observer.rawCapture.snapshot(evidence.captureCut) });
    return assertPublicShellLocaleResourceWaterfall({ bindings, scene, evidence, fontObservation });
}

/** The canonical caller supplies its one existing Browser. No launch, actor creation, retries,
 * or qualification flags live here. Unsupported drivers and actual allocation blockers stop
 * the matrix. observe is an internal callback seam for owning Node models, not a CLI override.
 */
export async function runPublicShellLocaleScenes(options)
{
    const { browser: ownedBrowser, matrix, harness, bindings, rootBinding } = readLocaleOriginalEnvelopeData(options,
        ['browser', 'matrix', 'harness', 'bindings', 'rootBinding']);
    const descriptor = Object.getOwnPropertyDescriptor(options, 'observe');
    if (descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'))
    {
        throw new BrowserContractFailure('locale scene operation must be a data callback', 'contract');
    }
    const observe = descriptor?.value ?? observePublicShellLocaleScene;
    const retainedDescriptor = Object.getOwnPropertyDescriptor(options, 'retainOriginal');
    if (retainedDescriptor && (!Object.hasOwn(retainedDescriptor, 'value') || typeof retainedDescriptor.value !== 'function'))
    {
        throw new BrowserContractFailure('locale original ref retention must be a data callback', 'contract');
    }
    if (!isDeepStrictEqual(bindings.identity, harness.identity) || matrix.contentDigest !== harness.identity.matrixDigest
        || ownedBrowser.contexts().length !== 0)
    {
        throw new BrowserContractFailure('locale scene loop admission or context boundary differs', 'contract');
    }
    const createContext = harness.contextFactory(ownedBrowser);
    const refs = [];
    for (const scene of matrix.scenes)
    {
        assertLocaleRootActive();
        let save;
        const driverObservations = [];
        let observationBytes = 0;
        await withPublicShellLocaleLifecycleScene({ harness, matrix, bindings, sceneId: scene.id, createContext,
            observe: async (input) =>
            {
                save = createPublicShellLocaleOriginalSink({ matrix, scene, lease: input.lease, rootBinding });
                return await observe({ ...input, matrix, rootBinding, saveStage: async (stage) =>
                {
                    const value = snapshotLocaleOriginalJson(stage.evidence);
                    const capture = value.evidence;
                    if (!capture || capture.sceneId !== scene.id || !isDeepStrictEqual(capture.identity, bindings.identity)
                        || !Number.isSafeInteger(capture.captureCut) || capture.captureCut < 0
                        || capture.captureCut > input.observer.rawCapture.cut()
                        || (stage.privateOriginals !== undefined && capture.captureCut !== stage.privateOriginals?.captureCut))
                    {
                        throw new BrowserContractFailure('locale driver stage has no matching actual capture cut', 'contract');
                    }
                    observationBytes += Buffer.byteLength(JSON.stringify(value));
                    if (driverObservations.length >= originalCaptureLimits.records || observationBytes > originalCaptureLimits.totalBytes)
                    {
                        throw new BrowserContractFailure('locale driver observations overflowed', 'contract');
                    }
                    // Stage cuts may coincide (e.g. selector-open with no new network request).
                    // Keep their original facts in the final normal/tail inputs, not duplicate
                    // private body batches or synthetic cuts/exclusive filename overwrites.
                    driverObservations.push(value);
                } });
            },
            saveEvidence: async (input) =>
            {
                save ??= createPublicShellLocaleOriginalSink({ matrix, scene, lease: input.lease, rootBinding });
                const ref = await save({ ...input, evidence: { ...input.evidence, driverObservations } });
                refs.push(ref);
                // The canonical finally owner needs refs even when observe/close later fails.
                retainedDescriptor?.value(ref);
            }
        });
        if (ownedBrowser.contexts().length !== 0)
        {
            throw new BrowserContractFailure('locale scene context did not close', 'contract');
        }
    }
    return refs;
}

/** Persist the fixture owner's original ledger, including real failed/entered states.
 * Only its existing projection/validator may decide terminal success. Root refs stay eight.
 */
export async function retainPublicShellLocaleSceneLedger(options)
{
    const { fixtureRoot, outputDirectory, rootBinding, matrix, originals } = readLocaleOriginalEnvelopeData(options,
        ['fixtureRoot', 'outputDirectory', 'rootBinding', 'matrix', 'originals']);
    assertLocaleRootActive();
    const bindings = readPublicShellLocaleSceneBindings(fixtureRoot);
    if (!bindings)
    {
        if (!Array.isArray(originals) || originals.length !== 0)
        {
            throw new BrowserContractFailure('locale originals have no actual fixture ledger', 'contract');
        }
        return { bindings: null, reference: null };
    }
    const caller = snapshotLocaleOriginalJson(rootBinding);
    const expectedArtifact = `.tmp/browser-contract/runs/${caller.binding.identity.namespace}/bindings/${caller.binding.preparation.id}/root-binding.json`;
    if (caller.artifact !== expectedArtifact)
    {
        throw new BrowserContractFailure('locale ledger Root namespace differs', 'contract');
    }
    const bindingFile = assertRunOwnedPath(path.join(root, caller.artifact), 'locale ledger Root');
    const readRoot = () =>
    {
        assertLocaleRootActive();
        assertRunOwnedPath(bindingFile, 'locale ledger Root');
        const current = readPrivateJson(bindingFile, { label: 'locale ledger Root' });
        if (current.contentDigest !== caller.digest || sha256File(bindingFile) !== caller.digest
            || !isDeepStrictEqual(current.document, caller.binding)
            || !isDeepStrictEqual(derivePublicShellLocaleRootIdentity(matrix, current.document), caller.identity))
        {
            throw new BrowserContractFailure('locale ledger Root changed', 'contract');
        }
        return current.document;
    };
    const binding = readRoot();
    const owner = { identity: binding.identity, preparation: binding.preparation, sourceState: binding.sourceState,
        buildDigest: binding.buildDigest, fixtureRoot: binding.resources.fixtureRoot, resources: binding.resources };
    if (fixtureRoot !== owner.fixtureRoot || !isDeepStrictEqual(bindings.owner, owner)
        || bindings.leases.some((lease) => !matrix.scenes.some((scene) => scene.id === lease.sceneId)))
    {
        throw new BrowserContractFailure('locale ledger differs from its Root/matrix owner', 'contract');
    }
    const refs = snapshotLocaleOriginalJson(originals);
    if (!Array.isArray(refs) || refs.length > matrix.scenes.length * 2 || new Set(refs.map((ref) => ref.path)).size !== refs.length)
    {
        throw new BrowserContractFailure('locale ledger original ref set is invalid', 'contract');
    }
    const identity = { matrixDigest: binding.matrixDigest, sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        namespace: binding.identity.namespace, preparationId: binding.preparation.id };
    for (const ref of refs)
    {
        const file = assertRunOwnedPath(path.join(root, ref.path), 'locale ledger original ref');
        const current = readPrivateJson(file, { label: 'locale ledger original ref' });
        const original = current.document;
        const scene = matrix.scenes.find((item) => item.id === original.scene?.id);
        const lease = bindings.leases.find((item) => item.sceneId === scene?.id);
        const cut = original.evidence?.captureCut;
        const role = original.evidence?.phase === 'observer-disposal' ? 'tail' : 'normal';
        const expectedPath = path.join(path.dirname(bindingFile), 'scene-originals', `scene-${encodeURIComponent(scene?.id)}`,
            `cut-${cut}-${role}.json`);
        if (!scene || !lease || !isDeepStrictEqual(original.scene, scene) || file !== expectedPath
            || current.contentDigest !== ref.digest || sha256File(file) !== ref.digest
            || !Number.isSafeInteger(cut) || cut < 0 || cut !== original.privateOriginals?.captureCut
            || original.evidence.sceneId !== scene.id || original.privateOriginals.binding?.sceneId !== scene.id
            || !isDeepStrictEqual(original.evidence.identity, identity)
            || !isDeepStrictEqual(original.privateOriginals.binding.identity, identity)
            || !isDeepStrictEqual(original.rootBinding, { artifact: caller.artifact, digest: caller.digest })
            || ['leaseId', 'actorId', 'contextId', 'sceneId', 'role', 'owner', 'authority']
                .some((field) => !isDeepStrictEqual(original.lease?.[field], lease[field]))
            || original.lease.status !== 'prepared')
        {
            throw new BrowserContractFailure('locale original does not join its actual ledger/Root/cut', 'contract');
        }
    }
    const source = assertRunOwnedPath(path.join(fixtureRoot, 'public-shell-locale-scene-bindings.json'), 'locale original ledger');
    const original = readPrivateJson(source, { label: 'locale original ledger' });
    if (!isDeepStrictEqual(original.document, bindings))
    {
        throw new BrowserContractFailure('locale ledger changed during read', 'contract');
    }
    const directory = assertRunOwnedPath(outputDirectory, 'locale retained ledger directory');
    await preparePrivateDirectory(directory);
    const target = assertRunOwnedPath(path.join(directory, 'public-shell-locale-scene-bindings.json'), 'locale retained ledger');
    readRoot();
    assertLocaleRootActive();
    await writeFile(target, original.bytes, { flag: 'wx', mode: 0o600 });
    const retained = readPrivateJson(target, { label: 'locale retained ledger' });
    if (retained.contentDigest !== original.contentDigest || sha256File(target) !== original.contentDigest
        || readPrivateJson(source, { label: 'locale original ledger' }).contentDigest !== original.contentDigest)
    {
        throw new BrowserContractFailure('locale ledger bytes changed during retention', 'contract');
    }
    readRoot();
    return { bindings, reference: { artifact: relative(target), digest: retained.contentDigest } };
}

async function snapshotPublicShellLocaleAuthority(matrix, prepared)
{
    assertLocaleRootActive();
    const authority = await readPublicShellLocaleRootAuthority(prepared, { matrix, signal: terminationController.signal });
    assertLocaleRootActive();
    const directory = assertRunOwnedPath(path.join(root, '.tmp', 'browser-contract', 'runs',
        prepared.identity.namespace, 'bindings', prepared.preparation.id), 'locale Root snapshot');
    await preparePrivateDirectory(directory);
    const roles = new Map([
        ['provider-state.json', 'provider-state'],
        ['contract-fixture.json', 'fixture-manifest'],
        ['prepare-state.json', 'prepare-state'],
        ['fixture-receipt.json', 'fixture-receipt']
    ]);
    if (!Array.isArray(authority.rawRefs) || authority.rawRefs.length !== 5
        || authority.rawRefs.some((ref) => typeof ref?.path !== 'string'
            || typeof ref?.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.digest))
        || new Set(authority.rawRefs.map((ref) => ref.path)).size !== 5)
    {
        throw new BrowserContractFailure('locale Root authority original raw roster is invalid', 'contract');
    }
    const refs = [];
    for (const [name, role] of roles)
    {
        assertLocaleRootActive();
        const declared = authority.rawRefs.find((ref) => ref.path === name);
        const source = path.join(prepared.root, name);
        if (!declared || realpathSync(source) !== source)
        {
            throw new BrowserContractFailure('locale Root original fixture ref is missing or noncanonical', 'contract');
        }
        const original = readPrivateJson(source, { label: `locale Root ${role}` });
        if (original.contentDigest !== declared.digest)
        {
            throw new BrowserContractFailure('locale Root original fixture bytes changed after admission', 'contract');
        }
        const target = path.join(directory, name);
        await writeFile(target, original.bytes, { flag: 'wx', mode: 0o600 });
        refs.push({ role, path: relative(target), digest: original.contentDigest });
    }
    const cookieRef = authority.rawRefs.find((ref) => !roles.has(ref.path));
    const expectedCookieSource = 'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs';
    if (cookieRef?.path !== expectedCookieSource)
    {
        throw new BrowserContractFailure('locale Root cookie source authority is invalid', 'contract');
    }
    for (const [role, source, name, expectedDigest] of [
        ['cookie-source', path.join(root, expectedCookieSource), 'cookie-source.cs', cookieRef.digest],
        ['build-receipt', buildReceiptFile, 'build-receipt.json', null]
    ])
    {
        assertLocaleRootActive();
        const stat = lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(source) !== source)
        {
            throw new BrowserContractFailure('locale Root build/source ref is unsafe', 'contract');
        }
        const bytes = await readFile(source);
        assertLocaleRootActive();
        const target = path.join(directory, name);
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        const contentDigest = sha256File(target);
        if (role === 'build-receipt')
        {
            const admitted = verifyProductionBuildReceipt({
                artifactRoot: path.dirname(source),
                receiptFile: path.basename(source),
                expectedSourceState: prepared.sourceState,
                repairReadOnlySeal: false
            });
            if (JSON.parse(bytes.toString('utf8')).contentDigest !== prepared.build.receiptContentDigest
                || admitted.receipt.contentDigest !== prepared.build.receiptContentDigest
                || sha256File(source) !== contentDigest)
            {
                throw new BrowserContractFailure('locale Root build bytes changed after admission', 'contract');
            }
        }
        if (expectedDigest !== null && contentDigest !== expectedDigest)
        {
            throw new BrowserContractFailure('locale Root source bytes changed after admission', 'contract');
        }
        refs.push({ role, path: relative(target), digest: contentDigest });
    }
    return { authority, directory, refs };
}

async function freezePublicShellLocaleRootBinding(matrix, prepared, snapshot, plan, actual)
{
    try
    {
        assertLocaleRootActive();
        const refs = [...snapshot.refs];
        for (const [role, value] of [['browser-plan', plan], ['browser-actual', actual]])
        {
            assertLocaleRootActive();
            const target = path.join(snapshot.directory, `${role}.json`);
            if (existsSync(target))
            {
                throw new Error('locale Root browser leaf is already frozen');
            }
            await writeBrowserContractReceipt(target, value);
            refs.push({ role, path: relative(target), digest: sha256File(target) });
        }
        const binding = {
            schema: 'fsusblog.public-shell-locale-root-binding.v1',
            matrixDigest: matrix.contentDigest,
            sourceState: prepared.sourceState,
            buildDigest: prepared.build.receiptContentDigest,
            identity: prepared.lifecycle.identity,
            preparation: prepared.preparation,
            resources: {
                fixtureRoot: prepared.root,
                databaseInstance: prepared.identity.databaseInstance,
                databaseSchema: prepared.identity.databaseSchema,
                redisInstance: prepared.identity.redisInstance,
                redisNamespace: prepared.identity.redisNamespace
            },
            runtimeId: snapshot.authority.runtimeRunId,
            fixtureReceiptDigest: snapshot.authority.fixtureReceiptDigest,
            plan,
            actual,
            launchOrdinal: 1,
            refs
        };
        const identity = derivePublicShellLocaleRootIdentity(matrix, binding);
        const target = path.join(snapshot.directory, 'root-binding.json');
        if (existsSync(target))
        {
            throw new Error('locale Root binding is already frozen');
        }
        assertLocaleRootActive();
        writePrivateJson(target, binding, { label: 'locale Root binding' });
        return { binding, identity, artifact: relative(target), digest: sha256File(target) };
    }
    catch (error)
    {
        if (error instanceof BrowserContractFailure)
        {
            throw error;
        }
        throw new BrowserContractFailure(`locale Root binding failed: ${error.message}`, 'contract');
    }
}

function expectedSourceState()
{
    const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT || '').trim();
    const worktreeFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || '').trim();
    if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new BrowserContractFailure(
            'Browser Contract requires complete FSUSBLOG_TEST_SOURCE_COMMIT and FSUSBLOG_TEST_SOURCE_FINGERPRINT identity',
            'contract'
        );
    }
    return { commit, worktreeFingerprint };
}

function enforceConfiguredCleanAttemptAdmission()
{
    try
    {
        requireCleanAttemptConsumerAdmission({
            consumerId: 'browser-contract',
            repositoryRoot: root
        });
    }
    catch (error)
    {
        throw new BrowserContractFailure(error.message, 'contract');
    }
}

async function verifyImmutableBuild(sourceState)
{
    if (!existsSync(buildReceiptFile))
    {
        throw new BrowserContractFailure(`immutable production build receipt is missing: ${relative(buildReceiptFile)}`, 'contract');
    }
    const result = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(buildReceiptFile),
        receiptFile: path.basename(buildReceiptFile),
        expectedSourceState: sourceState,
        repairReadOnlySeal: false
    });
    const requiredDomains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'];
    const domains = new Set(result.receipt.domains.map((domain) => domain.name));
    const missingDomains = requiredDomains.filter((domain) => !domains.has(domain));
    if (missingDomains.length > 0)
    {
        throw new BrowserContractFailure(
            `immutable production build is missing browser contract domains: ${missingDomains.join(', ')}`,
            'contract'
        );
    }
    return {
        receipt: relative(buildReceiptFile),
        receiptContentDigest: result.receipt.contentDigest,
        sourceState: result.receipt.sourceState,
        profile: result.receipt.build?.profile ?? null,
        domains: requiredDomains,
        artifactCount: result.evidence.artifactCount,
        artifactBytes: result.evidence.artifactBytes,
        verifiedAt: result.evidence.verifiedAt
    };
}

async function loadManagedPlaywright()
{
    const plan = createCorrectnessBrowserPlan({
        browserName: 'chromium',
        evidenceClass: 'browser-contract',
        locale: temporalContext.uiLocale,
        frontendRoot,
        env: process.env
    });
    return {
        chromium: plan.browserType,
        plan,
        metadata: {
            package: '@playwright/test',
            version: plan.playwright.version,
            chromiumRevision: plan.revision,
            chromiumVersion: null,
            executableName: path.basename(plan.executablePath),
            managedExecutable: true,
            browserIdentity: {
                plan: serializableBrowserPlan(plan),
                actual: null
            }
        }
    };
}

function contextOptions(scenario, fixture, rendering)
{
    const storageState = scenario.role === 'user'
        ? fixture.user.storageState
        : scenario.role === 'admin' ? fixture.admin.storageState : undefined;
    return {
        baseURL: fixture.baseUrl,
        ...(storageState ? { storageState } : {}),
        serviceWorkers: scenario.serviceWorkers,
        viewport: { width: 1280, height: 800 },
        colorScheme: rendering.colorScheme,
        locale: rendering.locale,
        deviceScaleFactor: rendering.deviceScaleFactor,
        timezoneId: temporalContext.timezone,
        userAgent: `FsusBlog-Release-Browser-Contract/${scenario.id}`,
        extraHTTPHeaders: fixture.testSession
            ? { 'X-Fsus-Test-Session': fixture.testSession }
            : {}
    };
}

async function captureFailureScreenshot(page, scenarioId)
{
    const file = path.join(screenshotRoot, `${scenarioId}.png`);
    await preparePrivateDirectory(path.dirname(file));
    await page.screenshot({ path: file, fullPage: false, timeout: 5_000 });
    await chmod(file, 0o600);
    return relative(file);
}

function requestTermination(signal)
{
    if (receivedSignal)
    {
        return;
    }
    receivedSignal = signal;
    browserDisconnected = true;
    terminationController.abort(new Error(`browser contract terminated by ${signal}`));
    browser?.close().catch(() =>
    {});
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
{
    process.once('SIGTERM', () => requestTermination('SIGTERM'));
    process.once('SIGINT', () => requestTermination('SIGINT'));
}

async function main()
{
    const sourceState = expectedSourceState();
    const build = await verifyImmutableBuild(sourceState);
    temporalContext = loadTemporalContext();
    await resetRunOutput();
    if (process.env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE !== 'browser-contract')
    {
        throw new BrowserContractFailure(
            'Browser Contract requires FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-contract',
            'contract'
        );
    }
    verifiedBuild = build;
    const plannedIdentity = resolveBrowserContractRunIdentity({
        env: process.env,
        sourceState: build.sourceState,
        repoRoot: root,
        now: startedAtEpochMs
    });
    plannedRunIdentity = plannedIdentity;
    const runningReceipt = createBrowserContractReceipt({
        sourceState: build.sourceState,
        build,
        fixture: {
            namespace: plannedIdentity.namespace,
            lifecycle: {
                identity: {
                    commit: plannedIdentity.commit,
                    runId: plannedIdentity.runId,
                    laneId: plannedIdentity.laneId,
                    namespace: plannedIdentity.namespace
                },
                status: 'preparing'
            }
        },
        startedAt: new Date(startedAtEpochMs).toISOString()
    });
    await writeAuditedBrowserContractReceipt(receiptFile, runningReceipt);
    preparedFixture = await prepareSingleBrowserContractFixture({
        env: process.env,
        repoRoot: root,
        sourceState: build.sourceState,
        build,
        signal: terminationController.signal,
        now: startedAtEpochMs
    });
    const runOutputRoot = path.join(outputRoot, 'runs', preparedFixture.identity.namespace);
    traceRoot = path.join(runOutputRoot, 'traces');
    screenshotRoot = path.join(runOutputRoot, 'screenshots');
    await preparePrivateDirectory(traceRoot);
    await preparePrivateDirectory(screenshotRoot);
    const fixtureEnv = {
        ...process.env,
        FSUSBLOG_FIXTURE_ROOT: preparedFixture.root,
        FSUSBLOG_TEST_NAMESPACE: preparedFixture.identity.namespace,
        FSUSBLOG_TEST_SESSION: preparedFixture.identity.namespace
    };
    const fixture = await loadBrowserContractFixture({
        env: fixtureEnv,
        repoRoot: root,
        fixtureRoot: preparedFixture.root,
        lifecycle: preparedFixture.lifecycle,
        expectedSourceState: build.sourceState,
        expectedBuild: build
    });
    const localeMatrix = await createPublicShellLocaleMatrix(root);
    const localeHarness = await admitPublicShellLocaleHarness({
        root,
        matrix: localeMatrix,
        prepared: preparedFixture,
        buildReceiptFile,
        env: fixtureEnv
    });
    const localeAuthoritySnapshot = await snapshotPublicShellLocaleAuthority(localeMatrix, preparedFixture);
    const selectedScenarios = selectBrowserContractScenarios(fixture.capabilities);
    const managed = await loadManagedPlaywright();
    const receipt = createBrowserContractReceipt({
        sourceState: build.sourceState,
        build,
        fixture: fixtureReceiptView(fixture, root),
        playwright: managed.metadata,
        scenarios: selectedScenarios
    });
    const productFailures = [];
    let primaryOutcome = null;
    let localeRootBinding = null;
    const localeOriginalRefs = [];
    const retainLocaleFailure = (error) =>
    {
        const localeError = {
            ...serializeBrowserContractError(error),
            failureClass: 'contract'
        };
        receipt.publicShellLocaleError = localeError;
        // A later locale/ledger failure never replaces the first product,
        // contract, infra or signal failure, and cleanup still executes.
        if (primaryOutcome?.status === 'success')
        {
            primaryOutcome = { status: 'failure', classification: 'contract', error: localeError };
        }
    };

    try
    {
        assertLocaleRootActive();
        const localeRuntimeBindings = await admitPublicShellLocaleRuntimeBindings({
            root, matrix: localeMatrix, harness: localeHarness, buildReceiptFile
        });
        receipt.topology.browserLaunchCount = 1;
        browser = await managed.chromium.launch(structuredClone(managed.plan.launchOptions));
        assertLocaleRootActive();
        receipt.topology.maxConcurrentBrowserRoots = 1;
        receipt.playwright.chromiumVersion = browser.version();
        receipt.playwright.browserIdentity.actual = observeCorrectnessBrowser({
            plan: managed.plan,
            browser,
            launchOptions: managed.plan.launchOptions,
            rendering: managed.plan.rendering
        });
        browser.on('disconnected', () =>
        {
            if (!closingBrowser)
            {
                browserDisconnected = true;
            }
        });

        for (const scenario of selectedScenarios)
        {
            if (receivedSignal)
            {
                throw new BrowserContractFailure(`browser contract terminated by ${receivedSignal}`, 'infra');
            }
            const runner = browserContractScenarioRunners[scenario.id];
            if (typeof runner !== 'function')
            {
                throw new BrowserContractFailure(`browser contract scenario runner is missing: ${scenario.id}`, 'contract');
            }

            const scenarioReceipt = receipt.scenarios.find((entry) => entry.id === scenario.id);
            const scenarioStartedAtMs = performance.now();
            scenarioReceipt.status = 'running';
            scenarioReceipt.startedAt = new Date().toISOString();
            activeScenario = scenarioReceipt;
            let context = null;
            let page = null;
            let audit = null;
            let localeProbe = null;
            let localeProbeOriginalRef = null;
            // Playwright traces serialize BrowserContext options and raw network
            // headers. Only the explicit anonymous allowlist may retain that raw
            // evidence; every authenticated or future role remains fail closed.
            const mayRetainRawTrace = scenario.role === 'anonymous';
            const traceFile = path.join(traceRoot, `${scenario.id}.zip`);
            try
            {
                context = await browser.newContext(contextOptions(scenario, fixture, managed.plan.rendering));
                receipt.topology.contextCount += 1;
                if (mayRetainRawTrace)
                {
                    await context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: scenario.id });
                }
                page = await context.newPage();
                if (browserTemporalObservation === null)
                {
                    const renderingObservation = await observeBrowserRendering(page);
                    receipt.playwright.browserIdentity.actual = bindBrowserRenderingObservation(
                        managed.plan,
                        receipt.playwright.browserIdentity.actual,
                        renderingObservation
                    );
                    const browserObservation = await page.evaluate(() => ({
                        locale: navigator.language,
                        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone
                    }));
                    const runtimeObservation =
                        preparedFixture.lifecycle?.runtime?.temporalObservation;
                    if (!runtimeObservation)
                    {
                        throw new BrowserContractFailure(
                            'browser contract backend/PostgreSQL temporal observation is missing',
                            'contract'
                        );
                    }
                    browserTemporalObservation = observeBrowserTemporalContext(
                        temporalContext,
                        {
                            ...runtimeObservation,
                            locale: browserObservation.locale,
                            timezoneId: browserObservation.timezoneId,
                            nodeTimezone: process.env.TZ
                        }
                    );
                    localeRootBinding = await freezePublicShellLocaleRootBinding(
                        localeMatrix, preparedFixture, localeAuthoritySnapshot,
                        serializableBrowserPlan(managed.plan), receipt.playwright.browserIdentity.actual
                    );
                    receipt.publicShellLocaleRootBinding = {
                        artifact: localeRootBinding.artifact,
                        digest: localeRootBinding.digest
                    };
                }
                page.setDefaultTimeout(browserContractAppReadyTimeoutMs);
                page.setDefaultNavigationTimeout(browserContractAppReadyTimeoutMs);
                audit = createPageAudit(page);
                if (scenario.id === 'public-hydration-history-reload')
                {
                    localeProbe = observePublicShellLocaleProbe(page, localeHarness.identity, {
                        signal: terminationController.signal,
                        matrix: localeMatrix,
                        async saveOriginalResponse(originals)
                        {
                            assertLocaleRootActive();
                            if (!localeRootBinding || JSON.stringify(originals.identity) !== JSON.stringify(localeHarness.identity))
                            {
                                throw new BrowserContractFailure('locale probe lacks its current Root binding', 'contract');
                            }
                            const bindingFile = path.join(root, localeRootBinding.artifact);
                            const binding = readPrivateJson(bindingFile, { label: 'locale probe Root binding' });
                            if (binding.contentDigest !== localeRootBinding.digest)
                            {
                                throw new BrowserContractFailure('locale probe Root bytes changed after launch', 'contract');
                            }
                            const target = assertRunOwnedPath(path.join(localeAuthoritySnapshot.directory,
                                'public-shell-locale-probe-original.json'), 'locale probe original response');
                            if (existsSync(target))
                            {
                                throw new BrowserContractFailure('locale probe original response is already frozen', 'contract');
                            }
                            await preparePrivateDirectory(path.dirname(target));
                            assertLocaleRootActive();
                            const published = writePrivateJson(target, {
                                evidenceKind: 'diagnostic-probe', qualificationEligible: false,
                                rootBinding: receipt.publicShellLocaleRootBinding,
                                identity: derivePublicShellLocaleRootIdentity(localeMatrix, binding.document),
                                scenarioId: scenario.id, originals
                            }, { label: 'locale probe original response', overwrite: false });
                            localeProbeOriginalRef = { artifact: relative(target), digest: published.contentDigest };
                            scenarioReceipt.artifacts.push(relative(target));
                            assertLocaleRootActive();
                            if (sha256File(bindingFile) !== localeRootBinding.digest)
                            {
                                throw new BrowserContractFailure('locale probe Root changed during private publication', 'contract');
                            }
                        }
                    });
                }
                await runner({ browser, context, page, fixture, audit, scenario, outputRoot });
                if (localeProbe)
                {
                    const observation = await localeProbe.finish();
                    const probeFile = path.join(runOutputRoot, 'public-shell-locale-probe.json');
                    const probeBindingFile = path.join(runOutputRoot, 'public-shell-locale-probe-binding.json');
                    await writeBrowserContractReceipt(probeFile, observation);
                    await writeBrowserContractReceipt(probeBindingFile, {
                        schema: 'fsusblog.public-shell-locale-probe-binding.v1',
                        evidenceKind: 'diagnostic-probe',
                        qualificationEligible: false,
                        identity: localeHarness.identity,
                        artifact: relative(probeFile),
                        digest: sha256File(probeFile),
                        originalResponse: localeProbeOriginalRef
                    });
                    scenarioReceipt.artifacts.push(relative(probeFile), relative(probeBindingFile));
                }
                if (browserDisconnected)
                {
                    throw new BrowserContractFailure('Chromium disconnected during the release browser contract', 'infra');
                }
                scenarioReceipt.status = 'success';
                scenarioReceipt.classification = 'clean';
            }
            catch (error)
            {
                scenarioReceipt.status = 'failure';
                scenarioReceipt.classification = classifyBrowserContractFailure(error, { browserDisconnected });
                scenarioReceipt.error = {
                    ...serializeBrowserContractError(error),
                    failureClass: scenarioReceipt.classification
                };
                if (page && !page.isClosed())
                {
                    const screenshot = await captureFailureScreenshot(page, scenario.id).catch(() => null);
                    if (screenshot)
                    {
                        scenarioReceipt.artifacts.push(screenshot);
                    }
                }
                if (scenarioReceipt.classification === 'product')
                {
                    productFailures.push({
                        scenario: scenario.id,
                        error: scenarioReceipt.error
                    });
                }
                else
                {
                    throw error;
                }
            }
            finally
            {
                let retainedProbeOriginal = false;
                let probeRetentionFailed = false;
                const retainAvailableProbeOriginal = async () =>
                {
                    if (!localeProbe || retainedProbeOriginal || probeRetentionFailed)
                    {
                        return;
                    }
                    try
                    {
                        retainedProbeOriginal = await localeProbe.saveAvailableOriginal();
                    }
                    catch
                    {
                        // Preserve the scenario's first error; never serialize private sink error text.
                        probeRetentionFailed = true;
                    }
                };
                await retainAvailableProbeOriginal();
                localeProbe?.dispose();
                scenarioReceipt.issues = audit?.issues ?? [];
                if (context)
                {
                    if (mayRetainRawTrace)
                    {
                        const traced = await context.tracing.stop({ path: traceFile }).then(() => true).catch(() => false);
                        if (traced)
                        {
                            await chmod(traceFile, 0o600);
                            scenarioReceipt.artifacts.push(relative(traceFile));
                        }
                    }
                    await context.close().catch(() =>
                    {});
                }
                // Closing the context may settle the original, already-started body read.
                await retainAvailableProbeOriginal();
                if (localeProbe && !retainedProbeOriginal)
                {
                    scenarioReceipt.issues.push({
                        kind: 'locale-probe-original-retention-failed',
                        detail: probeRetentionFailed ? 'Private original response retention failed.'
                            : 'Original response capture was not available at scenario cleanup.',
                        expected: false,
                        at: new Date().toISOString()
                    });
                }
                scenarioReceipt.finishedAt = new Date().toISOString();
                scenarioReceipt.durationMs = performance.now() - scenarioStartedAtMs;
                activeScenario = null;
            }
        }

        if (productFailures.length > 0)
        {
            throw new BrowserContractFailure(
                `${productFailures.length} browser contract product scenario(s) failed`,
                'product',
                { failures: productFailures }
            );
        }

        await runPublicShellLocaleScenes({ browser, matrix: localeMatrix, harness: localeHarness,
            bindings: localeRuntimeBindings, rootBinding: localeRootBinding,
            retainOriginal: (ref) => localeOriginalRefs.push(ref) });

        const publicPreviewStaging = path.join(runOutputRoot, 'public-preview-docs');
        const publicPreviewOperations = await import(pathToFileURL(
            path.join(root, 'tools/docs/public-preview-screenshots.mjs')
        ).href);
        const publicPreviewEvidenceFile = path.join(root, '.tmp/release-evidence/public-preview-screenshots.json');
        const publicPreview = await capturePublicPreviewGallery({
            browser,
            fixture,
            sourceCommit: build.sourceState.commit,
            stagingDirectory: publicPreviewStaging,
            evidenceFile: publicPreviewEvidenceFile,
            timeoutMs: browserContractAppReadyTimeoutMs,
            operations: publicPreviewOperations
        });
        receipt.publicPreview = {
            ...publicPreview,
            captureContextCount: Object.keys(publicPreview.images).length,
            evidencePath: relative(publicPreviewEvidenceFile),
            evidenceFileDigest: sha256File(publicPreviewEvidenceFile)
        };

        enforceConfiguredCleanAttemptAdmission();

        closingBrowser = true;
        await browser.close();
        browser = null;
        if (browserDisconnected && !receivedSignal)
        {
            throw new BrowserContractFailure('Chromium disconnected before contract completion', 'infra');
        }
        primaryOutcome = { status: 'success', classification: 'clean', error: null };
    }
    catch (error)
    {
        const classification = classifyBrowserContractFailure(error, { browserDisconnected });
        primaryOutcome = {
            status: 'failure',
            classification,
            error: {
                ...serializeBrowserContractError(error),
                failureClass: classification,
                activeScenario: activeScenario?.id ?? null,
                signal: receivedSignal
            }
        };
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { receipt });
    }
    finally
    {
        if (browser)
        {
            closingBrowser = true;
            await browser.close().catch(() =>
            {});
            browser = null;
        }
        // Read the fixture owner's actual ledger before cleanup removes it. A
        // diagnostic probe does not create scene leases or qualify the matrix.
        try
        {
            const { bindings, reference } = await retainPublicShellLocaleSceneLedger({ fixtureRoot: preparedFixture.root,
                outputDirectory: runOutputRoot, rootBinding: localeRootBinding, matrix: localeMatrix, originals: localeOriginalRefs });
            const identity = preparedFixture.identity;
            receipt.topology.publicShellLocale = projectBrowserContractLocaleTopology({
                matrix: localeMatrix,
                bindings,
                expectedOwner: {
                    identity: preparedFixture.lifecycle.identity,
                    preparation: preparedFixture.preparation,
                    sourceState: preparedFixture.sourceState,
                    buildDigest: preparedFixture.build.receiptContentDigest,
                    fixtureRoot: preparedFixture.root,
                    resources: {
                        databaseSchema: identity.databaseSchema,
                        databaseInstance: identity.databaseInstance,
                        redisNamespace: identity.redisNamespace,
                        redisInstance: identity.redisInstance,
                        fixtureRoot: identity.fixtureRoot
                    }
                }
            });
            if (bindings)
            {
                receipt.publicShellLocaleBinding = reference;
            }
            const errors = validateBrowserContractLocaleTopology(receipt.topology.publicShellLocale, {
                requireSuccess: primaryOutcome?.status === 'success'
            });
            if (errors.length > 0)
            {
                retainLocaleFailure(new BrowserContractFailure(
                    'PublicShell locale scene closure is incomplete', 'contract', { errors }
                ));
            }
        }
        catch (error)
        {
            retainLocaleFailure(error);
        }
        const cleanup = await cleanupSingleBrowserContractFixture(preparedFixture, {
            retainRejection: true,
            reason: receivedSignal
                ? `signal:${receivedSignal}`
                : primaryOutcome?.status === 'success' ? 'success' : 'failure'
        });
        finalizeBrowserContractReceipt(receipt, {
            primary: primaryOutcome ?? {
                status: 'failure',
                classification: 'contract',
                error: {
                    name: 'BrowserContractFailure',
                    message: 'browser contract ended without a primary outcome',
                    failureClass: 'contract',
                    details: null,
                    stack: null,
                    activeScenario: activeScenario?.id ?? null,
                    signal: receivedSignal
                }
            },
            cleanup,
            signal: receivedSignal,
            finishedAt: new Date().toISOString(),
            wallClockMs: performance.now() - startedAtMonotonicMs
        });
        if (browserTemporalObservation)
        {
            const temporal = bindCorrectnessProducerTemporalArtifacts({
                producerId: 'comment-moderation',
                contextInput: temporalContext,
                observations: browserTemporalObservation,
                outcome: receipt,
                generatedAt: receipt.finishedAt
            });
            receipt.temporalBinding = {
                plan: temporal.plan,
                actual: temporal.actual,
                receipt: temporal.receipt,
                bindingDigest: temporal.bindingDigest
            };
        }
        await persistFinalBrowserContractReceipt(
            receipt,
            (terminalReceipt) => writeAuditedBrowserContractReceipt(receiptFile, terminalReceipt)
        );
    }
    if (receipt.status !== 'success')
    {
        throw Object.assign(new BrowserContractFailure(
            receipt.error?.message ?? 'browser contract failed',
            receipt.classification ?? 'contract',
            receipt.error?.details ?? null
        ), { receipt });
    }
    return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
{
    main()
        .then((receipt) =>
        {
            console.log(
                `[browser-contract] ok scenarios=${receipt.scenarios.length} browserLaunches=${receipt.topology.browserLaunchCount} contexts=${receipt.topology.contextCount} wallMs=${receipt.wallClockMs} receipt=${relative(receiptFile)}`
            );
        })
        .catch(async (error) =>
        {
            const receipt = error?.receipt;
            if (!receipt)
            {
                const primaryClassification = classifyBrowserContractFailure(error, { browserDisconnected });
                const primaryError = serializeBrowserContractError(error);
                const startupPreparedFixture = preparedFixture ?? error?.preparedFixture ?? null;
                const cleanupAttempts = [];
                let cleanup = error?.cleanup ?? null;
                if (cleanup)
                {
                    cleanupAttempts.push(snapshotReceiptEvidence(cleanup));
                }
                if (!cleanup && startupPreparedFixture)
                {
                    cleanup = await cleanupSingleBrowserContractFixture(startupPreparedFixture, {
                        reason: receivedSignal ? `signal:${receivedSignal}` : 'startup-failure',
                        retainRejection: true
                    });
                    cleanupAttempts.push(snapshotReceiptEvidence(cleanup));
                }
                if (cleanup?.status === 'failure' && startupPreparedFixture)
                {
                    cleanup = await cleanupSingleBrowserContractFixture(startupPreparedFixture, {
                        reason: receivedSignal ? `signal:${receivedSignal}:retry` : 'startup-failure-retry',
                        retainRejection: true
                    });
                    cleanupAttempts.push(snapshotReceiptEvidence(cleanup));
                }
                const lifecycle = startupPreparedFixture?.lifecycle
        ?? error?.fixtureLifecycle
        ?? (plannedRunIdentity
            ? {
              status: 'startup-failure',
              identity: {
                commit: plannedRunIdentity.commit,
                runId: plannedRunIdentity.runId,
                laneId: plannedRunIdentity.laneId,
                namespace: plannedRunIdentity.namespace
              }
            }
            : null);
                const fallbackFixture = {
                    namespace: lifecycle?.identity?.namespace ?? null,
                    lifecycle,
                    cleanup,
                    cleanupAttempts
                };
                const fallback = createBrowserContractReceipt({
                    sourceState: verifiedBuild?.sourceState ?? null,
                    build: verifiedBuild,
                    fixture: fallbackFixture,
                    startedAt: new Date(startedAtEpochMs).toISOString()
                });
                finalizeBrowserContractReceipt(fallback, {
                    primary: {
                        status: 'failure',
                        classification: primaryClassification,
                        error: {
                            ...primaryError,
                            failureClass: primaryClassification,
                            signal: receivedSignal
                        }
                    },
                    cleanup,
                    cleanupAttempts,
                    signal: receivedSignal,
                    finishedAt: new Date().toISOString(),
                    wallClockMs: performance.now() - startedAtMonotonicMs
                });
                if (outputValidated)
                {
                    await persistFinalBrowserContractReceipt(
                        fallback,
                        (terminalReceipt) => writeAuditedBrowserContractReceipt(receiptFile, terminalReceipt)
                    ).catch((persistenceError) =>
                    {
                        console.error(`[browser-contract] contract failure: ${persistenceError.message}`);
                    });
                }
            }
            console.error(`[browser-contract] ${classifyBrowserContractFailure(error, { browserDisconnected })} failure: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        });
}
