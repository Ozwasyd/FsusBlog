import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestValue } = await import(new URL('../../tools/fact-extractors/lib/canonicalize.mjs', import.meta.url));
const { BehaviorId } = await import(new URL('../../tools/contracts/behavior-contract-catalog.mjs', import.meta.url));
const { loadGlobalDocumentAuthority } = await import(new URL('../../tools/docs/global-claim-exactness-final.mjs', import.meta.url));
const { sealBrowserContractReceipt } = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const { createBrowserTemporalFixture } = await import(new URL('./support/browser-temporal-fixture.mjs', import.meta.url));
const { deriveBrowserObservedRawFacts } = await import(new URL('../../tools/test-evidence/browser-contract-observed-facts.mjs', import.meta.url));
const { selectBrowserContractScenarios } = await import(new URL('../browser-contract/contract-core.mjs', import.meta.url));
const { createRuntimeRoleStaticV3Fixture } = await import(new URL('./support/runtime-role-minimal-v3-fixture.mjs', import.meta.url));
const {
    createCanonicalAotSourceFixture,
    createCanonicalHydrationFixtureObservation,
    createCanonicalPreparedFixture,
    createCanonicalProbeSourceFixture
} = await import(new URL('./support/canonical-post-runtime-source-fixture.mjs', import.meta.url));
const { acceptedClaimsSchema, authorityDigest, canonicalRepositoryFile, identityAuthoritySchema, loadPostRuntimeProducerRegistry, postRuntimeRegistrySchema, requiredPostRuntimeBehaviors, root, sourceReceiptSchema, validateAcceptedClaimsReceiptAgainstRegistry, validatePostRuntimeProducerRegistry, validatePostRuntimeReaderFirewall, validatePostRuntimeRepositoryAuthority, validatePostRuntimeReceiptSchemas, validateProducerReceiptAgainstRegistry: validateProducerReceiptAgainstRegistryRaw } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'));
const migrationLedger = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'));
const registry = loadPostRuntimeProducerRegistry(root);
const digest = (character) => `sha256:${character.repeat(64)}`;
const receiptRepositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-receipt-'));
process.on('exit', () => fs.rmSync(receiptRepositoryRoot, { recursive: true, force: true }));
fs.mkdirSync(path.join(receiptRepositoryRoot, 'config/schemas'), { recursive: true });
fs.mkdirSync(path.join(receiptRepositoryRoot, 'config/testing'), { recursive: true });
fs.mkdirSync(path.join(receiptRepositoryRoot, '.tmp/current-run'), { recursive: true });
fs.copyFileSync(path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'),
    path.join(receiptRepositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'));
fs.copyFileSync(path.join(root, 'config/testing/fixture-profile-catalog.json'),
    path.join(receiptRepositoryRoot, 'config/testing/fixture-profile-catalog.json'));
fs.mkdirSync(path.join(receiptRepositoryRoot, 'config/contracts'), { recursive: true });
fs.copyFileSync(path.join(root, 'config/contracts/behavior-fact-extractors.json'),
    path.join(receiptRepositoryRoot, 'config/contracts/behavior-fact-extractors.json'));
const previewRegistry = JSON.parse(fs.readFileSync(
    path.join(root, 'config/docs/public-preview-screenshots.json'),
    'utf8'
));
for (const file of [
    'config/testing/temporal-policy.json',
    'config/testing/temporal-callsite-dispositions.json',
    'config/testing/temporal-producer-bindings.json',
    'config/docs/public-preview-screenshots.json',
    previewRegistry.qualityPolicyFile,
    ...previewRegistry.qualityScenarioFiles
])
{
    fs.mkdirSync(path.dirname(path.join(receiptRepositoryRoot, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(receiptRepositoryRoot, file));
}
const previewQuality = JSON.parse(fs.readFileSync(
    path.join(root, 'docs/assets/visual-evidence/public-preview-quality.json'),
    'utf8'
));

function validateProducerReceiptAgainstRegistry(options)
{
    return validateProducerReceiptAgainstRegistryRaw({
        ...options,
        repositoryRoot: options.repositoryRoot ?? receiptRepositoryRoot
    });
}

function seal(receipt)
{
    const value = structuredClone(receipt);
    delete value.contentDigest;
    return { ...value, contentDigest: `sha256:${digestValue(value)}` };
}

function sealUnprefixed(receipt)
{
    const value = { ...structuredClone(receipt), contentDigest: null };
    value.contentDigest = digestValue(value);
    return value;
}

function fileDigestHex(file)
{
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(relative, value)
{
    const absolute = path.join(receiptRepositoryRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
    return absolute;
}

function createRuntimeRoleAdmission(sourceState)
{
    const source = {
        sourceCommit: sourceState.sourceCommit,
        worktreeFingerprint: sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
    };
    let admission = createRuntimeRoleStaticV3Fixture(sourceState.runId, source, {
        repositoryRoot: receiptRepositoryRoot,
        extractorIds: JSON.parse(fs.readFileSync(
            path.join(receiptRepositoryRoot, 'config/contracts/behavior-fact-extractors.json'),
            'utf8'
        )).extractors.map((extractor) => extractor.id).sort()
    });
    const minimal = admission.minimalContractBuild;
    const runtimeArtifact = minimal.artifacts['runtime-role-observation'];
    const deploymentObservationDigest = `sha256:${'4'.repeat(64)}`;
    for (const [artifactId, artifact] of Object.entries(minimal.artifacts))
    {
        const project = path.join(receiptRepositoryRoot, artifact.project);
        fs.mkdirSync(path.dirname(project), { recursive: true });
        fs.writeFileSync(project, `project:${artifactId}\n`);
        artifact.projectDigest = fileDigestHex(project);
        if (artifactId === 'runtime-role-observation')
        {
            artifact.buildReceipt.projectDigest = artifact.projectDigest;
        }
        const value = artifactId === 'runtime-role-observation'
            ? {
                schema: 'fsusblog.runtime-role-observation.v2',
                ownership: { claimEligible: true },
                deploymentAuthority: {
                    observationDigest: deploymentObservationDigest
                }
            }
            : { schema: `fsusblog.${artifactId}.fixture.v1` };
        const output = writeJson(artifact.path, value);
        artifact.artifactDigest = fileDigestHex(output);
        artifact.buildReceipt.artifactDigest = artifact.artifactDigest;
        if (artifactId === 'openapi-aeds-observation')
        {
            const projection = artifact.buildReceipt;
            const observed = writeJson(projection.openapiPath, {
                openapi: '3.0.1',
                info: { title: 'Synthetic post-runtime fixture', version: '1' },
                paths: {}
            });
            const published = path.join(receiptRepositoryRoot, projection.openapiArtifactPath);
            fs.mkdirSync(path.dirname(published), { recursive: true });
            fs.copyFileSync(observed, published);
            projection.openapiDigest = fileDigestHex(observed);
        }
    }
    const assembly = path.join(receiptRepositoryRoot, runtimeArtifact.assemblyPath);
    fs.mkdirSync(path.dirname(assembly), { recursive: true });
    fs.writeFileSync(assembly, 'runtime-role-assembly\n');
    runtimeArtifact.assemblyDigest = fileDigestHex(assembly);
    runtimeArtifact.buildReceipt.assemblyDigest = runtimeArtifact.assemblyDigest;
    runtimeArtifact.buildReceipt.reproducibleBuild.assemblyDigest =
        runtimeArtifact.assemblyDigest;
    const deployment = writeJson(runtimeArtifact.deploymentArtifactPath, {
        schema: 'fsusblog.runtime-role-deployment-observation.v1',
        ownership: { claimEligible: true },
        observationDigest: deploymentObservationDigest
    });
    runtimeArtifact.deploymentArtifactDigest = fileDigestHex(deployment);
    runtimeArtifact.buildReceipt.deploymentArtifactDigest =
        runtimeArtifact.deploymentArtifactDigest;
    runtimeArtifact.buildReceipt.deploymentObservationDigest =
        deploymentObservationDigest;
    admission.minimalContractBuild = sealUnprefixed(minimal);
    admission = sealUnprefixed(admission);
    return admission;
}

function producerReceipt(classId = 'route-response-error')
{
    const producer = registry.producers[0];
    const definition = registry.observationClasses[classId];
    const requiredModes = Object.entries(producer.requiredObservations)
        .filter(([, classes]) => classes.includes(classId))
        .map(([mode]) => mode)
        .sort();
    const allSourceState = {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: digest('b'),
        buildIdentity: digest('c'),
        artifactDigest: digest('2'),
        candidateId: 'run-1:candidate',
        runtimeId: 'run-1:runtime',
        browserIdentity: 'run-1:browser-contract',
        releaseId: '20260830123456-abcdef123456',
        rolloutId: 'run-1:rollout',
        runId: 'run-1',
        attemptId: 'attempt-0001',
        fixtureId: 'run-1:fixture',
        profileId: 'acceptance-representative'
    };
    const sourceState = Object.fromEntries(definition.requiredIdentityFields
        .filter((field) => !['producerId', 'toolVersion', 'contentDigest'].includes(field))
        .map((field) => [field, allSourceState[field]]));
    const rawFieldFor = (field) => field.endsWith('Digest') ? field.slice(0, -'Digest'.length) : field;
    const rawFacts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
    {
        const rawField = rawFieldFor(field);
        const value = field === 'responseStatus'
            ? 200
            : sourceState[field] ?? `${rawField}-raw-value`;
        return [rawField, value];
    }));
    const semanticFacts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
        [field, field.endsWith('Digest') ? authorityDigest(rawFacts[rawFieldFor(field)]) : rawFacts[field]]));
    const writeDependency = (relative, document, role = null) =>
    {
        const absolute = path.join(receiptRepositoryRoot, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`);
        const reference = {
            path: relative,
            fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
            contentDigest: document.schema
                === 'fsusblog.behavior-doc-static-admission-receipt.v1'
                ? `sha256:${document.contentDigest}`
                : document.contentDigest ?? null,
            schema: document.schema
        };
        if (role !== null)
        {
            reference.role = role;
        }
        return reference;
    };
    const embeddedDocument = (contract) =>
    {
        if (contract.schema === 'fsusblog.fixture-prepare-state.v1')
        {
            return createCanonicalPreparedFixture(sourceState);
        }
        const source = {
            commit: sourceState.sourceCommit,
            worktreeFingerprint: sourceState.worktreeFingerprint
        };
        const bySchema = {
            'fsusblog.ci-production-build-receipt.v1': { sourceState: source },
            'fsusblog.fixture-receipt.v2': {
                executionIdentity: { runId: sourceState.runId, source },
                profileIdentity: { profileId: sourceState.profileId }
            },
            'fsusblog.post-runtime-candidate-plan.v1': {
                executionIdentity: { runId: sourceState.runId, source },
                candidate: { candidateId: sourceState.candidateId }
            },
            'fsusblog.spa-manifest-descriptor.v1': {
                sourceCommit: sourceState.sourceCommit,
                worktreeFingerprint: sourceState.worktreeFingerprint,
                buildReceiptDigest: sourceState.buildIdentity
            },
            'fsusblog.browser-contract-receipt.v2': {
                sourceState: source,
                runIdentity: { runId: sourceState.runId }
            },
            'fsusblog.public-preview-screenshot-verification.v1': {
                status: 'ok', sourceCommit: sourceState.sourceCommit,
                releaseId: `20260718000000-${sourceState.sourceCommit.slice(0, 12)}`,
                manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1',
                visualInputDigest: 'c'.repeat(64), runtimeAudit: true, layoutAudit: true,
                sanitizationCheck: true, differences: [], commandVersion: 'd'.repeat(64),
                qualityAudit: true, qualityPolicyDigest: previewQuality.policyDigest, quality: structuredClone(previewQuality),
                images: Object.fromEntries(Array.from({ length: 9 }, (_, index) =>
                    [`screenshot-${index + 1}`, `${index + 1}`.repeat(64)]))
            },
            'fsusblog.release-rollout-evidence.v1': {
                rolloutId: sourceState.rolloutId,
                target: { releaseId: sourceState.releaseId }
            },
            'fsusblog.behavior-doc-static-admission-receipt.v1':
                createRuntimeRoleAdmission(sourceState),
            'fsusblog.runtime-role-observation.v1': { observationDigest: digest('1') }
        };
        const document = { schema: contract.schema, ...bySchema[contract.schema] };
        return [
            'fsusblog.public-preview-screenshot-verification.v1',
            'fsusblog.behavior-doc-static-admission-receipt.v1'
        ].includes(contract.schema) ? document : seal(document);
    };
    const embeddedReference = (field, contract) =>
    {
        const receiptPaths = {
            'fsusblog.ci-production-build-receipt.v1': '.tmp/ci-production-build/receipt.json',
            'fsusblog.fixture-prepare-state.v1': '.tmp/fixtures/run-1/prepare-state.json',
            'fsusblog.post-runtime-candidate-plan.v1': '.tmp/post-runtime-plan/run-1/attempt-0001/candidate-plan.json',
            'fsusblog.spa-manifest-descriptor.v1': '.tmp/aot-manifest/spa-manifest-descriptor.json',
            'fsusblog.browser-contract-receipt.v2': '.tmp/browser-contract/receipt.json',
            'fsusblog.public-preview-screenshot-verification.v1': '.tmp/release-evidence/public-preview-screenshots.json',
            'fsusblog.release-rollout-evidence.v1': `.tmp/release-rollout/${classId}.json`,
            'fsusblog.behavior-doc-static-admission-receipt.v1':
                '.tmp/behavior-doc-static-admission/receipt.json',
            'fsusblog.runtime-role-observation.v1': '.tmp/behavior-doc-static-admission/runtime-role-observation.json'
        };
        return writeDependency(
            receiptPaths[contract.schema]
                ?? `.tmp/post-runtime-dependencies/${classId}-${field.replaceAll('.', '-')}.json`,
            embeddedDocument(contract),
            contract.role);
    };
    let canonicalRerunCommand = 'node tools/test-evidence/runtime-observation-probes.mjs route';
    let independentVerifyCommand = 'node tools/test-evidence/runtime-observation-raw.mjs verify';
    const upstreamBody = {
        schema: definition.sourceReceipt.schema,
        producerId: producer.producerId,
        toolVersion: producer.toolVersion,
        sourceState,
        rawFacts,
        canonicalRerunCommand,
        independentVerifyCommand
    };
    if (definition.sourceReceipt.discriminator !== null)
    {
        upstreamBody[definition.sourceReceipt.discriminator.field] =
            definition.sourceReceipt.discriminator.value;
    }
    for (const field of definition.sourceReceipt.requiredReferenceFields)
    {
        upstreamBody[field] = embeddedReference(field,
            definition.sourceReceipt.referenceContracts[field]);
    }
    if (definition.sourceReceipt.referenceMap !== null)
    {
        const map = definition.sourceReceipt.referenceMap;
        upstreamBody[map.field] = Object.fromEntries(map.keys.map((key) =>
        {
            const referenceKey = `${map.field}.${key}`;
            return [key, embeddedReference(referenceKey,
                definition.sourceReceipt.referenceContracts[referenceKey])];
        }));
    }
    for (const field of definition.sourceReceipt.requiredFields)
    {
        if (field in upstreamBody || field === 'contentDigest')
        {
            continue;
        }
        upstreamBody[field] = {
            status: 'passed',
            identity: `${classId}-${field}`
        };
    }
    const upstream = seal(upstreamBody);
    const upstreamRelative = definition.sourceReceipt.role === 'probe'
        ? `.tmp/runtime-observation-probes/run-1/attempt-0001/${classId}.json`
        : definition.sourceReceipt.role === 'browser'
            ? '.tmp/browser-contract/receipt.json'
            : `.tmp/post-runtime-sources/run-1/attempt-0001/${classId}.json`;
    const upstreamRef = writeDependency(upstreamRelative, upstream);
    Object.assign(upstreamRef, {
        contentDigest: upstream.contentDigest,
        schema: definition.sourceReceipt.schema,
        role: definition.sourceReceipt.role
    });
    const refs = {};
    for (const [field, role, identityField] of [
        ['candidatePlanRef', 'plan', 'runId'],
        ['attemptAuthorityRef', 'attempt', 'attemptId'],
        ['fixtureAuthorityRef', 'fixture', 'fixtureId'],
        ['profileAuthorityRef', 'profile', 'profileId']
    ])
    {
        const authority = seal({
            schema: identityAuthoritySchema,
            role,
            authorityId: sourceState[identityField],
            sourceState: Object.fromEntries([
                'sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId', 'fixtureId', 'profileId'
            ].map((identity) => [identity, allSourceState[identity]]))
        });
        const relative = `.tmp/current-run/${role}-authority.json`;
        const absolute = path.join(receiptRepositoryRoot, relative);
        fs.writeFileSync(absolute, `${JSON.stringify(authority, null, 2)}\n`);
        refs[field] = {
            path: relative,
            fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
            contentDigest: authority.contentDigest,
            schema: identityAuthoritySchema,
            role
        };
    }
    if (definition.sourceReceipt.role === 'probe')
    {
        const canonicalSource = { commit: sourceState.sourceCommit, worktreeFingerprint: sourceState.worktreeFingerprint };
        const buildReceipt = seal({ schema: 'fsusblog.ci-production-build-receipt.v1', sourceState: canonicalSource });
        const buildRef = writeDependency('.tmp/ci-production-build/receipt.json', buildReceipt, 'production-build');
        sourceState.buildIdentity = buildReceipt.contentDigest;
        const prepared = createCanonicalPreparedFixture(sourceState);
        const fixtureRef = writeDependency('.tmp/fixtures/run-1/prepare-state.json', prepared, 'fixture');
        const plan = seal({
            schema: 'fsusblog.post-runtime-candidate-plan.v1', producerId: producer.producerId,
            status: 'planned', sourceState: canonicalSource,
            build: { receipt: buildRef.path, receiptContentDigest: buildReceipt.contentDigest },
            candidate: { ...allSourceState, releaseId: allSourceState.releaseId },
            observations: [{ classId, receiptPath: `.tmp/current-run/${classId}.json` }],
            identityAuthorityRefs: { plan: refs.candidatePlanRef, attempt: refs.attemptAuthorityRef,
                fixture: refs.fixtureAuthorityRef, profile: refs.profileAuthorityRef }
        });
        const planRef = writeDependency('.tmp/post-runtime-plan/run-1/attempt-0001/candidate-plan.json', plan, 'candidate-plan');
        const { upstream: probe, sourceState: probeIdentity } = createCanonicalProbeSourceFixture(classId, {
            candidatePlan: { relative: planRef.path, fileDigest: planRef.fileDigest, value: plan },
            build: { ref: { path: buildRef.path, contentDigest: buildRef.fileDigest }, value: buildReceipt },
            fixture: { ref: { path: fixtureRef.path, contentDigest: fixtureRef.fileDigest }, value: prepared },
            output: upstreamRelative
        }, { producer, sourceState });
        Object.assign(sourceState, probeIdentity);
        canonicalRerunCommand = probe.canonicalRerunCommand;
        independentVerifyCommand = probe.independentVerifyCommand;
        for (const field of definition.requiredSemanticFactFields)
        {
            semanticFacts[field] = field.endsWith('Digest')
                ? authorityDigest(probe.rawFacts[rawFieldFor(field)]) : probe.rawFacts[field];
        }
        Object.assign(upstreamRef, writeDependency(upstreamRelative, probe, 'probe'));
    }
    if (['browser-behavior-contract', 'aot-spa-hydration'].includes(classId))
    {
        const canonicalSource = {
            commit: sourceState.sourceCommit,
            worktreeFingerprint: sourceState.worktreeFingerprint
        };
        const assetRoot = path.join(receiptRepositoryRoot, '.tmp/retained-assets', allSourceState.releaseId);
        const manifestRelative = path.relative(receiptRepositoryRoot, path.join(assetRoot, '.vite/manifest.json'));
        const manifestRef = writeDependency(manifestRelative, { 'src/main.ts': { file: 'assets/main.js', isEntry: true } });
        const inventoryRef = writeDependency(path.relative(receiptRepositoryRoot, path.join(assetRoot, 'asset-manifest.json')),
            { schema: 'fsusblog.release-assets.v1', releaseId: allSourceState.releaseId, files: [] });
        const buildReceipt = seal({ schema: 'fsusblog.ci-production-build-receipt.v1', sourceState: canonicalSource,
            artifacts: [{ path: 'frontend-dist/.vite/manifest.json', sha256: manifestRef.fileDigest }] });
        const buildRef = writeDependency('.tmp/ci-production-build/receipt.json', buildReceipt);
        sourceState.buildIdentity = buildReceipt.contentDigest;
        const build = { receipt: buildRef.path, receiptContentDigest: buildReceipt.contentDigest,
            sourceState: canonicalSource, profile: 'production' };
        const candidatePlan = seal({
            schema: 'fsusblog.post-runtime-candidate-plan.v1',
            producerId: producer.producerId,
            status: 'planned',
            sourceState: canonicalSource,
            build,
            candidate: {
                candidateId: sourceState.candidateId, runtimeId: sourceState.runtimeId,
                browserId: sourceState.browserIdentity, runId: sourceState.runId,
                attemptId: sourceState.attemptId, fixtureId: sourceState.fixtureId,
                profileId: sourceState.profileId, releaseId: allSourceState.releaseId
            },
            observations: [{ classId, receiptPath: `.tmp/current-run/${classId}.json` }],
            identityAuthorityRefs: { plan: refs.candidatePlanRef, attempt: refs.attemptAuthorityRef,
                fixture: refs.fixtureAuthorityRef, profile: refs.profileAuthorityRef }
        });
        const candidatePlanRef = writeDependency('.tmp/post-runtime-plan/run-1/attempt-0001/candidate-plan.json',
            candidatePlan, 'candidate-plan');
        const browserPlan = seal({
            schema: 'fsusblog.playwright-browser-identity.v1', executionClass: 'correctness',
            evidenceClass: 'browser-contract', qualificationEligible: true, managedExecutable: true,
            browserName: 'chromium', browserVersion: '140.0.0', revision: '123456',
            executablePath: '/managed/chromium/chrome', executableSha256: digest('f'),
            playwright: { package: '@playwright/test', version: '1.59.1' },
            launchOptions: { headless: true }, rendering: {
                fontSetDigest: digest('1'), localeDataDigest: digest('2'), locale: 'zh-CN',
                deviceScaleFactor: 1, renderingMode: 'headless', colorScheme: 'light', gpuMode: 'software'
            }
        });
        const browserActual = seal({ ...browserPlan, schema: 'fsusblog.playwright-browser-actual.v1',
            planDigest: browserPlan.contentDigest, renderingObservation: {
                locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader fixture renderer'
            } });
        const publicPreviewRef = upstreamBody.publicPreviewRef ?? embeddedReference('publicPreviewRef', {
            schema: 'fsusblog.public-preview-screenshot-verification.v1', role: 'public-preview'
        });
        const preview = JSON.parse(fs.readFileSync(path.join(receiptRepositoryRoot, publicPreviewRef.path), 'utf8'));
        let browser = sealBrowserContractReceipt({
            ...upstreamBody,
            sourceState: canonicalSource,
            status: 'success', classification: 'clean', error: null,
            temporalBinding: createBrowserTemporalFixture({ sourceState: canonicalSource, runId: sourceState.runId }),
            wallClockMs: 2000,
            finalization: { state: 'complete', primary: { status: 'success' },
                cleanup: { status: 'success' }, persistence: { attemptCount: 1 } },
            playwright: { chromiumRevision: '123456', browserIdentity: { plan: browserPlan, actual: browserActual } },
            topology: { browserLaunchCount: 1, maxConcurrentBrowserRoots: 1, retries: 0, contextCount: selectBrowserContractScenarios().length },
            build,
            fixture: { namespace: 'run-1', lifecycle: { identity: { runId: sourceState.runId, attemptId: sourceState.attemptId } } },
            runIdentity: { commit: sourceState.sourceCommit, runId: sourceState.runId,
                attemptId: sourceState.attemptId, namespace: 'run-1' },
            scenarios: selectBrowserContractScenarios().map(({ id, capability }) => ({
                id, capability, status: 'success', classification: 'clean', issues: [], artifacts: [],
                startedAt: '2026-09-07T00:00:00.000Z', finishedAt: '2026-09-07T00:00:00.001Z',
                durationMs: 1, error: null,
                ...(id === 'public-hydration-history-reload' ? { observation: createCanonicalHydrationFixtureObservation(allSourceState.releaseId) } : {})
            })),
            schema: 'fsusblog.browser-contract-receipt.v2',
            publicPreview: { ...preview, captureContextCount: 9, evidencePath: publicPreviewRef.path,
                evidenceFileDigest: publicPreviewRef.fileDigest },
            publicPreviewRef,
            candidatePlanRef
        });
        browser = sealBrowserContractReceipt({ ...browser, rawFacts: deriveBrowserObservedRawFacts(browser, preview) });
        if (classId === 'aot-spa-hydration')
        {
            const descriptor = seal({ schema: 'fsusblog.spa-manifest-descriptor.v1',
                releaseId: allSourceState.releaseId, sourceCommit: sourceState.sourceCommit,
                worktreeFingerprint: sourceState.worktreeFingerprint, buildReceiptDigest: buildReceipt.contentDigest,
                assetRoot, manifestPath: path.join(assetRoot, '.vite/manifest.json'),
                manifestDigest: manifestRef.fileDigest, assetInventoryDigest: inventoryRef.fileDigest });
            const inputs = {
                manifest: { value: descriptor, ref: writeDependency('.tmp/aot-manifest/spa-manifest-descriptor.json', descriptor, 'spa-manifest') },
                browserContract: { value: browser, ref: writeDependency('.tmp/browser-contract/receipt.json', browser, 'browser-contract') }
            };
            const readBytes = (file) => fs.readFileSync(file);
            const { upstream: aot } = createCanonicalAotSourceFixture({ candidate: { ref: candidatePlanRef },
                plan: candidatePlan, inputs, producer, readBytes }, buildReceipt);
            for (const field of definition.requiredSemanticFactFields)
            {
                semanticFacts[field] = field.endsWith('Digest')
                    ? authorityDigest(aot.rawFacts[rawFieldFor(field)]) : aot.rawFacts[field];
            }
            canonicalRerunCommand = aot.canonicalRerunCommand;
            independentVerifyCommand = aot.independentVerifyCommand;
            Object.assign(upstreamRef, writeDependency(upstreamRelative, aot, 'aot'));
            sourceState.artifactDigest = manifestRef.fileDigest;
        }
        else
        {
            for (const field of definition.requiredSemanticFactFields)
            {
                semanticFacts[field] = field.endsWith('Digest')
                    ? authorityDigest(browser.rawFacts[rawFieldFor(field)]) : browser.rawFacts[field];
            }
            const browserRef = writeDependency(upstreamRelative, browser, 'browser');
            Object.assign(upstreamRef, browserRef);
            sourceState.artifactDigest = browserRef.fileDigest;
        }
    }
    const sourceReceipt = seal({
        schema: sourceReceiptSchema,
        role: 'source',
        classId,
        producerId: producer.producerId,
        toolVersion: producer.toolVersion,
        sourceState,
        candidatePlanRef: refs.candidatePlanRef,
        upstreamRef,
        canonicalRerunCommand,
        independentVerifyCommand
    });
    const sourceReceiptRelative = `.tmp/post-runtime-source-receipts/run-1/attempt-0001/${classId}.json`;
    const sourceReceiptAbsolute = path.join(receiptRepositoryRoot, sourceReceiptRelative);
    fs.mkdirSync(path.dirname(sourceReceiptAbsolute), { recursive: true });
    fs.writeFileSync(sourceReceiptAbsolute, `${JSON.stringify(sourceReceipt, null, 2)}\n`);
    return seal({
        schema: definition.schema,
        producerId: producer.producerId,
        toolVersion: producer.toolVersion,
        registryDigest: authorityDigest(registry),
        observationSchemaDigest: authorityDigest(JSON.parse(fs.readFileSync(
            path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))),
        sourceState,
        executionClass: 'correctness',
        evidenceClass: 'correctness',
        qualificationEligible: true,
        planned: true,
        executed: true,
        outcome: 'passed',
        recovered: false,
        modes: requiredModes,
        terminal: {
            timeout: false,
            cancelled: false,
            processTreeTerminated: false,
            priorAttemptDigest: null
        },
        semanticFacts,
        ...refs,
        sourceReceiptRef: {
            path: sourceReceiptRelative,
            fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(sourceReceiptAbsolute)).digest('hex')}`,
            contentDigest: sourceReceipt.contentDigest,
            schema: sourceReceiptSchema,
            role: 'source'
        },
        canonicalRerunCommand,
        independentVerifyCommand
    });
}

function tampered(modifier)
{
    const clone = structuredClone(registry);
    modifier(clone);
    return clone;
}

test('registry derives required behaviors from the BehaviorCatalog and validates exact-one', () =>
{
    const behaviors = requiredPostRuntimeBehaviors(catalog);
    assert.ok(behaviors.includes('browserless-production-correctness'));
    const summary = validatePostRuntimeProducerRegistry(registry, {
        catalog, migrationLedger, validateRepositoryAuthority: false
    });
    assert.equal(summary.schema, postRuntimeRegistrySchema);
    assert.equal(summary.producerCount, behaviors.length);
    assert.equal(summary.warnings, 0);
});

test('missing producer/schema for a post-runtime behavior fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => clone.producers.pop()), { catalog }),
        /has no producer mapping/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.observationClasses['route-response-error'].sourceReceipt.schema =
                'fsusblog.unknown-runtime-source.v1';
        }), { catalog }),
        /has no closed raw fact extractor/u);
});

test('embedded reference identity contracts cannot be weakened or expanded', () =>
{
    for (const mutate of [
        (clone) => clone.observationClasses['route-response-error']
            .sourceReceipt.referenceContracts.fixtureReceipt.identityFields.pop(),
        (clone) => clone.observationClasses['release-identity-readiness']
            .sourceReceipt.referenceContracts.rolloutEvidenceRef.identityFields.push('rolloutId'),
        (clone) => clone.observationClasses['route-response-error']
            .sourceReceipt.referenceContracts.buildReceipt.identityFields = []
    ])
    {
        assert.throws(() => validatePostRuntimeProducerRegistry(tampered(mutate), { catalog }),
            /schema\/role\/identity is invalid/u);
    }
});

test('two producers for the same behavior fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => clone.producers.push(structuredClone(clone.producers[0]))), { catalog }),
        /mapped by two producers/u);
});

test('artifact path or job name based mapping fields fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].artifactPath = '.tmp/receipt.json';
        }), { catalog }),
        /forbidden field artifactPath/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].jobName = 'ci-release-final';
        }), { catalog }),
        /forbidden field jobName/u);
});

test('existence shortcut observation classes fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.observationClasses['http-200-class'] = {
                schema: 'fsusblog.observation.http200.v1',
                sourceReceipt: {
                    ...structuredClone(clone.observationClasses['route-response-error'].sourceReceipt),
                    schema: 'fsusblog.http-200-source.v1',
                    discriminator: { field: 'kind', value: 'http-200-class' }
                },
                requiredIdentityFields: structuredClone(
                    clone.observationClasses['route-response-error'].requiredIdentityFields),
                requiredSemanticFactFields: ['responseStatus'],
                allowedModes: ['positive', 'negative', 'boundary', 'failure'],
                existenceShortcutForbidden: false
            };
        }), { catalog }),
        /must forbid existence shortcuts/u);
});

test('diagnostic qualification fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].diagnosticEligible = true;
        }), { catalog }),
        /never accept diagnostic evidence/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].executionClass = 'diagnostic';
        }), { catalog }),
        /cannot satisfy qualification/u);
});

test('missing required identity binding fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredIdentities = ['schedulerRunId'];
        }), { catalog }),
        /must bind source identity/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.observationClasses['route-response-error'].requiredIdentityFields;
        }), { catalog }),
        /missing or unknown fields/u);
});

test('unknown observation type and non-exact claim mapping fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredObservations.positive.push('screenshot-present');
        }), { catalog }),
        /unknown observation class screenshot-present/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger: tamperedLedger() }),
        /accepted claim refs must exact-match/u);

    function tamperedLedger()
    {
        const clone = structuredClone(migrationLedger);
        for (const scope of clone.scopes)
        {
            for (const entry of scope.entries)
            {
                if (entry.behaviorId === 'browserless-production-correctness')
                {
                    entry.claimIds = ['browserless-production-correctness.tiers'];
                }
            }
        }
        return clone;
    }
});

test('owner, behavior domain and per-producer evidenceClass are authority-bound', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].owner = 'docs/testing.md';
        }), { catalog, migrationLedger }),
        /canonical matrix producer authority/u);
    const documentationCatalog = structuredClone(catalog);
    documentationCatalog.contracts.find((contract) =>
        contract.id === 'browserless-production-correctness').domain = 'documentation';
    assert.throws(
        () => validatePostRuntimeProducerRegistry(registry, {
            catalog: documentationCatalog,
            migrationLedger
        }),
        /domain\/tier\/schema conflicts/u);
    const coordinatedDocumentationRegistry = structuredClone(registry);
    coordinatedDocumentationRegistry.producers[0].behaviorDomain = 'documentation';
    assert.throws(
        () => validatePostRuntimeProducerRegistry(coordinatedDocumentationRegistry, {
            catalog: documentationCatalog,
            migrationLedger
        }),
        /behavior domain is not runtime-eligible/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].evidenceClass = 'browser-contract';
        }), { catalog, migrationLedger }),
        /evidenceClass conflicts/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.producers[0].evidenceClass;
        }), { catalog, migrationLedger }),
        /missing or unknown fields/u);
});

test('registry claim refs reject missing, extra and duplicate entries', () =>
{
    for (const mutate of [
        (claims) => claims.pop(),
        (claims) => claims.push('browserless-production-correctness.unknown'),
        (claims) => claims.push(claims[0])
    ])
    {
        assert.throws(
            () => validatePostRuntimeProducerRegistry(tampered((clone) =>
            {
                mutate(clone.producers[0].acceptedClaimRefs);
            }), { catalog, migrationLedger }),
            /accepted claim refs must exact-match/u);
    }
});

test('manual owner/waiver fields and every pre-v2 registry fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].waiver = true;
        }), { catalog }),
        /forbidden field waiver/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.schema = 'fsusblog.post-runtime-producer-registry.v1';
        }), { catalog }),
        /unexpected registry schema/u);
});

test('registry and receipt schemas are closed and exact', () =>
{
    assert.equal(validatePostRuntimeReceiptSchemas(registry), true);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredObservations.positive.push('route-response-error');
        }), { catalog }),
        /duplicate observation classes/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.producers[0].requiredObservations.failure;
        }), { catalog }),
        /missing or unknown fields/u);
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].toolVersion = 'latest';
        }), { catalog }),
        /toolVersion is missing or invalid/u);
});

test('receipt binding recomputes digest and exact mode/tool/source identity', () =>
{
    const producer = registry.producers[0];
    const receipt = producerReceipt();
    assert.deepEqual(
        validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt }),
        {
            producerId: producer.producerId,
            behaviorId: BehaviorId('browserless-production-correctness'),
            classId: 'route-response-error',
            qualificationEligible: true,
            warnings: 0
        });

    const wrongSchema = seal({ ...receipt, schema: 'fsusblog.other-receipt.v1' });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: wrongSchema }),
        /does not resolve exact-one observation class/u);

    const missingIdentity = structuredClone(receipt);
    delete missingIdentity.sourceState.worktreeFingerprint;
    const resealedMissingIdentity = seal(missingIdentity);
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({
            registry,
            producerId: producer.producerId,
            receipt: resealedMissingIdentity
        }),
        /missing route-response-error identity worktreeFingerprint/u);

    const staleTool = seal({ ...receipt, toolVersion: 'production-correctness-scheduler@2' });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: staleTool }),
        /producer\/tool version mismatch/u);

    const extraMode = seal({ ...receipt, modes: [...receipt.modes, 'boundary'] });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: extraMode }),
        /modes must exact-match/u);

    const digestTamper = structuredClone(receipt);
    digestTamper.semanticFacts.coherent = false;
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: digestTamper }),
        /contentDigest mismatch/u);

    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: 'unknown-producer', receipt }),
        /unknown producer/u);
});

test('every observation class accepts only its declared source identities', () =>
{
    const producerId = registry.producers[0].producerId;
    for (const [classId, definition] of Object.entries(registry.observationClasses))
    {
        const receipt = producerReceipt(classId);
        assert.equal(validateProducerReceiptAgainstRegistry({
            registry, producerId, receipt, classId
        }).classId, classId);
        assert.deepEqual(Object.keys(receipt.sourceState).sort(),
            definition.requiredIdentityFields
                .filter((field) => !['producerId', 'toolVersion', 'contentDigest'].includes(field))
                .sort());

        const undeclaredField = ['browserIdentity', 'releaseId', 'rolloutId']
            .find((field) => !definition.requiredIdentityFields.includes(field));
        if (undeclaredField !== undefined)
        {
            const expanded = structuredClone(receipt);
            expanded.sourceState[undeclaredField] = `${undeclaredField}-self-reported`;
            assert.throws(() => validateProducerReceiptAgainstRegistry({
                registry, producerId, receipt: seal(expanded), classId
            }), /sourceState has missing or unknown fields/u);
        }
    }
});

test('canonical Browser source preserves its sealer fields and rejects re-sealed drift', () =>
{
    const classId = 'browser-behavior-contract';
    const producerId = registry.producers[0].producerId;
    const mutatePreview = (mutation) => (upstream) =>
    {
        const file = path.join(receiptRepositoryRoot, upstream.publicPreviewRef.path);
        const preview = JSON.parse(fs.readFileSync(file, 'utf8'));
        mutation(preview);
        const bytes = `${JSON.stringify(preview, null, 2)}\n`;
        fs.writeFileSync(file, bytes);
        const fileDigest =
            `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        upstream.publicPreviewRef.fileDigest = fileDigest;
        upstream.publicPreview.evidenceFileDigest = fileDigest;
    };
    for (const [mutate, expected] of [
        [(value) =>
        {
            value.unregistered = true;
        }, /missing or unknown fields/u],
        [(value) =>
        {
            delete value.diagnostics;
        }, /missing or unknown fields/u],
        [(value) =>
        {
            value.sourceState.sourceCommit = value.sourceState.commit;
        }, /sourceState has missing or unknown fields/u],
        [(value) =>
        {
            value.runIdentity.runId = 'other-run';
        }, /runId mismatch/u],
        [(value) =>
        {
            value.buildBinding.receiptContentDigest = digest('f');
        }, /canonical Browser contract.*build.*digest mismatch/u],
        [(value) =>
        {
            value.publicPreview.evidenceFileDigest = digest('f');
        }, /canonical source\/build\/run\/preview binding mismatch/u],
        [(value) =>
        {
            value.candidatePlanRef.fileDigest = digest('f');
        }, /candidatePlanRef file digest mismatch/u],
        [(value) =>
        {
            value.status = 'failure';
        }, /canonical Browser contract/u],
        [(value) =>
        {
            value.rawFacts.network.requestFailureCount = 3;
        }, /raw semantic facts do not replay/u],
        [mutatePreview((value) =>
        {
            value.captureContextCount = 9;
        }), /canonical preview has missing or unknown fields/u],
        [mutatePreview((value) =>
        {
            delete value.qualityAudit;
        }), /canonical preview has missing or unknown fields/u],
        [mutatePreview((value) =>
        {
            value.qualityAudit = false;
        }), /canonical preview quality mismatch/u],
        [mutatePreview((value) =>
        {
            value.qualityPolicyDigest = 'f'.repeat(64);
        }), /canonical preview quality mismatch/u],
        [mutatePreview((value) =>
        {
            value.quality.matrix.reports = [];
        }), /canonical preview quality mismatch/u]
    ])
    {
        const receipt = producerReceipt(classId);
        const sourcePath = path.join(
            receiptRepositoryRoot,
            receipt.sourceReceiptRef.path
        );
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const upstreamPath = path.join(
            receiptRepositoryRoot,
            source.upstreamRef.path
        );
        const upstream = JSON.parse(fs.readFileSync(upstreamPath, 'utf8'));
        assert.equal(upstream.evidenceClass, 'browser-contract');
        assert.deepEqual(
            Object.keys(upstream.sourceState).sort(),
            ['commit', 'worktreeFingerprint']
        );
        mutate(upstream);
        const changed = seal(upstream);
        fs.writeFileSync(upstreamPath, `${JSON.stringify(changed, null, 2)}\n`);
        source.upstreamRef.fileDigest =
            `sha256:${createHash('sha256')
                .update(fs.readFileSync(upstreamPath)).digest('hex')}`;
        source.upstreamRef.contentDigest = changed.contentDigest;
        receipt.sourceState.artifactDigest = source.upstreamRef.fileDigest;
        source.sourceState.artifactDigest = source.upstreamRef.fileDigest;
        const changedSource = seal(source);
        fs.writeFileSync(
            sourcePath,
            `${JSON.stringify(changedSource, null, 2)}\n`
        );
        receipt.sourceReceiptRef.fileDigest =
            `sha256:${createHash('sha256')
                .update(fs.readFileSync(sourcePath)).digest('hex')}`;
        receipt.sourceReceiptRef.contentDigest = changedSource.contentDigest;
        assert.throws(() => validateProducerReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: seal(receipt),
            classId
        }), expected);
    }
});

test('runtime-role admission rejects missing, unknown, stale and coordinated v2 tamper', () =>
{
    const classId = 'release-identity-readiness';
    const producerId = registry.producers[0].producerId;
    for (const [mutate, expected] of [
        [({ admission }) =>
        {
            delete admission.minimalContractBuild;
        }, /minimalContractBuild|fields are not sealed/u],
        [({ admission }) =>
        {
            admission.unknown = true;
        }, /fields are not sealed/u],
        [({ upstream }) =>
        {
            upstream.runtimeRoleAdmissionRef.contentDigest = digest('f');
        }, /runtime-role admission content seal mismatch/u],
        [({ observationFile }) =>
        {
            const observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'));
            observation.ownership.claimEligible = false;
            fs.writeFileSync(
                observationFile,
                `${JSON.stringify(observation, null, 2)}\n`
            );
        }, /artifact runtime-role-observation digest mismatch/u],
        [({ admission, observationFile, resealMinimal }) =>
        {
            const observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'));
            observation.schema = 'fsusblog.runtime-role-observation.v1';
            fs.writeFileSync(
                observationFile,
                `${JSON.stringify(observation, null, 2)}\n`
            );
            resealMinimal(admission, observationFile, 'artifact');
        }, /runtime-role v2 observation authority/u],
        [({ admission, deploymentFile, resealMinimal }) =>
        {
            const deployment = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
            deployment.ownership.claimEligible = false;
            fs.writeFileSync(
                deploymentFile,
                `${JSON.stringify(deployment, null, 2)}\n`
            );
            resealMinimal(admission, deploymentFile, 'deployment');
        }, /runtime-role v2 observation authority/u]
    ])
    {
        const receipt = producerReceipt(classId);
        const sourcePath = path.join(
            receiptRepositoryRoot,
            receipt.sourceReceiptRef.path
        );
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const upstreamPath = path.join(
            receiptRepositoryRoot,
            source.upstreamRef.path
        );
        let upstream = JSON.parse(fs.readFileSync(upstreamPath, 'utf8'));
        const admissionPath = path.join(
            receiptRepositoryRoot,
            upstream.runtimeRoleAdmissionRef.path
        );
        let admission = JSON.parse(fs.readFileSync(admissionPath, 'utf8'));
        const runtimeArtifact =
            admission.minimalContractBuild.artifacts['runtime-role-observation'];
        const observationFile = path.join(
            receiptRepositoryRoot,
            runtimeArtifact.path
        );
        const deploymentFile = path.join(
            receiptRepositoryRoot,
            runtimeArtifact.deploymentArtifactPath
        );
        const resealMinimal = (value, file, kind) =>
        {
            const artifact =
                value.minimalContractBuild.artifacts['runtime-role-observation'];
            const currentDigest = fileDigestHex(file);
            if (kind === 'artifact')
            {
                artifact.artifactDigest = currentDigest;
                artifact.buildReceipt.artifactDigest = currentDigest;
            }
            else
            {
                artifact.deploymentArtifactDigest = currentDigest;
                artifact.buildReceipt.deploymentArtifactDigest = currentDigest;
            }
            value.minimalContractBuild =
                sealUnprefixed(value.minimalContractBuild);
        };
        mutate({
            admission,
            upstream,
            observationFile,
            deploymentFile,
            resealMinimal
        });
        admission = sealUnprefixed(admission);
        fs.writeFileSync(
            admissionPath,
            `${JSON.stringify(admission, null, 2)}\n`
        );
        upstream.runtimeRoleAdmissionRef.fileDigest =
            `sha256:${fileDigestHex(admissionPath)}`;
        if (upstream.runtimeRoleAdmissionRef.contentDigest !== digest('f'))
        {
            upstream.runtimeRoleAdmissionRef.contentDigest =
                `sha256:${admission.contentDigest}`;
        }
        upstream = seal(upstream);
        fs.writeFileSync(
            upstreamPath,
            `${JSON.stringify(upstream, null, 2)}\n`
        );
        source.upstreamRef.fileDigest = `sha256:${fileDigestHex(upstreamPath)}`;
        source.upstreamRef.contentDigest = upstream.contentDigest;
        const changedSource = seal(source);
        fs.writeFileSync(
            sourcePath,
            `${JSON.stringify(changedSource, null, 2)}\n`
        );
        receipt.sourceReceiptRef.fileDigest =
            `sha256:${fileDigestHex(sourcePath)}`;
        receipt.sourceReceiptRef.contentDigest = changedSource.contentDigest;
        assert.throws(() => validateProducerReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: seal(receipt),
            classId
        }), expected);
    }
});

test('semantic candidate and release identities cannot be coordinated away from sourceState', () =>
{
    const classId = 'release-identity-readiness';
    const producerId = registry.producers[0].producerId;
    const receipt = producerReceipt(classId);
    const sourcePath = path.join(receiptRepositoryRoot, receipt.sourceReceiptRef.path);
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const upstreamPath = path.join(receiptRepositoryRoot, source.upstreamRef.path);
    const upstream = JSON.parse(fs.readFileSync(upstreamPath, 'utf8'));
    upstream.rawFacts.candidateId = 'other-run:candidate';
    const resealedUpstream = seal(upstream);
    fs.writeFileSync(upstreamPath, `${JSON.stringify(resealedUpstream, null, 2)}\n`);
    source.upstreamRef.fileDigest = `sha256:${createHash('sha256')
        .update(fs.readFileSync(upstreamPath)).digest('hex')}`;
    source.upstreamRef.contentDigest = resealedUpstream.contentDigest;
    const resealedSource = seal(source);
    fs.writeFileSync(sourcePath, `${JSON.stringify(resealedSource, null, 2)}\n`);
    receipt.sourceReceiptRef.fileDigest = `sha256:${createHash('sha256')
        .update(fs.readFileSync(sourcePath)).digest('hex')}`;
    receipt.sourceReceiptRef.contentDigest = resealedSource.contentDigest;
    receipt.semanticFacts.candidateId = 'other-run:candidate';
    assert.throws(() => validateProducerReceiptAgainstRegistry({
        registry, producerId, receipt: seal(receipt), classId
    }), /semantic identity candidateId does not bind sourceState/u);
});

test('re-sealed embedded build and fixture receipts remain bound to outer source identity', () =>
{
    const classId = 'route-response-error';
    const producerId = registry.producers[0].producerId;
    for (const [referenceField, identityField, mutate] of [
        ['buildReceipt', 'sourceCommit', (embedded) =>
        {
            embedded.sourceState.commit = 'f'.repeat(40);
        }],
        ['fixtureReceipt', 'runId', (embedded) =>
        {
            embedded.plan.executionIdentity.runId = 'other-run';
        }]
    ])
    {
        const receipt = producerReceipt(classId);
        const sourcePath = path.join(receiptRepositoryRoot, receipt.sourceReceiptRef.path);
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const upstreamPath = path.join(receiptRepositoryRoot, source.upstreamRef.path);
        const upstream = JSON.parse(fs.readFileSync(upstreamPath, 'utf8'));
        const embeddedPath = path.join(receiptRepositoryRoot, upstream[referenceField].path);
        const embedded = JSON.parse(fs.readFileSync(embeddedPath, 'utf8'));
        mutate(embedded);
        const resealedEmbedded = referenceField === 'fixtureReceipt'
            ? embedded
            : seal(embedded);
        fs.writeFileSync(embeddedPath, `${JSON.stringify(resealedEmbedded, null, 2)}\n`);
        upstream[referenceField].fileDigest = `sha256:${createHash('sha256')
            .update(fs.readFileSync(embeddedPath)).digest('hex')}`;
        upstream[referenceField].contentDigest =
            resealedEmbedded.contentDigest ?? null;
        const resealedUpstream = seal(upstream);
        fs.writeFileSync(upstreamPath, `${JSON.stringify(resealedUpstream, null, 2)}\n`);
        source.upstreamRef.fileDigest = `sha256:${createHash('sha256')
            .update(fs.readFileSync(upstreamPath)).digest('hex')}`;
        source.upstreamRef.contentDigest = resealedUpstream.contentDigest;
        const resealedSource = seal(source);
        fs.writeFileSync(sourcePath, `${JSON.stringify(resealedSource, null, 2)}\n`);
        receipt.sourceReceiptRef.fileDigest = `sha256:${createHash('sha256')
            .update(fs.readFileSync(sourcePath)).digest('hex')}`;
        receipt.sourceReceiptRef.contentDigest = resealedSource.contentDigest;
        assert.throws(() => validateProducerReceiptAgainstRegistry({
            registry, producerId, receipt: seal(receipt), classId
        }), new RegExp(`${identityField} does not bind the outer source identity`, 'u'));
    }
});

test('run, attempt, fixture and profile identities are typed and bind independent authorities', () =>
{
    const producerId = registry.producers[0].producerId;
    const base = producerReceipt();
    for (const field of ['runId', 'attemptId', 'fixtureId', 'profileId'])
    {
        const empty = structuredClone(base);
        empty.sourceState[field] = '';
        assert.throws(
            () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(empty) }),
            /source identity is invalid|scoped candidate\/runtime\/browser\/release identity is invalid/u);
    }

    const malformedAttempt = structuredClone(base);
    malformedAttempt.sourceState.attemptId = 'run-0001';
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(malformedAttempt) }),
        /source identity is invalid/u);

    for (const [field, value] of [
        ['runId', '../run-1'],
        ['attemptId', 'attempt-0001/../attempt-0002']
    ])
    {
        const unsafe = structuredClone(base);
        unsafe.sourceState[field] = value;
        assert.throws(
            () => validateProducerReceiptAgainstRegistry({
                registry, producerId, receipt: seal(unsafe)
            }),
            /source identity is invalid/u);
    }

    for (const [classId, field, value] of [
        ['release-identity-readiness', 'releaseId', 'run-1:release'],
        ['route-response-error', 'runtimeId', digest('3')],
        ['session-cookie-runtime', 'browserIdentity', digest('4')],
        ['route-response-error', 'candidateId', 'other-run:candidate'],
        ['blue-green-containment', 'rolloutId', 'other-run:rollout']
    ])
    {
        const invalid = structuredClone(producerReceipt(classId));
        invalid.sourceState[field] = value;
        assert.throws(
            () => validateProducerReceiptAgainstRegistry({
                registry, producerId, receipt: seal(invalid), classId
            }),
            /scoped candidate\/runtime\/browser\/release identity is invalid/u);
    }

    const swappedIdentities = structuredClone(base)
    ;[swappedIdentities.sourceState.runId, swappedIdentities.sourceState.fixtureId] =
        [swappedIdentities.sourceState.fixtureId, swappedIdentities.sourceState.runId];
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(swappedIdentities) }),
        /source identity is invalid/u);

    const swappedAuthorities = structuredClone(base)
    ;[swappedAuthorities.candidatePlanRef, swappedAuthorities.attemptAuthorityRef] =
        [swappedAuthorities.attemptAuthorityRef, swappedAuthorities.candidatePlanRef];
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(swappedAuthorities) }),
        /plan authority reference is invalid/u);
});

test('sourceReceiptRef replays exact current source, producer, schema and file identity', () =>
{
    const producerId = registry.producers[0].producerId;
    const base = producerReceipt();
    const validate = (receipt) => validateProducerReceiptAgainstRegistry({
        registry, producerId, receipt: seal(receipt)
    });

    const swapped = structuredClone(base);
    swapped.sourceReceiptRef = structuredClone(base.candidatePlanRef);
    assert.throws(() => validate(swapped), /identity authorities must use independent paths/u);

    for (const invalidPath of [
        path.join(receiptRepositoryRoot, base.sourceReceiptRef.path),
        '../source-receipt.json',
        '.tmp/latest/source-receipt.json',
        '.tmp/current-run/missing-source-receipt.json',
        '.tmp/history/run-1/attempt-0001/route-response-error.json',
        '.tmp/docs/run-1/attempt-0001/route-response-error.json',
        '.tmp/post-runtime-source-receipts/run-1/route-response-error.json',
        '.tmp/post-runtime-source-receipts/run-1/attempt-0002/route-response-error.json',
        '.tmp/post-runtime-source-receipts/run-1/attempt-0001/session-cookie-runtime.json',
        '.tmp/post-runtime-source-receipts/other-run/attempt-0001/route-response-error.json',
        '.tmp/post-runtime-source-receipts/run-1/attempt-0001/../attempt-0001/route-response-error.json'
    ])
    {
        const invalid = structuredClone(base);
        invalid.sourceReceiptRef.path = invalidPath;
        assert.throws(
            () => validate(invalid),
            /source receipt path does not exact-match/u);
    }

    const sourceAbsolute = path.join(receiptRepositoryRoot, base.sourceReceiptRef.path);
    const originalSourceBytes = fs.readFileSync(sourceAbsolute);
    fs.rmSync(sourceAbsolute);
    assert.throws(() => validate(base), /ENOENT|cannot be opened without following links/u);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    const sourceAlias = path.join(receiptRepositoryRoot, '.tmp/current-run/source-receipt-alias.json');
    fs.writeFileSync(sourceAlias, originalSourceBytes);
    fs.rmSync(sourceAbsolute);
    fs.symlinkSync(sourceAlias, sourceAbsolute);
    assert.throws(() => validate(base), /regular non-symlink single-link file/u);
    fs.rmSync(sourceAbsolute);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    fs.rmSync(sourceAlias);
    fs.writeFileSync(sourceAlias, originalSourceBytes);
    fs.rmSync(sourceAbsolute);
    fs.linkSync(sourceAlias, sourceAbsolute);
    assert.throws(() => validate(base), /single-link file/u);
    fs.rmSync(sourceAbsolute);
    fs.rmSync(sourceAlias);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    for (const [field, value, expected] of [
        ['schema', 'fsusblog.other-source-receipt.v1', /source receipt reference is invalid/u],
        ['role', 'probe', /source receipt reference is invalid/u],
        ['contentDigest', digest('7'), /schema\/producer\/source identity mismatch/u]
    ])
    {
        const invalid = structuredClone(base);
        invalid.sourceReceiptRef[field] = value;
        assert.throws(() => validate(invalid), expected);
    }

    const rewriteSource = (mutate) =>
    {
        const document = JSON.parse(fs.readFileSync(sourceAbsolute, 'utf8'));
        mutate(document);
        const sealed = seal(document);
        fs.writeFileSync(sourceAbsolute, `${JSON.stringify(sealed, null, 2)}\n`);
        return {
            path: base.sourceReceiptRef.path,
            fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(sourceAbsolute)).digest('hex')}`,
            contentDigest: sealed.contentDigest,
            schema: sourceReceiptSchema,
            role: 'source'
        };
    };
    const stale = structuredClone(base);
    stale.sourceReceiptRef = rewriteSource((document) =>
    {
        document.sourceState.attemptId = 'attempt-0002';
    });
    assert.throws(() => validate(stale), /schema\/producer\/source identity mismatch/u);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    const wrongProducer = structuredClone(base);
    wrongProducer.sourceReceiptRef = rewriteSource((document) =>
    {
        document.producerId = 'other-producer';
    });
    assert.throws(() => validate(wrongProducer), /schema\/producer\/source identity mismatch/u);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    for (const [field, value, expected] of [
        ['schema', 'fsusblog.other-source.v1', /upstream reference is invalid/u],
        ['role', 'browser', /upstream reference is invalid/u],
        ['contentDigest', digest('8'), /upstream schema\/producer\/tool\/command\/content identity mismatch/u],
        ['fileDigest', digest('7'), /upstream schema\/producer\/tool\/command\/content identity mismatch/u],
        ['path', '.tmp/current-run/run-1/missing-upstream.json', /ENOENT/u],
        ['path', '.tmp/latest/run-1/upstream.json', /explicit current-run JSON path/u],
        ['path', '.tmp/history/run-1/upstream.json', /explicit current-run JSON path/u],
        ['path', '.tmp/docs/run-1/upstream.json', /upstream reference is invalid/u],
        ['path', '../upstream.json', /upstream reference is invalid|explicit current-run JSON path/u],
        ['path', path.join(receiptRepositoryRoot, '.tmp/current-run/upstream.json'),
            /upstream reference is invalid|explicit current-run JSON path/u]
    ])
    {
        const invalid = structuredClone(base);
        invalid.sourceReceiptRef = rewriteSource((document) =>
        {
            document.upstreamRef[field] = value;
        });
        assert.throws(() => validate(invalid), expected);
        fs.writeFileSync(sourceAbsolute, originalSourceBytes);
    }

    const wrapper = JSON.parse(originalSourceBytes.toString('utf8'));
    const upstreamAbsolute = path.join(receiptRepositoryRoot, wrapper.upstreamRef.path);
    const upstreamBytes = fs.readFileSync(upstreamAbsolute);
    const arbitraryDocsRelative = 'docs/arbitrary-producer-claim.json';
    const arbitraryDocsAbsolute = path.join(receiptRepositoryRoot, arbitraryDocsRelative);
    const arbitraryDocsReceipt = seal({
        schema: 'fsusblog.ci-production-build-receipt.v1',
        sourceState: base.sourceState,
        arbitraryClaim: 'documentation bytes are not producer evidence'
    });
    fs.mkdirSync(path.dirname(arbitraryDocsAbsolute), { recursive: true });
    fs.writeFileSync(arbitraryDocsAbsolute, `${JSON.stringify(arbitraryDocsReceipt, null, 2)}\n`);
    const semanticDrift = structuredClone(base);
    semanticDrift.semanticFacts.responseStatus = 599;
    assert.throws(() => validate(semanticDrift), /raw semantic facts mismatch/u);

    const coordinatedUpstreamMutation = (mutate) =>
    {
        const changed = JSON.parse(upstreamBytes.toString('utf8'));
        mutate(changed);
        const resealed = seal(changed);
        fs.writeFileSync(upstreamAbsolute, `${JSON.stringify(resealed, null, 2)}\n`);
        const coordinated = structuredClone(base);
        coordinated.sourceReceiptRef = rewriteSource((document) =>
        {
            document.upstreamRef.fileDigest = `sha256:${createHash('sha256').update(fs.readFileSync(upstreamAbsolute)).digest('hex')}`;
            document.upstreamRef.contentDigest = resealed.contentDigest;
        });
        return coordinated;
    };

    for (const [label, mutate, expected] of [
        ['documentation bytes', (document) =>
        {
            document.buildReceipt = {
                path: arbitraryDocsRelative,
                fileDigest: `sha256:${createHash('sha256').update(
                    fs.readFileSync(arbitraryDocsAbsolute)).digest('hex')}`,
                contentDigest: arbitraryDocsReceipt.contentDigest,
                schema: arbitraryDocsReceipt.schema,
                role: 'production-build'
            };
        }, /explicit current-run JSON path|explicit non-document current-run receipt/u],
        ['historical alias', (document) =>
        {
            document.buildReceipt.path = '.tmp/history/run-1/build.json';
        },
        /explicit current-run JSON path/u],
        ['path escape', (document) =>
        {
            document.buildReceipt.path = '../build.json';
        },
        /explicit current-run JSON path|canonical repository-relative path/u],
        ['wrong role', (document) =>
        {
            document.buildReceipt.role = 'fixture';
        },
        /schema\/role\/digest contract is invalid/u],
        ['wrong schema', (document) =>
        {
            document.buildReceipt.schema = 'fsusblog.fixture-receipt.v2';
        },
        /schema\/role\/digest contract is invalid/u],
        ['wrong file digest', (document) =>
        {
            document.buildReceipt.fileDigest = digest('7');
        },
        /file digest mismatch/u],
        ['digest role confusion', (document) =>
        {
            document.buildReceipt.contentDigest = document.buildReceipt.fileDigest;
        }, /schema\/role\/digest contract is invalid/u]
    ])
    {
        const changed = coordinatedUpstreamMutation(mutate);
        assert.throws(() => validate(changed), expected, label);
        fs.writeFileSync(upstreamAbsolute, upstreamBytes);
        fs.writeFileSync(sourceAbsolute, originalSourceBytes);
    }

    const rawTamper = coordinatedUpstreamMutation((document) =>
    {
        document.rawFacts.typedPayload = 'coordinated-self-report';
    });
    assert.throws(() => validate(rawTamper), /raw semantic facts mismatch/u);
    fs.writeFileSync(upstreamAbsolute, upstreamBytes);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    const selfReportedFacts = structuredClone(base.semanticFacts);
    selfReportedFacts.typedPayloadDigest = authorityDigest('self-reported-payload');
    const selfReported = coordinatedUpstreamMutation((document) =>
    {
        document.semanticFacts = selfReportedFacts;
    });
    selfReported.semanticFacts = selfReportedFacts;
    assert.throws(() => validate(seal(selfReported)), /upstream receipt has missing or unknown fields/u);
    fs.writeFileSync(upstreamAbsolute, upstreamBytes);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    const buildAbsolute = path.join(receiptRepositoryRoot,
        JSON.parse(upstreamBytes.toString('utf8')).buildReceipt.path);
    const buildBytes = fs.readFileSync(buildAbsolute);
    const buildAlias = path.join(receiptRepositoryRoot, '.tmp/ci-production-build/build-alias.json');
    fs.writeFileSync(buildAlias, buildBytes);
    fs.rmSync(buildAbsolute);
    fs.symlinkSync(buildAlias, buildAbsolute);
    assert.throws(() => validate(base), /regular non-symlink single-link file/u);
    fs.rmSync(buildAbsolute);
    fs.writeFileSync(buildAbsolute, buildBytes);
    fs.rmSync(buildAlias);

    const staleUpstream = JSON.parse(upstreamBytes.toString('utf8'));
    staleUpstream.sourceState.runId = 'other-run';
    const sealedUpstream = seal(staleUpstream);
    fs.writeFileSync(upstreamAbsolute, `${JSON.stringify(sealedUpstream, null, 2)}\n`);
    const staleUpstreamReceipt = structuredClone(base);
    staleUpstreamReceipt.sourceReceiptRef = rewriteSource((document) =>
    {
        document.upstreamRef.fileDigest = `sha256:${createHash('sha256').update(fs.readFileSync(upstreamAbsolute)).digest('hex')}`;
        document.upstreamRef.contentDigest = sealedUpstream.contentDigest;
    });
    assert.throws(() => validate(staleUpstreamReceipt), /upstream runId mismatch/u);
    fs.writeFileSync(upstreamAbsolute, upstreamBytes);
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    for (const [label, mutate] of [
        ['missing producer', (document) =>
        {
            delete document.producerId;
        }],
        ['wrong tool', (document) =>
        {
            document.toolVersion = 'other-tool@1';
        }],
        ['wrong rerun', (document) =>
        {
            document.canonicalRerunCommand = 'node other.mjs';
        }],
        ['wrong verify', (document) =>
        {
            document.independentVerifyCommand = 'node other-verify.mjs';
        }],
        ['missing nested ref', (document) =>
        {
            delete document.fixtureReceipt;
        }],
        ['extra nested ref', (document) =>
        {
            document.otherReceipt = document.fixtureReceipt;
        }]
    ])
    {
        const changed = JSON.parse(upstreamBytes.toString('utf8'));
        mutate(changed);
        const resealed = seal(changed);
        fs.writeFileSync(upstreamAbsolute, `${JSON.stringify(resealed, null, 2)}\n`);
        const coordinated = structuredClone(base);
        coordinated.sourceReceiptRef = rewriteSource((document) =>
        {
            document.upstreamRef.fileDigest = `sha256:${createHash('sha256').update(fs.readFileSync(upstreamAbsolute)).digest('hex')}`;
            document.upstreamRef.contentDigest = resealed.contentDigest;
        });
        assert.throws(() => validate(coordinated), /upstream receipt|upstream schema\/producer\/tool\/command/u,
            label);
        fs.writeFileSync(upstreamAbsolute, upstreamBytes);
        fs.writeFileSync(sourceAbsolute, originalSourceBytes);
    }

    const upstreamAlias = path.join(receiptRepositoryRoot, '.tmp/current-run/upstream-alias.json');
    fs.writeFileSync(upstreamAlias, upstreamBytes);
    fs.rmSync(upstreamAbsolute);
    fs.symlinkSync(upstreamAlias, upstreamAbsolute);
    assert.throws(() => validate(base), /regular non-symlink single-link file/u);
    fs.rmSync(upstreamAbsolute);
    fs.writeFileSync(upstreamAbsolute, upstreamBytes);
    fs.rmSync(upstreamAlias);

    fs.writeFileSync(upstreamAlias, upstreamBytes);
    fs.rmSync(upstreamAbsolute);
    fs.linkSync(upstreamAlias, upstreamAbsolute);
    assert.throws(() => validate(base), /single-link file/u);
    fs.rmSync(upstreamAbsolute);
    fs.rmSync(upstreamAlias);
    fs.writeFileSync(upstreamAbsolute, upstreamBytes);

    for (const [bytes, expected] of [
        [originalSourceBytes.toString('utf8').replace('"role": "source",',
            '"role": "source",\n  "role": "source",'), /duplicate JSON key role|structured JSON/u],
        [JSON.stringify(JSON.parse(originalSourceBytes.toString('utf8'))), /canonical 2-space JSON|structured JSON/u]
    ])
    {
        fs.writeFileSync(sourceAbsolute, bytes);
        const malformed = structuredClone(base);
        malformed.sourceReceiptRef.fileDigest = `sha256:${createHash('sha256').update(fs.readFileSync(sourceAbsolute)).digest('hex')}`;
        assert.throws(() => validate(malformed), expected);
    }
    fs.writeFileSync(sourceAbsolute, originalSourceBytes);

    const wrongFileDigest = structuredClone(base);
    wrongFileDigest.sourceReceiptRef.fileDigest = digest('9');
    assert.throws(() => validate(wrongFileDigest), /source receipt file digest mismatch/u);

    const planAbsolute = path.join(receiptRepositoryRoot, base.candidatePlanRef.path);
    const planBytes = fs.readFileSync(planAbsolute, 'utf8');
    fs.writeFileSync(planAbsolute, planBytes.replace('"role": "plan",',
        '"role": "plan",\n  "role": "plan",'));
    const duplicateAuthority = structuredClone(base);
    duplicateAuthority.candidatePlanRef.fileDigest = `sha256:${createHash('sha256').update(fs.readFileSync(planAbsolute)).digest('hex')}`;
    assert.throws(() => validate(duplicateAuthority), /duplicate JSON key role/u);
    fs.writeFileSync(planAbsolute, planBytes);

    const schemaAbsolute = path.join(receiptRepositoryRoot,
        'config/schemas/post-runtime-observation-result.schema.json');
    const schemaBytes = fs.readFileSync(schemaAbsolute, 'utf8');
    fs.writeFileSync(schemaAbsolute, schemaBytes.replace(
        '"$schema": "https://json-schema.org/draft/2020-12/schema",',
        '"$schema": "https://json-schema.org/draft/2020-12/schema",\n    "$schema": "https://json-schema.org/draft/2020-12/schema",'));
    assert.throws(() => validate(base), /duplicate JSON key \$schema/u);
    fs.writeFileSync(schemaAbsolute, schemaBytes);
});

test('HTTP-only and stale registry/schema/evidenceClass receipts cannot qualify', () =>
{
    const producerId = registry.producers[0].producerId;
    const receipt = producerReceipt();
    const httpOnly = seal({ ...receipt, semanticFacts: { httpStatus: 200 } });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: httpOnly }),
        /raw semantic facts mismatch/u);

    const registryDrift = structuredClone(registry);
    registryDrift.canonicalSerialization = 'json-utf8-v2';
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry: registryDrift, producerId, receipt }),
        /registry\/schema digest mismatch/u);

    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-schema-'));
    fs.mkdirSync(path.join(repositoryRoot, 'config/schemas'), { recursive: true });
    const schema = JSON.parse(fs.readFileSync(
        path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'));
    schema.title = 'drifted contract';
    fs.writeFileSync(path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'),
        `${JSON.stringify(schema, null, 4)}\n`);
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt, repositoryRoot }),
        /registry\/schema digest mismatch/u);
    fs.rmSync(repositoryRoot, { recursive: true, force: true });

    const wrongEvidenceClass = seal({ ...receipt, evidenceClass: 'browser-contract' });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: wrongEvidenceClass }),
        /evidenceClass does not match producer contract/u);
});

test('production validator rejects a second registry and is wired into static governance', (context) =>
{
    const createRepository = () =>
    {
        const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-authority-'));
        context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
        fs.mkdirSync(path.join(repositoryRoot, 'config/testing'), { recursive: true });
        fs.copyFileSync(path.join(root, 'config/configuration-ownership.json'),
            path.join(repositoryRoot, 'config/configuration-ownership.json'));
        fs.copyFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'),
            path.join(repositoryRoot, 'config/testing/post-runtime-producer-registry.json'));
        execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot });
        execFileSync('git', ['add', 'config/configuration-ownership.json',
            'config/testing/post-runtime-producer-registry.json'], { cwd: repositoryRoot });
        execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
            'commit', '--quiet', '-m', 'canonical authority'], { cwd: repositoryRoot });
        return repositoryRoot;
    };
    const canonicalRoot = createRepository();
    assert.equal(validatePostRuntimeRepositoryAuthority(canonicalRoot, { validateReaderFirewall: false }), true);
    for (const roguePath of [
        'tools/second-post-runtime-registry.json',
        'generated/second-post-runtime-registry.json',
        'vendor/second-post-runtime-registry.json',
        'node_modules/second-post-runtime-registry.json',
        '.tmp/second-post-runtime-registry.json',
        'tmp/second-post-runtime-registry.json',
        'tools/second-post-runtime-registry.generated.json',
        'tools/second-post-runtime-registry.JSON',
        'tools/second-post-runtime-registry.registry'
    ])
    {
        const repositoryRoot = createRepository();
        fs.mkdirSync(path.dirname(path.join(repositoryRoot, roguePath)), { recursive: true });
        fs.copyFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'),
            path.join(repositoryRoot, roguePath));
        execFileSync('git', ['add', '--force', roguePath], { cwd: repositoryRoot });
        execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
            'commit', '--quiet', '-m', 'rogue authority'], { cwd: repositoryRoot });
        assert.throws(
            () => validatePostRuntimeRepositoryAuthority(repositoryRoot, { validateReaderFirewall: false }),
            /authority paths must exact-match/u,
            `tracked rogue registry at ${roguePath} must fail closed`);
    }

    const stagedSplitRoot = createRepository();
    fs.mkdirSync(path.join(stagedSplitRoot, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'),
        path.join(stagedSplitRoot, 'tools/staged.registry'));
    execFileSync('git', ['add', 'tools/staged.registry'], { cwd: stagedSplitRoot });
    fs.writeFileSync(path.join(stagedSplitRoot, 'tools/staged.registry'), '{"schema":"benign"}\n');
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(stagedSplitRoot, { validateReaderFirewall: false }),
        /HEAD\/index authority is not exact-clean/u);

    const worktreeSplitRoot = createRepository();
    fs.mkdirSync(path.join(worktreeSplitRoot, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(worktreeSplitRoot, 'tools/worktree.registry'), '{"schema":"benign"}\n');
    execFileSync('git', ['add', 'tools/worktree.registry'], { cwd: worktreeSplitRoot });
    execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
        'commit', '--quiet', '-m', 'benign index blob'], { cwd: worktreeSplitRoot });
    fs.copyFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'),
        path.join(worktreeSplitRoot, 'tools/worktree.registry'));
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(worktreeSplitRoot, { validateReaderFirewall: false }),
        /worktree bytes do not exact-match/u);

    const hardlinkRoot = createRepository();
    fs.mkdirSync(path.join(hardlinkRoot, 'tools'), { recursive: true });
    fs.linkSync(path.join(hardlinkRoot, 'config/testing/post-runtime-producer-registry.json'),
        path.join(hardlinkRoot, 'tools/hardlink.registry'));
    execFileSync('git', ['add', 'tools/hardlink.registry'], { cwd: hardlinkRoot });
    execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
        'commit', '--quiet', '-m', 'hardlink authority'], { cwd: hardlinkRoot });
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(hardlinkRoot, { validateReaderFirewall: false }),
        /single-link file/u);

    const gitlinkRoot = createRepository();
    const gitlinkOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitlinkRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${gitlinkOid},tools/hidden-authority`],
        { cwd: gitlinkRoot });
    execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
        'commit', '--quiet', '-m', 'gitlink authority escape'], { cwd: gitlinkRoot });
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(gitlinkRoot, { validateReaderFirewall: false }),
        /unsupported mode 160000/u);

    const replacementRoot = createRepository();
    execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
        'commit', '--quiet', '--allow-empty', '-m', 'replacement target'], { cwd: replacementRoot });
    const replacementHead = execFileSync('git', ['rev-parse', 'HEAD'],
        { cwd: replacementRoot, encoding: 'utf8' }).trim();
    const replacementParent = execFileSync('git', ['rev-parse', 'HEAD^'],
        { cwd: replacementRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['replace', replacementHead, replacementParent], { cwd: replacementRoot });
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(replacementRoot, { validateReaderFirewall: false }),
        /replacement refs are forbidden/u);

    const duplicateRoot = createRepository();
    const duplicateRegistry = path.join(duplicateRoot, 'config/testing/post-runtime-producer-registry.json');
    const duplicateBytes = fs.readFileSync(duplicateRegistry, 'utf8').replace(
        '"schema": "fsusblog.post-runtime-producer-registry.v2",',
        '"schema": "fsusblog.post-runtime-producer-registry.v2",\n    "schema": "fsusblog.post-runtime-producer-registry.v2",');
    fs.writeFileSync(duplicateRegistry, duplicateBytes);
    execFileSync('git', ['add', 'config/testing/post-runtime-producer-registry.json'], { cwd: duplicateRoot });
    execFileSync('git', ['-c', 'user.name=FsusBlog Test', '-c', 'user.email=test@fsus.invalid',
        'commit', '--quiet', '-m', 'duplicate registry key'], { cwd: duplicateRoot });
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(duplicateRoot, { validateReaderFirewall: false }),
        /duplicate JSON key schema/u);

    const staticLane = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');
    assert.match(staticLane,
        /StaticPostRuntimeProducerRegistry\(\).*post-runtime-producer-registry\.mjs/su);
    assert.match(staticLane,
        /post-runtime-producer-registry StaticPostRuntimeProducerRegistry/u);
});

test('owner and command authorities reject symlinks and external realpaths', (context) =>
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-owner-'));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-external-'));
    context.after(() =>
    {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
        fs.rmSync(externalRoot, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(repositoryRoot, 'tools'), { recursive: true });
    const external = path.join(externalRoot, 'owner.mjs');
    fs.writeFileSync(external, 'export const owner = true\n');
    fs.symlinkSync(external, path.join(repositoryRoot, 'tools/owner.mjs'));
    assert.throws(
        () => canonicalRepositoryFile(repositoryRoot, 'tools/owner.mjs', 'producer owner'),
        /regular non-symlink single-link file/u);

    fs.symlinkSync(externalRoot, path.join(repositoryRoot, 'tools-link'));
    assert.throws(
        () => canonicalRepositoryFile(repositoryRoot, 'tools-link/owner.mjs', 'producer command'),
        /canonical path inside the repository root/u);
});

test('reader firewall traverses imports and rejects transitive Markdown/DocClaim readers', (context) =>
{
    const current = validatePostRuntimeReaderFirewall(root);
    assert.ok(current.modules.includes('tools/test-matrix/post-runtime-producer-registry.mjs'));

    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-reader-'));
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(repositoryRoot, 'tools/test-matrix'), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, 'tools/docs'), { recursive: true });
    const canonicalSource = fs.readFileSync(path.join(root,
        'tools/test-matrix/post-runtime-producer-registry.mjs'), 'utf8');
    const pinnedReaderSource = canonicalSource.slice(
        canonicalSource.indexOf('function readPinnedRepositoryFile('),
        canonicalSource.indexOf('function trackedRepositoryEntries(')).trim();
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/copied-reader.mjs'),
        `import * as fs from 'node:fs'\n${pinnedReaderSource}\n`);
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/copied-entry.mjs'),
        "import './copied-reader.mjs'\n");
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/copied-entry.mjs'),
        /computed filesystem path is forbidden/u);
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/post-runtime-producer-registry.mjs'),
        `import * as fs from 'node:fs'\n${pinnedReaderSource.replace('fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW', 'fs.constants.O_RDONLY')}\n`);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot),
        /computed filesystem path is forbidden/u);
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/entry.mjs'),
        "import './middle.mjs'\nexport const entry = true\n");
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/middle.mjs'),
        "export { claim } from '../docs/doc-claim.mjs'\n");
    fs.writeFileSync(path.join(repositoryRoot, 'tools/docs/doc-claim.mjs'),
        'export const claim = true\n');
    fs.writeFileSync(path.join(repositoryRoot, 'package.json'), `${JSON.stringify({
        name: 'post-runtime-reader-fixture',
        type: 'module',
        imports: { '#doc-reader': './tools/docs/doc-claim.mjs' },
        exports: { './doc-reader': './tools/docs/doc-claim.mjs' }
    }, null, 2)}\n`);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/entry.mjs'),
        /import closure reaches forbidden Markdown\/DocClaim module/u);

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/escaped-entry.mjs'),
        "import '../d\\u006fcs/doc-claim.mjs'\nexport const entry = true\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/escaped-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/escaped-entry.mjs'),
        /import closure reaches forbidden Markdown\/DocClaim module/u);

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/escaped-hex-entry.mjs'),
        "import '..\\x2fdocs\\x2fdoc-claim.mjs'\nexport const entry = true\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/escaped-hex-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/escaped-hex-entry.mjs'),
        /import closure reaches forbidden Markdown\/DocClaim module/u);

    for (const [name, specifier] of [
        ['absolute-entry.mjs', path.join(repositoryRoot, 'tools/docs/doc-claim.mjs')],
        ['imports-alias-entry.mjs', '#doc-reader'],
        ['self-export-entry.mjs', 'post-runtime-reader-fixture/doc-reader']
    ])
    {
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', name),
            `import ${JSON.stringify(specifier)}\nexport const entry = true\n`);
        execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix', name)]);
        assert.throws(
            () => validatePostRuntimeReaderFirewall(repositoryRoot, `tools/test-matrix/${name}`),
            /import closure reaches forbidden Markdown\/DocClaim module/u);
    }

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/require-entry.mjs'),
        "import './middle.cjs'\nexport const entry = true\n");
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/middle.cjs'),
        "module.exports = require('../d\\x6fcs/doc-claim.cjs')\n");
    fs.writeFileSync(path.join(repositoryRoot, 'tools/docs/doc-claim.cjs'),
        'module.exports = { claim: true }\n');
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/require-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/require-entry.mjs'),
        /import closure reaches forbidden Markdown\/DocClaim module/u);

    for (const [name, source] of [
        ['template-middle.cjs', "module.exports = `${require('../docs/doc-claim.cjs').claim}`\n"],
        ['escaped-require-middle.cjs', "module.exports = requ\\u0069re('../docs/doc-claim.cjs')\n"],
        ['aliased-require-middle.cjs', "const replay = require\nmodule.exports = replay('../docs/doc-claim.cjs')\n"]
    ])
    {
        const entry = name.replace('-middle.cjs', '-entry.mjs');
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', name), source);
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', entry),
            `import './${name}'\nexport const entry = true\n`);
        execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix', entry)]);
        assert.throws(
            () => validatePostRuntimeReaderFirewall(repositoryRoot, `tools/test-matrix/${entry}`),
            /import closure reaches forbidden Markdown\/DocClaim module/u);
    }

    for (const [name, source] of [
        ['eval-entry.cjs', "module.exports = eval('1 + 1')\n"],
        ['function-entry.cjs', "const Dynamic = Function\nmodule.exports = Dynamic('return 2')()\n"]
    ])
    {
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', name), source);
        execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix', name)]);
        assert.throws(
            () => validatePostRuntimeReaderFirewall(repositoryRoot, `tools/test-matrix/${name}`),
            /dynamic eval\/Function code is forbidden/u);
    }

    fs.mkdirSync(path.join(repositoryRoot, 'DoCs'), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, 'DoCs/reader.mjs'), 'export const reader = true\n');
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/case-docs-entry.mjs'),
        "import '../../DoCs/reader.mjs'\nexport const entry = true\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/case-docs-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/case-docs-entry.mjs'),
        /forbidden Markdown\/DocClaim module/u);

    fs.mkdirSync(path.join(repositoryRoot, 'Ｄｏｃｓ'), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, 'Ｄｏｃｓ/reader.mjs'), 'export const reader = true\n');
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/unicode-docs-entry.mjs'),
        "import '../../Ｄｏｃｓ/reader.mjs'\nexport const entry = true\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/unicode-docs-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/unicode-docs-entry.mjs'),
        /forbidden Markdown\/DocClaim module/u);

    const docsText = path.join(repositoryRoot, 'DoCs/reader.txt');
    fs.writeFileSync(docsText, 'reader facts\n');
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/fs-docs-entry.mjs'),
        `import fs from 'node:fs'\nexport const facts = fs.readFileSync(${JSON.stringify(docsText)}, 'utf8')\n`);
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/fs-docs-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/fs-docs-entry.mjs'),
        /documentation filesystem read is forbidden/u);

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/aliased-fs-docs-entry.mjs'),
        `import { readFileSync as load } from 'node:fs'\nexport const facts = load(${JSON.stringify(docsText)}, 'utf8')\n`);
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/aliased-fs-docs-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/aliased-fs-docs-entry.mjs'),
        /documentation filesystem read is forbidden/u);

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/url-docs-entry.mjs'),
        "export const facts = new URL('../../DoCs/reader.txt', import.meta.url).href\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/url-docs-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/url-docs-entry.mjs'),
        /documentation URL is forbidden/u);

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/computed-fs-entry.mjs'),
        "import fs from 'node:fs'\nexport const facts = fs.readFileSync(process.argv[2], 'utf8')\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/computed-fs-entry.mjs'), docsText]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/computed-fs-entry.mjs'),
        /computed filesystem path is forbidden/u);

    for (const [name, source] of [
        ['trusted-name-entry.mjs',
            `import fs from 'node:fs'\nfunction readPinnedRepositoryFile() { return fs.readFileSync(${JSON.stringify(docsText)}, 'utf8') }\nexport const facts = readPinnedRepositoryFile()\n`],
        ['stream-reader-entry.mjs',
            `import fs from 'node:fs'\nexport const facts = fs.createReadStream(${JSON.stringify(docsText)})\nfacts.resume()\n`],
        ['call-reader-entry.mjs',
            `import fs from 'node:fs'\nexport const facts = fs.readFileSync.call(fs, ${JSON.stringify(docsText)}, 'utf8')\n`],
        ['reflect-reader-entry.mjs',
            `import fs from 'node:fs'\nexport const facts = Reflect.apply(fs.readFileSync, fs, [${JSON.stringify(docsText)}, 'utf8'])\n`]
    ])
    {
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', name), source);
        execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix', name)]);
        assert.throws(
            () => validatePostRuntimeReaderFirewall(repositoryRoot, `tools/test-matrix/${name}`),
            /documentation filesystem read is forbidden/u);
    }

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/computed-reader-entry.mjs'),
        `import fs from 'node:fs'\nexport const facts = fs['read' + 'FileSync'](${JSON.stringify(docsText)}, 'utf8')\n`);
    execFileSync(process.execPath, [path.join(repositoryRoot,
        'tools/test-matrix/computed-reader-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot,
            'tools/test-matrix/computed-reader-entry.mjs'),
        /computed filesystem reader method is forbidden/u);

    for (const [name, source] of [
        ['cjs-computed-reader.cjs',
            `const disk = require('node:fs')\nprocess.stdout.write(disk['read' + 'FileSync'](${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-namespace-alias.cjs',
            `const disk = require('node:fs')\nconst storage = disk\nprocess.stdout.write(storage?.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-reader-alias.cjs',
            `const disk = require('node:fs')\nconst load = disk.readFileSync\nprocess.stdout.write(load?.(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-computed-reader-alias.cjs',
            `const disk = require('node:fs')\nconst load = disk['read' + 'FileSync']\nprocess.stdout.write(load?.(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-bound-reader.cjs',
            `const disk = require('node:fs')\nconst load = disk.readFileSync.bind(disk)\nprocess.stdout.write(load(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-module-require.cjs',
            `const disk = module.require('node:fs')\nprocess.stdout.write(disk['read' + 'FileSync'](${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['create-require-entry.mjs',
            `import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk?.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['default-module-create-require-entry.mjs',
            `import Module from 'node:module'\nconst load = Module.createRequire(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk?.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['named-default-module-create-require-entry.mjs',
            `import { default as Module } from 'node:module'\nconst load = Module.createRequire(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['hoisted-default-module-create-require-entry.mjs',
            `const load = Module.createRequire(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\nimport Module from 'node:module'\n`],
        ['namespace-module-create-require-entry.mjs',
            `import * as Module from 'node:module'\nconst factory = Module['create\\u0052equire']\nconst load = factory(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk?.['readFileSync'](${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['namespace-destructured-create-require-entry.mjs',
            `import * as Module from 'node:module'\nconst { ['createRequire']: factory } = Module\nconst load = factory(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['default-assigned-create-require-entry.mjs',
            `import Module from 'node:module'\nlet factory\nfactory = Module['createRequire']\nconst load = factory(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['namespace-aliased-direct-create-require-entry.mjs',
            `import * as Module from 'node:module'\nconst RuntimeModule = Module\nconst disk = RuntimeModule['createRequire'](import.meta.url)('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['namespace-computed-create-require-entry.mjs',
            `import * as Module from 'node:module'\nconst factory = Module['create' + 'Require']\nconst load = factory(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-create-require.cjs',
            `const { createRequire: factory } = require('node:module')\nconst load = factory(__filename)\nconst disk = load('node:fs')\nprocess.stdout.write(disk?.readFileSync(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['imported-fs-promises-reader.mjs',
            `import { promises as disk } from 'node:fs'\nprocess.stdout.write(await disk.readFile(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['cjs-destructured-promises-reader.cjs',
            `const { promises: disk } = require('node:fs')\ndisk.readFile(${JSON.stringify(docsText)}, 'utf8').then(value => process.stdout.write(value))\n`],
        ['cjs-assigned-reader.cjs',
            `const disk = require('node:fs')\nlet load\n;({ readFileSync: load } = disk)\nprocess.stdout.write(load(${JSON.stringify(docsText)}, 'utf8'))\n`],
        ['dynamic-import-entry.mjs',
            `const disk = await import('node:fs')\nprocess.stdout.write(disk['read' + 'FileSync'](${JSON.stringify(docsText)}, 'utf8'))\n`]
    ])
    {
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', name), source);
        assert.equal(execFileSync(process.execPath, [path.join(repositoryRoot,
            'tools/test-matrix', name)], { encoding: 'utf8' }), 'reader facts\n');
        assert.throws(
            () => validatePostRuntimeReaderFirewall(repositoryRoot, `tools/test-matrix/${name}`),
            /documentation filesystem read|computed (?:filesystem reader|module factory) method/u);
    }

    const dataText = path.join(repositoryRoot, 'reader-data.txt');
    fs.writeFileSync(dataText, 'non-document data\n');
    for (const [name, source] of [
        ['default-module-safe-entry.mjs',
            `import Module from 'node:module'\nconst load = Module.createRequire(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk.readFileSync(${JSON.stringify(dataText)}, 'utf8'))\n`],
        ['namespace-module-safe-entry.mjs',
            `import * as Module from 'node:module'\nconst factory = Module['createRequire']\nconst load = factory(import.meta.url)\nconst disk = load('node:fs')\nprocess.stdout.write(disk['readFileSync'](${JSON.stringify(dataText)}, 'utf8'))\n`]
    ])
    {
        fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix', name), source);
        assert.equal(execFileSync(process.execPath, [path.join(repositoryRoot,
            'tools/test-matrix', name)], { encoding: 'utf8' }), 'non-document data\n');
        assert.doesNotThrow(
            () => validatePostRuntimeReaderFirewall(repositoryRoot,
                `tools/test-matrix/${name}`));
    }

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/unrelated-module-member.mjs'),
        "const model = { createRequire: () => () => ({ readFileSync: value => value }) }\nprocess.stdout.write(model['createRequire']()('node:fs').readFileSync('synthetic'))\n");
    assert.equal(execFileSync(process.execPath, [path.join(repositoryRoot,
        'tools/test-matrix/unrelated-module-member.mjs')], { encoding: 'utf8' }), 'synthetic');
    assert.doesNotThrow(
        () => validatePostRuntimeReaderFirewall(repositoryRoot,
            'tools/test-matrix/unrelated-module-member.mjs'));

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/unrelated-reader.mjs'),
        "const model = { readFileSync: (value) => value }\nexport const value = model.readFileSync(process.argv[2])\n");
    assert.doesNotThrow(
        () => validatePostRuntimeReaderFirewall(repositoryRoot,
            'tools/test-matrix/unrelated-reader.mjs'));

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/unrelated-require.mjs'),
        "const model = { require: (value) => value, readFileSync: (value) => value }\nexport const value = model.readFileSync(model.require(process.argv[2]))\n");
    assert.doesNotThrow(
        () => validatePostRuntimeReaderFirewall(repositoryRoot,
            'tools/test-matrix/unrelated-require.mjs'));

    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/computed-url-entry.mjs'),
        "export const facts = new URL(process.argv[2], import.meta.url).href\n");
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/computed-url-entry.mjs'), docsText]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/computed-url-entry.mjs'),
        /dynamic or documentation URL is forbidden/u);

    fs.linkSync(path.join(repositoryRoot, 'tools/docs/doc-claim.mjs'),
        path.join(repositoryRoot, 'tools/test-matrix/hardlink-entry.mjs'));
    execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/test-matrix/hardlink-entry.mjs')]);
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/hardlink-entry.mjs'),
        /single-link file/u);
    fs.rmSync(path.join(repositoryRoot, 'tools/test-matrix/hardlink-entry.mjs'));
});

test('pure receipt contracts reject transitive filesystem and execution capabilities', (context) =>
{
    const repositoryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-pure-receipt-')
    );
    context.after(() =>
        fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const entry = 'tools/docs/behavior-doc-static-admission-contract.mjs';
    const entryFile = path.join(repositoryRoot, entry);
    fs.mkdirSync(path.dirname(entryFile), { recursive: true });
    fs.writeFileSync(
        entryFile,
        "import path from 'node:path'; export const normalize = path.resolve;\n"
    );
    assert.doesNotThrow(() =>
        validatePostRuntimeReaderFirewall(repositoryRoot, entry));
    fs.writeFileSync(
        entryFile,
        "import fs from 'node:fs'; export const reader = fs;\n"
    );
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, entry),
        /forbidden I\/O or execution module node:fs/u
    );
    const helper = path.join(repositoryRoot, 'tools/contracts/pure-helper.mjs');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(
        entryFile,
        "export { run } from '../contracts/pure-helper.mjs';\n"
    );
    fs.writeFileSync(
        helper,
        "import { spawnSync } from 'node:child_process'; export const run = spawnSync;\n"
    );
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, entry),
        /forbidden I\/O or execution module node:child_process/u
    );
});

test('re-sealed diagnostic, timeout, cancel and recovered mutations cannot qualify', () =>
{
    const producerId = registry.producers[0].producerId;
    const base = producerReceipt();
    const diagnostic = seal({ ...base, executionClass: 'diagnostic', qualificationEligible: false });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: diagnostic }),
        /executionClass cannot satisfy qualification/u);

    const timedOut = seal({
        ...base,
        qualificationEligible: false,
        outcome: 'timed-out',
        terminal: {
            timeout: true,
            cancelled: false,
            processTreeTerminated: true,
            priorAttemptDigest: null
        }
    });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: timedOut }),
        /qualificationEligible cannot satisfy qualification/u);

    const contradictoryCancel = seal({
        ...base,
        outcome: 'cancelled',
        terminal: {
            timeout: false,
            cancelled: true,
            processTreeTerminated: false,
            priorAttemptDigest: null
        }
    });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: contradictoryCancel }),
        /terminal outcome is contradictory/u);

    const recovered = seal({
        ...base,
        qualificationEligible: false,
        recovered: true,
        terminal: { ...base.terminal, priorAttemptDigest: digest('9') }
    });
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: recovered }),
        /qualificationEligible cannot satisfy qualification/u);
});

function acceptedClaimsFixture(context)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-claims-'));
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(repositoryRoot, 'config/schemas'), { recursive: true });
    const schedulerRunId = 'run-1';
    const attemptId = 'attempt-0001';
    const evidenceDirectory = path.join(repositoryRoot, 'artifacts/current-run', schedulerRunId, attemptId);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.copyFileSync(
        path.join(root, 'config/schemas/post-runtime-accepted-claims.schema.json'),
        path.join(repositoryRoot, 'config/schemas/post-runtime-accepted-claims.schema.json'));
    fs.copyFileSync(path.join(root, 'config/schemas/doc-claim.schema.json'),
        path.join(repositoryRoot, 'config/schemas/doc-claim.schema.json'));
    const terminalRelative = `artifacts/current-run/${schedulerRunId}/${attemptId}/global-claim-exactness-final.terminal.json`;
    const referenceRelative = `artifacts/current-run/${schedulerRunId}/${attemptId}/global-claim-exactness-final.reference.json`;
    const terminalPath = path.join(repositoryRoot, terminalRelative);
    const referencePath = path.join(repositoryRoot, referenceRelative);
    const owners = new Map();
    for (const scope of migrationLedger.scopes)
    {
        for (const entry of scope.entries)
        {
            for (const [claimIndex, claimId] of entry.claimIds.entries())
            {
                owners.set(claimId, {
                    claimId,
                    behaviorId: BehaviorId(entry.behaviorId),
                    scopeId: scope.scopeId,
                    documentPath: entry.documentPath,
                    generatedSectionIds: [...(entry.generatedSectionIds ?? [])].sort(),
                    generatedSectionId: (entry.generatedSectionIds ?? [])[claimIndex] ?? null
                });
            }
        }
    }
    const documentAuthority = loadGlobalDocumentAuthority(root);
    const claimAcceptance = documentAuthority.claimAcceptance;
    const generatedClaimCount = documentAuthority.ledgerSummary.generatedClaimCount;
    const proseClaimCount = documentAuthority.ledgerSummary.proseClaimCount;
    // Synthetic consumer envelope; not compiled-observation terminal acceptance.
    const terminal = {
        schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1',
        scopeId: 'global-document-claim-exactness',
        runId: schedulerRunId,
        source: {
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: 'b'.repeat(64),
            ...documentAuthority.documentAuthorityDigests,
            observationDigests: { test: 'e'.repeat(64) }
        },
        authorityDigests: ['test'],
        counts: {
            requiredBehaviors: 1,
            scopes: 1,
            ledgerEntries: 1,
            generatedClaimCount,
            proseClaimCount,
            proseTotal: 1,
            proseVerified: 1,
            generatedSectionsVerified: 1,
            generatedSectionDrifts: 0,
            missing: 0,
            extra: 0,
            residue: 0,
            mutationKilled: 1,
            mutationTotal: 1,
            warnings: 0
        },
        mutationAggregate: { killed: 1, total: 1 },
        claimAcceptance,
        residue: [],
        proseVerification: { diagnostics: [] },
        status: 'ok',
        failureReasons: [],
        contentDigest: null
    };
    terminal.contentDigest = digestValue(terminal);
    const writeTerminal = (value) =>
    {
        fs.writeFileSync(terminalPath, `${JSON.stringify(value, null, 2)}\n`);
        return `sha256:${createHash('sha256').update(fs.readFileSync(terminalPath)).digest('hex')}`;
    };
    const fileDigest = writeTerminal(terminal);
    const terminalAuthority = registry.receiptSemantics.acceptedTerminalAuthority;
    const candidateIdentity = { candidateId: 'run-1:candidate' };
    const buildIdentity = { buildDigest: digest('4') };
    const referenceBody = {
        schema: terminalAuthority.referenceSchema,
        schedulerRunId,
        attemptId,
        sourceCommit: terminal.source.sourceCommit,
        worktreeFingerprint: terminal.source.worktreeFingerprint,
        candidateIdentity,
        buildIdentity,
        authorityId: terminalAuthority.authorityId,
        producerId: terminalAuthority.producerId,
        payload: {
            path: terminalRelative,
            schema: terminal.schema,
            digest: fileDigest
        }
    };
    const referenceWithContent = { ...referenceBody, contentDigest: authorityDigest(referenceBody) };
    const reference = {
        ...referenceWithContent,
        producerReceiptDigest: authorityDigest(referenceWithContent)
    };
    fs.writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`);
    const referenceFileDigest = `sha256:${createHash('sha256').update(fs.readFileSync(referencePath)).digest('hex')}`;
    const producer = registry.producers[0];
    const receipt = seal({
        schema: acceptedClaimsSchema,
        sourceState: {
            commit: terminal.source.sourceCommit,
            worktreeFingerprint: `sha256:${terminal.source.worktreeFingerprint}`,
            schedulerRunId,
            attemptId,
            candidateIdentityDigest: authorityDigest(candidateIdentity),
            buildIdentityDigest: authorityDigest(buildIdentity)
        },
        producerId: producer.producerId,
        toolVersion: registry.receiptSemantics.acceptedClaimsToolVersion,
        registryDigest: authorityDigest(registry),
        claimsSchemaDigest: authorityDigest(JSON.parse(fs.readFileSync(
            path.join(root, 'config/schemas/post-runtime-accepted-claims.schema.json'), 'utf8'))),
        terminalReceiptRef: {
            path: referenceRelative,
            fileDigest: referenceFileDigest,
            contentDigest: reference.contentDigest,
            schema: reference.schema,
            authorityId: terminalAuthority.authorityId,
            producerId: terminalAuthority.producerId,
            toolVersion: terminalAuthority.toolVersion,
            producerCommand: terminalAuthority.producerCommand,
            payloadPath: terminalRelative,
            payloadFileDigest: fileDigest,
            payloadContentDigest: `sha256:${terminal.contentDigest}`,
            payloadSchema: terminal.schema
        },
        migrationLedgerDigest: `sha256:${terminal.source.migrationLedgerDigest}`,
        claims: producer.acceptedClaimRefs.map((claimId) =>
        {
            const owner = owners.get(claimId);
            const accepted = claimAcceptance.find((claim) => claim.claimId === claimId);
            return {
                claimId: owner.claimId,
                behaviorId: BehaviorId(owner.behaviorId),
                scopeId: owner.scopeId,
                claimDigest: accepted.claimDigest
            };
        })
            .sort((left, right) => left.claimId.localeCompare(right.claimId)),
        status: 'accepted'
    });
    const bindTerminal = (value, receiptValue = receipt) =>
    {
        const payloadFileDigest = writeTerminal(value);
        const referenceBody = structuredClone(reference);
        delete referenceBody.contentDigest;
        delete referenceBody.producerReceiptDigest;
        referenceBody.payload.digest = payloadFileDigest;
        const referenceWithContent = {
            ...referenceBody,
            contentDigest: authorityDigest(referenceBody)
        };
        const currentReference = {
            ...referenceWithContent,
            producerReceiptDigest: authorityDigest(referenceWithContent)
        };
        fs.writeFileSync(referencePath, `${JSON.stringify(currentReference, null, 2)}\n`);
        const changed = structuredClone(receiptValue);
        changed.terminalReceiptRef.fileDigest = `sha256:${createHash('sha256')
            .update(fs.readFileSync(referencePath)).digest('hex')}`;
        changed.terminalReceiptRef.contentDigest = currentReference.contentDigest;
        changed.terminalReceiptRef.payloadFileDigest = payloadFileDigest;
        changed.terminalReceiptRef.payloadContentDigest = `sha256:${value.contentDigest}`;
        return seal(changed);
    };
    return {
        repositoryRoot, terminalPath, referencePath, terminal, reference, receipt,
        writeTerminal, bindTerminal
    };
}

test('accepted claims replay one exact #2205 terminal path, digest, identity and claim set', (context) =>
{
    const fixture = acceptedClaimsFixture(context);
    const producerId = registry.producers[0].producerId;
    const result = validateAcceptedClaimsReceiptAgainstRegistry({
        registry,
        producerId,
        receipt: fixture.receipt,
        repositoryRoot: fixture.repositoryRoot,
        migrationLedger
    });
    assert.equal(result.producerId, producerId);
    assert.equal(result.acceptedClaims, registry.producers[0].acceptedClaimRefs.length);

    const oldV1Shape = structuredClone(fixture.receipt);
    oldV1Shape.terminalReceiptDigest = oldV1Shape.terminalReceiptRef.contentDigest;
    delete oldV1Shape.terminalReceiptRef;
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: seal(oldV1Shape),
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /missing or unknown fields/u);

    for (const field of ['registryDigest', 'claimsSchemaDigest'])
    {
        assert.throws(
            () => validateAcceptedClaimsReceiptAgainstRegistry({
                registry,
                producerId,
                receipt: seal({ ...fixture.receipt, [field]: digest('8') }),
                repositoryRoot: fixture.repositoryRoot,
                migrationLedger
            }),
            /registry\/schema digest mismatch/u);
    }
});

test('accepted terminal preserves canonical DocClaim types and refuses aliases or section contradictions', (context) =>
{
    const producerId = registry.producers[0].producerId;
    for (const mutation of ['unknown', 'prose', 'generated-null', 'rationale-with-section'])
    {
        const fixture = acceptedClaimsFixture(context);
        const terminal = structuredClone(fixture.terminal);
        assert.ok(terminal.claimAcceptance.some((claim) => claim.claimType === 'rationale'));
        const claim = terminal.claimAcceptance.find((entry) => entry.claimType === 'generated-section');
        if (mutation === 'unknown') claim.claimType = 'opaque-compatible-type';
        if (mutation === 'prose') claim.claimType = 'prose';
        if (mutation === 'generated-null') claim.generatedSectionId = null;
        if (mutation === 'rationale-with-section') claim.claimType = 'rationale';
        terminal.contentDigest = digestValue({ ...terminal, contentDigest: null });
        const receipt = fixture.bindTerminal(terminal);
        assert.throws(() => validateAcceptedClaimsReceiptAgainstRegistry({
            registry, producerId, receipt, repositoryRoot: fixture.repositoryRoot, migrationLedger
        }), /terminal claim acceptance is invalid/u, mutation);
    }
});

test('accepted claims reject terminal file/content/identity and re-sealed claim mutations', (context) =>
{
    const fixture = acceptedClaimsFixture(context);
    const producerId = registry.producers[0].producerId;
    fs.appendFileSync(fixture.terminalPath, ' ');
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: fixture.receipt,
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /file digest mismatch/u);

    fixture.writeTerminal(fixture.terminal);
    const duplicateClaim = seal({
        ...fixture.receipt,
        claims: [...fixture.receipt.claims, fixture.receipt.claims[0]]
    });
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: duplicateClaim,
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /claim set does not exact-match/u);

    const driftedTerminal = structuredClone(fixture.terminal);
    driftedTerminal.source.sourceCommit = 'f'.repeat(40);
    driftedTerminal.contentDigest = null;
    driftedTerminal.contentDigest = digestValue(driftedTerminal);
    const driftedFileDigest = fixture.writeTerminal(driftedTerminal);
    const driftedReferenceBody = {
        ...fixture.reference,
        sourceCommit: driftedTerminal.source.sourceCommit,
        payload: { ...fixture.reference.payload, digest: driftedFileDigest }
    };
    delete driftedReferenceBody.contentDigest;
    delete driftedReferenceBody.producerReceiptDigest;
    const driftedReferenceWithContent = {
        ...driftedReferenceBody,
        contentDigest: authorityDigest(driftedReferenceBody)
    };
    const driftedReference = {
        ...driftedReferenceWithContent,
        producerReceiptDigest: authorityDigest(driftedReferenceWithContent)
    };
    fs.writeFileSync(fixture.referencePath, `${JSON.stringify(driftedReference, null, 2)}\n`);
    const identityDrift = seal({
        ...fixture.receipt,
        terminalReceiptRef: {
            ...fixture.receipt.terminalReceiptRef,
            fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(fixture.referencePath)).digest('hex')}`,
            contentDigest: driftedReference.contentDigest,
            payloadFileDigest: driftedFileDigest,
            payloadContentDigest: `sha256:${driftedTerminal.contentDigest}`
        }
    });
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: identityDrift,
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /reference identity\/content seal mismatch/u);
});

test('accepted claims reject a re-sealed terminal from another scheduler run', (context) =>
{
    const fixture = acceptedClaimsFixture(context);
    const terminal = structuredClone(fixture.terminal);
    terminal.runId = 'other-run';
    terminal.contentDigest = digestValue({ ...terminal, contentDigest: null });
    const receipt = fixture.bindTerminal(terminal);
    assert.throws(() => validateAcceptedClaimsReceiptAgainstRegistry({
        registry, producerId: registry.producers[0].producerId, receipt,
        repositoryRoot: fixture.repositoryRoot, migrationLedger
    }), /terminal receipt source identity mismatch/u);
});

test('accepted claims replay the terminal exact claim inventory rather than reconstructing it', (context) =>
{
    const producerId = registry.producers[0].producerId;
    for (const mutate of [
        (terminal) =>
        {
            const removed = terminal.claimAcceptance.pop();
            terminal.counts[removed.claimType === 'generated-section'
                ? 'generatedClaimCount'
                : 'proseClaimCount'] -= 1;
        },
        (terminal) =>
        {
            terminal.claimAcceptance[0].behaviorId = BehaviorId(catalog.contracts
                .find((contract) => contract.id !== terminal.claimAcceptance[0].behaviorId).id);
        },
        (terminal) =>
        {
            terminal.claimAcceptance[0].behaviorId = `${BehaviorId(terminal.claimAcceptance[0].behaviorId)}-unregistered`;
        },
        (terminal) =>
        {
            terminal.claimAcceptance[0].documentPath = 'docs/other.md';
        }
    ])
    {
        const fixture = acceptedClaimsFixture(context);
        const changedTerminal = structuredClone(fixture.terminal);
        mutate(changedTerminal);
        changedTerminal.contentDigest = null;
        changedTerminal.contentDigest = digestValue(changedTerminal);
        const coordinated = fixture.bindTerminal(changedTerminal);
        assert.throws(() => validateAcceptedClaimsReceiptAgainstRegistry({
            registry, producerId, receipt: coordinated,
            repositoryRoot: fixture.repositoryRoot, migrationLedger
        }), /terminal claim set does not exact-match|terminal claim .*does not exact-match/u);
    }
});

test('accepted claims reject re-sealed #2205 path, producer, tool, command and duplicate JSON drift', (context) =>
{
    const producerId = registry.producers[0].producerId;
    for (const [field, value] of [
        ['path', '.tmp/current-run/global-claims.json'],
        ['producerId', 'other-producer'],
        ['toolVersion', 'other-tool@1'],
        ['producerCommand', 'node tools/docs/global-claim-exactness-final.mjs']
    ])
    {
        const fixture = acceptedClaimsFixture(context);
        const changed = structuredClone(fixture.receipt);
        changed.terminalReceiptRef[field] = value;
        assert.throws(() => validateAcceptedClaimsReceiptAgainstRegistry({
            registry, producerId, receipt: seal(changed), repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }), /does not exact-match #2205 authority\/path\/producer\/tool\/command/u);
    }

    const duplicateReference = acceptedClaimsFixture(context);
    const duplicateBytes = fs.readFileSync(duplicateReference.referencePath, 'utf8')
        .replace('"schema":', '"schema": "fsusblog.current-run-evidence-reference.v1",\n  "schema":');
    fs.writeFileSync(duplicateReference.referencePath, duplicateBytes);
    duplicateReference.receipt.terminalReceiptRef.fileDigest =
        `sha256:${createHash('sha256').update(duplicateBytes).digest('hex')}`;
    assert.throws(() => validateAcceptedClaimsReceiptAgainstRegistry({
        registry, producerId, receipt: seal(duplicateReference.receipt),
        repositoryRoot: duplicateReference.repositoryRoot, migrationLedger
    }), /duplicate JSON key schema/u);

    const duplicatePayload = acceptedClaimsFixture(context);
    const payloadBytes = fs.readFileSync(duplicatePayload.terminalPath, 'utf8')
        .replace('"schema":', '"schema": "fsusblog.global-claim-exactness-terminal-receipt.v1",\n  "schema":');
    fs.writeFileSync(duplicatePayload.terminalPath, payloadBytes);
    const payloadFileDigest = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`;
    const referenceBody = structuredClone(duplicatePayload.reference);
    delete referenceBody.contentDigest;
    delete referenceBody.producerReceiptDigest;
    referenceBody.payload.digest = payloadFileDigest;
    const referenceWithContent = { ...referenceBody, contentDigest: authorityDigest(referenceBody) };
    const reference = { ...referenceWithContent, producerReceiptDigest: authorityDigest(referenceWithContent) };
    fs.writeFileSync(duplicatePayload.referencePath, `${JSON.stringify(reference, null, 2)}\n`);
    duplicatePayload.receipt.terminalReceiptRef.fileDigest =
        `sha256:${createHash('sha256').update(fs.readFileSync(duplicatePayload.referencePath)).digest('hex')}`;
    duplicatePayload.receipt.terminalReceiptRef.contentDigest = reference.contentDigest;
    duplicatePayload.receipt.terminalReceiptRef.payloadFileDigest = payloadFileDigest;
    assert.throws(() => validateAcceptedClaimsReceiptAgainstRegistry({
        registry, producerId, receipt: seal(duplicatePayload.receipt),
        repositoryRoot: duplicatePayload.repositoryRoot, migrationLedger
    }), /duplicate JSON key schema/u);
});
