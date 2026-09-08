/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRuntimeEnvironment } from '../test/bundles/runtime-environment.mjs';
import { digestCanonical, plainObject } from '../test-fixtures/receipt/canonical.mjs';
import { validateFixtureReceipt } from '../test-fixtures/receipt/fixture-receipt.mjs';

import { loadRuntimeStateAuthority } from './catalog.mjs';
import { createProtectedFingerprint, sealDocument, verifySealedDocument } from './contract.mjs';
import { validateRuntimeExecutionSessionReceipt } from './runtime-execution-session.mjs';

export const productionObserverAuthoritySchema = 'fsusblog.production-observer-authority.v1';

const secretKeys = new Set([
    'ConnectionStrings__DefaultConnection', 'ConnectionStrings__Redis',
    'FSUSBLOG_NOTIFICATION_DRILL_SECRET', 'NotificationStream__DrillSecret',
    'Jwt__SecretKey', 'Security__Pow__SigningKey', 'Security__PerceptionSealedToken__Keys__dev',
    'Security__RecoveryKeyPepper', 'MfaChallenge__TicketSigningKey', 'HumanReadProof__SigningKey',
    'HumanReadProof__Dedup__CurrentKey', 'ReadAnalyticsPrivacy__NoiseKey', 'VisitLog__IpPseudonymization__CurrentKey',
    'Moderation__Pepper', 'Moderation__RegionPolicy__IpHashKey', 'Subscription__EmailHashPepper',
    'AnonymousCredentialIssuer__SubjectHashPepper', 'AnonymousCredentialRoot__AttestationKey',
    'AnonymousIdentity__NullifierPepper'
]);

function regularFile(file, label)
{
    const absolute = path.resolve(String(file ?? ''));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return absolute;
}

function readJson(file, label)
{
    return JSON.parse(fs.readFileSync(regularFile(file, label), 'utf8'));
}

function fileDigest(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function readFingerprintKey(file)
{
    const bytes = fs.readFileSync(regularFile(file, 'runtime observer fingerprint key'));
    if (bytes.length < 32)
    {
        throw new Error('runtime observer fingerprint key must contain at least 32 bytes');
    }
    return bytes;
}

function normalizeValue(value)
{
    if (/^-?\d+$/u.test(value))
    {
        return Number(value);
    }
    if (value === 'true' || value === 'false')
    {
        return value === 'true';
    }
    return value;
}

function semanticConfigValue(key, value)
{
    if (/(?:^|_)(?:PORT|PID)$/u.test(key))
    {
        return { runtimeValueClass: key.endsWith('_PID') ? 'process-id' : 'ephemeral-port' };
    }
    if (/(?:URL|ORIGIN)$/u.test(key))
    {
        const parsed = new URL(value);
        return { runtimeValueClass: 'loopback-endpoint', protocol: parsed.protocol.slice(0, -1) };
    }
    if (/(?:ROOT|FILE|PATH)$/u.test(key) || key === 'PublicAot__SsrClientRoot')
    {
        return { runtimeValueClass: 'session-owned-path', role: key.replace(/[^A-Za-z0-9]+/gu, '-').toLowerCase() };
    }
    if (/(?:CONTAINER_NAME|TEST_NAMESPACE|INSTANCE_NAME)$/u.test(key) || key === 'RedisOptions__InstanceName')
    {
        return { runtimeValueClass: 'session-owned-identity', role: key.replace(/[^A-Za-z0-9]+/gu, '-').toLowerCase() };
    }
    return normalizeValue(value);
}

function endpoint(environment, urlKey, role)
{
    const parsed = new URL(environment[urlKey]);
    return { role, protocol: parsed.protocol.slice(0, -1), hostAuthority: 'loopback' };
}

function resolvedConfig({ environment, identity, fingerprintKey })
{
    const requiredKeys = Object.keys(environment).sort();
    const values = {};
    const sources = {};
    const secrets = [];
    for (const key of requiredKeys)
    {
        sources[key] = 'acceptance-bootstrap';
        if (secretKeys.has(key))
        {
            secrets.push({
                secretClass: `runtime-${key.replace(/[^A-Za-z0-9_.-]+/gu, '-').toLowerCase()}`,
                sourceOwner: 'acceptance-bootstrap',
                present: environment[key] !== '',
                protectedValue: environment[key] === '' ? null : createProtectedFingerprint({
          key: fingerprintKey,
          scopeId: identity.runId,
          secretClass: `runtime-${key.replace(/[^A-Za-z0-9_.-]+/gu, '-').toLowerCase()}`,
          value: environment[key]
        })
            });
            values[key] = { secret: true, present: environment[key] !== '' };
        }
        else
        {
            values[key] = semanticConfigValue(key, environment[key]);
        }
    }
    return {
        schema: 'fsusblog.runtime-config.v1',
        namespace: identity.runId,
        requiredKeys,
        values,
        sources,
        featuresDigest: digestCanonical(Object.fromEntries(Object.entries(values).filter(([key]) => /Enabled|Mode|Count|Limit|Concurrency/u.test(key)))),
        policyDigest: digestCanonical({ requiredKeys, sources, secretClasses: secrets.map(({ secretClass }) => secretClass).sort() }),
        endpoints: [
            endpoint(environment, 'FSUSBLOG_DEBUG_BACKEND_URL', 'backend'),
            endpoint(environment, 'FSUSBLOG_DEBUG_FRONTEND_URL', 'frontend'),
            endpoint(environment, 'FSUSBLOG_RELEASE_PREVIEW_URL', 'release-preview')
        ],
        secrets
    };
}

function validateServiceEnvelope(document, identity)
{
    if (document?.schema !== 'fsusblog.test-execution-envelope-services.v1'
    || document.qualificationEligible !== true || document.admission !== 'planned-actual-exact'
    || document.runId !== identity.runId || digestCanonical(document.planned) !== digestCanonical(document.actual))
    {
        throw new Error('execution service envelope is stale or not planned/actual exact');
    }
}

function serviceProjection(service, namespace)
{
    if (service.kind !== 'container')
    {
        throw new Error(`unsupported topology service kind: ${service.kind}`);
    }
    const imageDigest = String(service.imageId ?? '');
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest))
    {
        throw new Error(`container ${service.id} lacks image digest`);
    }
    const limits = service.resourceLimits ?? {};
    return {
        role: service.id,
        ownerNamespace: namespace,
        runtimeKind: 'container',
        imageDigest,
        networkNamespace: 'session-network',
        endpoints: (service.ports ?? []).map(() => ({ role: `${service.id}-service`, protocol: service.id === 'postgres' ? 'postgresql' : 'redis' })),
        resources: {
            cpuUnits: Math.max(1, Number(limits.nanoCpus ?? 0) / 1_000_000_000 || 1),
            memoryBytes: Math.max(1, Number(limits.memory ?? limits.memoryReservation ?? 0) || 1),
            processLimit: Math.max(1, Number(limits.pidsLimit ?? 0) || 1)
        },
        readinessDigest: digestCanonical({ id: service.id, imageId: service.imageId, serviceVersion: service.serviceVersion }),
        liveness: 'live'
    };
}

function processProjection({ identityFile, executableFile, expectedRole, identity, readinessFile })
{
    const processIdentity = readJson(identityFile, `${expectedRole} process identity`);
    if (processIdentity.schema !== 'fsusblog.local-runtime-process-identity.v1'
    || processIdentity.runId !== identity.runId
    || processIdentity.role !== expectedRole
    || processIdentity.sourceState?.commit !== identity.sourceCommit
    || processIdentity.sourceState?.worktreeFingerprint !== identity.sourceFingerprint)
    {
        throw new Error(`${expectedRole} process identity is stale or cross-source`);
    }
    const executable = regularFile(executableFile, `${expectedRole} executable`);
    const readiness = regularFile(readinessFile, `${expectedRole} readiness receipt`);
    return {
        role: expectedRole,
        ownerNamespace: identity.runId,
        runtimeKind: 'process',
        executableDigest: fileDigest(executable),
        networkNamespace: 'session-network',
        endpoints: [{ role: `${expectedRole}-service`, protocol: 'http' }],
        resources: { cpuUnits: 1, memoryBytes: 1, processLimit: 1 },
        readinessDigest: digestCanonical({
            role: expectedRole,
            processIdentityDigest: fileDigest(identityFile),
            readinessReceiptDigest: fileDigest(readiness)
        }),
        liveness: 'live'
    };
}

function contained(root, candidate)
{
    const parent = path.resolve(root);
    const child = path.resolve(candidate);
    return child !== parent && child.startsWith(`${parent}${path.sep}`);
}

function safeRelative(root, relative, label)
{
    const normalized = String(relative ?? '').replaceAll('\\', '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => ['', '.', '..'].includes(part)))
    {
        throw new Error(`${label} is not a safe relative path`);
    }
    const resolved = path.resolve(root, ...normalized.split('/'));
    if (!contained(root, resolved))
    {
        throw new Error(`${label} escapes its release-derived root`);
    }
    return { normalized, resolved };
}

function sha256Hex(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function dotnetIndentedDigest(value)
{
    return sha256Hex(Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

function exactKeys(value, keys)
{
    return plainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function materializedAot(reportFile, identity, environment)
{
    if (!reportFile || !fs.existsSync(reportFile))
    {
        return null;
    }
    const absolute = regularFile(reportFile, 'public AOT warm report');
    const report = readJson(absolute, 'public AOT warm report');
    if (report.schema !== 'fsusblog.public-aot-warm-evidence.v1' || report.status !== 'ok'
    || !Array.isArray(report.manifest) || report.manifest.length === 0
    || report.failed !== 0 || report.warmed !== report.manifest.length
    || new Set(report.manifest.map(({ path: route }) => route)).size !== report.manifest.length)
    {
        throw new Error('public AOT warm authority is incomplete');
    }
    const releaseRoot = path.resolve(environment.FSUSBLOG_RELEASE_DERIVED_ROOT, environment.FSUSBLOG_RELEASE_ID, 'public-aot');
    if (!fs.lstatSync(releaseRoot).isDirectory())
    {
        throw new Error('public AOT release-derived root is missing');
    }
    const transactionRoot = path.join(releaseRoot, '.transactions');
    const transactionPointerRoot = path.join(releaseRoot, '.transaction-pointers');
    if (!fs.lstatSync(transactionRoot).isDirectory() || !fs.lstatSync(transactionPointerRoot).isDirectory())
    {
        throw new Error('public AOT transaction/pointer authority is missing');
    }
    const candidates = fs.readdirSync(transactionRoot).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map((name) =>
    {
        const transactionFile = path.join(transactionRoot, name);
        const pointerFile = path.join(transactionPointerRoot, name);
        const transaction = readJson(transactionFile, 'public AOT transaction');
        const pointer = readJson(pointerFile, 'public AOT transaction pointer');
        const transactionBody = { ...transaction, contentDigest: '' };
        const pointerBody = { ...pointer, contentDigest: '' };
        const transactionIdentity = Object.fromEntries([
            'schema', 'artifactId', 'cacheKey', 'relativePath', 'generation', 'payloadDigest', 'registryKeys'
        ].map((key) => [key, transaction[key]]));
        if (!exactKeys(transaction, ['schema', 'artifactId', 'cacheKey', 'relativePath', 'generation', 'payloadDigest', 'registryKeys', 'state', 'updatedAtUtc', 'contentDigest'])
      || !exactKeys(pointer, ['schema', 'artifactId', 'cacheKey', 'relativePath', 'generation', 'payloadDigest', 'transactionDigest', 'updatedAtUtc', 'contentDigest'])
      || transaction.schema !== 'fsusblog.public-aot-artifact-transaction.v1'
      || pointer.schema !== 'fsusblog.public-aot-artifact-pointer.v1'
      || transaction.state !== 'complete'
      || transaction.artifactId !== name.slice(0, -5)
      || pointer.artifactId !== transaction.artifactId
      || pointer.cacheKey !== transaction.cacheKey
      || pointer.relativePath !== transaction.relativePath
      || pointer.generation !== transaction.generation
      || pointer.payloadDigest !== transaction.payloadDigest
      || transaction.contentDigest !== dotnetIndentedDigest(transactionBody)
      || pointer.contentDigest !== dotnetIndentedDigest(pointerBody)
      || pointer.transactionDigest !== dotnetIndentedDigest(transactionIdentity)
      || sha256Hex(transaction.cacheKey) !== transaction.artifactId
      || !/^[a-f0-9]{64}$/u.test(transaction.payloadDigest))
        {
            throw new Error(`public AOT transaction authority is invalid: ${name}`);
        }
        const relative = safeRelative(releaseRoot, transaction.relativePath, 'public AOT artifact path');
        const publisherId = sha256Hex(relative.normalized);
        const publicationPointerFile = path.join(releaseRoot, '.pointers', `${publisherId}.json`);
        const publicationPointer = readJson(publicationPointerFile, 'public AOT release-derived pointer');
        if (!exactKeys(publicationPointer, ['schema', 'releaseId', 'kind', 'artifactPath', 'generation'])
      || publicationPointer.schema !== 'fsusblog.release-derived-artifact-pointer.v1'
      || publicationPointer.releaseId !== environment.FSUSBLOG_RELEASE_ID
      || publicationPointer.kind !== 'public-aot'
      || publicationPointer.artifactPath !== relative.normalized)
        {
            throw new Error(`public AOT release-derived pointer is invalid: ${name}`);
        }
        const generationRoot = path.join(releaseRoot, '.artifacts', publisherId, 'generations', publicationPointer.generation);
        const generationManifestFile = path.join(generationRoot, 'generation-manifest.json');
        const generationManifest = readJson(generationManifestFile, 'public AOT generation manifest');
        if (generationManifest.schema !== 'fsusblog.release-derived-generation.v1'
      || generationManifest.releaseId !== environment.FSUSBLOG_RELEASE_ID
      || generationManifest.kind !== 'public-aot'
      || generationManifest.generation !== publicationPointer.generation
      || !Array.isArray(generationManifest.files) || generationManifest.files.length !== 1
      || generationManifest.files[0].path !== relative.normalized)
        {
            throw new Error(`public AOT generation manifest is invalid: ${name}`);
        }
        const immutableArtifact = safeRelative(generationRoot, relative.normalized, 'public AOT immutable artifact').resolved;
        const contentDigest = fileDigest(immutableArtifact);
        const fileEntry = generationManifest.files[0];
        if (contentDigest !== fileEntry.sha256 || fs.statSync(immutableArtifact).size !== fileEntry.bytes
      || contentDigest !== `sha256:${transaction.payloadDigest}`)
        {
            throw new Error(`public AOT generation bytes disagree: ${name}`);
        }
        return { transaction, pointerFile, publicationPointerFile, generationManifestFile, immutableArtifact, contentDigest };
    });
    const artifacts = [];
    const artifactRefs = {};
    const routes = {};
    for (const route of report.manifest)
    {
        const prefix = `public:aot:v2:doc:${route.pageId}:${route.routeKey}`;
        const matches = candidates.filter(({ transaction }) => transaction.cacheKey === prefix
      || transaction.cacheKey.startsWith(`${prefix}:locale:`)
      || transaction.cacheKey.startsWith(`${prefix}:iv:`));
        if (matches.length !== 1)
        {
            throw new Error(`public AOT route has ${matches.length} active artifacts: ${route.path}`);
        }
        const match = matches[0];
        const id = `artifact-${match.transaction.artifactId.slice(0, 32)}`;
        artifacts.push({ id, ref: match.immutableArtifact, contentDigest: match.contentDigest });
        artifactRefs[id] = match.immutableArtifact;
        routes[route.path] = id;
    }
    const authorityFiles = candidates.flatMap((entry) => [entry.pointerFile, entry.publicationPointerFile, entry.generationManifestFile])
        .sort().map((file) => ({ role: path.basename(path.dirname(file)), contentDigest: fileDigest(file) }));
    const authorityDigest = digestCanonical({ reportManifestDigest: report.manifestDigest, authorityFiles });
    const generationId = `generation-${authorityDigest.replace(/^sha256:/u, '').slice(0, 32)}`;
    const body = {
        schema: 'fsusblog.aot-generation.v1', generationId,
        sourceCommit: identity.sourceCommit, buildReceiptDigest: identity.buildReceiptDigest,
        artifacts: artifacts.sort((left, right) => left.id.localeCompare(right.id)), routes
    };
    const manifest = { ...body, contentDigest: digestCanonical(body) };
    return {
        status: 'observed',
        active: { status: 'active', generationId, authorityDigest },
        manifest,
        artifactRefs
    };
}

function materializedAuth(fixtureReceiptFile, namespace, identity)
{
    if (!fixtureReceiptFile || !fs.existsSync(fixtureReceiptFile))
    {
        return null;
    }
    const receipt = readJson(fixtureReceiptFile, 'FixtureReceipt');
    validateFixtureReceipt(receipt, { requireVerified: true });
    if (receipt.executionIdentity?.namespace !== namespace)
    {
        throw new Error('FixtureReceipt namespace drifted');
    }
    const identities = (receipt.databaseObservation?.entities ?? [])
        .filter(({ kind }) => ['user', 'admin', 'session'].includes(kind))
        .map(({ kind, id, domain, fields }) => ({ kind, id: String(id), domain, fieldsDigest: digestCanonical(fields ?? {}) }));
    return {
        status: 'observed',
        stateClass: 'fixture-auth-catalog',
        readonly: true,
        namespace,
        clockDigest: identity.clockDigest,
        identities,
        fixtureReceiptDigest: receipt.receiptDigest
    };
}

export function publishProductionObserverAuthority({
    phase,
    outputFile,
    sessionReceiptFile,
    environmentFile,
    fingerprintKeyFile,
    serviceEnvelopeFile = null,
    environmentReadyFile = null,
    runtimeTopologyFile = null,
    fixtureReceiptFile = null,
    aotWarmReportFile = null,
    browserStorageFile = null,
    objectStorageRoot = null,
    backendProcessIdentityFile = null,
    frontendProcessIdentityFile = null,
    releaseProcessIdentityFile = null,
    backendExecutableFile = null,
    frontendExecutableFile = null,
    releaseExecutableFile = null
})
{
    return publish({
        phase, outputFile, sessionReceiptFile, environmentFile, fingerprintKeyFile,
        serviceEnvelopeFile, environmentReadyFile, runtimeTopologyFile,
        fixtureReceiptFile, aotWarmReportFile, browserStorageFile, objectStorageRoot,
        backendProcessIdentityFile, frontendProcessIdentityFile, releaseProcessIdentityFile,
        backendExecutableFile, frontendExecutableFile, releaseExecutableFile
    });
}

function publish(options)
{
    const sessionReceipt = readJson(options.sessionReceiptFile, 'runtime session receipt');
    validateRuntimeExecutionSessionReceipt(sessionReceipt);
    const identity = sessionReceipt.identity;
    const absoluteEnvironment = regularFile(options.environmentFile, 'runtime environment');
    const rawEnvironment = fs.readFileSync(absoluteEnvironment, 'utf8');
    const namespace = rawEnvironment.match(/^FSUSBLOG_TEST_NAMESPACE=(.+)$/mu)?.[1];
    const environment = parseRuntimeEnvironment(rawEnvironment, namespace);
    if (environment.FSUSBLOG_TEST_RUN_ID !== identity.runId)
    {
        throw new Error('runtime environment run identity drifted');
    }
    const config = resolvedConfig({ environment, identity, fingerprintKey: readFingerprintKey(options.fingerprintKeyFile) });
    const domains = Object.fromEntries(loadRuntimeStateAuthority().accessedDomains.map((domain) => [
        domain, { status: 'absent', reasonCode: options.phase === 'ready' ? 'not-materialized' : 'before-bootstrap' }
    ]));
    domains['fixture.runtime-config'] = { status: 'observed', config };
    let serviceEnvelopeDigest = null;
    if (options.phase === 'ready')
    {
        const serviceEnvelope = readJson(options.serviceEnvelopeFile, 'execution service envelope');
        validateServiceEnvelope(serviceEnvelope, identity);
        serviceEnvelopeDigest = fileDigest(regularFile(options.serviceEnvelopeFile, 'execution service envelope'));
        const processInputs = [
            ['backend', options.backendProcessIdentityFile, options.backendExecutableFile],
            ['debug-frontend', options.frontendProcessIdentityFile, options.frontendExecutableFile],
            ['release-preview', options.releaseProcessIdentityFile, options.releaseExecutableFile]
        ];
        const services = [
            ...serviceEnvelope.actual.services.map((service) => serviceProjection(service, identity.runId)),
            ...processInputs.map(([expectedRole, identityFile, executableFile]) => processProjection({
                identityFile, executableFile, expectedRole, identity,
                readinessFile: options.environmentReadyFile
            }))
        ].sort((left, right) => left.role.localeCompare(right.role));
        const plannedTopology = { services };
        const topology = {
            namespace: identity.runId,
            plannedTopologyDigest: digestCanonical(plannedTopology),
            plannedTopology,
            services
        };
        for (const domain of [
            'browser.service-worker', 'network.host-topology', 'network.zap-container',
            'runtime.backend-process', 'runtime.backend-resource-counters', 'runtime.data-scale-backend',
            'runtime.frontend-preview', 'runtime.measurement-children', 'runtime.performance-counters',
            'runtime.release-preview'
        ])
        {
            domains[domain] = { status: 'observed', topology };
        }
        if (!environment.FSUSBLOG_POSTGRES_CONTAINER_NAME || !environment.FSUSBLOG_REDIS_CONTAINER_NAME)
        {
            throw new Error('ready observer authority lacks the session-owned PostgreSQL/Redis handles');
        }
        for (const domain of Object.keys(domains).filter((value) => value.startsWith('postgres.')))
        {
            domains[domain] = { status: 'observed', provider: 'session-postgresql-container' };
        }
        for (const domain of Object.keys(domains).filter((value) => value.startsWith('redis.')))
        {
            domains[domain] = { status: 'observed', provider: 'session-redis-container' };
        }
    }
    const aot = options.phase === 'ready' ? materializedAot(options.aotWarmReportFile, identity, environment) : null;
    domains['artifact.public-aot-overlay'] = aot ?? { status: 'absent', reasonCode: options.phase === 'ready' ? 'warm-report-not-materialized' : 'before-bootstrap' };
    const fixtureAuth = options.phase === 'ready' ? materializedAuth(options.fixtureReceiptFile, namespace, identity) : null;
    domains['fixture.auth-identities'] = fixtureAuth ?? { status: 'absent', reasonCode: options.phase === 'ready' ? 'fixture-auth-not-materialized' : 'before-bootstrap' };
    domains['browser.storage-state'] = options.phase === 'ready' && options.browserStorageFile && fs.existsSync(options.browserStorageFile)
        ? { status: 'observed', stateClass: 'playwright-storage', sourceFile: regularFile(options.browserStorageFile, 'browser storage state'), sourceDigest: fileDigest(options.browserStorageFile) }
        : { status: 'observed', stateClass: 'empty-browser-storage', cookies: [], origins: [] };
    const objectRoot = options.objectStorageRoot ? path.resolve(options.objectStorageRoot) : null;
    if (objectRoot)
    {
        fs.mkdirSync(objectRoot, { recursive: true, mode: 0o700 });
    }
    domains['storage.fixture-objects'] = options.phase === 'ready'
        ? { status: 'observed', namespaceId: identity.sessionId, root: objectRoot, objects: [] }
        : { status: 'absent', reasonCode: 'before-bootstrap' };
    const fixtureRoot = options.runtimeTopologyFile ? path.dirname(path.resolve(options.runtimeTopologyFile)) : null;
    const fileRoots = {
        'artifact.release-derived': environment.FSUSBLOG_RELEASE_DERIVED_ROOT,
        'artifact.static-web-assets': environment.PublicAot__SsrClientRoot,
        'fixture.public-content': fixtureRoot,
        'fixture.security-state': fixtureRoot
    };
    for (const [domain, candidate] of Object.entries(fileRoots))
    {
        if (options.phase !== 'ready' || !candidate)
        {
            continue;
        }
        const root = path.resolve(candidate);
        if (!root.startsWith(`${path.resolve(sessionReceipt.ownedRoot)}${path.sep}`))
        {
            throw new Error(`${domain} producer root is outside the runtime session`);
        }
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`${domain} producer root is not a real directory`);
        }
        domains[domain] = { status: 'observed', root };
    }
    const body = {
        schema: productionObserverAuthoritySchema,
        phase: options.phase,
        identity,
        sourceRefs: {
            environmentDigest: fileDigest(absoluteEnvironment),
            serviceEnvelopeDigest,
            environmentReadyDigest: options.environmentReadyFile && fs.existsSync(options.environmentReadyFile)
                ? fileDigest(regularFile(options.environmentReadyFile, 'environment-ready receipt')) : null,
            runtimeTopologyDigest: options.runtimeTopologyFile && fs.existsSync(options.runtimeTopologyFile)
                ? fileDigest(regularFile(options.runtimeTopologyFile, 'runtime topology inventory')) : null,
            fixtureReceiptDigest: options.fixtureReceiptFile && fs.existsSync(options.fixtureReceiptFile)
                ? fileDigest(regularFile(options.fixtureReceiptFile, 'FixtureReceipt')) : null,
            aotWarmReportDigest: options.aotWarmReportFile && fs.existsSync(options.aotWarmReportFile)
                ? fileDigest(regularFile(options.aotWarmReportFile, 'public AOT warm report')) : null
        },
        producerRefs: {
            sessionReceiptFile: path.resolve(options.sessionReceiptFile),
            environmentFile: absoluteEnvironment,
            fingerprintKeyFile: path.resolve(options.fingerprintKeyFile),
            serviceEnvelopeFile: options.serviceEnvelopeFile ? path.resolve(options.serviceEnvelopeFile) : null,
            environmentReadyFile: options.environmentReadyFile ? path.resolve(options.environmentReadyFile) : null,
            runtimeTopologyFile: options.runtimeTopologyFile ? path.resolve(options.runtimeTopologyFile) : null,
            fixtureReceiptFile: options.fixtureReceiptFile ? path.resolve(options.fixtureReceiptFile) : null,
            aotWarmReportFile: options.aotWarmReportFile ? path.resolve(options.aotWarmReportFile) : null,
            browserStorageFile: options.browserStorageFile ? path.resolve(options.browserStorageFile) : null,
            objectStorageRoot: objectRoot
            , backendProcessIdentityFile: options.backendProcessIdentityFile ? path.resolve(options.backendProcessIdentityFile) : null
            , frontendProcessIdentityFile: options.frontendProcessIdentityFile ? path.resolve(options.frontendProcessIdentityFile) : null
            , releaseProcessIdentityFile: options.releaseProcessIdentityFile ? path.resolve(options.releaseProcessIdentityFile) : null
            , backendExecutableFile: options.backendExecutableFile ? path.resolve(options.backendExecutableFile) : null
            , frontendExecutableFile: options.frontendExecutableFile ? path.resolve(options.frontendExecutableFile) : null
            , releaseExecutableFile: options.releaseExecutableFile ? path.resolve(options.releaseExecutableFile) : null
        },
        runtimeHandles: {
            postgresContainer: environment.FSUSBLOG_POSTGRES_CONTAINER_NAME ?? null,
            redisContainer: environment.FSUSBLOG_REDIS_CONTAINER_NAME ?? null,
            redisNamespacePrefix: environment.RedisOptions__InstanceName ?? null
        },
        domains
    };
    const document = sealDocument(body);
    const output = path.resolve(options.outputFile);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const temporary = `${output}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, output);
    return document;
}

export function readProductionObserverAuthority(file, expectedIdentity = null)
{
    const document = readJson(file, 'production observer authority');
    if (document.schema !== productionObserverAuthoritySchema)
    {
        throw new Error('production observer authority schema is invalid');
    }
    verifySealedDocument(document);
    if (expectedIdentity && digestCanonical(document.identity) !== digestCanonical(expectedIdentity))
    {
        throw new Error('production observer authority is stale or cross-session');
    }
    return document;
}

function parseArgs(argv)
{
    const result = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        result[argv[index].replace(/^--/u, '')] = argv[index + 1];
    }
    return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    try
    {
        const values = parseArgs(process.argv.slice(2));
        publish({
            phase: values.phase,
            outputFile: values.output,
            sessionReceiptFile: values['session-receipt'],
            environmentFile: values.environment,
            fingerprintKeyFile: values['fingerprint-key'],
            serviceEnvelopeFile: values['service-envelope'],
            environmentReadyFile: values['environment-ready'],
            runtimeTopologyFile: values['runtime-topology']
            , fixtureReceiptFile: values['fixture-receipt']
            , aotWarmReportFile: values['aot-warm-report']
            , browserStorageFile: values['browser-storage']
            , objectStorageRoot: values['object-storage-root']
            , backendProcessIdentityFile: values['backend-process-identity']
            , frontendProcessIdentityFile: values['frontend-process-identity']
            , releaseProcessIdentityFile: values['release-process-identity']
            , backendExecutableFile: values['backend-executable']
            , frontendExecutableFile: values['frontend-executable']
            , releaseExecutableFile: values['release-executable']
        });
    }
    catch (error)
    {
        console.error(`[production-observer-authority] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
