/* eslint-disable import-x/no-relative-parent-imports -- The production binding composes canonical repository authorities owned by sibling tool domains. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyProductionBuildReceipt } from '../ci/production-build-artifacts.mjs';
import { deriveRandomConsumerStream, loadRandomStreamInventory } from '../test/random-streams.mjs';
import { verifyReplayQualification } from '../test/verify-replay-qualification.mjs';
import { digestCanonical } from '../test-fixtures/receipt/canonical.mjs';
import { validateFrontendBuildStageReceiptBinding } from '../test-matrix/frontend-build-ready-marker.mjs';
import { productionBuildLayoutDigest, resolveProductionBuildLayout } from '../test-matrix/production-build-layout.mjs';
import { consumeResetPostconditionReceipt } from '../test-matrix/reset-postcondition-verifier.mjs';
import { readRunBoundMarker } from '../test-matrix/run-bound-marker.mjs';

import { loadRuntimeStateAuthority } from './catalog.mjs';
import { normalizeRuntimeIdentity, requireDigest, sealDocument, verifySealedDocument } from './contract.mjs';
import { publishProductionObserverAuthority, readProductionObserverAuthority } from './production-observer-authority.mjs';
import { createDockerPostgresqlReadonlyPort, createDockerRedisReadonlyPort } from './production-observer-ports.mjs';
import {
    createProductionReceiptAbsencePort,
    createProductionReceiptAotGenerationPort,
    createProductionReceiptAuthStatePort,
    createProductionReceiptObjectStoragePort,
    createProductionReceiptRuntimeConfigPort,
    createProductionReceiptRuntimeTopologyPort
} from './production-receipt-observer-ports.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const identityFile = path.resolve(String(process.env.FSUSBLOG_RUNTIME_ORDER_IDENTITY_FILE ?? ''));

function regularFile(file, label)
{
    if (!file || !file.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} must remain inside the repository`);
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return file;
}

function loadIdentityAuthority()
{
    const document = JSON.parse(fs.readFileSync(regularFile(identityFile, 'FSUSBLOG_RUNTIME_ORDER_IDENTITY_FILE'), 'utf8'));
    if (document.schema !== 'fsusblog.production-runtime-order-identity.v1')
    {
        throw new Error('runtime-order identity schema is invalid');
    }
    verifySealedDocument(document);
    const identity = normalizeRuntimeIdentity({ ...document.identity, sessionId: 'schedule-template' });
    const fixedClock = document.fixedClock;
    if (!Number.isSafeInteger(Number(fixedClock?.epochMs)) || fixedClock?.digest !== identity.clockDigest)
    {
        throw new Error('runtime-order identity lacks the exact fixed-clock authority');
    }
    requireDigest(document.replayQualification?.contentDigest, 'replay qualification digest');
    const replayFile = regularFile(path.resolve(document.replayQualification.file), 'replay qualification receipt');
    const replayQualification = JSON.parse(fs.readFileSync(replayFile, 'utf8'));
    const replayVerification = verifyReplayQualification(replayFile);
    if (replayQualification.schema !== 'fsusblog.replay-qualification.v1'
    || replayQualification.status !== 'qualified'
    || replayQualification.contentDigest !== document.replayQualification.contentDigest
    || replayQualification.contentDigest !== identity.replayDigest
    || replayVerification.status !== 'verified'
    || replayVerification.receiptDigest !== replayQualification.contentDigest
    || replayQualification.sourceState?.commit !== identity.sourceCommit
    || replayQualification.sourceState?.worktreeFingerprint !== identity.sourceFingerprint)
    {
        throw new Error('runtime-order identity replay qualification is stale or cross-source');
    }
    const randomizedResults = replayQualification.families?.randomized?.results ?? [];
    if (!Array.isArray(randomizedResults) || randomizedResults.length === 0)
    {
        throw new Error('runtime-order replay qualification lacks randomized producer results');
    }
    const rootSeeds = new Set(randomizedResults.map((entry) =>
    {
        const resultFile = regularFile(path.resolve(repositoryRoot, entry.ref), 'randomized replay producer receipt');
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        if (result.contentDigest !== entry.digest || result.status !== 'verified'
      || result.source?.commit !== identity.sourceCommit
      || result.source?.worktreeFingerprint !== identity.sourceFingerprint)
        {
            throw new Error(`randomized replay producer receipt is stale: ${entry.producerId}/${entry.topology}`);
        }
        return String(result.plan?.inline?.rootSeed ?? '');
    }));
    if (rootSeeds.size !== 1 || !/^seed256:[0-9a-f]{64}$/u.test([...rootSeeds][0]))
    {
        throw new Error('runtime-order replay qualification has no exact common root seed');
    }
    return Object.freeze({
        document,
        identity,
        fixedClock: Object.freeze({ epochMs: Number(fixedClock.epochMs), digest: fixedClock.digest }),
        replay: Object.freeze({ rootSeed: [...rootSeeds][0], qualificationDigest: replayQualification.contentDigest })
    });
}

const identityAuthority = loadIdentityAuthority();
export const immutableIdentity = identityAuthority.identity;
export const maxConcurrency = 2;

export function productionRuntimeEnvironment()
{
    const inventory = loadRandomStreamInventory();
    const streams = Object.fromEntries(inventory.consumers.map((consumer) =>
    {
        const stream = deriveRandomConsumerStream({ rootSeed: identityAuthority.replay.rootSeed, consumer });
        return [`${consumer.canonicalTestId}\u0000${consumer.streamId}`, stream.derivedSeed];
    }));
    return Object.freeze({
        FSUSBLOG_RANDOM_STREAMS_JSON: JSON.stringify(streams),
        FSUSBLOG_REPLAY_ROOT_SEED: identityAuthority.replay.rootSeed,
        FSUSBLOG_REPLAY_EVIDENCE_CLASS: 'correctness',
        FSUSBLOG_REPLAY_QUALIFICATION_DIGEST: identityAuthority.replay.qualificationDigest
    });
}

function safeId(value)
{
    return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
}

function domainNamespace(identity, domain)
{
    return safeId(`${identity.runId}-${domain}`);
}

function adapter()
{
    return Object.freeze({
        async clone({ domain, identity, mutableRoot })
        {
            const root = path.join(mutableRoot, 'domains', safeId(domain));
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            return {
                owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
                mutableRoot: root,
                namespace: domainNamespace(identity, domain),
                opaqueHandle: `domain-${safeId(domain)}`
            };
        },
        async reset({ handle })
        {
            fs.rmSync(handle.mutableRoot, { recursive: true, force: true });
            fs.mkdirSync(handle.mutableRoot, { recursive: true, mode: 0o700 });
            return { status: 'reset', postconditionDigest: digestCanonical({ root: handle.mutableRoot, entries: [] }) };
        },
        async ready({ handle })
        {
            const stat = fs.lstatSync(handle.mutableRoot);
            if (!stat.isDirectory() || stat.isSymbolicLink())
            {
                throw new Error('runtime domain root is not an owned directory');
            }
            return { status: 'ready', observationDigest: digestCanonical({ domain: handle.domain, namespace: handle.namespace }) };
        },
        async cleanup({ handle })
        {
            fs.rmSync(handle.mutableRoot, { recursive: true, force: true });
            return { status: 'clean' };
        }
    });
}

export async function createSessionAdapters()
{
    const domains = loadRuntimeStateAuthority().accessedDomains;
    return Object.freeze({ domains, adapters: Object.fromEntries(domains.map((domain) => [domain, adapter()])) });
}

function initialObserverAuthority({ identity, authority })
{
    const domains = Object.fromEntries(authority.accessedDomains.map((domain) => [domain, {
        status: 'absent', reasonCode: 'before-runtime'
    }]));
    return sealDocument({
        schema: 'fsusblog.production-observer-authority.v1',
        phase: 'before-runtime',
        identity,
        sourceRefs: {},
        producerRefs: {},
        domains
    });
}

function writeAuthority(file, document)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function refreshObserverAuthority(file, identity, authority)
{
    if (!fs.existsSync(file))
    {
        writeAuthority(file, initialObserverAuthority({ identity, authority }));
    }
    let document = readProductionObserverAuthority(file, identity);
    const refs = document.producerRefs ?? {};
    if (document.phase === 'ready' && refs.environmentFile && refs.fingerprintKeyFile && refs.serviceEnvelopeFile)
    {
        document = publishProductionObserverAuthority({
            phase: 'ready', outputFile: file, sessionReceiptFile: refs.sessionReceiptFile,
            environmentFile: refs.environmentFile, fingerprintKeyFile: refs.fingerprintKeyFile,
            serviceEnvelopeFile: refs.serviceEnvelopeFile, environmentReadyFile: refs.environmentReadyFile,
            runtimeTopologyFile: refs.runtimeTopologyFile, fixtureReceiptFile: refs.fixtureReceiptFile,
            aotWarmReportFile: refs.aotWarmReportFile, browserStorageFile: refs.browserStorageFile,
            objectStorageRoot: refs.objectStorageRoot,
            backendProcessIdentityFile: refs.backendProcessIdentityFile,
            frontendProcessIdentityFile: refs.frontendProcessIdentityFile,
            releaseProcessIdentityFile: refs.releaseProcessIdentityFile,
            backendExecutableFile: refs.backendExecutableFile,
            frontendExecutableFile: refs.frontendExecutableFile,
            releaseExecutableFile: refs.releaseExecutableFile
        });
    }
    for (const domain of authority.accessedDomains)
    {
        if (!document.domains?.[domain])
        {
            throw new Error(`observer authority omits ${domain}`);
        }
    }
    return document;
}

const postgresTables = Object.freeze({
    'postgres.article': 'article', 'postgres.audit': 'sys_audit_log', 'postgres.auth': 'sys_user',
    'postgres.comment': 'comment', 'postgres.schema': '__fsus_schema_migration_history',
    'postgres.security': 'security_risk_event', 'postgres.settings': 'sys_systemconfig'
});

const postgresPrimaryKeys = Object.freeze({
    'postgres.schema': ['migration_id'],
    'postgres.settings': ['key']
});

function observedHandle(base, record, document, identity, domain, sessionReceipt)
{
    const owner = base.owner;
    const common = { ...base, owner, catalogDigest: identity.catalogDigest };
    if (record.status === 'absent')
    {
        return {
            ...common, observationStatus: 'absent', absenceAuthorityDigest: document.contentDigest
        };
    }
    if (domain.startsWith('postgres.'))
    {
        return {
            ...common, schema: 'public', table: postgresTables[domain], primaryKey: postgresPrimaryKeys[domain] ?? ['id'], semanticClockColumns: []
        };
    }
    if (domain.startsWith('redis.'))
    {
        const prefix = String(document.runtimeHandles?.redisNamespacePrefix ?? '');
        if (!prefix)
        {
            throw new Error(`${domain} lacks the sealed Redis namespace prefix`);
        }
        return {
            ...common,
            namespacePrefix: prefix,
            keyPattern: `${prefix}*|e2e:*`,
            keyPatterns: [`${prefix}*`, 'e2e:*'],
            ownershipClass: 'dedicated-session-container'
        };
    }
    if (domain === 'fixture.runtime-config')
    {
        return {
            ...common, namespace: record.config.namespace, plannedConfig: record.config, configReceiptDigest: document.contentDigest
        };
    }
    if (domain === 'artifact.public-aot-overlay')
    {
        return {
            ...common, namespace: domainNamespace(identity, domain), overlayId: 'public-aot-overlay',
            activeGenerationRef: record.active, manifestRef: { contentDigest: record.manifest.contentDigest },
            expectedArtifacts: record.manifest.artifacts, expectedRoutes: record.manifest.routes
        };
    }
    if (domain === 'storage.fixture-objects')
    {
        return {
            ...common, namespace: domainNamespace(identity, domain), namespaceClass: 'fixture-session',
            namespaceId: record.namespaceId, providerId: 'session-filesystem', expectedObjects: record.objects
        };
    }
    if (domain.startsWith('runtime.') || domain.startsWith('network.') || domain === 'browser.service-worker')
    {
        return {
            ...common, namespace: record.topology.namespace, plannedTopologyDigest: record.topology.plannedTopologyDigest,
            plannedTopology: record.topology.plannedTopology
        };
    }
    if (record.root)
    {
        return {
            ...common, root: record.root, sessionRoot: sessionReceipt.ownedRoot,
            sourceRoot: repositoryRoot, rootId: safeId(domain)
        };
    }
    if (domain === 'fixture.auth-identities' || domain === 'browser.storage-state')
    {
        return {
            ...common, namespace: domainNamespace(identity, domain),
            ...(domain === 'fixture.auth-identities' ? {
      stateClass: record.stateClass,
      expectedIdentityDigest: digestCanonical(record.identities ?? [])
    } : {
      userId: 'anonymous-user', siteId: 'default-site', authSessionId: 'anonymous-session',
      deviceId: 'anonymous-device', declaredClaims: [], declaredLocalStorageKeys: [],
      declaredSessionStorageKeys: [], declaredIndexedDbStores: []
    })
        };
    }
    throw new Error(`${domain} has no shipped production observer handle projection`);
}

export async function createProductionSnapshotContext({ identity, sessionReceipt, authority })
{
    const authorityFile = path.resolve(String(process.env.FSUSBLOG_RUNTIME_ORDER_AUTHORITY_FILE ?? ''));
    if (!authorityFile.startsWith(`${sessionReceipt.ownedRoot}${path.sep}`))
    {
        throw new Error('observer authority is outside the session-owned root');
    }
    const document = refreshObserverAuthority(authorityFile, identity, authority);
    const handles = Object.fromEntries(authority.accessedDomains.map((domain) => [
        domain,
        observedHandle(sessionReceipt.handles[domain], document.domains[domain], document, identity, domain, sessionReceipt)
    ]));
    const ports = {
        absence: createProductionReceiptAbsencePort({ authorityFile, identity }),
        runtimeConfig: createProductionReceiptRuntimeConfigPort({ authorityFile, identity }),
        runtimeTopology: createProductionReceiptRuntimeTopologyPort({ authorityFile, identity }),
        aotGeneration: createProductionReceiptAotGenerationPort({ authorityFile, identity }),
        objectStorage: createProductionReceiptObjectStoragePort({ authorityFile, identity })
    };
    ports.authState = createProductionReceiptAuthStatePort({ authorityFile, identity, fixedClock: identityAuthority.fixedClock });
    if (document.runtimeHandles?.postgresContainer)
    {
        ports.postgresql = createDockerPostgresqlReadonlyPort({ container: document.runtimeHandles.postgresContainer });
    }
    if (document.runtimeHandles?.redisContainer)
    {
        ports.redis = createDockerRedisReadonlyPort({ container: document.runtimeHandles.redisContainer, fixedClock: identityAuthority.fixedClock });
    }
    return Object.freeze({
        identity, handles, ports, fixedClock: identityAuthority.fixedClock,
        protectedFingerprintKey: fs.readFileSync(regularFile(path.resolve(
            document.producerRefs?.fingerprintKeyFile
        ?? String(process.env.FSUSBLOG_RUNTIME_ORDER_FINGERPRINT_KEY_FILE ?? '')
        ), 'observer fingerprint key')),
        fingerprintScope: 'run', fingerprintScopeId: identity.runId
    });
}

function currentRunSourceState(identity)
{
    return Object.freeze({ commit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint });
}

function currentRunResetIdentity(identity)
{
    return Object.freeze({
        runId: identity.runId,
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
        profileId: String(process.env.FSUSBLOG_LOCAL_PROFILE ?? 'production').trim(),
        sourceState: currentRunSourceState(identity)
    });
}

function resetDeclaration({ barrier, authority })
{
    const consumer = authority.steps?.[barrier.consumerStepId];
    const reset = consumer?.[barrier.phase]?.find((entry) => entry.producer === barrier.producerStepId
    && entry.assertionId === barrier.assertionId
    && entry.receiptSchema === barrier.receiptSchema);
    if (!reset)
    {
        throw new Error(`runtime reset declaration is absent for ${barrier.barrierId}`);
    }
    return reset;
}

export async function verifyProductionResetPostconditions({ barrier, identity, authority })
{
    const reset = resetDeclaration({ barrier, authority });
    const consumed = consumeResetPostconditionReceipt({
        root: repositoryRoot,
        reset,
        producerStep: { id: reset.producer, command: reset.producerCommand },
        runIdentity: currentRunResetIdentity(identity)
    });
    const receiptDigest = `sha256:${createHash('sha256').update(fs.readFileSync(consumed.file)).digest('hex')}`;
    return Object.freeze(barrier.domains.map((domain) => Object.freeze({
        domain,
        status: 'satisfied',
        observationDigest: digestCanonical({
            domain,
            barrierId: barrier.barrierId,
            assertionId: consumed.receipt.assertionId,
            receiptDigest,
            observations: consumed.receipt.observations
        })
    })));
}

function regularCurrentRunFile(file, label)
{
    const absolute = path.resolve(file);
    if (!absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} escapes the repository`);
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return { absolute, stat };
}

function fileReceiptDigest(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function artifactFileEvidence(file)
{
    const { absolute, stat } = regularCurrentRunFile(file, 'coordination artifact');
    const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/');
    const content = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    return Object.freeze({
        relative,
        digest: `sha256:${createHash('sha256').update(`file:${Number(stat.mode)}:${Number(stat.size)}:${content}`).digest('hex')}`,
        artifactRef: `artifact:${createHash('sha256').update(`path:${relative}`).digest('hex')}`
    });
}

function assertCurrentBuildLayout(marker, identity)
{
    const layout = resolveProductionBuildLayout({ root: repositoryRoot, runId: identity.runId });
    const source = currentRunSourceState(identity);
    const expectedManifest = path.relative(repositoryRoot, layout.manifestFile).replaceAll(path.sep, '/');
    const manifest = JSON.parse(fs.readFileSync(regularCurrentRunFile(layout.manifestFile, 'production build layout').absolute, 'utf8'));
    if (manifest.runId !== identity.runId || manifest.sourceState?.commit !== source.commit
    || manifest.sourceState?.worktreeFingerprint !== source.worktreeFingerprint
    || marker?.buildLayout?.runId !== identity.runId
    || marker?.buildLayout?.manifestPath !== expectedManifest
    || marker?.buildLayout?.manifestDigest !== productionBuildLayoutDigest(layout)
    || marker?.buildLayout?.sourceCommit !== source.commit
    || marker?.buildLayout?.sourceFingerprint !== source.worktreeFingerprint)
    {
        throw new Error('coordination marker production build layout is stale or cross-source');
    }
    return layout;
}

function readMarkerFile(identity, name)
{
    return regularCurrentRunFile(path.join(repositoryRoot, '.tmp', 'test-runs', identity.runId, `${name}.json`), `${name} marker`).absolute;
}

function verifyBackendBuildReady(identity)
{
    const file = readMarkerFile(identity, 'backend-build-ready');
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertCurrentBuildLayout(marker, identity);
    const server = artifactFileEvidence(String(process.env.FSUSBLOG_BACKEND_SERVER_DLL ?? ''));
    if (marker.schema !== 'fsusblog.local-production.backend-build-ready.v1'
    || marker.status !== 'success' || marker.physicalBundleId !== 'backend-tests'
    || marker.schedulerRunId !== identity.runId || marker.serverDll?.path !== server.relative
    || marker.serverDll?.exists !== true || marker.serverDll?.digest !== server.digest
    || marker.serverDll?.artifactRef !== server.artifactRef)
    {
        throw new Error('backend build readiness marker or artifact is stale');
    }
    return fileReceiptDigest(file);
}

async function verifyFrontendBuildReady(identity)
{
    const file = readMarkerFile(identity, 'frontend-build-ready');
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    const layout = assertCurrentBuildLayout(marker, identity);
    const { createFrontendBuildStages } = await import('../frontend/build.mjs');
    const expectedStages = createFrontendBuildStages([], 'generate', {
        frontendRoot: path.join(repositoryRoot, 'src', 'frontend'),
        env: { ...process.env, FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC: process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC ?? '1' }
    });
    const owned = new Set(expectedStages.flatMap((stage) => stage.ownedOutputs));
    const criticalOutputPaths = [
        path.join(layout.frontendDist, 'index.html'),
        path.join(layout.frontendDist, 'server', 'public-shell-emergency.css'),
        path.join(layout.frontendDist, 'wasm'),
        path.join(layout.frontendDist, 'assets', 'fsus-spa-entry.js'),
        path.join(layout.frontendDist, 'dist'),
        path.join(layout.frontendWasm, 'wasm-manifest.aeds'),
        path.join(layout.frontendWasm, 'aeds-runtime-manifest.json'),
        layout.backendWebRoot
    ].filter((candidate) => owned.has(candidate));
    if (marker.schema !== 'fsusblog.local-production.frontend-build-ready.v1'
    || marker.status !== 'success' || marker.physicalBundleId !== 'build-static'
    || marker.producerStepId !== 'sync-static-assets' || marker.schedulerRunId !== identity.runId)
    {
        throw new Error('frontend build readiness marker is stale');
    }
    validateFrontendBuildStageReceiptBinding({
        root: repositoryRoot,
        marker,
        runId: identity.runId,
        sourceState: currentRunSourceState(identity),
        expectedPath: marker.stageReceipt?.path,
        expectedStages,
        stageCwd: path.join(repositoryRoot, 'src', 'frontend'),
        criticalOutputPaths
    });
    return fileReceiptDigest(file);
}

function genericRunBoundCoordination(stepId, identity)
{
    const sourceState = currentRunSourceState(identity);
    const environment = {
        'behavior-evidence-ready': {
            producerBundleId: 'backend-tests', producerStepId: 'behavior-evidence-pre-runtime',
            artifacts: [path.join(repositoryRoot, '.tmp', 'behavior-evidence-pre-runtime', 'receipt.json')]
        },
        'production-build-artifacts-ready': {
            producerBundleId: 'build-static', producerStepId: 'production-build-artifacts',
            artifacts: [path.join(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '', 'artifacts', 'production-build', 'receipt.json')]
        }
    }[stepId];
    if (!environment)
    {
        throw new Error(`unsupported production coordination step ${stepId}`);
    }
    let bindings = null;
    if (stepId === 'production-build-artifacts-ready')
    {
        const artifactRoot = path.dirname(environment.artifacts[0]);
        const { receipt } = verifyProductionBuildReceipt({
            artifactRoot,
            expectedSourceState: sourceState,
            expectedProducer: { runId: identity.runId, job: 'production-build-artifacts' },
            repairReadOnlySeal: false
        });
        const layout = resolveProductionBuildLayout({ root: repositoryRoot, runId: identity.runId });
        bindings = {
            attemptId: String(process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? '').trim(),
            buildLayout: {
                runId: identity.runId,
                manifestPath: path.relative(repositoryRoot, layout.manifestFile).replaceAll(path.sep, '/'),
                manifestDigest: productionBuildLayoutDigest(layout),
                sourceCommit: identity.sourceCommit,
                sourceFingerprint: identity.sourceFingerprint
            },
            receipt: { path: path.relative(repositoryRoot, environment.artifacts[0]).replaceAll(path.sep, '/'), contentDigest: receipt.contentDigest },
            producer: receipt.producer
        };
    }
    const markerFile = readMarkerFile(identity, stepId);
    const marker = readRunBoundMarker(markerFile, {
        root: repositoryRoot, markerId: stepId, runId: identity.runId, sourceState,
        producerBundleId: environment.producerBundleId, producerStepId: environment.producerStepId,
        artifacts: environment.artifacts, bindings
    });
    return `sha256:${marker.digest}`;
}

export async function verifyProductionCoordination({ stepId, identity })
{
    const receiptDigest = stepId === 'backend-build-ready'
        ? verifyBackendBuildReady(identity)
        : stepId === 'frontend-build-ready'
      ? await verifyFrontendBuildReady(identity)
      : genericRunBoundCoordination(stepId, identity);
    requireDigest(receiptDigest, `${stepId} coordination receipt digest`);
    return Object.freeze({ status: 'verified', receiptDigest });
}
