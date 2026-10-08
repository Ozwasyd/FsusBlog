#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
    compactPublicShellLocaleScene,
    derivePublicShellLocaleRootIdentity,
    PublicShellLocaleEvidenceError,
    publicShellLocaleCoverage,
    validatePublicShellLocaleSubResults
} from './public-shell-locale-evidence.mjs';
import {
    gateDigest,
    loadPublicShellLocaleGate,
    publicShellLocaleQualificationSchema,
    publicShellLocaleSubResultsSchema,
    resolveGatePath,
    verifyPublicShellLocaleBuild
} from './public-shell-locale-gate.mjs';

const { readPrivateFile } = await import(new URL('../test-fixtures/receipt/private-io.mjs', import.meta.url));
const { originalBrowserRecordLimits, originalCaptureLimits, validatePublicShellLocaleOriginalCaptureLimits } = await import(new URL('../../tests/browser-contract/public-shell-locale-lifecycle-evidence.mjs', import.meta.url));
const { projectBrowserContractLocaleTopology } = await import(new URL('../release/browser-contract-receipt-contract.mjs', import.meta.url));

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultReceipt = '.tmp/browser-evidence/public-shell-locale.json';

function callerRootFailure(message)
{
    throw new PublicShellLocaleEvidenceError(`PublicShell locale caller Root ${message}`, { code: 'caller-root' });
}

function callerEqual(actual, expected, label)
{
    if (!isDeepStrictEqual(actual, expected))
    {
        callerRootFailure(`${label} mismatch`);
    }
}

function readCallerArtifact(root, ref, prefix)
{
    const artifact = ref?.artifact;
    if (!ref || Object.keys(ref).sort().join(',') !== 'artifact,digest'
        || typeof artifact !== 'string' || !artifact.startsWith(prefix) || artifact.length === prefix.length
        || artifact.includes('\\') || artifact.includes('\0')
        || artifact.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    {
        callerRootFailure('ref is missing or is not a canonical current owned path');
    }
    const digest = typeof ref.digest === 'string' ? ref.digest.replace(/^sha256:/u, '') : '';
    if (!/^[a-f0-9]{64}$/u.test(digest))
    {
        callerRootFailure('ref digest is invalid');
    }
    const target = assertRawRefPath(root, artifact);
    const before = lstatSync(target);
    const { bytes } = readPrivateFile(target, { label: 'PublicShell locale caller Root ref' });
    assertRawRefPath(root, artifact);
    const after = lstatSync(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size)
    {
        callerRootFailure('ref changed during verification');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
    {
        callerRootFailure('ref digest mismatch');
    }
    return { target, bytes };
}

async function readCallerParent({ root, matrix, buildDigest, browserReceiptFile })
{
    const target = resolveGatePath(root, browserReceiptFile, 'current Browser Contract parent receipt');
    const artifact = path.relative(root, target).replaceAll(path.sep, '/');
    assertRawRefPath(root, artifact);
    const before = lstatSync(target);
    const { bytes } = readPrivateFile(target, { label: 'current Browser Contract parent receipt' });
    const after = lstatSync(assertRawRefPath(root, artifact));
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size)
    {
        callerRootFailure('parent changed during verification');
    }
    const parent = JSON.parse(bytes.toString('utf8'));
    const { validateBrowserContractReceipt } = await import(new URL('../release/browser-contract-receipt-contract.mjs', import.meta.url));
    const errors = validateBrowserContractReceipt(parent, {
        expectedCommit: matrix.identity.sourceCommit,
        expectedFingerprint: matrix.identity.worktreeFingerprint,
        expectedBuildReceiptDigest: buildDigest,
        requireSuccess: false
    });
    if (errors.length)
    {
        callerRootFailure('current parent validation failed');
    }
    const fixture = parent.fixture;
    const fixtureRoot = resolveGatePath(root, fixture?.root ?? '', 'current fixture root');
    return {
        parent, ref: parent.publicShellLocaleRootBinding,
        original: { artifact, digest: createHash('sha256').update(bytes).digest('hex'), bytes },
        owner: {
            identity: parent.runIdentity,
            preparation: fixture?.preparation,
            sourceState: parent.sourceState,
            buildDigest,
            fixtureRoot,
            resources: {
                fixtureRoot, databaseInstance: fixture?.databaseInstance, databaseSchema: fixture?.databaseSchema,
                redisInstance: fixture?.redisInstance, redisNamespace: fixture?.redisNamespace
            }
        }
    };
}

/** Reopen current caller-owned originals; successful admission is not stage qualification. */
export async function readPublicShellLocaleCallerRoot({
    root = defaultRoot, matrix, buildDigest, buildReceiptFile,
    callerRootRef = null, callerOwner = null, browserReceiptFile = null,
    fixtureProviderFile = process.env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER
} = {})
{
    root = realpathSync(root);
    let parent = null;
    let parentOriginal = null;
    if (!callerRootRef && browserReceiptFile)
    {
        const loaded = await readCallerParent({ root, matrix, buildDigest, browserReceiptFile });
        callerRootRef = loaded.ref;
        callerOwner = loaded.owner;
        parent = loaded.parent;
        parentOriginal = loaded.original;
    }
    if (!callerRootRef)
    {
        callerRootFailure('ref is required; submitted result identity is not authority');
    }
    if (!callerOwner || Object.keys(callerOwner).sort().join(',')
        !== 'buildDigest,fixtureRoot,identity,preparation,resources,sourceState')
    {
        callerRootFailure('current owner is required');
    }
    const prefix = `.tmp/browser-contract/runs/${callerOwner.identity?.namespace}/bindings/${callerOwner.preparation?.id}/`;
    if (callerRootRef.artifact !== `${prefix}root-binding.json`)
    {
        callerRootFailure('ref does not name the current preparation Root');
    }
    const loadedRoot = readCallerArtifact(root, callerRootRef, prefix);
    const binding = JSON.parse(loadedRoot.bytes.toString('utf8'));
    const identity = derivePublicShellLocaleRootIdentity(matrix, binding);
    for (const field of ['identity', 'preparation', 'sourceState', 'buildDigest', 'resources'])
    {
        callerEqual(binding[field], callerOwner[field], field);
    }
    callerEqual(binding.resources.fixtureRoot, callerOwner.fixtureRoot, 'fixture root');
    callerEqual(binding.buildDigest, buildDigest, 'current build');
    const snapshots = new Map();
    for (const ref of binding.refs)
    {
        snapshots.set(ref.role, readCallerArtifact(root, { artifact: ref.path, digest: ref.digest }, prefix));
    }
    const configuredProvider = fixtureProviderFile ? path.resolve(root, fixtureProviderFile) : null;
    const defaultProvider = path.join(root, 'tests/browser-contract/default-fixture-provider.mjs');
    if (configuredProvider !== defaultProvider || realpathSync(defaultProvider) !== defaultProvider)
    {
        callerRootFailure('configured provider has no supported snapshot validator');
    }
    const { validatePublicShellLocaleMatrix } = await import(new URL('../../tests/browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
    await validatePublicShellLocaleMatrix(matrix, root);
    const { verifyProductionBuildReceipt } = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
    if (!buildReceiptFile)
    {
        callerRootFailure('current immutable build receipt is required');
    }
    const buildFile = resolveGatePath(root, buildReceiptFile, 'current immutable build receipt');
    const admittedBuild = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(buildFile), receiptFile: path.basename(buildFile),
        expectedSourceState: callerOwner.sourceState, expectedReceiptDigest: buildDigest, repairReadOnlySeal: false
    }).receipt;
    const json = role => JSON.parse(snapshots.get(role).bytes.toString('utf8'));
    callerEqual(json('build-receipt'), admittedBuild, 'original build receipt');
    const request = {
        identity: callerOwner.identity, preparation: callerOwner.preparation,
        sourceState: callerOwner.sourceState, resources: callerOwner.resources,
        build: { receiptContentDigest: buildDigest }
    };
    const { validateDefaultFixtureProviderState } = await import(new URL('../../tests/browser-contract/default-fixture-provider.mjs', import.meta.url));
    const state = validateDefaultFixtureProviderState(json('provider-state'), request);
    callerEqual(state.phase, 'prepared', 'provider phase');
    callerEqual(state.runtimeRunId, binding.runtimeId, 'runtime');
    const { readSealedBrowserContractFixture } = await import(new URL('../../tests/browser-contract/fixture-lifecycle.mjs', import.meta.url));
    const manifest = await readSealedBrowserContractFixture(snapshots.get('fixture-manifest').target);
    for (const field of ['identity', 'preparation', 'sourceState'])
    {
        callerEqual(manifest[field], callerOwner[field], `manifest ${field}`);
    }
    callerEqual(manifest.buildIdentity?.receiptContentDigest, buildDigest, 'manifest build');
    callerEqual(manifest.transport?.testSessionHeader, false, 'manifest transport');
    callerEqual(manifest.baseUrl, state.runtime?.frontendUrl, 'frontend runtime');
    callerEqual(manifest.backendUrl, state.runtime?.backendUrl, 'backend runtime');
    for (const url of [manifest.baseUrl, manifest.backendUrl])
    {
        if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u.test(url))
        {
            callerRootFailure('runtime URL is not the dedicated current runtime');
        }
    }
    const { readFixtureReceipt } = await import(new URL('../test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
    const fixture = readFixtureReceipt(snapshots.get('fixture-receipt').target, { requireVerified: true });
    callerEqual(fixture.receiptDigest, binding.fixtureReceiptDigest, 'fixture seal');
    callerEqual(fixture.executionIdentity?.runId, binding.runtimeId, 'fixture runtime');
    callerEqual(fixture.executionIdentity?.namespace, binding.identity.namespace, 'fixture namespace');
    callerEqual(fixture.executionIdentity?.source, binding.sourceState, 'fixture source');
    for (const field of ['databaseInstance', 'databaseSchema', 'redisInstance', 'redisNamespace'])
    {
        callerEqual(fixture.serviceIdentity?.[field], binding.resources[field], `fixture ${field}`);
    }
    const prepared = json('prepare-state');
    const { plan } = await import(new URL('../test-fixtures/orchestrator.mjs', import.meta.url));
    callerEqual(prepared.plan, plan(prepared.plan?.profileIdentity, prepared.plan?.executionIdentity), 'current preparation plan');
    callerEqual(prepared.plan.executionIdentity?.runId, binding.runtimeId, 'preparation runtime');
    callerEqual(prepared.plan.executionIdentity?.namespace, binding.identity.namespace, 'preparation namespace');
    callerEqual(prepared.plan.executionIdentity?.sourceIdentity, binding.sourceState, 'preparation source');
    callerEqual(prepared.plan.profileIdentity?.profileId, fixture.profileIdentity?.profileId, 'preparation profile');
    callerEqual(prepared.catalogDigest, fixture.catalogDigest, 'preparation catalog');
    const { projectPreparedPublicIds } = await import(new URL('../test-fixtures/receipt/prepared-public-projection-contract.mjs', import.meta.url));
    const projection = projectPreparedPublicIds(prepared);
    callerEqual(projection.articleId, String(manifest.entities?.publicArticle?.id), 'prepared article');
    callerEqual(projection.categoryId, String(manifest.entities?.category?.id), 'prepared category');
    const cookieFile = path.join(root, 'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs');
    assertRawRefPath(root, path.relative(root, cookieFile));
    const cookieBytes = await readFile(cookieFile);
    callerEqual(snapshots.get('cookie-source').bytes, cookieBytes, 'current cookie source');
    callerEqual(json('browser-plan'), binding.plan, 'original browser plan');
    callerEqual(json('browser-actual'), binding.actual, 'original browser actual');
    const { createCorrectnessBrowserPlan, serializableBrowserPlan, assertBrowserPlanActualMatch,
        assertBrowserRenderingObservation } = await import(new URL('../test/playwright-browser-identity.mjs', import.meta.url));
    const currentPlanOptions = {
        browserName: binding.plan.browserName, evidenceClass: 'browser-contract', locale: binding.plan.rendering.locale,
        repoRoot: root, frontendRoot: path.join(root, 'src/frontend')
    };
    const base = createCorrectnessBrowserPlan(currentPlanOptions);
    const args = new Set(base.launchOptions.args);
    const currentPlan = createCorrectnessBrowserPlan({
        ...currentPlanOptions, additionalLaunchArgs: binding.plan.launchOptions.args.filter(argument => !args.has(argument))
    });
    callerEqual(serializableBrowserPlan(currentPlan), binding.plan, 'current managed browser plan');
    assertBrowserPlanActualMatch(binding.plan, binding.actual);
    assertBrowserRenderingObservation(binding.plan, binding.actual.renderingObservation);
    if (parent)
    {
        callerEqual(parent.playwright?.browserIdentity?.plan, binding.plan, 'parent browser plan');
        callerEqual(parent.playwright?.browserIdentity?.actual, binding.actual, 'parent browser actual');
        callerEqual(readCallerArtifact(root, {
            artifact: parentOriginal.artifact, digest: parentOriginal.digest
        }, `${path.posix.dirname(parentOriginal.artifact)}/`).bytes,
        parentOriginal.bytes, 'parent bytes after validation');
    }
    callerEqual(readCallerArtifact(root, callerRootRef, prefix).bytes, loadedRoot.bytes, 'Root bytes after validation');
    for (const ref of binding.refs)
    {
        callerEqual(readCallerArtifact(root, { artifact: ref.path, digest: ref.digest }, prefix).bytes,
            snapshots.get(ref.role).bytes, 'original bytes after validation');
    }
    return { identity, binding, callerRootRef, callerOwner, qualificationEligible: false };
}

/** Root admission and intact raw bytes cannot substitute for the pending native causal layer. */
export function requirePublicShellLocaleCausalVerification()
{
    throw new PublicShellLocaleEvidenceError('PublicShell locale native causal verification is not observed', {
        code: 'native-causal-not-observed'
    });
}

function originalAssert(condition, message)
{
    if (!condition)
    {
        throw new PublicShellLocaleEvidenceError(`PublicShell locale scene original ${message}`, { code: 'scene-original' });
    }
}

function originalKeys(value, keys)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

// Derived retention ceiling, not a new capture policy or a transport allocation guarantee.
const originalFileBytes = Math.ceil(originalCaptureLimits.totalBytes * 4 / 3)
    + originalCaptureLimits.leaves * (originalCaptureLimits.headerBytes * 6 + originalCaptureLimits.stringBytes * 16)
    + originalCaptureLimits.totalBytes * 6;

/** Bounded private I/O only; this exported boundary admits neither a caller nor browser facts. */
export function readPublicShellLocaleSceneOriginalArtifact({ root, ref, prefix, remainingBytes = originalFileBytes })
{
    root = realpathSync(root);
    originalAssert(Number.isSafeInteger(remainingBytes) && remainingBytes >= 0 && remainingBytes <= originalFileBytes,
        'remaining file byte budget invalid');
    originalAssert(originalKeys(ref, ['path', 'digest']) && typeof prefix === 'string'
        && prefix.startsWith('.tmp/browser-contract/runs/') && prefix.endsWith('/')
        && !prefix.includes('\\') && !prefix.includes('\0')
        && !prefix.slice(0, -1).split('/').some(part => !part || part === '.' || part === '..')
        && typeof ref.path === 'string' && ref.path.startsWith(prefix) && ref.path.length > prefix.length
        && !ref.path.includes('\\') && !ref.path.includes('\0')
        && !ref.path.split('/').some(part => !part || part === '.' || part === '..')
        && /^sha256:[a-f0-9]{64}$/u.test(ref.digest ?? ''), 'ref is not canonical');
    const target = assertRawRefPath(root, ref.path);
    const ownedDirectory = path.resolve(root, prefix);
    for (let directory = path.dirname(target); directory === ownedDirectory || directory.startsWith(`${ownedDirectory}${path.sep}`); directory = path.dirname(directory))
    {
        originalAssert((lstatSync(directory).mode & 0o777) === 0o700, 'directory is not private');
    }
    const same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink
        && left.mode === right.mode;
    const privateFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= originalFileBytes;
    const before = lstatSync(target);
    originalAssert(privateFile(before), 'file is not bounded private single-link regular data');
    originalAssert(before.size <= remainingBytes, 'combined file byte budget exceeded before allocation');
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try
    {
        const opened = fstatSync(fd);
        originalAssert(privateFile(opened) && same(before, opened), 'inode changed before read');
        originalAssert(opened.size <= remainingBytes, 'combined file byte budget exceeded before allocation');
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length)
        {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            originalAssert(count > 0, 'file was truncated during read');
            offset += count;
        }
        originalAssert(readSync(fd, Buffer.alloc(1), 0, 1, offset) === 0
            && same(opened, fstatSync(fd)) && same(opened, lstatSync(assertRawRefPath(root, ref.path))), 'file changed during read');
        originalAssert(`sha256:${createHash('sha256').update(bytes).digest('hex')}` === ref.digest, 'byte digest mismatch');
        return { bytes, stat: opened };
    }
    finally
    {
        closeSync(fd);
    }
}

/** Preflight the original writer's finite JSON grammar before materializing its object graph.
 * This is not a generic parser/policy: trusted scene/owner/resource shapes come from admission;
 * record/count/byte limits come from the existing collector. No recursive unknown JSON branch exists.
 */
export function parsePublicShellLocaleSceneOriginalJson(bytes, { kind, matrix, caller, runtime = { resources: [] } })
{
    originalAssert(Buffer.isBuffer(bytes) && bytes.length <= originalFileBytes, 'JSON bytes are not bounded');
    const scalar = (maximum = originalBrowserRecordLimits.recordBytes, check = null) => ({ type: 'scalar', maximum, check });
    const object = (fields, required = Object.keys(fields), maximum = null, omitted = []) => ({ type: 'object', fields, required, maximum, omitted });
    const array = (element, maximum, minimum = 0, retainedBytes = null) => ({ type: 'array', element, maximum, minimum, retainedBytes });
    const alternatives = shapes => ({ type: 'alternatives', shapes });
    const nullable = shape => ({ ...shape, nullable: true });
    const templates = values =>
    {
        const nonNull = values.filter(value => value !== null);
        if (!nonNull.length || nonNull.every(value => typeof value !== 'object'))
        {
            return scalar();
        }
        if (nonNull.every(Array.isArray))
        {
            const items = nonNull.flat();
            return { ...array(items.length ? templates(items) : scalar(), Math.max(...nonNull.map(value => value.length))), nullable: values.includes(null) };
        }
        originalAssert(nonNull.every(value => !Array.isArray(value) && typeof value === 'object'), 'trusted JSON templates are incompatible');
        const keys = [...new Set(nonNull.flatMap(Object.keys))];
        return { ...object(Object.fromEntries(keys.map(key => [key, templates(nonNull.filter(value => Object.hasOwn(value, key)).map(value => value[key]))])),
            keys.filter(key => nonNull.every(value => Object.hasOwn(value, key)))), nullable: values.includes(null) };
    };
    const text = scalar(originalCaptureLimits.stringBytes);
    const primitive = scalar();
    const rawIdentity = templates([{ matrixDigest: caller.binding.matrixDigest, sourceState: caller.binding.sourceState,
        buildDigest: caller.binding.buildDigest, namespace: caller.binding.identity.namespace, preparationId: caller.binding.preparation.id }]);
    const authority = object({ matrixDigest: text, runtimeRunId: text, fixtureReceiptDigest: text,
        runtime: object({ frontendUrl: text, backendUrl: text }),
        inputs: object({ viewport: templates(matrix.scenes.map(scene => scene.viewport)), javaScriptEnabled: primitive,
            acceptLanguage: text, cookie: templates(matrix.negotiationCases.map(item => item.cookie)), cookieName: text }),
        rawRefs: array(object({ path: text, digest: text }), caller.binding.refs.filter(ref =>
            ['provider-state', 'fixture-manifest', 'prepare-state', 'fixture-receipt', 'cookie-source'].includes(ref.role)).length) });
    const owner = templates([caller.callerOwner]);
    const leaseFields = { leaseId: text, actorId: text, contextId: text, sceneId: text, role: text, status: text, owner, authority };
    // Failure strings are diagnostic writer fields, not raw capture strings; retain the file ceiling.
    const failureFields = { name: scalar(originalFileBytes), message: scalar(originalFileBytes) };
    const failure = nullable(object(failureFields));
    const header = object({ name: text, value: text });
    const rawLeaf = object({ sequence: primitive, kind: text, source: text, captureState: text,
        requestOrdinal: primitive, parentRequestOrdinal: primitive, invocationOrdinal: primitive,
        method: text, url: text, status: primitive, representation: text, purpose: text,
        headersArray: array(header, originalCaptureLimits.headers), headerRepresentation: text, bodyApplicable: primitive,
        bodyEncoding: text, bodyBase64: scalar(Math.ceil(originalCaptureLimits.totalBytes / 3) * 4),
        byteLength: primitive, byteSha256: text }, ['sequence', 'kind', 'source', 'captureState']);
    const requestFields = { url: primitive, urlDigest: primitive, method: primitive, resourceType: primitive, requestOrdinal: primitive, captureSequence: primitive };
    const derivedResponseFields = ['captureSequence', 'resource', 'contentDigest', 'commandDigest', 'command', 'preference', 'error', 'observationError'];
    const request = object(requestFields, Object.keys(requestFields), originalCaptureLimits.headerBytes, ['captureSequence']);
    const response = object({ ...requestFields, status: primitive, fromServiceWorker: primitive,
        resource: runtime.resources.length ? templates([...runtime.resources, null]) : scalar(), contentDigest: text, commandDigest: text,
        command: object({ mode: text, fixedLocale: text, expectedRevision: primitive }),
        preference: object({ mode: text, fixedLocale: text, revision: primitive, updatedAt: text }),
        error: object({ code: primitive, category: primitive, statusCode: primitive, kind: text,
            messageDigest: text, detailsDigest: text, traceDigest: text }),
        observationError: object({ name: failureFields.name, digest: text }) }, [...Object.keys(requestFields), 'status', 'fromServiceWorker'],
    originalCaptureLimits.headerBytes, derivedResponseFields);
    // DOM array members are the existing readPublicShellLocaleDom returns, not arbitrary recursive JSON.
    const box = object({ x: primitive, y: primitive, width: primitive, height: primitive });
    const domBoolean = scalar(undefined, value => typeof value === 'boolean');
    const domNullableText = nullable(scalar(undefined, value => typeof value === 'string'));
    const dom = object({ language: primitive, direction: primitive, hydrationKind: primitive, hydrated: primitive,
        metadata: object({ title: primitive, description: primitive, openGraphLocale: primitive }),
        copyNodes: array(object({ key: primitive, text: primitive, visible: primitive }), originalBrowserRecordLimits.recordBytes),
        selectors: array(object({ active: primitive, pending: primitive, visible: primitive, expanded: primitive, disabled: domBoolean,
            items: array(object({ code: primitive, selected: primitive, visible: primitive, ariaLabelOrText: primitive,
            nativeName: domNullableText, englishName: domNullableText, direction: domNullableText, disabled: domBoolean }),
                originalBrowserRecordLimits.recordBytes) }), originalBrowserRecordLimits.recordBytes),
        geometry: array(object({ name: primitive, box, visible: primitive, ariaLabelOrText: primitive, fontFamily: primitive }),
            originalBrowserRecordLimits.recordBytes),
        containment: array(array(scalar(originalBrowserRecordLimits.recordBytes, value => typeof value === 'number'), 2, 2), originalBrowserRecordLimits.recordBytes),
        viewport: object({ width: primitive, height: primitive }),
        fonts: nullable(array(object({ family: primitive, weight: primitive, status: primitive }), originalBrowserRecordLimits.recordBytes)) });
    const snapshot = object({ observedAt: primitive, dom });
    const recorder = object({
        frames: array({ ...snapshot, maximum: originalBrowserRecordLimits.recordBytes }, originalBrowserRecordLimits.frames),
        marks: array(object({ name: primitive, startTime: primitive, snapshot: nullable(snapshot) }, undefined,
            originalBrowserRecordLimits.recordBytes), originalBrowserRecordLimits.records),
        events: array(object({ name: primitive, generation: primitive, locale: primitive, level: primitive, from: primitive, to: primitive },
            ['name', 'from', 'to'], originalBrowserRecordLimits.recordBytes), originalBrowserRecordLimits.records),
        errors: array(object({ name: primitive, digest: primitive }), originalBrowserRecordLimits.records), overflow: primitive });
    // Performance/preload leaves have aggregate browser bounds, not the recorder's per-record cap.
    const browserPrimitive = scalar(originalCaptureLimits.totalBytes);
    const browser = object({ recorder, recordOverflow: primitive,
        performance: array(object({ url: browserPrimitive, initiatorType: browserPrimitive, startTime: browserPrimitive, duration: browserPrimitive,
            transferSize: browserPrimitive, encodedBodySize: browserPrimitive, decodedBodySize: browserPrimitive, urlDigest: browserPrimitive }), originalCaptureLimits.records),
        preloads: array(object({ url: browserPrimitive, rel: browserPrimitive, as: browserPrimitive, urlDigest: browserPrimitive }), originalCaptureLimits.records) },
    undefined, originalCaptureLimits.totalBytes);
    const issue = alternatives([
        object({ kind: scalar(undefined, value => ['warning', 'error'].includes(value)), digest: primitive,
            location: nullable(object({ url: primitive, urlDigest: primitive, lineNumber: primitive, columnNumber: primitive })),
            captureSequence: primitive }, undefined, originalCaptureLimits.headerBytes, ['captureSequence']),
        object({ kind: scalar(undefined, value => value === 'pageerror'), digest: primitive, captureSequence: primitive },
            undefined, originalCaptureLimits.headerBytes, ['captureSequence']),
        object({ kind: scalar(undefined, value => value === 'requestfailed'), requestOrdinal: primitive, urlDigest: primitive,
            failureDigest: primitive, captureSequence: primitive }, undefined, originalCaptureLimits.headerBytes, ['captureSequence'])
    ]);
    // Base capture has no driverObservations edge: nested stage captures cannot recursively contain stages.
    const captureFields = { identity: rawIdentity, sceneId: text, captureCut: primitive, phase: text, browser,
        requests: array(request, originalCaptureLimits.records), responses: array(response, originalCaptureLimits.records),
        issues: array(issue, originalCaptureLimits.records), pageCount: primitive, observationFailure: object(failureFields) };
    const capture = object(captureFields, ['identity', 'sceneId', 'captureCut']);
    const stage = name => scalar(undefined, value => value === name);
    const httpCapture = object(Object.fromEntries(['identity', 'sceneId', 'captureCut', 'requests', 'responses', 'issues']
        .map(key => [key, captureFields[key]])));
    const diagnostic = object({
        schema: scalar(undefined, value => value === 'fsusblog.public-shell-locale-first-response.v1'),
        evidenceKind: scalar(undefined, value => value === 'diagnostic-probe'),
        qualificationEligible: scalar(undefined, value => value === false),
        identity: object(Object.fromEntries(['sourceCommit', 'worktreeFingerprint', 'matrixDigest', 'buildDigest', 'runtimeId', 'namespace']
            .map(key => [key, text]))),
        response: object({ status: scalar(undefined, value => value === 200), contentType: text, contentLanguage: text,
            cacheControlDigest: text, bodyDigest: text, bodyBytes: primitive }),
        observed: object({ locale: text, route: text, authActionContext: text })
    });
    const switchObservation = alternatives([
        object({ stage: stage('before-click'), dom }),
        object({ stage: stage('pending'), target: primitive, dom }),
        object({ stage: stage('after-commit'), dom })
    ]);
    // Trace arrays have no separate product count limit. Their counts are bounded conservatively
    // by the existing run writer's total-byte budget (each JSON item consumes at least one byte).
    const trace = object({ identity: rawIdentity, sceneId: text,
        observations: array(switchObservation, originalCaptureLimits.totalBytes),
        telemetry: array(object({ name: primitive, level: primitive, generation: primitive, locale: primitive, from: primitive, to: primitive },
            ['name', 'from', 'to']), originalCaptureLimits.totalBytes),
        requests: array(object({ identity: primitive, type: primitive, method: primitive }), originalCaptureLimits.totalBytes),
        issues: array(object({ kind: primitive, digest: primitive }), originalCaptureLimits.totalBytes),
        failedRequests: array(object({ digest: primitive, error: primitive }), originalCaptureLimits.totalBytes),
        domGaps: object({ unobservedKeys: array(primitive, originalCaptureLimits.totalBytes),
            hiddenControls: array(primitive, originalCaptureLimits.totalBytes) }),
        remainingContracts: array(primitive, originalCaptureLimits.totalBytes), failure: object(failureFields) },
    ['identity', 'sceneId', 'observations', 'telemetry', 'requests', 'issues', 'failedRequests']);
    const driverObservation = alternatives([
        object({ stage: stage('first-response'), publishedArtifactRef: object({ path: text,
            digest: scalar(originalCaptureLimits.stringBytes, value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)) }),
        firstResponse: diagnostic, evidence: httpCapture }),
        ...['first-html', 'interactive-ready', 'selector-open'].map(name => object({ stage: stage(name), dom, evidence: capture })),
        object({ stage: stage('hydration-start'), observation: snapshot, evidence: capture }),
        object({ stage: stage('initial-network'), fontObservation: object({ status: primitive,
            checks: array(object({ weight: primitive, available: primitive }), originalCaptureLimits.totalBytes),
            faces: array(object({ family: primitive, weight: primitive, status: primitive, unicodeRange: primitive }), originalCaptureLimits.totalBytes) }),
        evidence: capture }),
        object({ stage: stage('before-click'), dom, evidence: capture }),
        object({ stage: stage('pending'), target: primitive, dom, evidence: capture }),
        object({ stage: stage('after-commit'), dom, evidence: capture }),
        ...['post-commit', 'first-failure'].map(name => object({ stage: stage(name), trace, evidence: capture }))
    ]);
    let schema;
    if (kind === 'scene')
    {
        schema = object({ scene: templates(matrix.scenes), lease: object(leaseFields), rootBinding: object({ artifact: text, digest: text }), failure,
            evidence: object({ ...captureFields,
                driverObservations: array(driverObservation, originalCaptureLimits.records, 0, originalCaptureLimits.totalBytes) },
            ['identity', 'sceneId']),
            privateOriginals: object({ binding: object({ identity: rawIdentity, sceneId: text }),
                limits: object(Object.fromEntries(Object.keys(originalCaptureLimits).map(key => [key, primitive]))), captureCut: primitive,
                originals: array(rawLeaf, originalCaptureLimits.leaves),
                failures: array(object({ sequence: primitive, reason: primitive, name: failureFields.name }), originalCaptureLimits.records), overflow: primitive }) });
    }
    else
    {
        originalAssert(kind === 'ledger', 'JSON kind is unknown');
        const phases = ['prepared', 'reserved', 'entered', 'finished', 'abandoned', 'creation-failed', 'close-failed'];
        const minimumEventBytes = Buffer.byteLength(JSON.stringify({ phase: 'entered', at: '2026-01-01T00:00:00.000Z' }));
        const event = object({ phase: scalar(originalCaptureLimits.stringBytes, value => phases.includes(value)),
            at: scalar(originalCaptureLimits.stringBytes, value => typeof value === 'string' && Number.isFinite(Date.parse(value))
                && new Date(value).toISOString() === value) });
        schema = object({ schema: text, owner, closing: primitive, contentDigest: text,
            leases: array(object({ ...leaseFields, entered: primitive, ended: primitive,
                firstFailure: nullable(object({ ...failureFields, failureClass: text })),
                events: array(event, Math.floor(originalFileBytes / minimumEventBytes)) }), matrix.scenes.length),
            blocked: array(object({ sceneId: text, status: text, reason: text, requiredOwner: text, contextCount: primitive, authority }), matrix.scenes.length) });
    }
    let index = 0;
    const skip = () =>
    {
        while ([9, 10, 13, 32].includes(bytes[index]))
        {
            index += 1;
        }
    };
    const string = maximum =>
    {
        const start = index;
        originalAssert(bytes[index++] === 34, 'JSON string syntax invalid');
        let closed = false;
        while (index < bytes.length)
        {
            const byte = bytes[index++];
            originalAssert(index - start <= maximum * 6 + 2, 'JSON string byte budget invalid');
            if (byte === 34)
            {
                closed = true;
                break;
            }
            originalAssert(byte >= 32, 'JSON string contains control byte');
            if (byte === 92)
            {
                const escape = bytes[index++];
                originalAssert([34, 92, 47, 98, 102, 110, 114, 116, 117].includes(escape), 'JSON escape invalid');
                if (escape === 117)
                {
                    for (let digit = 0; digit < 4; digit += 1)
                    {
                        const hex = bytes[index++];
                        originalAssert((hex >= 48 && hex <= 57) || (hex >= 65 && hex <= 70) || (hex >= 97 && hex <= 102), 'JSON unicode escape invalid');
                    }
                }
            }
        }
        originalAssert(closed, 'JSON string is unterminated');
        const token = bytes.subarray(start, index);
        const source = token.toString('utf8');
        originalAssert(Buffer.from(source).equals(token), 'JSON UTF-8 invalid');
        const value = JSON.parse(source); // A bounded primitive token only, never an object/array.
        originalAssert(Buffer.byteLength(value) <= maximum, 'JSON string byte budget invalid');
        return value;
    };
    const scan = shape =>
    {
        skip();
        if (shape.type === 'alternatives')
        {
            const start = index;
            let firstError;
            for (const alternative of shape.shapes)
            {
                index = start;
                try
                {
                    return scan(alternative);
                }
                catch (error)
                {
                    if (error.code !== 'scene-original')
                    {
                        throw error;
                    }
                    firstError ??= error;
                }
            }
            throw firstError;
        }
        if (shape.nullable && bytes.subarray(index, index + 4).toString() === 'null')
        {
            index += 4;
            return 4;
        }
        if (shape.type === 'scalar')
        {
            let value;
            if (bytes[index] === 34)
            {
                value = string(shape.maximum);
            }
            else
            {
                const start = index;
                while (index < bytes.length && ![9, 10, 13, 32, 44, 93, 125].includes(bytes[index]))
                {
                    originalAssert(index - start < shape.maximum, 'JSON primitive byte budget invalid');
                    originalAssert(bytes[index] !== 91 && bytes[index] !== 123, 'JSON primitive cannot contain a nested graph');
                    index += 1;
                }
                const tokenBytes = bytes.subarray(start, index);
                const token = tokenBytes.toString('ascii');
                originalAssert(Buffer.from(token, 'ascii').equals(tokenBytes), 'JSON primitive contains non-ASCII bytes');
                originalAssert(/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u.test(token), 'JSON primitive syntax invalid');
                value = JSON.parse(token);
                originalAssert(typeof value !== 'number' || Number.isFinite(value), 'JSON number is not finite');
            }
            originalAssert(!shape.check || shape.check(value), 'JSON primitive differs from writer representation');
            return Buffer.byteLength(JSON.stringify(value));
        }
        if (shape.type === 'array')
        {
            originalAssert(bytes[index++] === 91, 'JSON array shape invalid');
            let count = 0;
            let size = 2;
            let retainedBytes = 0;
            skip();
            while (bytes[index] !== 93)
            {
                originalAssert(count < shape.maximum, 'JSON array count budget invalid');
                const itemBytes = scan(shape.element);
                retainedBytes += itemBytes;
                originalAssert(shape.retainedBytes === null || retainedBytes <= shape.retainedBytes, 'JSON retained array byte budget invalid');
                size += itemBytes + (count ? 1 : 0);
                count += 1;
                skip();
                if (bytes[index] === 93)
                {
                    break;
                }
                originalAssert(bytes[index++] === 44, 'JSON array separator invalid');
                skip();
                originalAssert(bytes[index] !== 93, 'JSON array trailing comma invalid');
            }
            index += 1;
            originalAssert(count >= shape.minimum, 'JSON array tuple is incomplete');
            return size;
        }
        originalAssert(bytes[index++] === 123, 'JSON object shape invalid');
        const seen = new Set();
        let size = 2;
        let budget = 2;
        let budgetCount = 0;
        const maximumKey = Math.max(...Object.keys(shape.fields).map(key => Buffer.byteLength(key)), 0);
        skip();
        while (bytes[index] !== 125)
        {
            const key = string(maximumKey);
            originalAssert(Object.hasOwn(shape.fields, key), 'JSON unknown field rejected before its value');
            originalAssert(!seen.has(key), 'JSON duplicate key invalid');
            seen.add(key);
            skip();
            originalAssert(bytes[index++] === 58, 'JSON object colon invalid');
            const fieldSize = Buffer.byteLength(JSON.stringify(key)) + 1 + scan(shape.fields[key]);
            size += fieldSize + (seen.size > 1 ? 1 : 0);
            if (!shape.omitted.includes(key))
            {
                budget += fieldSize + (budgetCount ? 1 : 0);
                budgetCount += 1;
                originalAssert(shape.maximum === null || budget <= shape.maximum, 'JSON record byte budget invalid');
            }
            skip();
            if (bytes[index] === 125)
            {
                break;
            }
            originalAssert(bytes[index++] === 44, 'JSON object separator invalid');
            skip();
            originalAssert(bytes[index] !== 125, 'JSON object trailing comma invalid');
        }
        index += 1;
        originalAssert(shape.required.every(key => seen.has(key)), 'JSON required field missing');
        return size;
    };
    scan(schema);
    skip();
    originalAssert(index === bytes.length, 'JSON trailing input invalid');
    return JSON.parse(bytes.toString('utf8'));
}

function originalUrlMatches(actualUrl, record, runtime)
{
    if (typeof actualUrl !== 'string' || record.urlDigest !== `sha256:${createHash('sha256').update(actualUrl).digest('hex')}`)
    {
        return false;
    }
    // Match the collector's actual representation, not equality of its redacted text to raw URL.
    if (actualUrl === runtime.preferenceUrl || runtime.resources.some(resource => resource.url === actualUrl))
    {
        return record.url === actualUrl;
    }
    const url = new URL(actualUrl);
    return record.url === `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
}

function validateOriginalBatch(document, identity, runtime, limits)
{
    const batch = document.privateOriginals;
    const evidence = document.evidence;
    originalAssert(originalKeys(batch, ['binding', 'limits', 'captureCut', 'originals', 'failures', 'overflow'])
        && originalKeys(batch.binding, ['identity', 'sceneId']) && isDeepStrictEqual(batch.binding.identity, identity)
        && batch.binding.sceneId === document.scene.id && isDeepStrictEqual(evidence.identity, identity)
        && evidence.sceneId === document.scene.id, 'batch identity mismatch');
    originalAssert(Number.isSafeInteger(batch.captureCut) && batch.captureCut > 0
        && evidence.captureCut === batch.captureCut && batch.overflow === false
        && Array.isArray(batch.failures) && batch.failures.length === 0 && document.failure === null,
    'cut is missing or capture has a sticky failure');
    originalAssert(Array.isArray(batch.originals) && batch.originals.length > 0
        && batch.originals.length <= limits.leaves, 'leaf count is missing or over budget');
    const normal = evidence.phase !== 'observer-disposal';
    if (normal)
    {
        for (const field of ['requests', 'responses', 'issues'])
        {
            originalAssert(Array.isArray(evidence[field]) && evidence[field].length <= limits.records
                && evidence[field].every(record => Number.isSafeInteger(record.captureSequence)
                    && record.captureSequence > 0 && record.captureSequence <= batch.captureCut), 'metadata cut or count invalid');
            for (const record of evidence[field])
            {
                // append bounds the original input, before adding captureSequence or response readback.
                const input = Object.fromEntries(Object.entries(record).filter(([key]) => ![
                    'captureSequence', 'resource', 'contentDigest', 'commandDigest', 'command', 'preference', 'error', 'observationError'
                ].includes(key)));
                originalAssert(Buffer.byteLength(JSON.stringify(input)) <= limits.headerBytes, 'metadata record byte budget invalid');
            }
        }
        originalAssert(evidence.issues.length === 0 && evidence.responses.every(record => !record.observationError),
            'HTTP metadata has a sticky failure');
        if (!Object.hasOwn(evidence, 'browser'))
        {
            originalAssert(document.scene.issue === 2083 && document.scene.stage === 'first-response'
                && document.lease.authority.inputs.javaScriptEnabled === false
                && originalKeys(evidence, ['identity', 'sceneId', 'captureCut', 'requests', 'responses', 'issues',
                    ...(Object.hasOwn(evidence, 'driverObservations') ? ['driverObservations'] : [])]),
            'HTTP-only capture is not a canonical JS-disabled first-response scene');
        }
        else
        {
            originalAssert(evidence.browser?.recordOverflow === false && evidence.browser.recorder?.overflow === false
                && Array.isArray(evidence.browser.recorder.errors) && evidence.browser.recorder.errors.length === 0,
            'browser metadata has a sticky failure');
            for (const records of [evidence.browser.performance, evidence.browser.preloads])
            {
                originalAssert(Array.isArray(records) && records.length <= limits.records, 'browser record budget invalid');
            }
            let recorderBytes = 0;
            for (const [field, maximum] of [['frames', originalBrowserRecordLimits.frames], ['marks', originalBrowserRecordLimits.records],
                ['events', originalBrowserRecordLimits.records], ['errors', originalBrowserRecordLimits.records]])
            {
                const records = evidence.browser.recorder[field];
                originalAssert(Array.isArray(records) && records.length <= maximum, 'browser recorder count invalid');
                for (const record of records)
                {
                    if (field === 'frames')
                    {
                        originalAssert(originalKeys(record, ['observedAt', 'dom']) && record.dom !== null
                            && typeof record.dom === 'object' && !Array.isArray(record.dom), 'browser frame representation invalid');
                    }
                    const bytes = Buffer.byteLength(JSON.stringify(record));
                    originalAssert(bytes <= originalBrowserRecordLimits.recordBytes, 'browser recorder record byte budget invalid');
                    recorderBytes += bytes;
                }
            }
            originalAssert(recorderBytes <= originalBrowserRecordLimits.totalBytes, 'browser recorder total byte budget invalid');
            originalAssert(Buffer.byteLength(JSON.stringify(evidence.browser)) <= limits.totalBytes, 'browser byte budget invalid');
        }
    }
    let total = 0;
    const seen = new Set();
    const requestOrdinal = value => Number.isSafeInteger(value) && value >= 0;
    const invocationOrdinal = value => Number.isSafeInteger(value) && value > 0;
    for (const leaf of batch.originals)
    {
        originalAssert(Number.isSafeInteger(leaf.sequence) && leaf.sequence > 0 && leaf.sequence <= batch.captureCut
            && leaf.captureState === 'observed' && ['request', 'response', 'invocation', 'supplied-body'].includes(leaf.kind),
        'leaf is pending, incomplete or outside cut');
        const key = `${leaf.kind}/${leaf.sequence}`;
        originalAssert(!seen.has(key), 'duplicate capture leaf');
        seen.add(key);
        const bodyFields = ['bodyEncoding', 'bodyBase64', 'byteLength', 'byteSha256'];
        const baseFields = ['sequence', 'kind', 'source', 'captureState'];
        const fields = leaf.kind === 'request'
            ? [...baseFields, 'requestOrdinal', 'method', 'url', 'representation', 'headersArray',
                ...(leaf.bodyApplicable === false ? ['bodyApplicable'] : bodyFields)]
            : leaf.kind === 'response'
                ? [...baseFields, 'requestOrdinal', 'parentRequestOrdinal', 'invocationOrdinal', 'method', 'url', 'status',
                    'representation', 'headersArray', ...bodyFields]
                : leaf.kind === 'invocation'
                    ? [...baseFields, 'parentRequestOrdinal', 'method', 'url', 'invocationOrdinal']
                    : [...baseFields, 'requestOrdinal', 'purpose', 'representation', ...bodyFields,
                        ...(Object.hasOwn(leaf, 'url') ? ['url', 'headersArray', 'headerRepresentation'] : [])];
        originalAssert(originalKeys(leaf, fields), 'leaf fields are not the original capture representation');
        if (leaf.kind === 'request')
        {
            const matches = runtime.requests.filter(record => record.requestOrdinal === leaf.requestOrdinal);
            originalAssert(leaf.source === 'browser' && leaf.representation === 'request-post-data'
                && requestOrdinal(leaf.requestOrdinal) && matches.length > 0
                && matches.every(record => originalUrlMatches(leaf.url, record, runtime) && record.method === leaf.method
                    && record.captureSequence === leaf.sequence), 'request correlation invalid');
        }
        else if (leaf.kind === 'response')
        {
            originalAssert(leaf.representation === 'playwright-response-body' && Number.isInteger(leaf.status)
                && leaf.status >= 100 && leaf.status <= 599, 'response shape invalid');
            if (leaf.source === 'browser')
            {
                const requests = runtime.requests.filter(record => record.requestOrdinal === leaf.requestOrdinal);
                const matches = runtime.responses.filter(record => record.requestOrdinal === leaf.requestOrdinal
                    && record.captureSequence === leaf.sequence);
                originalAssert(requestOrdinal(leaf.requestOrdinal) && leaf.invocationOrdinal === null
                    && leaf.parentRequestOrdinal === null && matches.length > 0
                    && matches.every(record => originalUrlMatches(leaf.url, record, runtime) && record.method === leaf.method && record.status === leaf.status)
                    && requests.length > 0 && requests.every(record => record.method === leaf.method
                        && record.captureSequence < leaf.sequence && originalUrlMatches(leaf.url, record, runtime)),
                'response request correlation invalid');
            }
            else
            {
                const invocation = batch.originals.filter(item => item.kind === 'invocation'
                    && item.invocationOrdinal === leaf.invocationOrdinal);
                originalAssert(['api-request', 'route-fetch'].includes(leaf.source) && invocationOrdinal(leaf.invocationOrdinal)
                    && leaf.requestOrdinal === null
                    && (leaf.parentRequestOrdinal === null || requestOrdinal(leaf.parentRequestOrdinal))
                    && invocation.length === 1 && invocation[0].sequence === leaf.sequence
                    && ['source', 'method', 'url', 'parentRequestOrdinal'].every(field => invocation[0][field] === leaf[field]),
                'response invocation correlation invalid');
            }
        }
        else if (leaf.kind === 'invocation')
        {
            originalAssert(['api-request', 'route-fetch'].includes(leaf.source) && invocationOrdinal(leaf.invocationOrdinal)
                && batch.originals.filter(item => item.kind === 'response' && item.invocationOrdinal === leaf.invocationOrdinal).length === 1,
            'invocation response missing');
            if (leaf.parentRequestOrdinal !== null)
            {
                const parents = runtime.requests.filter(record => record.requestOrdinal === leaf.parentRequestOrdinal);
                originalAssert(requestOrdinal(leaf.parentRequestOrdinal) && parents.length > 0
                    && parents.every(record => record.captureSequence < leaf.sequence && originalUrlMatches(leaf.url, record, runtime)
                        && (leaf.source !== 'route-fetch' || record.method === leaf.method)), 'invocation actual parent mismatch');
            }
        }
        else
        {
            originalAssert(leaf.source === 'route-input' && leaf.representation === 'route-supplied-body'
                && requestOrdinal(leaf.requestOrdinal) && ['stale-delivery-input', 'forwarded-command', 'resource-replacement-input'].includes(leaf.purpose)
                && runtime.requests.some(record => record.requestOrdinal === leaf.requestOrdinal)
                && (!Object.hasOwn(leaf, 'url') || leaf.headerRepresentation === 'route-supplied-headers'), 'supplied body correlation invalid');
            if (leaf.purpose === 'resource-replacement-input')
            {
                originalAssert(typeof leaf.url === 'string' && runtime.resources.some(resource => resource.url === leaf.url)
                    && Array.isArray(leaf.headersArray) && leaf.headerRepresentation === 'route-supplied-headers'
                    && runtime.requests.filter(record => record.requestOrdinal === leaf.requestOrdinal).every(record =>
                        record.captureSequence < leaf.sequence && originalUrlMatches(leaf.url, record, runtime)),
                'supplied resource URL, headers or actual resource request missing');
            }
        }
        for (const [field, value] of Object.entries(leaf))
        {
            if (typeof value === 'string' && field !== 'bodyBase64')
            {
                originalAssert(Buffer.byteLength(value) <= limits.stringBytes, 'leaf string budget invalid');
            }
        }
        const headersRequired = leaf.kind === 'request' || leaf.kind === 'response'
            || (leaf.kind === 'supplied-body' && Object.hasOwn(leaf, 'url'));
        if (headersRequired || Object.hasOwn(leaf, 'headersArray'))
        {
            originalAssert(Array.isArray(leaf.headersArray) && leaf.headersArray.length <= limits.headers, 'full headers unavailable');
            let headerBytes = 0;
            for (const header of leaf.headersArray)
            {
                originalAssert(originalKeys(header, ['name', 'value']) && typeof header.name === 'string'
                    && typeof header.value === 'string' && Buffer.byteLength(header.name) <= limits.stringBytes
                    && Buffer.byteLength(header.value) <= limits.stringBytes, 'header shape invalid');
                headerBytes += Buffer.byteLength(header.name) + Buffer.byteLength(header.value);
            }
            originalAssert(headerBytes <= limits.headerBytes, 'header byte budget invalid');
        }
        const hasBody = leaf.kind === 'response' || leaf.kind === 'supplied-body'
            || (leaf.kind === 'request' && leaf.bodyApplicable !== false);
        if (!hasBody)
        {
            originalAssert(['bodyEncoding', 'bodyBase64', 'byteLength', 'byteSha256'].every(field => !Object.hasOwn(leaf, field)),
                'unexpected body fields');
            continue;
        }
        originalAssert(leaf.bodyEncoding === 'base64' && typeof leaf.bodyBase64 === 'string'
            && leaf.bodyBase64.length <= Math.ceil(limits.totalBytes / 3) * 4
            && leaf.bodyBase64.length % 4 === 0
            && Number.isSafeInteger(leaf.byteLength) && leaf.byteLength >= 0, 'body encoding invalid');
        const bytes = Buffer.from(leaf.bodyBase64, 'base64');
        originalAssert(bytes.toString('base64') === leaf.bodyBase64 && bytes.length === leaf.byteLength
            && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === leaf.byteSha256, 'body byte integrity mismatch');
        const url = leaf.url ?? runtime.preferenceUrl;
        const resource = runtime.resources.some(item => item.url === url);
        const request = runtime.requests.find(item => item.requestOrdinal === leaf.requestOrdinal);
        const maximum = url === runtime.preferenceUrl ? limits.bodyBytes : resource ? limits.totalBytes
            : request?.resourceType === 'document' ? limits.documentBytes : null;
        originalAssert(maximum !== null && bytes.length <= maximum, 'body URL or per-body budget invalid');
        total += bytes.length;
        originalAssert(total <= limits.totalBytes, 'total body budget exceeded');
    }
    return { normal, captureCut: batch.captureCut, bodyBytes: total };
}

function originalPublishedArtifactRef(ref, binding, scene)
{
    const prefix = `.tmp/browser-contract/runs/${binding.identity.namespace}/bindings/${binding.preparation.id}/published-artifacts/scene-${encodeURIComponent(scene.id)}/`;
    originalAssert(originalKeys(ref, ['path', 'digest']) && typeof ref.path === 'string' && ref.path.startsWith(prefix)
        && /^published-artifact-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u.test(ref.path.slice(prefix.length))
        && typeof ref.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(ref.digest), 'published artifact ref is not canonical');
    return { prefix, ref: { path: ref.path, digest: ref.digest } };
}

function validateFirstResponseOriginalStage(document, observation, binding, identity, runtime, limits)
{
    originalAssert(document.scene.issue === 2083 && document.scene.stage === 'first-response'
        && document.lease.authority.inputs.javaScriptEnabled === false
        && originalKeys(observation, ['stage', 'publishedArtifactRef', 'firstResponse', 'evidence']),
    'first-response stage differs from canonical scene or shape');
    originalPublishedArtifactRef(observation.publishedArtifactRef, binding, document.scene);
    const diagnostic = observation.firstResponse;
    originalAssert(originalKeys(diagnostic, ['schema', 'evidenceKind', 'qualificationEligible', 'identity', 'response', 'observed'])
        && diagnostic.schema === 'fsusblog.public-shell-locale-first-response.v1'
        && diagnostic.evidenceKind === 'diagnostic-probe' && diagnostic.qualificationEligible === false,
    'first-response diagnostic schema or qualification flags invalid');
    originalAssert(isDeepStrictEqual(diagnostic.identity, { sourceCommit: binding.sourceState.commit,
        worktreeFingerprint: binding.sourceState.worktreeFingerprint, matrixDigest: binding.matrixDigest,
        buildDigest: binding.buildDigest, runtimeId: binding.runtimeId, namespace: binding.identity.namespace })
        && isDeepStrictEqual(diagnostic.observed, { locale: document.scene.locale, route: document.scene.route,
            authActionContext: document.scene.authActionContext }), 'first-response diagnostic identity differs');
    const capture = observation.evidence;
    originalAssert(originalKeys(capture, ['identity', 'sceneId', 'captureCut', 'requests', 'responses', 'issues'])
        && Number.isSafeInteger(capture.captureCut) && capture.captureCut > 0 && capture.captureCut <= document.evidence.captureCut,
    'first-response HTTP capture shape or cut invalid');
    const batch = { ...document.privateOriginals, captureCut: capture.captureCut,
        originals: document.privateOriginals.originals.filter(leaf => leaf.sequence <= capture.captureCut) };
    for (const field of ['requests', 'responses'])
    {
        const prefix = new Map();
        for (const record of runtime[field].filter(item => item.captureSequence <= capture.captureCut))
        {
            const previous = prefix.get(record.captureSequence);
            originalAssert(!previous || isDeepStrictEqual(previous, record), 'first-response metadata prefix changed between cuts');
            prefix.set(record.captureSequence, record);
        }
        originalAssert(Array.isArray(capture[field]) && capture[field].length === prefix.size
            && new Set(capture[field].map(record => record.captureSequence)).size === prefix.size
            && capture[field].every(record => isDeepStrictEqual(record, prefix.get(record.captureSequence))),
        'first-response stage metadata differs from original prefix');
    }
    validateOriginalBatch({ ...document, evidence: capture, privateOriginals: batch }, identity, runtime, limits);
    const summary = diagnostic.response;
    originalAssert(originalKeys(summary, ['status', 'contentType', 'contentLanguage', 'cacheControlDigest', 'bodyDigest', 'bodyBytes'])
        && summary.status === 200 && summary.contentType === 'text/html' && summary.contentLanguage === document.scene.document.language
        && Number.isSafeInteger(summary.bodyBytes) && summary.bodyBytes > 0 && summary.bodyBytes <= limits.documentBytes
        && ['bodyDigest', 'cacheControlDigest'].every(key => typeof summary[key] === 'string' && /^[a-f0-9]{64}$/u.test(summary[key])),
    'first-response diagnostic response shape invalid');
    const matches = batch.originals.filter(leaf => leaf.kind === 'response' && leaf.source === 'browser'
        && leaf.method === 'GET' && leaf.byteSha256 === `sha256:${summary.bodyDigest}` && leaf.byteLength === summary.bodyBytes && leaf.status === summary.status
        && capture.responses.some(record => record.captureSequence === leaf.sequence && record.requestOrdinal === leaf.requestOrdinal
            && record.resourceType === 'document'));
    originalAssert(matches.length === 1, 'first-response diagnostic has no unique original document');
    const selectedRoute = runtime.publishedRoutes?.get(document.scene.id);
    originalAssert(typeof selectedRoute?.path === 'string' && matches[0].url === new URL(selectedRoute.path, runtime.runtime.frontendUrl).href,
        'first-response original document differs from independently selected published route');
    const header = name =>
    {
        const headers = matches[0].headersArray.filter(item => item.name.toLowerCase() === name);
        originalAssert(headers.length === 1, 'first-response diagnostic header is missing or ambiguous');
        return headers[0].value;
    };
    originalAssert(header('content-type').split(';')[0].trim().toLowerCase() === summary.contentType
        && header('content-language') === summary.contentLanguage
        && createHash('sha256').update(header('cache-control')).digest('hex') === summary.cacheControlDigest,
    'first-response diagnostic differs from original headers');
}

/** Pure joins for Node contract models and the reader below, never caller admission or qualification. */
export function validatePublicShellLocaleSceneOriginalDocuments({ matrix, caller, parent, bindings, documents, runtime })
{
    originalAssert(bindings?.schema === 'fsusblog.browser-contract-public-shell-scene-bindings.v1'
        && Array.isArray(bindings.leases) && bindings.leases.length <= matrix.scenes.length
        && isDeepStrictEqual(bindings.owner, caller.callerOwner), 'durable ledger owner invalid');
    const { contentDigest, ...body } = bindings;
    originalAssert(contentDigest === createHash('sha256').update(JSON.stringify(body)).digest('hex'), 'ledger semantic digest mismatch');
    const topology = projectBrowserContractLocaleTopology({ matrix, bindings, expectedOwner: caller.callerOwner });
    originalAssert(isDeepStrictEqual(parent.publicShellLocaleRootBinding, caller.callerRootRef)
        && isDeepStrictEqual(parent.topology?.publicShellLocale, topology), 'current parent topology or Root mismatch');
    for (const field of ['sceneId', 'actorId', 'leaseId', 'contextId'])
    {
        originalAssert(new Set(bindings.leases.map(lease => lease[field])).size === bindings.leases.length, 'duplicate ledger identity');
    }
    originalAssert(Array.isArray(documents) && documents.length > 0 && documents.length <= originalCaptureLimits.leaves,
        'original document count invalid');
    const binding = caller.binding;
    const identity = { matrixDigest: binding.matrixDigest, sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        namespace: binding.identity.namespace, preparationId: binding.preparation.id };
    const scenes = new Map();
    const firstResponseStages = new Map();
    for (const document of documents)
    {
        originalAssert(originalKeys(document, ['scene', 'lease', 'evidence', 'privateOriginals', 'failure', 'rootBinding'])
            && isDeepStrictEqual(document.rootBinding, caller.callerRootRef), 'leaf envelope or Root mismatch');
        const scene = matrix.scenes.find(item => item.id === document.scene?.id);
        originalAssert(scene && isDeepStrictEqual(scene, document.scene), 'scene differs from current matrix');
        const lease = bindings.leases.find(item => item.sceneId === scene.id);
        originalAssert(lease && lease.status === 'finished' && lease.entered === 1 && lease.ended === 1
            && lease.firstFailure === null && scene.authActionContext === 'anonymous', 'scene has no terminal successful lease');
        const { leaseId, actorId, contextId, sceneId, role, owner, authority } = lease;
        originalAssert(['leaseId', 'actorId', 'contextId'].every(field => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(lease[field] ?? ''))
            && isDeepStrictEqual(owner, caller.callerOwner) && role === scene.authActionContext
            && isDeepStrictEqual(document.lease, { leaseId, actorId, contextId, sceneId, role, status: 'prepared', owner, authority }),
        'prepared transport does not join durable scene/actor/context');
        originalAssert(authority?.matrixDigest === binding.matrixDigest && authority.runtimeRunId === binding.runtimeId
            && authority.fixtureReceiptDigest === binding.fixtureReceiptDigest && isDeepStrictEqual(authority.runtime, runtime.runtime),
        'lease runtime authority mismatch');
        const roles = new Map([['provider-state', 'provider-state.json'], ['fixture-manifest', 'contract-fixture.json'],
            ['prepare-state', 'prepare-state.json'], ['fixture-receipt', 'fixture-receipt.json'],
            ['cookie-source', 'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs']]);
        const expectedRefs = binding.refs.filter(ref => roles.has(ref.role)).map(ref => ({ path: roles.get(ref.role), digest: ref.digest }));
        originalAssert(Array.isArray(authority.rawRefs) && authority.rawRefs.length === expectedRefs.length
            && expectedRefs.length === roles.size && expectedRefs.every(ref => authority.rawRefs.filter(item => isDeepStrictEqual(item, ref)).length === 1),
        'lease original authority refs mismatch');
        const negotiation = matrix.negotiationCases.find(item => item.id === scene.negotiationId);
        originalAssert(negotiation && isDeepStrictEqual(authority.inputs, { viewport: scene.viewport,
            javaScriptEnabled: scene.issue !== 2083, acceptLanguage: negotiation.header, cookie: negotiation.cookie,
            cookieName: runtime.cookieName }), 'lease input authority mismatch');
        originalAssert(originalKeys(document.privateOriginals?.limits, Object.keys(originalCaptureLimits)), 'capture limits missing');
        const limits = validatePublicShellLocaleOriginalCaptureLimits(document.privateOriginals.limits);
        originalAssert(isDeepStrictEqual(document.privateOriginals.limits, limits), 'capture limits mismatch');
        const requests = documents.filter(item => item.scene?.id === scene.id && item.evidence?.phase !== 'observer-disposal')
            .flatMap(item => item.evidence?.requests ?? []);
        const responses = documents.filter(item => item.scene?.id === scene.id && item.evidence?.phase !== 'observer-disposal')
            .flatMap(item => item.evidence?.responses ?? []);
        const checked = validateOriginalBatch(document, identity, { ...runtime, requests, responses }, limits);
        const observations = document.evidence.driverObservations ?? [];
        originalAssert(Array.isArray(observations) && observations.length <= limits.records,
            'driver observations count invalid');
        let firstResponses = 0;
        for (const observation of observations)
        {
            if (observation.stage === 'first-response')
            {
                firstResponses += 1;
                validateFirstResponseOriginalStage(document, observation, binding, identity, { ...runtime, requests, responses }, limits);
                const previous = firstResponseStages.get(scene.id);
                originalAssert(!previous || isDeepStrictEqual(previous, observation), 'first-response stage changed between normal and tail cuts');
                firstResponseStages.set(scene.id, observation);
            }
            else
            {
                originalAssert(Object.hasOwn(observation.evidence ?? {}, 'browser'), 'non-first-response stage has no browser recorder');
                const capture = observation.evidence;
                originalAssert(Number.isSafeInteger(capture.captureCut) && capture.captureCut > 0
                    && capture.captureCut <= document.evidence.captureCut, 'driver capture cut invalid');
                validateOriginalBatch({ ...document, evidence: capture, privateOriginals: { ...document.privateOriginals,
                    captureCut: capture.captureCut, originals: document.privateOriginals.originals.filter(leaf => leaf.sequence <= capture.captureCut) } },
                identity, { ...runtime, requests, responses }, limits);
            }
        }
        originalAssert(firstResponses <= 1 && (!checked.normal || Object.hasOwn(document.evidence, 'browser') || firstResponses === 1),
            'HTTP-only normal capture requires its unique first-response stage');
        const cuts = scenes.get(scene.id) ?? [];
        originalAssert(!cuts.some(cut => cut.captureCut === checked.captureCut && cut.normal === checked.normal), 'duplicate scene cut');
        cuts.push({ ...checked, batch: document.privateOriginals });
        scenes.set(scene.id, cuts);
    }
    for (const cuts of scenes.values())
    {
        originalAssert(cuts.some(cut => cut.normal), 'disposal tail cannot replace a normal observation');
        for (const left of cuts)
        {
            for (const right of cuts)
            {
                if (right.captureCut >= left.captureCut)
                {
                    originalAssert(isDeepStrictEqual(left.batch.limits, right.batch.limits)
                        && isDeepStrictEqual(left.batch.originals, right.batch.originals.filter(leaf => leaf.sequence <= left.captureCut)),
                    'capture prefix changed between cuts');
                }
                originalAssert(right.normal || right.captureCut >= left.captureCut, 'disposal tail precedes normal cut');
            }
        }
    }
    return { documentCount: documents.length, sceneCount: scenes.size };
}

/** Independently reopen current Root, parent and durable ledger snapshot before reading scene bytes.
 * This does not reconstruct native stage causality and never emits a qualification marker.
 */
export async function readPublicShellLocaleSceneOriginals({ refs, ...options } = {})
{
    originalAssert(typeof options.browserReceiptFile === 'string' && options.browserReceiptFile.length > 0,
        'current parent receipt is required');
    const root = realpathSync(options.root ?? defaultRoot);
    const caller = await readPublicShellLocaleCallerRoot({ ...options, root });
    const loaded = await readCallerParent({ ...options, root });
    callerEqual(loaded.owner, caller.callerOwner, 'scene reader current parent owner');
    callerEqual(loaded.ref, caller.callerRootRef, 'scene reader current parent Root');
    const runPrefix = `.tmp/browser-contract/runs/${caller.binding.identity.namespace}/`;
    const prefix = `${runPrefix}bindings/${caller.binding.preparation.id}/`;
    const ledgerRef = loaded.parent.publicShellLocaleBinding;
    originalAssert(originalKeys(ledgerRef, ['artifact', 'digest'])
        && ledgerRef.artifact === `${runPrefix}public-shell-locale-scene-bindings.json`, 'original durable ledger ref missing');
    const ledger = readPublicShellLocaleSceneOriginalArtifact({ root, prefix: runPrefix,
        ref: { path: ledgerRef.artifact, digest: ledgerRef.digest } });
    const providerRef = caller.binding.refs.find(ref => ref.role === 'provider-state');
    const provider = JSON.parse(readCallerArtifact(root, { artifact: providerRef.path, digest: providerRef.digest }, prefix).bytes.toString('utf8'));
    const cookieRef = caller.binding.refs.find(ref => ref.role === 'cookie-source');
    const cookieBytes = readCallerArtifact(root, { artifact: cookieRef.path, digest: cookieRef.digest }, prefix).bytes;
    const cookieNames = [...cookieBytes.toString('utf8').matchAll(/public const string CookieName = "([^"]+)";/gu)];
    originalAssert(cookieNames.length === 1, 'cookie source authority ambiguous');
    const { admitPublicShellLocaleRuntimeBindings } = await import(new URL('../../tests/browser-contract/public-shell-locale-runtime-bindings.mjs', import.meta.url));
    const runtime = await admitPublicShellLocaleRuntimeBindings({ root, matrix: options.matrix,
        harness: { identity: caller.identity, fixture: { baseUrl: provider.runtime.frontendUrl } },
        buildReceiptFile: resolveGatePath(root, options.buildReceiptFile, 'current build receipt') });
    const bindings = parsePublicShellLocaleSceneOriginalJson(ledger.bytes, { kind: 'ledger', matrix: options.matrix, caller, runtime });
    originalAssert(Array.isArray(refs) && refs.length > 0 && refs.length <= originalCaptureLimits.leaves
        && new Set(refs.map(ref => ref.path)).size === refs.length, 'refs missing, duplicate or over budget');
    let retainedBytes = 0;
    const originals = refs.map(ref =>
    {
        const original = readPublicShellLocaleSceneOriginalArtifact({ root, ref, prefix: `${prefix}scene-originals/`,
            remainingBytes: originalFileBytes - retainedBytes });
        retainedBytes += original.bytes.length;
        originalAssert(retainedBytes <= originalFileBytes, 'combined file byte budget exceeded');
        return original;
    });
    const documents = originals.map(original => parsePublicShellLocaleSceneOriginalJson(original.bytes,
        { kind: 'scene', matrix: options.matrix, caller, runtime }));
    const publishedOriginals = new Map();
    const publishedRoutes = new Map();
    const { validatePublicShellLocalePublishedArtifactResponse } = await import(new URL('../../tests/browser-contract/default-fixture-provider.mjs', import.meta.url));
    const { readSealedBrowserContractFixture } = await import(new URL('../../tests/browser-contract/fixture-lifecycle.mjs', import.meta.url));
    const { resolvePublicShellLocalePublishedRoute } = await import(new URL('../../tests/browser-contract/public-shell-locale-runtime-bindings.mjs', import.meta.url));
    let fixture;
    for (const document of documents)
    {
        for (const observation of document.evidence.driverObservations ?? [])
        {
            if (observation.stage !== 'first-response')
            {
                continue;
            }
            const scene = options.matrix.scenes.find(item => item.id === document.scene.id);
            originalAssert(scene?.issue === 2083 && scene.stage === 'first-response', 'published artifact belongs to another stage');
            const admitted = originalPublishedArtifactRef(observation.publishedArtifactRef, caller.binding, scene);
            const previous = publishedOriginals.get(admitted.ref.path);
            if (previous)
            {
                originalAssert(previous.sceneId === scene.id && isDeepStrictEqual(previous.ref, admitted.ref),
                    'published artifact ref is shared across scenes or differs between cuts');
                continue;
            }
            const original = readPublicShellLocaleSceneOriginalArtifact({ root, ref: admitted.ref, prefix: admitted.prefix,
                remainingBytes: Math.min(originalCaptureLimits.totalBytes, originalFileBytes - retainedBytes) });
            retainedBytes += original.bytes.length;
            fixture ??= await readSealedBrowserContractFixture(readCallerArtifact(root, {
                artifact: caller.binding.refs.find(ref => ref.role === 'fixture-manifest').path,
                digest: caller.binding.refs.find(ref => ref.role === 'fixture-manifest').digest
            }, prefix).target);
            const route = await resolvePublicShellLocalePublishedRoute({ root, scene, fixture });
            const previousRoute = publishedRoutes.get(scene.id);
            originalAssert(!previousRoute || isDeepStrictEqual(previousRoute, route), 'published route differs between reads');
            publishedRoutes.set(scene.id, route);
            const publication = validatePublicShellLocalePublishedArtifactResponse(original.bytes, { body: {
                namespace: caller.binding.identity.namespace, runtimeRunId: caller.binding.runtimeId,
                sourceCommit: caller.binding.sourceState.commit, worktreeFingerprint: caller.binding.sourceState.worktreeFingerprint,
                buildDigest: caller.binding.buildDigest, path: route.path, locale: scene.locale
            } }, scene);
            originalAssert(publication.owner.runtimeScope === '' && publication.route.routeKey === route.routeKey,
                'published artifact scope or selected route differs from current no-session runtime');
            publishedOriginals.set(admitted.ref.path, { ...original, ref: admitted.ref, prefix: admitted.prefix, sceneId: scene.id });
        }
    }
    const counts = validatePublicShellLocaleSceneOriginalDocuments({ matrix: options.matrix, caller, parent: loaded.parent,
        bindings, documents, runtime: { ...runtime, publishedRoutes, runtime: {
            frontendUrl: provider.runtime.frontendUrl, backendUrl: provider.runtime.backendUrl
        }, cookieName: cookieNames[0][1] } });
    for (let index = 0; index < refs.length; index += 1)
    {
        const document = documents[index];
        const role = document.evidence.phase === 'observer-disposal' ? 'tail' : 'normal';
        originalAssert(refs[index].path === `${prefix}scene-originals/scene-${encodeURIComponent(document.scene.id)}/cut-${document.evidence.captureCut}-${role}.json`,
            'leaf path does not join scene or cut');
        const reopened = readPublicShellLocaleSceneOriginalArtifact({ root, ref: refs[index], prefix: `${prefix}scene-originals/` });
        originalAssert(reopened.bytes.equals(originals[index].bytes) && reopened.stat.ino === originals[index].stat.ino
            && reopened.stat.dev === originals[index].stat.dev, 'leaf changed during reader lifecycle');
    }
    const finalLedger = readPublicShellLocaleSceneOriginalArtifact({ root, prefix: runPrefix,
        ref: { path: ledgerRef.artifact, digest: ledgerRef.digest } });
    for (const original of publishedOriginals.values())
    {
        const reopened = readPublicShellLocaleSceneOriginalArtifact({ root, ref: original.ref, prefix: original.prefix,
            remainingBytes: originalCaptureLimits.totalBytes });
        originalAssert(reopened.bytes.equals(original.bytes) && reopened.stat.ino === original.stat.ino
            && reopened.stat.dev === original.stat.dev, 'published artifact changed during reader lifecycle');
    }
    originalAssert(finalLedger.bytes.equals(ledger.bytes) && finalLedger.stat.ino === ledger.stat.ino
        && finalLedger.stat.dev === ledger.stat.dev, 'ledger changed during reader lifecycle');
    callerEqual((await readCallerParent({ ...options, root })).original.bytes, loaded.original.bytes, 'scene reader parent bytes');
    await readPublicShellLocaleCallerRoot({ ...options, root });
    return { ...counts, documents };
}

function parseArgs(argv)
{
    const options = {};
    const positional = [];
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (!argument.startsWith('--'))
        {
            positional.push(argument);
            continue;
        }
        const key = argument.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith('--'))
        {
            throw new Error(`missing value for --${key}`);
        }
        options[key] = value;
        index += 1;
    }
    if (positional.length > 1)
    {
        throw new Error('verifier accepts one qualification receipt');
    }
    options.receipt = positional[0] ?? null;
    return options;
}

function relative(root, absolute)
{
    return `./${path.relative(root, absolute).replaceAll(path.sep, '/')}`;
}

function withoutDigest(value)
{
    const body = { ...value };
    delete body.contentDigest;
    return body;
}

function assertRawRefPath(root, relativePath)
{
    let current = root;
    for (const segment of relativePath.split('/'))
    {
        current = path.join(current, segment);
        let stat;
        try
        {
            stat = lstatSync(current);
        }
        catch
        {
            throw new Error('PublicShell locale raw ref is unreadable');
        }
        if (stat.isSymbolicLink() || realpathSync(current) !== current)
        {
            throw new Error('PublicShell locale raw ref contains a symlink');
        }
    }
    return current;
}

/** Reopen explicit private artifacts; byte integrity alone is not rendered acceptance. */
export function verifyPublicShellLocaleRawRefs({ root, results })
{
    root = realpathSync(root);
    let runDirectory = null;
    const seen = new Set();
    if (!Array.isArray(results) || results.length === 0)
    {
        throw new Error('PublicShell locale raw refs are missing');
    }
    for (const result of results)
    {
        if (!Array.isArray(result.refs) || result.refs.length === 0)
        {
            throw new Error('PublicShell locale raw refs are missing');
        }
        for (const ref of result.refs)
        {
            const refPath = typeof ref.path === 'string' ? ref.path.replace(/^\.\//u, '') : '';
            const parts = refPath.split('/');
            if (!refPath || refPath.includes('\\') || path.posix.isAbsolute(refPath)
                || parts.some((part) => !part || part === '.' || part === '..'))
            {
                throw new Error('PublicShell locale raw ref must be a canonical repository-relative path');
            }
            if (parts.length < 5 || parts.slice(0, 3).join('/') !== '.tmp/browser-contract/runs')
            {
                throw new Error('PublicShell locale raw ref must remain in the canonical owned run');
            }
            const owner = parts.slice(0, 4).join('/');
            if (runDirectory !== null && owner !== runDirectory)
            {
                throw new Error('PublicShell locale raw refs contain cross-run artifacts');
            }
            runDirectory = owner;
            if (seen.has(refPath))
            {
                throw new Error('PublicShell locale duplicate raw ref cannot represent another scene');
            }
            seen.add(refPath);
            const target = assertRawRefPath(root, refPath);
            const before = lstatSync(target);
            const { bytes } = readPrivateFile(target, { label: 'PublicShell locale raw ref' });
            assertRawRefPath(root, refPath);
            const after = lstatSync(target);
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
                || bytes.length !== after.size)
            {
                throw new Error('PublicShell locale raw ref changed during verification');
            }
            const expectedDigest = typeof ref.digest === 'string' ? ref.digest.replace(/^sha256:/u, '') : '';
            if (!/^[a-f0-9]{64}$/u.test(expectedDigest)
                || createHash('sha256').update(bytes).digest('hex') !== expectedDigest)
            {
                throw new Error('PublicShell locale raw ref digest mismatch');
            }
        }
    }
    return { runDirectory, artifactCount: seen.size };
}

export async function verifyPublicShellLocaleQualification({
    root = defaultRoot,
    receiptFile = null,
    buildReceiptFile = null,
    inputFile = null,
    callerRootRef = null,
    callerOwner = null,
    browserReceiptFile = null,
    fixtureProviderFile = process.env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER
} = {})
{
    root = path.resolve(root);
    const errors = [];
    let receipt = null;
    try
    {
        const gate = await loadPublicShellLocaleGate({ root, buildReceiptFile });
        const resolvedReceipt = receiptFile
            ? resolveGatePath(root, receiptFile, 'qualification receipt')
            : resolveGatePath(root, defaultReceipt, 'qualification receipt');
        receipt = JSON.parse(await readFile(resolvedReceipt, 'utf8'));
        if (receipt.schema !== publicShellLocaleQualificationSchema)
        {
            errors.push(`qualification receipt schema mismatch: ${receipt.schema ?? '<missing>'}`);
            return { ok: false, errors, receipt };
        }
        if (receipt.status !== 'success' || receipt.qualificationEligible !== true || receipt.evidenceKind !== 'verified')
        {
            errors.push('qualification receipt is not a verified success');
        }
        if (receipt.producer?.browserSpawnCount !== 0 || receipt.producer?.subMatrixSpawnCount !== 0)
        {
            errors.push('aggregate receipt reports browser or sub-matrix spawning');
        }
        if (receipt.verifier?.independent !== true
            || receipt.verifier?.browserSpawnCount !== 0
            || receipt.verifier?.subMatrixSpawnCount !== 0)
        {
            errors.push('verifier receipt is not independent and browser-free');
        }
        const build = verifyPublicShellLocaleBuild(gate);
        if (receipt.build?.receiptPath !== relative(root, gate.receiptFile))
        {
            errors.push('qualification receipt build path is not the configured current build');
        }
        if (receipt.build?.digest !== build.digest)
        {
            errors.push('qualification receipt build digest mismatch');
        }
        if (JSON.stringify(receipt.build?.domains ?? []) !== JSON.stringify(build.domains))
        {
            errors.push('qualification receipt build domain set mismatch');
        }
        const configuredInput = gate.config.subResults.inputPath ?? '.tmp/browser-evidence/public-shell-locale-sub-results.json';
        const expectedInputFile = inputFile
            ? resolveGatePath(root, inputFile, 'sub-results')
            : resolveGatePath(root, configuredInput, 'sub-results');
        const inputPath = receipt.input?.path;
        if (inputPath !== relative(root, expectedInputFile))
        {
            errors.push('qualification receipt input path is not the configured current sub-result input');
        }
        const resolvedInput = expectedInputFile;
        const input = JSON.parse(await readFile(resolvedInput, 'utf8'));
        if (input.schema !== publicShellLocaleSubResultsSchema)
        {
            throw new Error('qualification receipt input schema mismatch');
        }
        const canonicalInput = {
            ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'results')),
            results: [...(input.results ?? [])].sort((left, right) => String(left?.scene?.id ?? '').localeCompare(String(right?.scene?.id ?? '')))
        };
        const inputDigest = gateDigest(canonicalInput);
        if (receipt.input?.digest !== inputDigest)
        {
            errors.push('qualification receipt input digest mismatch');
        }
        const orderedResults = [...input.results].sort((left, right) => left.scene.id.localeCompare(right.scene.id));
        verifyPublicShellLocaleRawRefs({ root, results: orderedResults });
        if (receipt.input?.sceneCount !== orderedResults.length)
        {
            errors.push('qualification receipt input scene count mismatch');
        }
        if (JSON.stringify(receipt.matrix) !== JSON.stringify({
            schema: gate.matrix.schema,
            digest: gate.matrix.contentDigest,
            sourceCommit: gate.matrix.identity.sourceCommit,
            sceneCount: gate.matrix.scenes.length,
            locales: gate.matrix.locales.map((locale) => locale.code),
            issueCounts: Object.fromEntries([...new Set(gate.matrix.scenes.map((scene) => scene.issue))].sort((left, right) => left - right)
                .map((issue) => [String(issue), gate.matrix.scenes.filter((scene) => scene.issue === issue).length]))
        }))
        {
            errors.push('qualification receipt matrix summary mismatch');
        }
        if (JSON.stringify(receipt.coverage) !== JSON.stringify(publicShellLocaleCoverage(gate.matrix)))
        {
            errors.push('qualification receipt coverage mismatch');
        }
        const expectedScenes = orderedResults.map(compactPublicShellLocaleScene);
        if (JSON.stringify(receipt.scenes) !== JSON.stringify(expectedScenes))
        {
            errors.push('qualification receipt scene evidence mismatch');
        }
        if (!Array.isArray(receipt.errors) || receipt.errors.length !== 0
            || !Array.isArray(receipt.warnings) || receipt.warnings.length !== 0
            || !Array.isArray(receipt.notObserved) || receipt.notObserved.length !== 0
            || receipt.firstFailure !== null)
        {
            errors.push('qualification receipt contains errors, warnings, not-observed evidence, or a first failure');
        }
        if (receipt.contentDigest !== gateDigest(withoutDigest(receipt)))
        {
            errors.push('qualification receipt content digest mismatch');
        }
        const caller = await readPublicShellLocaleCallerRoot({
            root, matrix: gate.matrix, buildDigest: build.digest, buildReceiptFile: gate.receiptFile,
            callerRootRef, callerOwner, browserReceiptFile, fixtureProviderFile
        });
        validatePublicShellLocaleSubResults({
            matrix: gate.matrix, results: input.results, buildDigest: build.digest, identity: caller.identity
        });
        if (!isDeepStrictEqual(receipt.identity, caller.identity))
        {
            errors.push('qualification receipt identity closure mismatch');
        }
        requirePublicShellLocaleCausalVerification();
    }
    catch (error)
    {
        errors.push(error.message);
    }
    return { ok: errors.length === 0, errors, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        if (options.help)
        {
            process.stdout.write('node tools/test-matrix/verify-public-shell-locale.mjs <receipt> [--root <repo>] [--input <sub-results>] [--build-receipt <receipt>] [--browser-receipt <current-parent>]\n');
        }
        else
        {
            const result = await verifyPublicShellLocaleQualification({
                root: options.root ?? defaultRoot,
                receiptFile: options.receipt,
                buildReceiptFile: options['build-receipt'] ?? null,
                inputFile: options.input ?? null,
                browserReceiptFile: options['browser-receipt'] ?? process.env.FSUSBLOG_BROWSER_CONTRACT_RECEIPT
                    ?? '.tmp/browser-contract/receipt.json'
            });
            if (!result.ok)
            {
                throw new Error(result.errors.join('; '));
            }
            process.stdout.write(JSON.stringify({ status: 'success', receipt: options.receipt ?? defaultReceipt }) + '\n');
        }
    }
    catch (error)
    {
        process.stderr.write(`[public-shell-locale-verify] ${error.message}\n`);
        process.exitCode = 1;
    }
}
