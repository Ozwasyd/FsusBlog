
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
    gateDigest,
    publicShellLocaleQualificationSchema,
    publicShellLocaleSubResultSchema,
    publicShellLocaleSubResultsSchema,
    sortedUnique
} from './public-shell-locale-gate.mjs';

export class PublicShellLocaleEvidenceError extends Error
{
    constructor(message, details = {})
    {
        super(message);
        this.name = 'PublicShellLocaleEvidenceError';
        this.code = details.code ?? 'invalid-evidence';
        this.sceneId = details.sceneId ?? null;
        this.firstFailure = details.firstFailure ?? { code: this.code, message, sceneId: this.sceneId };
        this.rawRefs = details.rawRefs ?? [];
    }
}

function reject(message, details = {})
{
    throw new PublicShellLocaleEvidenceError(message, details);
}

function equal(actual, expected, label, details = {})
{
    if (!isDeepStrictEqual(actual, expected))
    {
        reject(`${label} does not match canonical authority`, details);
    }
}

function nonEmptyString(value, label, details = {})
{
    if (typeof value !== 'string' || !value.trim())
    {
        reject(`${label} must be a non-empty string`, details);
    }
}

function digest(value, label, details = {})
{
    if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value))
    {
        reject(`${label} must be a SHA-256 digest`, details);
    }
}

function integer(value, label, details = {})
{
    if (!Number.isInteger(value) || value < 0)
    {
        reject(`${label} must be a non-negative integer`, details);
    }
}

function exactKeys(value, allowed, label, details = {})
{
    const actual = Object.keys(value ?? {}).sort();
    const expected = [...allowed].sort();
    if (!isDeepStrictEqual(actual, expected))
    {
        reject(`${label} contains an unregistered field`, details);
    }
}

function sceneMetadata(scene)
{
    return {
        id: scene.id,
        issue: scene.issue,
        negotiationId: scene.negotiationId,
        locale: scene.locale,
        source: scene.source,
        route: scene.route,
        surface: scene.surface,
        authActionContext: scene.authActionContext,
        viewport: scene.viewport,
        stage: scene.stage,
        transition: scene.transition,
        expectedKeys: scene.expectedKeys,
        requiredDomains: scene.requiredDomains,
        requiredFont: scene.requiredFont,
        selectorItems: scene.selectorItems,
        document: scene.document,
        networkPolicy: scene.networkPolicy,
        geometryRef: scene.geometryRef,
        evidenceId: scene.evidenceId
    };
}

function matrixPolicyDigest(matrix)
{
    const routeDomains = [...new Map(matrix.scenes.map((scene) => [scene.route, {
        route: scene.route,
        requiredDomains: scene.requiredDomains
    }])).values()].sort((left, right) => left.route.localeCompare(right.route));
    return gateDigest({ schema: 'fsusblog.public-shell-locale-domain-policy.v1', routes: routeDomains });
}

function artifactPolicyDigest(matrix)
{
    return gateDigest({
        schema: 'fsusblog.public-shell-locale-artifact-policy.v1',
        refs: matrix.identity.refs.map((item) => ({ path: item.path, digest: item.digest }))
    });
}

export function publicShellLocaleIdentity(matrix, buildDigest, dynamic = null)
{
    const identity = {
        sourceCommit: matrix.identity.sourceCommit,
        worktreeFingerprint: matrix.identity.worktreeFingerprint,
        matrixDigest: matrix.contentDigest,
        buildDigest,
        runtimeId: dynamic?.runtimeId ?? null,
        fixtureId: dynamic?.fixtureId ?? null,
        browserId: dynamic?.browserId ?? null,
        catalogDigest: matrix.identity.catalogDigest,
        artifactPolicyDigest: artifactPolicyDigest(matrix),
        domainPolicyDigest: matrixPolicyDigest(matrix),
        fontPolicyDigest: matrix.fontPlan.digest,
        fontPlanDigest: matrix.fontPlan.digest
    };
    return identity;
}

function validateIdentity(identity, expected, sceneId)
{
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    {
        reject('sub-result identity is missing', { code: 'identity-missing', sceneId });
    }
    for (const key of Object.keys(expected))
    {
        if (key === 'runtimeId' || key === 'fixtureId' || key === 'browserId')
        {
            nonEmptyString(identity[key], `identity.${key}`, { code: 'identity-invalid', sceneId });
        }
        else
        {
            nonEmptyString(identity[key], `identity.${key}`, { code: 'identity-invalid', sceneId });
        }
        if (identity[key] !== expected[key])
        {
            reject(`identity.${key} crosses the current run`, { code: 'cross-run-identity', sceneId });
        }
    }
}

function validateRefs(refs, sceneId)
{
    if (!Array.isArray(refs) || refs.length === 0)
    {
        reject('sub-result refs are missing', { code: 'refs-missing', sceneId });
    }
    const paths = new Set();
    for (const ref of refs)
    {
        nonEmptyString(ref?.path, 'sub-result ref.path', { code: 'ref-invalid', sceneId });
        if (paths.has(ref.path))
        {
            reject(`duplicate sub-result ref: ${ref.path}`, { code: 'ref-duplicate', sceneId, rawRefs: refs });
        }
        paths.add(ref.path);
        digest(ref.digest, `sub-result ref ${ref.path}.digest`, { code: 'ref-invalid', sceneId });
    }
}

function validateObserved(scene, observed, sceneId, localeCodes)
{
    if (!observed || typeof observed !== 'object' || Array.isArray(observed))
    {
        reject('sub-result observed evidence is missing', { code: 'observed-missing', sceneId });
    }
    exactKeys(observed, [
        'locale', 'uiLocale', 'source', 'route', 'stage', 'copyKeys', 'requiredDomains', 'fontFaceIds',
        'selectorLocales', 'network', 'commitGenerations', 'geometry', 'preference', 'failureRecovery',
        'consoleErrors', 'warnings', 'notObserved', 'issues'
    ], 'sub-result observed evidence', { code: 'unsupported-observation', sceneId });
    equal(observed.locale, scene.locale, 'observed.locale', { code: 'observed-locale', sceneId });
    equal(observed.uiLocale, scene.transition?.expectedUiLocale ?? scene.locale, 'observed.uiLocale', { code: 'observed-ui-locale', sceneId });
    equal(observed.source, scene.source, 'observed.source', { code: 'observed-source', sceneId });
    equal(observed.route, scene.route, 'observed.route', { code: 'observed-route', sceneId });
    equal(observed.stage, scene.stage, 'observed.stage', { code: 'observed-stage', sceneId });
    equal(observed.copyKeys, scene.expectedKeys, 'observed.copyKeys', { code: 'copy-key-mismatch', sceneId });
    equal(observed.requiredDomains, scene.requiredDomains, 'observed.requiredDomains', { code: 'domain-mismatch', sceneId });
    equal(observed.fontFaceIds, scene.requiredFont.faceIds, 'observed.fontFaceIds', { code: 'font-mismatch', sceneId });
    equal(observed.selectorLocales, localeCodes, 'observed.selectorLocales', { code: 'selector-mismatch', sceneId });

    const network = observed.network;
    exactKeys(network, [
        'checked', 'domainSet', 'fontSet', 'localeSet', 'includeCacheAndPreload',
        'businessDataReRequests', 'requestCounts'
    ], 'sub-result network evidence', { code: 'unsupported-network-field', sceneId });
    if (network?.checked !== true)
    {
        reject('network observation is not checked', { code: 'network-not-observed', sceneId });
    }
    equal(network.domainSet, scene.requiredDomains, 'observed.network.domainSet', { code: 'network-domain-mismatch', sceneId });
    equal(network.fontSet, scene.requiredFont.faceIds, 'observed.network.fontSet', { code: 'network-font-mismatch', sceneId });
    equal(network.localeSet, scene.networkPolicy.localeSet, 'observed.network.localeSet', { code: 'network-locale-mismatch', sceneId });
    equal(network.includeCacheAndPreload, scene.networkPolicy.includeCacheAndPreload,
        'observed.network.includeCacheAndPreload', { code: 'network-policy-mismatch', sceneId });
    equal(network.businessDataReRequests, scene.networkPolicy.businessDataReRequests,
        'observed.network.businessDataReRequests', { code: 'network-policy-mismatch', sceneId });
    if (!network.requestCounts || typeof network.requestCounts !== 'object' || Array.isArray(network.requestCounts))
    {
        reject('network request counts are missing', { code: 'request-counts-missing', sceneId });
    }
    for (const [key, value] of Object.entries(network.requestCounts))
    {
        integer(value, `network.requestCounts.${key}`, { code: 'request-counts-invalid', sceneId });
    }

    const generations = observed.commitGenerations;
    exactKeys(generations, ['sameRun', 'document', 'locale', 'font', 'preference'],
        'sub-result commit generation evidence', { code: 'unsupported-generation-field', sceneId });
    if (!generations || generations.sameRun !== true)
    {
        reject('commit generation evidence is missing or cross-run', { code: 'generation-not-observed', sceneId });
    }
    for (const key of ['document', 'locale', 'font', 'preference'])
    {
        integer(generations[key], `commitGenerations.${key}`, { code: 'generation-invalid', sceneId });
    }

    exactKeys(observed.geometry, ['inspected', 'ref', 'viewport', 'layoutStable'],
        'sub-result geometry evidence', { code: 'unsupported-geometry-field', sceneId });
    if (observed.geometry?.inspected !== true || observed.geometry.ref !== scene.geometryRef)
    {
        reject('geometry evidence is missing or not bound to the matrix', { code: 'geometry-not-observed', sceneId });
    }
    equal(observed.geometry.viewport, scene.viewport, 'observed.geometry.viewport', { code: 'geometry-mismatch', sceneId });
    exactKeys(observed.preference, ['checked', 'persistenceChecked', 'state'],
        'sub-result preference evidence', { code: 'unsupported-preference-field', sceneId });
    if (observed.preference?.checked !== true || observed.preference.persistenceChecked !== true)
    {
        reject('preference/persistence evidence is missing', { code: 'preference-not-observed', sceneId });
    }
    exactKeys(observed.failureRecovery, ['checked', 'recoveryObserved', 'state'],
        'sub-result failure/recovery evidence', { code: 'unsupported-failure-field', sceneId });
    if (observed.failureRecovery?.checked !== true || observed.failureRecovery.recoveryObserved !== true)
    {
        reject('failure/recovery evidence is missing', { code: 'failure-recovery-not-observed', sceneId });
    }
    if (!Array.isArray(observed.consoleErrors) || observed.consoleErrors.length !== 0)
    {
        reject('console errors are present', { code: 'console-errors', sceneId });
    }
    if (!Array.isArray(observed.warnings) || observed.warnings.length !== 0)
    {
        reject('warnings are present', { code: 'warnings', sceneId });
    }
    if (!Array.isArray(observed.notObserved) || observed.notObserved.length !== 0)
    {
        reject('not-observed evidence is present', { code: 'not-observed', sceneId });
    }
    if (!Array.isArray(observed.issues) || observed.issues.length !== 0)
    {
        reject('sub-result issues are present', { code: 'issues', sceneId });
    }
}

export function validatePublicShellLocaleSubResults({ matrix, results, buildDigest })
{
    if (!Array.isArray(results))
    {
        reject('sub-results must be an array', { code: 'results-missing' });
    }
    const required = new Map(matrix.scenes.map((scene) => [scene.id, scene]));
    const seen = new Set();
    const localeCodes = matrix.locales.map((locale) => locale.code);
    let identity = null;
    for (const result of results)
    {
        const sceneId = result?.scene?.id ?? null;
        exactKeys(result, [
            'schema', 'status', 'evidenceKind', 'qualificationEligible', 'browserSpawnCount',
            'subMatrixSpawnCount', 'scene', 'observed', 'identity', 'refs', 'contentDigest'
        ], 'sub-result', { code: 'unsupported-sub-result-field', sceneId });
        if (result?.schema !== publicShellLocaleSubResultSchema)
        {
            reject('sub-result schema mismatch', { code: 'sub-result-schema', sceneId });
        }
        if (result?.status !== 'passed' || result?.qualificationEligible !== true
            || result?.evidenceKind !== 'browser-contract')
        {
            reject('diagnostic or non-passing sub-result cannot qualify', { code: 'diagnostic-result', sceneId, rawRefs: result?.refs });
        }
        if (!required.has(sceneId))
        {
            reject(`sub-result scene is not in the required matrix: ${sceneId ?? '<missing>'}`, { code: 'extra-scene', sceneId, rawRefs: result?.refs });
        }
        if (seen.has(sceneId))
        {
            reject(`duplicate sub-result scene: ${sceneId}`, { code: 'duplicate-scene', sceneId, rawRefs: result?.refs });
        }
        seen.add(sceneId);
        const scene = required.get(sceneId);
        equal(result.scene, sceneMetadata(scene), 'sub-result scene metadata', { code: 'scene-metadata-mismatch', sceneId });
        if (result.browserSpawnCount !== 0 || result.subMatrixSpawnCount !== 0)
        {
            reject('aggregator input reports browser or sub-matrix spawning', { code: 'browser-spawn', sceneId });
        }
        validateRefs(result.refs, sceneId);
        const expectedContentDigest = gateDigest(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'contentDigest')));
        if (result.contentDigest !== expectedContentDigest)
        {
            reject('sub-result content digest mismatch', { code: 'sub-result-digest', sceneId, rawRefs: result.refs });
        }
        const expectedIdentity = publicShellLocaleIdentity(matrix, buildDigest, identity ?? result.identity);
        validateIdentity(result.identity, expectedIdentity, sceneId);
        if (identity === null)
        {
            identity = result.identity;
        }
        validateObserved(scene, result.observed, sceneId, localeCodes);
    }
    const requiredIds = [...required.keys()].sort();
    const actualIds = [...seen].sort();
    if (!isDeepStrictEqual(actualIds, requiredIds))
    {
        const missing = requiredIds.filter((id) => !seen.has(id));
        reject(`sub-result required set is incomplete; missing ${missing.length} scene(s)`, {
            code: 'missing-scene',
            sceneId: missing[0] ?? null
        });
    }
    return { identity, orderedResults: [...results].sort((left, right) => left.scene.id.localeCompare(right.scene.id)) };
}

function issueCounts(matrix)
{
    return Object.fromEntries(sortedUnique(matrix.scenes.map((scene) => scene.issue)).map((issue) => [String(issue), matrix.scenes.filter((scene) => scene.issue === issue).length]));
}

export function publicShellLocaleCoverage(matrix)
{
    return {
        locales: matrix.locales.map((locale) => locale.code),
        sceneCount: matrix.scenes.length,
        issueCounts: issueCounts(matrix),
        stages: sortedUnique(matrix.scenes.map((scene) => scene.stage)),
        routes: sortedUnique(matrix.scenes.map((scene) => scene.route)),
        authContexts: sortedUnique(matrix.scenes.map((scene) => scene.authActionContext)),
        viewports: [...new Set(matrix.scenes.map((scene) => scene.viewport.width))].sort((left, right) => left - right),
        negotiationSources: sortedUnique(matrix.negotiationCases.map((item) => item.source))
    };
}

export function compactPublicShellLocaleScene(result)
{
    return {
        id: result.scene.id,
        issue: result.scene.issue,
        locale: result.scene.locale,
        source: result.scene.source,
        route: result.scene.route,
        stage: result.scene.stage,
        authActionContext: result.scene.authActionContext,
        viewport: result.scene.viewport,
        expectedCopyKeys: result.scene.expectedKeys,
        observedCopyKeys: result.observed.copyKeys,
        requiredDomains: result.scene.requiredDomains,
        observedDomains: result.observed.requiredDomains,
        requiredFont: result.scene.requiredFont,
        observedFontFaceIds: result.observed.fontFaceIds,
        requestCounts: result.observed.network.requestCounts,
        commitGenerations: result.observed.commitGenerations,
        geometry: result.observed.geometry,
        preference: result.observed.preference,
        failureRecovery: result.observed.failureRecovery,
        consoleErrors: result.observed.consoleErrors,
        warnings: result.observed.warnings,
        notObserved: result.observed.notObserved,
        refs: result.refs,
        contentDigest: result.contentDigest
    };
}

export function createPublicShellLocaleQualification({ gate, build, inputPath, inputDigest, identity, results, verifierCommand })
{
    const body = {
        schema: publicShellLocaleQualificationSchema,
        status: 'success',
        evidenceKind: 'verified',
        qualificationEligible: true,
        producer: {
            command: 'node tools/test-matrix/aggregate-public-shell-locale.mjs',
            browserSpawnCount: 0,
            subMatrixSpawnCount: 0
        },
        verifier: {
            command: verifierCommand,
            independent: true,
            browserSpawnCount: 0,
            subMatrixSpawnCount: 0
        },
        identity,
        matrix: {
            schema: gate.matrix.schema,
            digest: gate.matrix.contentDigest,
            sourceCommit: gate.matrix.identity.sourceCommit,
            sceneCount: gate.matrix.scenes.length,
            locales: gate.matrix.locales.map((locale) => locale.code),
            issueCounts: issueCounts(gate.matrix)
        },
        build: {
            receiptPath: pathRelative(gate.root, gate.receiptFile),
            digest: build.digest,
            sourceState: build.sourceState,
            domains: build.domains
        },
        input: {
            schema: publicShellLocaleSubResultsSchema,
            path: pathRelative(gate.root, inputPath),
            digest: inputDigest,
            sceneCount: results.length
        },
        coverage: publicShellLocaleCoverage(gate.matrix),
        scenes: results.map(compactPublicShellLocaleScene),
        errors: [],
        warnings: [],
        notObserved: [],
        firstFailure: null
    };
    return { ...body, contentDigest: gateDigest(body) };
}

export function createPublicShellLocaleFailure({ gate, inputPath, inputDigest, results = [], error })
{
    const body = {
        schema: publicShellLocaleQualificationSchema,
        status: 'failed',
        evidenceKind: 'diagnostic',
        qualificationEligible: false,
        producer: {
            command: 'node tools/test-matrix/aggregate-public-shell-locale.mjs',
            browserSpawnCount: 0,
            subMatrixSpawnCount: 0
        },
        matrix: {
            schema: gate.matrix.schema,
            digest: gate.matrix.contentDigest,
            sourceCommit: gate.matrix.identity.sourceCommit,
            sceneCount: gate.matrix.scenes.length,
            locales: gate.matrix.locales.map((locale) => locale.code)
        },
        input: {
            schema: publicShellLocaleSubResultsSchema,
            path: pathRelative(gate.root, inputPath),
            digest: inputDigest,
            sceneCount: results.length
        },
        rawRefs: results.flatMap((result) => result?.refs ?? []),
        scenes: [],
        errors: [error.message],
        warnings: [],
        notObserved: [],
        firstFailure: error.firstFailure ?? { code: 'aggregate-failure', message: error.message, sceneId: null }
    };
    return { ...body, contentDigest: gateDigest(body) };
}

function pathRelative(root, absolute)
{
    return `./${path.relative(root, absolute).replaceAll(path.sep, '/')}`;
}
