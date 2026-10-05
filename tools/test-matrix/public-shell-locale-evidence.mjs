
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
    gateDigest,
    publicShellLocaleQualificationSchema,
    publicShellLocaleSubResultSchema,
    publicShellLocaleSubResultsSchema,
    sortedUnique
} from './public-shell-locale-gate.mjs';

const {
    assertBrowserPlanActualMatch,
    assertBrowserRenderingObservation
} = await import(new URL('../test/playwright-browser-identity.mjs', import.meta.url));

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

function rootBindingKeys(value, fields, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    {
        reject(`root binding ${label} must be a JSON object`, { code: 'root-binding' });
    }
    exactKeys(value, fields, `root binding ${label}`, { code: 'root-binding' });
}

function rootBindingJson(value, ancestors = new Set())
{
    if (value === null || ['string', 'boolean'].includes(typeof value))
    {
        return;
    }
    if (typeof value === 'number' && Number.isFinite(value))
    {
        return;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)
        || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
    {
        reject('root binding must contain only serializable JSON values', { code: 'root-binding' });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value).filter((key) => !(Array.isArray(value) && key === 'length'));
    if ((Array.isArray(value) && keys.length !== value.length)
        || keys.some((key) => typeof key !== 'string' || !descriptors[key].enumerable
            || !Object.hasOwn(descriptors[key], 'value')))
    {
        reject('root binding cannot contain hidden fields or accessors', { code: 'root-binding' });
    }
    ancestors.add(value);
    for (const key of keys)
    {
        rootBindingJson(descriptors[key].value, ancestors);
    }
    ancestors.delete(value);
}

function rootBindingBrowser(plan, actual)
{
    const fields = ['schema', 'executionClass', 'evidenceClass', 'qualificationEligible', 'managedExecutable',
        'browserName', 'browserVersion', 'revision', 'executablePath', 'executableSha256',
        'playwright', 'launchOptions', 'rendering', 'contentDigest'];
    rootBindingKeys(plan, fields, 'plan');
    rootBindingKeys(actual, [...fields, 'planDigest', 'renderingObservation'], 'actual');
    rootBindingKeys(plan.playwright, ['package', 'version', 'packageDigest', 'browserCatalogDigest'], 'playwright');
    for (const field of ['browserVersion', 'revision', 'executablePath', 'executableSha256'])
    {
        nonEmptyString(plan[field], `root binding plan.${field}`);
    }
    for (const field of ['package', 'version'])
    {
        nonEmptyString(plan.playwright[field], `root binding playwright.${field}`);
    }
    for (const field of ['packageDigest', 'browserCatalogDigest'])
    {
        digest(plan.playwright[field], `root binding playwright.${field}`);
    }
    rootBindingKeys(plan.launchOptions, ['headless', 'executablePath', 'args'], 'launch options');
    rootBindingKeys(plan.rendering, ['fontSetDigest', 'localeDataDigest', 'locale', 'deviceScaleFactor',
        'renderingMode', 'colorScheme', 'gpuMode'], 'rendering');
    rootBindingKeys(actual.renderingObservation, ['locale', 'deviceScaleFactor', 'colorScheme', 'renderer'], 'rendering observation');
    if (plan.browserName !== 'chromium' || plan.evidenceClass !== 'browser-contract'
        || actual.schema !== 'fsusblog.playwright-browser-actual.v1'
        || plan.playwright.package !== '@playwright/test' || plan.launchOptions.headless !== true
        || plan.launchOptions.executablePath !== plan.executablePath
        || !Array.isArray(plan.launchOptions.args)
        || plan.launchOptions.args.some((arg) => typeof arg !== 'string' || !arg.trim())
        || new Set(plan.launchOptions.args).size !== plan.launchOptions.args.length)
    {
        reject('root binding browser plan or actual is invalid', { code: 'root-binding' });
    }
    const { contentDigest, ...body } = actual;
    if (contentDigest !== `sha256:${gateDigest(body)}`)
    {
        reject('root binding actual digest mismatch', { code: 'root-binding' });
    }
    try
    {
        // These existing validators are pure. Managed policy/catalog/binary I/O
        // and the actual launch remain with the Root browser owner.
        assertBrowserPlanActualMatch(plan, actual);
        assertBrowserRenderingObservation(plan, actual.renderingObservation);
    }
    catch (error)
    {
        reject(`root binding browser identity is invalid: ${error.message}`, { code: 'root-binding' });
    }
}

/**
 * Derive caller-owned identity from a closed, serializable Root binding.
 * This pure mapping neither reopens refs nor proves a launch or raw qualification.
 * Root supplies it only after the owned launch and rendering observation resolve.
 */
export function derivePublicShellLocaleRootIdentity(matrix, binding)
{
    rootBindingJson(binding);
    rootBindingKeys(binding, ['schema', 'matrixDigest', 'sourceState', 'buildDigest', 'identity', 'preparation',
        'resources', 'runtimeId', 'fixtureReceiptDigest', 'plan', 'actual', 'launchOrdinal', 'refs'], 'body');
    rootBindingKeys(binding.sourceState, ['commit', 'worktreeFingerprint'], 'source');
    rootBindingKeys(binding.identity, ['commit', 'runId', 'laneId', 'namespace'], 'identity');
    rootBindingKeys(binding.preparation, ['id', 'startedAt'], 'preparation');
    rootBindingKeys(binding.resources, ['fixtureRoot', 'databaseInstance', 'databaseSchema', 'redisInstance', 'redisNamespace'], 'resources');
    digest(binding.matrixDigest, 'root binding matrixDigest');
    digest(binding.buildDigest, 'root binding buildDigest');
    digest(binding.fixtureReceiptDigest, 'root binding fixtureReceiptDigest');
    digest(binding.sourceState.worktreeFingerprint, 'root binding source fingerprint');
    if (binding.schema !== 'fsusblog.public-shell-locale-root-binding.v1'
        || matrix?.schema !== 'fsusblog.public-shell-locale-matrix.v1'
        || binding.matrixDigest !== matrix.contentDigest
        || typeof binding.sourceState.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(binding.sourceState.commit)
        || binding.sourceState.commit !== matrix.identity?.sourceCommit
        || binding.sourceState.worktreeFingerprint !== matrix.identity?.worktreeFingerprint
        || binding.identity.commit !== binding.sourceState.commit || binding.launchOrdinal !== 1)
    {
        reject('root binding schema, matrix, source or launch ordinal mismatch', { code: 'root-binding' });
    }
    for (const field of ['runId', 'laneId', 'namespace'])
    {
        if (typeof binding.identity[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(binding.identity[field]))
        {
            reject(`root binding identity.${field} is invalid`, { code: 'root-binding' });
        }
    }
    nonEmptyString(binding.runtimeId, 'root binding runtimeId');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(binding.runtimeId))
    {
        reject('root binding runtimeId is not a canonical runtime run ID', { code: 'root-binding' });
    }
    if (typeof binding.preparation.id !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(binding.preparation.id)
        || typeof binding.preparation.startedAt !== 'string' || !Number.isFinite(Date.parse(binding.preparation.startedAt))
        || new Date(binding.preparation.startedAt).toISOString() !== binding.preparation.startedAt)
    {
        reject('root binding preparation is invalid', { code: 'root-binding' });
    }
    for (const [field, value] of Object.entries(binding.resources))
    {
        nonEmptyString(value, `root binding resources.${field}`);
    }
    if (!path.isAbsolute(binding.resources.fixtureRoot) || path.resolve(binding.resources.fixtureRoot) !== binding.resources.fixtureRoot)
    {
        reject('root binding fixture root must be an absolute normalized path', { code: 'root-binding' });
    }
    const roles = ['provider-state', 'fixture-manifest', 'prepare-state', 'fixture-receipt',
        'build-receipt', 'browser-plan', 'browser-actual', 'cookie-source'];
    if (!Array.isArray(binding.refs) || binding.refs.length !== roles.length)
    {
        reject('root binding requires exactly eight authority refs', { code: 'root-binding' });
    }
    const seenRoles = new Set();
    const seenPaths = new Set();
    const prefix = `.tmp/browser-contract/runs/${binding.identity.namespace}/bindings/${binding.preparation.id}/`;
    for (const ref of binding.refs)
    {
        rootBindingKeys(ref, ['role', 'path', 'digest'], 'ref');
        if (!roles.includes(ref.role) || seenRoles.has(ref.role) || typeof ref.path !== 'string'
            || !ref.path.startsWith(prefix) || ref.path.length === prefix.length
            || ref.path.includes('\\') || ref.path.includes('\0')
            || ref.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
            || seenPaths.has(ref.path))
        {
            reject('root binding ref role or path is invalid or duplicate', { code: 'root-binding' });
        }
        digest(ref.digest, 'root binding ref digest');
        seenRoles.add(ref.role);
        seenPaths.add(ref.path);
    }
    rootBindingBrowser(binding.plan, binding.actual);
    const fixtureId = gateDigest({
        fixtureReceiptDigest: binding.fixtureReceiptDigest, preparation: binding.preparation,
        sourceState: binding.sourceState, buildDigest: binding.buildDigest, runtimeId: binding.runtimeId,
        identity: binding.identity, resources: binding.resources
    });
    const browserId = gateDigest({
        fixtureId, runtimeId: binding.runtimeId, preparation: binding.preparation,
        sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        planDigest: binding.plan.contentDigest, actualDigest: binding.actual.contentDigest, ordinal: binding.launchOrdinal
    });
    return publicShellLocaleIdentity(matrix, binding.buildDigest, { runtimeId: binding.runtimeId, fixtureId, browserId });
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

const notApplicableEvidence = Object.freeze({ applicable: false, reason: 'not-required-by-canonical-scene' });
const firstResponseApplicability = Object.freeze({
    network: false, commitGenerations: false, geometry: false, preference: false, failureRecovery: false
});
const sceneStageContracts = Object.freeze([
    { issue: 2083, stages: ['first-response'], applicability: firstResponseApplicability },
    { issue: 2084, stages: ['first-html', 'hydration-start', 'interactive-ready', 'selector-open'],
        applicability: Object.freeze({ ...firstResponseApplicability, geometry: true }) },
    { issue: 2085, stages: ['initial-network'],
        applicability: Object.freeze({ ...firstResponseApplicability, network: true }) },
    { issue: 2086, stages: ['preparing', 'commit', 'post-commit', 'spa-navigation', 'refresh', 'back-forward', 'latest-wins'],
        applicability: Object.freeze({ network: true, commitGenerations: true, geometry: true, preference: true, failureRecovery: false }) },
    { issue: 2087, stages: ['domain-failure', 'font-failure', 'preference-failure', 'revision-conflict', 'artifact-invalid', 'superseded-failure', 'retry'],
        applicability: Object.freeze({ network: true, commitGenerations: true, geometry: true, preference: true, failureRecovery: true }) }
]);

/** Applicability is derived from the canonical scene, never an observation's opt-out flag. */
export function publicShellLocaleStageApplicability(scene)
{
    const contract = sceneStageContracts.find((item) => item.issue === scene?.issue && item.stages.includes(scene?.stage));
    if (!contract)
    {
        reject('canonical scene has an unsupported issue/stage combination', { code: 'unsupported-stage', sceneId: scene?.id });
    }
    return contract.applicability;
}

function validateNetworkEvidence(scene, network, sceneId)
{
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
}

function validateGenerationEvidence(_scene, generations, sceneId)
{
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
}

function validateGeometryEvidence(scene, geometry, sceneId)
{
    exactKeys(geometry, ['inspected', 'ref', 'viewport', 'layoutStable'],
        'sub-result geometry evidence', { code: 'unsupported-geometry-field', sceneId });
    if (geometry?.inspected !== true || geometry.ref !== scene.geometryRef)
    {
        reject('geometry evidence is missing or not bound to the matrix', { code: 'geometry-not-observed', sceneId });
    }
    equal(geometry.viewport, scene.viewport, 'observed.geometry.viewport', { code: 'geometry-mismatch', sceneId });
}

function validatePreferenceEvidence(_scene, preference, sceneId)
{
    exactKeys(preference, ['checked', 'persistenceChecked', 'state'],
        'sub-result preference evidence', { code: 'unsupported-preference-field', sceneId });
    if (preference?.checked !== true || preference.persistenceChecked !== true)
    {
        reject('preference/persistence evidence is missing', { code: 'preference-not-observed', sceneId });
    }
}

function validateFailureRecoveryEvidence(_scene, failureRecovery, sceneId)
{
    exactKeys(failureRecovery, ['checked', 'recoveryObserved', 'state'],
        'sub-result failure/recovery evidence', { code: 'unsupported-failure-field', sceneId });
    if (failureRecovery?.checked !== true || failureRecovery.recoveryObserved !== true)
    {
        reject('failure/recovery evidence is missing', { code: 'failure-recovery-not-observed', sceneId });
    }
}

function validateObserved(scene, observed, sceneId, localeCodes)
{
    const applicability = publicShellLocaleStageApplicability(scene);
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
    for (const [field, validate] of [
        ['network', validateNetworkEvidence], ['commitGenerations', validateGenerationEvidence],
        ['geometry', validateGeometryEvidence], ['preference', validatePreferenceEvidence],
        ['failureRecovery', validateFailureRecoveryEvidence]
    ])
    {
        if (applicability[field])
        {
            validate(scene, observed[field], sceneId);
        }
        else
        {
            equal(observed[field], notApplicableEvidence, `observed.${field} non-applicable evidence`,
                { code: 'non-applicable-evidence', sceneId });
        }
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

export function validatePublicShellLocaleSubResults({ matrix, results, buildDigest, identity })
{
    if (!identity)
    {
        reject('current caller expected identity is required', { code: 'caller-identity-missing' });
    }
    const expectedIdentity = publicShellLocaleIdentity(matrix, buildDigest, identity);
    equal(identity, expectedIdentity, 'caller identity', { code: 'caller-identity-invalid' });
    if (!Array.isArray(results))
    {
        reject('sub-results must be an array', { code: 'results-missing' });
    }
    const required = new Map(matrix.scenes.map((scene) => [scene.id, scene]));
    const seen = new Set();
    const localeCodes = matrix.locales.map((locale) => locale.code);
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
        validateIdentity(result.identity, expectedIdentity, sceneId);
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
