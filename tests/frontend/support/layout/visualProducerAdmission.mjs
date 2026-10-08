import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { governanceContentDigest, validateCurrentRunEvidenceContext, validateEvidenceLocatorRegistry } from '@fsusblog/layout-governance/evidence-location-contract';
import { locateCurrentRunEvidence, verifyCurrentRunEvidenceBinding } from '@fsusblog/layout-governance/evidence-locator';
import { resolveEvidenceReferencePayload } from '@fsusblog/layout-governance/evidence-publication';
import { locateTransportedCurrentRunEvidence } from '@fsusblog/layout-governance/evidence-transport';
import { assertBrowserPlanActualMatch, assertBrowserRenderingObservation, createCorrectnessBrowserPlan, validateBrowserIdentityPlan } from '@fsusblog/layout-governance/playwright-browser-identity';
import { validateJsonSchema } from '@fsusblog/layout-governance/schema-validator';

import { compositionDigest } from './compositionContracts.mjs';

export { inspectCompositionObservationDiagnostic, projectCompositionSceneState } from './visualCompositionObservation.mjs';

const canonicalRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const registryUrl = new URL('../../../../config/testing/evidence-locator-registry.json', import.meta.url);
const schemaUrl = new URL('../../../../config/schemas/layout-visual-adjudication.schema.json', import.meta.url);
const loadedSchema = readFileSync(schemaUrl);
const loadedSource = readFileSync(fileURLToPath(import.meta.url));
const authorityPaths = [
    'package.json',
    'tests/frontend/package.json',
    'tests/frontend/package-lock.json',
    'tests/frontend/support/layout/compositionContracts.mjs',
    'tests/frontend/support/layout/visualAdjudication.mjs',
    'tests/frontend/support/layout/visualCompositionObservation.mjs',
    'tools/test-matrix/schema-validator/validate.mjs',
    'tools/test-matrix/schema-validator/package.json',
    'tools/test-matrix/schema-validator/package-lock.json',
    'tools/test/evidence-location-contract.mjs',
    'tools/test/current-run-evidence-locator.mjs',
    'tools/test/current-run-evidence-transport.mjs',
    'tools/test/current-run-evidence-publication.mjs',
    'tools/test/playwright-browser-identity.mjs',
    'src/frontend/scripts/fsusui-root.mjs',
    'config/testing/evidence-locator-registry.json',
    'config/testing/playwright-browser-identity-policy.json',
    'config/schemas/layout-visual-adjudication.schema.json'
];
const loadedAuthorities = new Map(authorityPaths.map((path) => [path, readFileSync(resolve(canonicalRoot, path))]));
const importOwners = {
    'schema-validator': 'tools/test-matrix/schema-validator/validate.mjs',
    'evidence-location-contract': 'tools/test/evidence-location-contract.mjs',
    'evidence-locator': 'tools/test/current-run-evidence-locator.mjs',
    'evidence-transport': 'tools/test/current-run-evidence-transport.mjs',
    'evidence-publication': 'tools/test/current-run-evidence-publication.mjs',
    'playwright-browser-identity': 'tools/test/playwright-browser-identity.mjs',
    'composition-contracts': 'tests/frontend/support/layout/compositionContracts.mjs',
    'fsusui-source-resolver': 'src/frontend/scripts/fsusui-root.mjs'
};
const loadedImports = new Map(Object.keys(importOwners).map((name) =>
    [name, import.meta.resolve(`@fsusblog/layout-governance/${name}`)]));

function fail(code, message)
{
    const error = new Error(`[visual-producer-admission] ${message}`);
    error.code = `visual-admission-${code}`;
    throw error;
}

function bytesDigest(bytes)
{
    if (!Buffer.isBuffer(bytes))
    {
        fail('bytes-required', 'explicit artifact Buffer required');
    }
    return createHash('sha256').update(bytes).digest('hex');
}

function equal(left, right, label)
{
    if (compositionDigest(left) !== compositionDigest(right))
    {
        fail('binding-mismatch', label);
    }
}

function fresh()
{
    if (!readFileSync(schemaUrl).equals(loadedSchema)
        || !readFileSync(fileURLToPath(import.meta.url)).equals(loadedSource))
    {
        fail('version-drift', 'loaded consumer/schema bytes differ from current source');
    }
    for (const [name, importedUrl] of loadedImports)
    {
        const currentUrl = import.meta.resolve(`@fsusblog/layout-governance/${name}`);
        const expected = realpathSync(resolve(canonicalRoot, importOwners[name]));
        if (currentUrl !== importedUrl || realpathSync(fileURLToPath(importedUrl)) !== expected)
        {
            fail('module-owner-mismatch', `canonical alias resolves to another owner: ${name}`);
        }
    }
    for (const [path, bytes] of loadedAuthorities)
    {
        if (!readFileSync(resolve(canonicalRoot, path)).equals(bytes))
        {
            fail('version-drift', `loaded canonical dependency/authority differs: ${path}`);
        }
    }
}

export function visualProducerAdmissionIdentity()
{
    fresh();
    const identity = {
        schema: 'fsusblog.visual-producer-admission-identity.v1',
        moduleDigest: bytesDigest(loadedSource),
        importOwners: { ...importOwners },
        dependencyDigests: Object.fromEntries([...loadedAuthorities].map(([path, bytes]) => [path, bytesDigest(bytes)]))
    };
    return { ...identity, producerAdmissionDigest: compositionDigest(identity) };
}

function visualIdentity()
{
    const schema = JSON.parse(loadedSchema.toString('utf8'));
    return {
        schemaDigest: bytesDigest(loadedSchema),
        verifierDigest: bytesDigest(loadedAuthorities.get('tests/frontend/support/layout/visualAdjudication.mjs')),
        rubricDigest: compositionDigest(schema.$defs.rubric),
        rubricVersion: schema.properties.rubricVersion.const,
        verifierVersion: schema.properties.verifierVersion.const,
        producerAdmissionDigest: visualProducerAdmissionIdentity().producerAdmissionDigest
    };
}

function receiptDigest(receipt)
{
    const unsigned = { ...receipt };
    delete unsigned.contentDigest;
    return compositionDigest(unsigned);
}

function originPayload(origin, context, repositoryRoot)
{
    if (!origin || typeof origin.consumerId !== 'string')
    {
        fail('origin-required', 'registered canonical reference input required');
    }
    const allowed = new Set(['consumerId', 'explicitInputs', 'reference', 'transportManifestPath', 'expectedManifestDigest']);
    if (Object.keys(origin).some((key) => !allowed.has(key)))
    {
        fail('origin-options', 'unknown origin option; registries and callbacks cannot replace canonical authority');
    }
    const registry = validateEvidenceLocatorRegistry(JSON.parse(readFileSync(registryUrl, 'utf8')));
    const entry = registry.entries.find(({ consumerId }) => consumerId === origin.consumerId);
    if (!entry)
    {
        fail('consumer-unregistered', origin.consumerId);
    }
    const explicitCount = Array.isArray(origin.explicitInputs) ? origin.explicitInputs.length : 0;
    if (explicitCount + Number(Boolean(origin.reference)) !== 1)
    {
        fail('origin-cardinality', 'exactly one explicit origin input required');
    }
    const options = { context, registry, registryEntry: entry, repositoryRoot,
        ...(origin.reference ? { reference: origin.reference } : { explicitInputs: origin.explicitInputs }) };
    let located;
    let payloadReference;
    if (origin.transportManifestPath)
    {
        if (!/^sha256:[a-f0-9]{64}$/u.test(origin.expectedManifestDigest ?? ''))
        {
            fail('transport-digest-required', 'explicit current transport manifest digest required');
        }
        located = locateTransportedCurrentRunEvidence({ ...options,
            transportManifestPath: origin.transportManifestPath, expectedManifestDigest: origin.expectedManifestDigest });
        const entries = located.transportObject.archiveEntries.filter(({ role }) => role === 'payload');
        if (entries.length !== 1 || entries[0].path !== located.receipt.payload?.path
            || entries[0].digest !== located.receipt.payload.digest)
        {
            fail('payload-mapping', 'transport payload must map the exact canonical reference');
        }
        payloadReference = { ...located.receipt, payload: { ...located.receipt.payload, path: entries[0].extractedPath } };
    }
    else
    {
        if (origin.expectedManifestDigest)
        {
            fail('origin-options', 'transport digest without a transport manifest');
        }
        located = locateCurrentRunEvidence(options);
        payloadReference = located.receipt;
    }
    verifyCurrentRunEvidenceBinding(located.bindingReceipt, options);
    const resolved = resolveEvidenceReferencePayload(payloadReference, { repositoryRoot, ownedRoots: context.ownedRoots });
    const bytes = readFileSync(resolved.file);
    if (`sha256:${bytesDigest(bytes)}` !== located.receipt.payload.digest)
    {
        fail('payload-tampered', 'payload changed after canonical resolution');
    }
    return { bytes, payload: JSON.parse(bytes.toString('utf8')), bindingReceipt: located.bindingReceipt,
        transportConsumerReceipt: located.consumerReceipt ?? null };
}

/** Identity consistency only. No source/run provenance or producer qualification. */
export function inspectVisualBrowserBinding(plan, actual)
{
    fresh();
    validateBrowserIdentityPlan(plan);
    if (actual?.schema !== 'fsusblog.playwright-browser-actual.v1'
        || actual.contentDigest !== governanceContentDigest(actual))
    {
        fail('browser-seal', 'canonical actual browser schema/content seal required');
    }
    assertBrowserPlanActualMatch(plan, actual);
    assertBrowserRenderingObservation(plan, actual.renderingObservation);
    // Recreate using real canonical policy/package/catalog/font/locale/binary;
    // no caller fileSystem, requireFactory, policy, or verification callback.
    const base = createCorrectnessBrowserPlan({ browserName: plan.browserName,
        evidenceClass: plan.evidenceClass, locale: plan.rendering.locale });
    const additionalLaunchArgs = plan.launchOptions.args.filter((argument) => !base.launchOptions.args.includes(argument));
    const current = createCorrectnessBrowserPlan({ browserName: plan.browserName,
        evidenceClass: plan.evidenceClass, locale: plan.rendering.locale, additionalLaunchArgs });
    assertBrowserPlanActualMatch(current, actual);
    return { status: 'browser-identity-consistent-only', qualificationEligible: false,
        planDigest: current.contentDigest, actualDigest: actual.contentDigest };
}

/** Read-only current-run consumer foundation. Never a visual/producer acceptance. */
export function inspectVisualProducerAdmission({ visualReceipt, visualOrigin, browserOrigin,
    browserPlan, context, evidenceArtifacts, repositoryRoot = canonicalRoot, purpose })
{
    fresh();
    validateCurrentRunEvidenceContext(context);
    if (resolve(repositoryRoot) !== resolve(canonicalRoot) && purpose !== 'synthetic-contract-test')
    {
        fail('repository-scope', 'production admission uses this canonical repository only');
    }
    const schema = JSON.parse(loadedSchema.toString('utf8'));
    const errors = validateJsonSchema(visualReceipt, schema);
    if (errors.length)
    {
        fail('visual-schema', errors.join('; '));
    }
    if (visualReceipt.evidenceClass !== 'rendered' && purpose !== 'synthetic-contract-test')
    {
        fail('synthetic-not-admitted', 'synthetic input is restricted to explicit nonqualifying contract tests');
    }
    for (const [key, value] of Object.entries(visualIdentity()))
    {
        if (visualReceipt[key] !== value)
        {
            fail('version-drift', `stale visual ${key}`);
        }
    }
    if (visualReceipt.contentDigest !== receiptDigest(visualReceipt))
    {
        fail('visual-seal', 'visual receipt content digest mismatch');
    }
    const visual = originPayload(visualOrigin, context, repositoryRoot);
    equal(visual.payload, visualReceipt, 'caller receipt differs from canonical payload bytes');
    const binding = visualReceipt.binding;
    if (visualReceipt.compositionIdentity.sourceCommit !== context.sourceCommit
        || binding.runId !== context.schedulerRunId || binding.attemptId !== context.attemptId
        || `sha256:${binding.worktreeFingerprint}` !== context.worktreeFingerprint)
    {
        fail('binding-mismatch', 'visual source/worktree/run/attempt differs from canonical current-run origin');
    }
    const expected = new Set(visualReceipt.evidence.map(({ id }) => id));
    if (expected.size !== visualReceipt.evidence.length || !evidenceArtifacts
        || Object.keys(evidenceArtifacts).length !== expected.size
        || Object.keys(evidenceArtifacts).some((id) => !expected.has(id)))
    {
        fail('evidence-cardinality', 'explicit evidence set must match visual references exactly');
    }
    for (const reference of visualReceipt.evidence)
    {
        const artifact = evidenceArtifacts[reference.id];
        equal(reference.binding, binding, `${reference.id}: cross-scene/current-run reference`);
        if (bytesDigest(artifact?.bytes) !== reference.contentDigest
            || bytesDigest(artifact?.opaqueProducerBytes) !== reference.opaqueProducerDigest)
        {
            fail('evidence-tampered', `${reference.id}: explicit evidence bytes mismatch`);
        }
    }
    if (!browserOrigin)
    {
        fail('browser-origin-required', 'actual browser lacks a canonical current-run reference');
    }
    const browser = originPayload(browserOrigin, context, repositoryRoot);
    const browserBinding = inspectVisualBrowserBinding(browserPlan, browser.payload);
    return { status: 'origin-payload-browser-binding-only', qualificationEligible: false,
        visualPayloadDigest: `sha256:${bytesDigest(visual.bytes)}`, visualOriginBinding: visual.bindingReceipt,
        browserOriginBinding: browser.bindingReceipt, browserBinding,
        transportConsumerBindings: [visual.transportConsumerReceipt, browser.transportConsumerReceipt].filter(Boolean),
        pending: ['registered-visual-producer-semantic-authority', 'opaque-producer-to-evidence-mapping',
            'canonical-scene-state-fixture-admission', 'browser-scene-execution-mapping', 'structured-rendered-adjudication'],
        missingProductionCapabilities: [2098, 2099] };
}
