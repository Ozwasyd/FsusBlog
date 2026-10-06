#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { validateJsonSchema } = await import(new URL('../test-matrix/schema-validator/validate.mjs', import.meta.url));
import { discoverBoundedChannels, discoverUnboundedChannels } from './bounded-channel-discovery.mjs';

export { discoverBoundedChannels, discoverUnboundedChannels } from './bounded-channel-discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const defaultCatalogPath = path.join(root, 'config/testing/bounded-channel-delivery-contracts.json');
const deliveryClasses = new Set(['required', 'best-effort', 'coalescible', 'replayable']);
const dispositionKinds = new Set(['implemented', 'not-applicable', 'successor-required']);
const publicHotAuthorities = [1629, 1630, 1631]
    .map((issue) => `https://github.com/Ozwasyd/FsusBlog/issues/${issue}`);
const publicHotRiskProjectionQueue = Object.freeze({
    queueId: 'public-hot-read-risk-projection-remote',
    ownerType: 'PublicHotReadRiskProjectionWorker'
});
const drainParticipantSource = 'src/backend/Infrastructure/Operations/BoundedQueueDrainParticipants.cs';
const drainParticipantRegistrationSource = 'src/backend/Infrastructure/Operations/ActiveReleaseFenceHosting.cs';
const acceptanceReceiptSchema = 'fsusblog.bounded-queue-acceptance.v1';
const drainAggregateSchema = 'fsusblog.bounded-queue-drain-aggregate.v1';
const matrixTestSource = 'tests/backend/Unit/BoundedQueueDrainAggregatorTests.cs';
const matrixScenarios = [
    'exact-drain',
    'queued-pending',
    'in-flight-pending',
    'durable-pending',
    'terminal-failure',
    'commit-postcondition-unknown',
    'drop-proof-mutation',
    'worker-crash',
    'cancel-timeout',
    'restart-generation-regression'
];
const acceptanceSourcePaths = [
    'config/testing/bounded-channel-delivery-contracts.json',
    'config/testing/bounded-channel-delivery-contracts.schema.json',
    'src/backend/Infrastructure/Operations/ActiveReleaseFenceHosting.cs',
    'src/backend/Infrastructure/Operations/BoundedQueueDeliveryCatalog.cs',
    'src/backend/Infrastructure/Operations/BoundedQueueDrainAggregator.cs',
    'src/backend/Infrastructure/Operations/BoundedQueueDrainContracts.cs',
    drainParticipantSource,
    'src/backend/Infrastructure/Operations/BoundedQueueDrainReleaseParticipant.cs',
    'src/backend/Infrastructure/Operations/ProductionHealth.cs',
    'src/backend/Infrastructure/PublicAot/PublicAotFileShellCacheInvalidationSubscriber.cs',
    'src/backend/Infrastructure/Security/AdminSessionProjectionRuntime.cs',
    'src/backend/Infrastructure/Security/PublicHotReadRiskProjection.cs',
    'docs/testing.md',
    'tests/backend/Unit/AdminSessionValidationServiceTests.cs',
    'tests/backend/Unit/NotificationStreamDeliveryAccountingTests.cs',
    'tests/backend/Unit/PublicHotReadRiskProjectionQueueWrapperTests.cs',
    'tests/backend/Unit/PublicAotFileShellInvalidationQueueTests.cs',
    'tests/tools/bounded-channel-contracts.test.mjs',
    'tests/tools/bounded-channel-discovery.test.mjs',
    matrixTestSource,
    'tools/governance/bounded-channel-contracts.mjs',
    'tools/governance/bounded-channel-discovery.mjs'
].sort();

function canonical(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function deliveryCatalogDigest(queues)
{
    return `sha256:${crypto.createHash('sha256').update(canonical(queues)).digest('hex')}`;
}

function presentString(value)
{
    return typeof value === 'string' && value.trim().length > 0;
}

function validateReference(reference, label, errors, readSource)
{
    if (!reference || !presentString(reference.file) || !presentString(reference.token))
    {
        errors.push(`${label} must contain file and token`);
        return;
    }
    const source = readSource(reference.file);
    if (source === null)
    {
        errors.push(`${label} references missing file ${reference.file}`);
    }
    else if (!source.includes(reference.token))
    {
        errors.push(`${label} token is absent from ${reference.file}: ${reference.token}`);
    }
}

function validateDisposition(value, label, errors, readSource)
{
    if (!value || !dispositionKinds.has(value.status))
    {
        errors.push(`${label}.status is unknown`);
    }
    if (!presentString(value?.rationale))
    {
        errors.push(`${label}.rationale is required`);
    }
    if (!Array.isArray(value?.callsites))
    {
        errors.push(`${label}.callsites must be an array`);
    }
    else
    {
        if (value.status === 'implemented' && value.callsites.length === 0)
        {
            errors.push(`${label} implemented disposition needs a callsite`);
        }
        value.callsites.forEach((reference, index) => validateReference(reference, `${label}.callsites[${index}]`, errors, readSource));
    }
}

export function validateBoundedChannelCatalog(catalogPath = defaultCatalogPath, options = {})
{
    const catalog = options.catalog ?? JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const sourceOverrides = options.sources instanceof Map ? options.sources : new Map();
    const readSource = (file) =>
    {
        if (sourceOverrides.has(file))
        {
            return sourceOverrides.get(file);
        }
        const absolute = path.join(root, file);
        return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    };
    const errors = [];
    const schemaPath = path.join(root, 'config/testing/bounded-channel-delivery-contracts.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    if (schema.$id !== 'https://fsus.blog/schemas/testing/bounded-channel-delivery-contracts.schema.json')
    {
        errors.push('bounded channel schema authority is unknown');
    }
    errors.push(...validateJsonSchema(catalog, schema));
    rejectUnknownKeys(catalog, new Set(['schema', 'digest', 'queues']), 'catalog', errors);
    if (catalog.schema !== 'fsusblog.bounded-channel-delivery-contracts.v1')
    {
        errors.push('catalog schema is unknown');
    }
    if (!Array.isArray(catalog.queues))
    {
        return [...errors, 'catalog queues must be an array'];
    }
    const discovered = options.discovered ?? discoverBoundedChannels(options.sources ? { sources: options.sources } : {});
    const unbounded = options.unbounded ?? discoverUnboundedChannels(options.sources instanceof Map ? { sources: options.sources } : {});
    for (const channel of unbounded)
    {
        errors.push(`unbounded channel is forbidden: ${channel.file}:${channel.line}`);
    }
    const duplicate = (values, label) =>
    {
        for (const value of new Set(values.filter((item, index) => values.indexOf(item) !== index)))
        {
            errors.push(`duplicate ${label}: ${value}`);
        }
    };
    duplicate(catalog.queues.map((queue) => queue.queueId), 'queue ID');
    duplicate(catalog.queues.map((queue) => queue.discoveryKey), 'discovery key');
    duplicate(catalog.queues.map((queue) => queue.owner?.id), 'owner');
    duplicate(
        catalog.queues
            .filter((queue) => queue.drainParticipant === true)
            .map((queue) => queue.participantAdapter?.token)
            .filter(Boolean),
        'drain participant adapter'
    );
    const sortedIds = catalog.queues.map((queue) => queue.queueId);
    if (JSON.stringify(sortedIds) !== JSON.stringify([...sortedIds].sort()))
    {
        errors.push('catalog queues must have stable queueId ordering');
    }
    const catalogKeys = new Set(catalog.queues.map((queue) => queue.discoveryKey));
    const discoveredKeys = new Set(discovered.map((queue) => queue.discoveryKey));
    for (const key of discoveredKeys)
    {
        if (!catalogKeys.has(key))
        {
            errors.push(`bounded channel missing from catalog: ${key}`);
        }
    }
    for (const key of catalogKeys)
    {
        if (!discoveredKeys.has(key))
        {
            errors.push(`orphan catalog queue: ${key}`);
        }
    }
    if (catalog.digest !== deliveryCatalogDigest(catalog.queues))
    {
        errors.push('catalog digest does not match stable canonical queue ordering');
    }
    for (const queue of catalog.queues)
    {
        validateQueue(queue, discovered.find((item) => item.discoveryKey === queue.discoveryKey), errors, readSource);
    }
    if (new Set(catalog.queues.map((queue) => queue.deliveryClass)).size < 2)
    {
        errors.push('catalog must not assign every queue one delivery class');
    }
    const catalogText = options.catalogText ?? fs.readFileSync(catalogPath, 'utf8');
    if (/\bwildcardSuppression\b|directory-level suppression|private fallback unregistered/iu.test(`${catalogText}\n${JSON.stringify(catalog)}`))
    {
        errors.push('catalog must not use directory-level suppression or unregistered private fallbacks');
    }
    return errors;
}

function validateQueue(queue, discovery, errors, readSource)
{
    const label = queue.queueId || '<unknown>';
    rejectUnknownKeys(queue, new Set(['queueId', 'discoveryKey', 'owner', 'deliveryClass', 'drainParticipant', 'participantAdapter', 'channelBehavior', 'writerCallsites', 'readerCallsites', 'drain', 'fallback', 'failureSemantics', 'evidenceSources', 'proofTestIds', 'classProof', 'disposition', 'implementationOwner', 'authoritativeContracts']), label, errors);
    for (const field of ['queueId', 'discoveryKey', 'deliveryClass', 'implementationOwner', 'disposition'])
    {
        if (!presentString(queue[field]))
        {
            errors.push(`${label}.${field} is required`);
        }
    }
    if (!deliveryClasses.has(queue.deliveryClass))
    {
        errors.push(`${label} has unknown delivery class`);
    }
    if (typeof queue.drainParticipant !== 'boolean')
    {
        errors.push(`${label}.drainParticipant must be a boolean`);
    }
    if (queue.drainParticipant === true)
    {
        if (!queue.participantAdapter)
        {
            errors.push(`${label} drain participant requires participantAdapter`);
        }
        else
        {
            validateReference(queue.participantAdapter, `${label}.participantAdapter`, errors, readSource);
            validateDrainParticipantBinding(queue, errors, readSource);
        }
    }
    else if (queue.participantAdapter)
    {
        errors.push(`${label} participantAdapter is only valid when drainParticipant is true`);
    }
    if (!queue.owner || !presentString(queue.owner.id) || !presentString(queue.owner.file) || !presentString(queue.owner.type) || !presentString(queue.owner.slot))
    {
        errors.push(`${label} has unknown owner`);
    }
    else if (discovery && (queue.owner.file !== discovery.file || queue.owner.type !== discovery.ownerType || queue.owner.slot !== discovery.target))
    {
        errors.push(`${label} owner does not match discovered bounded channel`);
    }
    if (discovery?.fullMode && queue.channelBehavior?.fullMode !== discovery.fullMode)
    {
        errors.push(`${label} fullMode does not match source discovery`);
    }
    for (const field of ['writerCallsites', 'readerCallsites', 'evidenceSources'])
    {
        if (!Array.isArray(queue[field]) || queue[field].length === 0)
        {
            errors.push(`${label}.${field} must be non-empty`);
        }
        else
        {
            queue[field].forEach((reference, index) => validateReference(reference, `${label}.${field}[${index}]`, errors, readSource));
        }
    }
    if (!Array.isArray(queue.proofTestIds) || queue.proofTestIds.length === 0)
    {
        errors.push(`${label}.proofTestIds must be non-empty`);
    }
    else
    {
        queue.proofTestIds.forEach((reference, index) => validateReference(reference, `${label}.proofTestIds[${index}]`, errors, readSource));
    }
    validateDisposition(queue.drain, `${label}.drain`, errors, readSource);
    validateDisposition(queue.fallback, `${label}.fallback`, errors, readSource);
    const failure = queue.failureSemantics;
    for (const field of ['closed', 'cancellation', 'workerFailure', 'overflowMarker', 'inFlight', 'commitPostcondition', 'qualificationImpact'])
    {
        if (!presentString(failure?.[field]))
        {
            errors.push(`${label}.failureSemantics.${field} is required`);
        }
    }
    if (!presentString(queue.channelBehavior?.fullMode) || !presentString(queue.channelBehavior?.writerPrimitive))
    {
        errors.push(`${label}.channelBehavior requires fullMode and writerPrimitive`);
    }
    if (queue.channelBehavior?.fullMode === 'Wait' && queue.channelBehavior?.writerPrimitive.includes('TryWrite') && !presentString(queue.channelBehavior.waitTryWriteDisposition))
    {
        errors.push(`${label} FullMode Wait plus TryWrite must be explained`);
    }
    validateWriterPrimitive(queue, label, errors);
    validateClassProof(queue, label, errors, readSource);
    if (queue.deliveryClass === 'best-effort' && /audit|security|risk|challenge/iu.test(`${queue.queueId} ${queue.owner?.id ?? ''} ${queue.owner?.type ?? ''}`))
    {
        errors.push(`${label} protected audit/security queue cannot be best-effort`);
    }
    const isPublicHotRiskProjectionQueue = queue.queueId === publicHotRiskProjectionQueue.queueId
    && queue.owner?.type === publicHotRiskProjectionQueue.ownerType;
    if (queue.owner?.type?.includes('PublicHot') && !isPublicHotRiskProjectionQueue)
    {
        if (JSON.stringify(queue.authoritativeContracts) !== JSON.stringify(publicHotAuthorities))
        {
            errors.push(`${label} PublicHot authority must reference #1629-#1631 exactly`);
        }
        if (Object.hasOwn(queue, 'copiedAuthority'))
        {
            errors.push(`${label} PublicHot contract must not copy authoritative logic`);
        }
    }
    else if (queue.authoritativeContracts !== undefined)
    {
        errors.push(`${label} non-PublicHot queue must not declare PublicHot authority`);
    }
}

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function validateDrainParticipantBinding(queue, errors, readSource)
{
    const reference = queue.participantAdapter;
    const token = reference?.token;
    if (!presentString(token))
    {
        return;
    }
    const source = readSource(reference.file);
    if (source !== null)
    {
        const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(token)}\\b[\\s\\S]{0,480}:\\s*IBoundedQueueDrainParticipant\\b`, 'u');
        if (!classPattern.test(source))
        {
            errors.push(`${queue.queueId}.participantAdapter token must implement IBoundedQueueDrainParticipant`);
        }
        const queueIdToken = `QueueId => "${queue.queueId}"`;
        if ((source.match(new RegExp(escapeRegExp(queueIdToken), 'gu')) ?? []).length !== 1)
        {
            errors.push(`${queue.queueId}.participantAdapter must bind QueueId exactly once`);
        }
    }
    const registrations = readSource(drainParticipantRegistrationSource);
    if (registrations === null)
    {
        errors.push(`${queue.queueId}.participantAdapter registration source is missing`);
    }
    else
    {
        const registration = `ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ${token}>()`;
        if (!registrations.includes(registration))
        {
            errors.push(`${queue.queueId}.participantAdapter is not registered in ${drainParticipantRegistrationSource}`);
        }
    }
}

function validateWriterPrimitive(queue, label, errors)
{
    const primitive = queue.channelBehavior?.writerPrimitive;
    const callsites = Array.isArray(queue.writerCallsites) ? queue.writerCallsites.map((reference) => reference?.token ?? '').join('\n') : '';
    const primitiveUsesTryWrite = presentString(primitive) && /\bTryWrite\b/iu.test(primitive);
    const callsitesUseTryWrite = /\bTryWrite\b/iu.test(callsites);
    if (primitiveUsesTryWrite && !callsitesUseTryWrite)
    {
        errors.push(`${label} writer primitive does not match its writer callsite`);
    }
    // Indirect WriteAsync callsites are valid when the catalog records the writer abstraction;
    // a mutation that erases an explicit TryWrite contract must still fail closed.
    if (presentString(primitive) && /^WriteAsync$/u.test(primitive.trim()) && callsitesUseTryWrite)
    {
        errors.push(`${label} writer primitive does not match its writer callsite`);
    }
}

function rejectUnknownKeys(value, allowed, label, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return;
    }
    for (const key of Object.keys(value))
    {
        if (!allowed.has(key))
        {
            errors.push(`${label} contains unknown property ${key}`);
        }
    }
}

function validateClassProof(queue, label, errors, readSource)
{
    const proof = queue.classProof;
    if (!proof || proof.kind !== queue.deliveryClass)
    {
        errors.push(`${label} class proof does not match delivery class`);
        return;
    }
    if (proof.kind === 'required')
    {
        validateReference(proof.durableSource, `${label}.classProof.durableSource`, errors, readSource);
        validateReference(proof.replaySource, `${label}.classProof.replaySource`, errors, readSource);
    }
    else if (proof.kind === 'best-effort')
    {
        if (!presentString(proof.productCapability) || !presentString(proof.impact))
        {
            errors.push(`${label} best-effort product proof is incomplete`);
        }
        if (/security|audit|correctness|authorization|integrity/iu.test(`${proof.productCapability ?? ''} ${proof.impact ?? ''}`))
        {
            errors.push(`${label} best-effort proof cannot waive security, audit, or correctness`);
        }
        validateReference(proof.productProof, `${label}.classProof.productProof`, errors, readSource);
    }
    else if (proof.kind === 'coalescible')
    {
        validateReference(proof.commutativeProof, `${label}.classProof.commutativeProof`, errors, readSource);
        validateReference(proof.monotonicProof, `${label}.classProof.monotonicProof`, errors, readSource);
    }
    else if (proof.kind === 'replayable')
    {
        validateReference(proof.executableSource, `${label}.classProof.executableSource`, errors, readSource);
        validateReference(proof.postcondition, `${label}.classProof.postcondition`, errors, readSource);
        if (/log|metric|telemetry/iu.test(`${proof.postcondition?.file ?? ''} ${proof.postcondition?.token ?? ''}`))
        {
            errors.push(`${label} replayable postcondition cannot be log-only evidence`);
        }
    }
}

export function queueDispositionReport(catalogPath = defaultCatalogPath)
{
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    return catalog.queues.map(({ queueId, deliveryClass, disposition, implementationOwner }) => ({ queueId, deliveryClass, disposition, implementationOwner }));
}

function sha256Text(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(file)
{
    return sha256Text(fs.readFileSync(path.join(root, file)));
}

function currentSourceBindings(catalog)
{
    const files = new Set(acceptanceSourcePaths);
    const visit = (value) =>
    {
        if (!value || typeof value !== 'object')
        {
            return;
        }
        if (presentString(value.file))
        {
            files.add(value.file);
        }
        Object.values(value).forEach(visit);
    };
    visit(catalog.queues);
    return [...files].sort().map((file) => ({ path: file, contentDigest: sha256File(file) }));
}

function expectedMutation(id, mutate, expectedPattern, options = {})
{
    const value = JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'));
    mutate(value);
    value.digest = deliveryCatalogDigest(value.queues);
    const errors = validateBoundedChannelCatalog(defaultCatalogPath, {
        catalog: value,
        discovered: discoverBoundedChannels(),
        sources: options.sources
    });
    const passed = errors.some((error) => expectedPattern.test(error));
    if (!passed)
    {
        throw new Error(`${id} mutation was not rejected: ${errors.join('; ')}`);
    }
    return { id, status: 'rejected', evidence: errors.filter((error) => expectedPattern.test(error)).sort() };
}

function runtimeMutationSourceEvidence(id, scenario)
{
    const source = fs.readFileSync(path.join(root, matrixTestSource), 'utf8');
    if (!source.includes(`"${scenario}"`))
    {
        throw new Error(`${id} is missing runtime matrix scenario ${scenario}`);
    }
    return { id, status: 'source-bound', evidence: { path: matrixTestSource, scenario } };
}

function matrixSourceEvidence()
{
    const source = fs.readFileSync(path.join(root, matrixTestSource), 'utf8');
    const missing = matrixScenarios.filter((scenario) => !source.includes(`"${scenario}"`));
    if (missing.length > 0
    || !source.includes('embedded.DrainParticipants')
    || !source.includes('Assert.Equal(contracts.Count * scenarios.Length, executed)'))
    {
        throw new Error(`bounded queue matrix source is incomplete: ${missing.join(', ') || 'catalog enumeration or fixture assertion missing'}`);
    }
    return {
        path: matrixTestSource,
        enumeration: 'BoundedQueueDeliveryCatalog.Embedded.DrainParticipants',
        scenarioCount: matrixScenarios.length,
        fixtureAssertion: 'contracts.Count * scenarios.Length'
    };
}

function buildAcceptanceMutationResults()
{
    const catalog = JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'));
    const bestEffort = catalog.queues.find((queue) => queue.deliveryClass === 'best-effort');
    const protectedQueue = catalog.queues.find((queue) => /audit|security|risk|challenge/iu.test(`${queue.queueId} ${queue.owner?.type ?? ''}`));
    const bestEffortProof = structuredClone(bestEffort.classProof);
    return [
        expectedMutation(
            'unbounded-channel',
            () =>
            {},
            /unbounded channel is forbidden/iu,
            { sources: new Map([['src/backend/Mutation.cs', 'private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();']]) }
        ),
        expectedMutation(
            'writeasync-without-callsite-contract',
            (value) =>
            {
                value.queues.find((queue) => queue.channelBehavior.writerPrimitive.includes('TryWrite')).channelBehavior.writerPrimitive = 'WriteAsync';
            },
            /writer primitive does not match/iu
        ),
        expectedMutation(
            'unknown-best-effort-classification',
            (value) =>
            {
                value.queues.find((queue) => queue.deliveryClass === 'required').deliveryClass = 'best-effort';
            },
            /class proof does not match/iu
        ),
        expectedMutation(
            'protected-warning-only-drop',
            (value) =>
            {
                const queue = value.queues.find((candidate) => candidate.queueId === protectedQueue.queueId);
                queue.deliveryClass = 'best-effort';
                queue.classProof = structuredClone(bestEffortProof);
            },
            /protected audit\/security queue cannot be best-effort/iu
        ),
        runtimeMutationSourceEvidence('coalescing-generation-regression', 'restart-generation-regression'),
        runtimeMutationSourceEvidence('queued-count-only-drain', 'in-flight-pending'),
        runtimeMutationSourceEvidence('worker-without-in-flight-accounting', 'in-flight-pending'),
        expectedMutation(
            'log-only-replay-postcondition',
            (value) =>
            {
                const queue = value.queues.find((candidate) => candidate.deliveryClass === 'replayable');
                queue.classProof.postcondition = { file: queue.classProof.executableSource.file, token: 'ILogger' };
            },
            /postcondition|log-only/iu
        )
    ];
}

export function buildBoundedQueueAcceptanceReceipt(catalogPath = defaultCatalogPath)
{
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const errors = validateBoundedChannelCatalog(catalogPath);
    if (errors.length > 0)
    {
        throw new Error(`cannot build bounded queue acceptance receipt: ${errors.join('; ')}`);
    }
    const participants = catalog.queues
        .filter((queue) => queue.drainParticipant === true)
        .sort((left, right) => left.queueId.localeCompare(right.queueId));
    const sources = currentSourceBindings(catalog);
    const matrix = matrixSourceEvidence();
    const payload = {
        schema: acceptanceReceiptSchema,
        source: {
            files: sources,
            contentDigest: sha256Text(canonical(sources))
        },
        catalog: {
            path: path.relative(root, catalogPath).split(path.sep).join('/'),
            fileDigest: sha256File(path.relative(root, catalogPath)),
            catalogDigest: catalog.digest
        },
        matrix: {
            test: matrixTestSource,
            enumeration: matrix.enumeration,
            scenarios: matrixScenarios,
            queueCount: participants.length,
            fixtureCount: participants.length * matrixScenarios.length,
            fixtureAssertion: matrix.fixtureAssertion
        },
        perQueue: participants.map((queue) => ({
            queueId: queue.queueId,
            deliveryClass: queue.deliveryClass,
            participantAdapter: queue.participantAdapter,
            qualificationImpact: queue.failureSemantics.qualificationImpact,
            proofTestIds: queue.proofTestIds,
            scenarios: matrixScenarios
        })),
        drainAggregate: {
            schema: drainAggregateSchema,
            source: 'src/backend/Infrastructure/Operations/BoundedQueueDrainAggregator.cs',
            catalogDigest: catalog.digest,
            participantQueueIds: participants.map((queue) => queue.queueId)
        },
        mutationResults: buildAcceptanceMutationResults(),
        warnings: []
    };
    return { ...payload, contentDigest: sha256Text(canonical(payload)) };
}

export function verifyBoundedQueueAcceptanceReceipt(receipt, catalogPath = defaultCatalogPath)
{
    const expected = buildBoundedQueueAcceptanceReceipt(catalogPath);
    if (canonical(receipt) !== canonical(expected))
    {
        throw new Error('bounded queue acceptance receipt does not match current source');
    }
    return receipt;
}

export const warningOnlyMutation = Object.freeze({
    source: 'src/backend/Infrastructure/Audit/AdminAuditLogChannel.cs',
    oracleSource: 'tests/backend/Unit/AdminAuditDurableAdmissionIssue2040Tests.cs',
    oracle: 'FsusBlog.Server.Tests.Unit.AdminAuditDurableAdmissionIssue2040Tests.PersistentReplayFailure_BlocksRealAdminParticipantHealthAndQualification',
    before: 'await store.WriteBatchAsync(audits, cancellationToken).ConfigureAwait(false);',
    after: 'cancellationToken.ThrowIfCancellationRequested();\n                _logger.LogWarning("admin-audit mutation omitted required store write. StoreType={StoreType}", store.GetType().Name);'
});

function gitObject(type, bytes)
{
    return crypto.createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

// Read raw git ls-tree -rz output, not a caller-authored list of selected files.
export function warningMutationParent(commitBytes, indexBytes, expectedCommit)
{
    if (gitObject('commit', commitBytes) !== expectedCommit)
    {
        throw new Error('physical mutation parent commit object mismatch');
    }
    const files = indexBytes.toString('utf8').split('\0').filter(Boolean).map((entry) =>
    {
        const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(entry);
        if (!match || match[3].split('/').some((part) => !part || part === '.' || part === '..'))
        {
            throw new Error('unsupported or unsafe parent index entry');
        }
        return { mode: match[1], object: match[2], path: match[3] };
    });
    const tree = new Map();
    for (const file of files)
    {
        let directory = tree;
        const parts = file.path.split('/');
        for (const part of parts.slice(0, -1))
        {
            if (!directory.has(part))
            {
                directory.set(part, new Map());
            }
            directory = directory.get(part);
            if (!(directory instanceof Map))
            {
                throw new Error('parent index path collision');
            }
        }
        const name = parts.at(-1);
        if (directory.has(name))
        {
            throw new Error('duplicate parent index entry');
        }
        directory.set(name, file);
    }
    function hashTree(directory)
    {
        const entries = [...directory].sort(([a, av], [b, bv]) =>
            Buffer.compare(Buffer.from(`${a}${av instanceof Map ? '/' : ''}`), Buffer.from(`${b}${bv instanceof Map ? '/' : ''}`)));
        return gitObject('tree', Buffer.concat(entries.map(([name, value]) =>
            Buffer.concat([
                Buffer.from(`${value instanceof Map ? '40000' : value.mode} ${name}\0`),
                Buffer.from(value instanceof Map ? hashTree(value) : value.object, 'hex')
            ]))));
    }
    const treeObject = hashTree(tree);
    if (!commitBytes.toString('utf8').startsWith(`tree ${treeObject}\n`))
    {
        throw new Error('physical mutation full index/tree mismatch');
    }
    return { commit: expectedCommit, tree: treeObject, files };
}

export function validateWarningMutationTrx(xml, variant)
{
    const counters = /<Counters\s+([^>]+)\/?\s*>/u.exec(xml)?.[1] ?? '';
    const count = (name) => Number(new RegExp(`\\b${name}="(\\d+)"`, 'u').exec(counters)?.[1] ?? NaN);
    const results = [...xml.matchAll(/<UnitTestResult\b([^>]+)>/gu)];
    const definitions = [...xml.matchAll(/<UnitTest\b([^>]+)>/gu)];
    const definition = xml.includes(`className="${warningOnlyMutation.oracle.slice(0, warningOnlyMutation.oracle.lastIndexOf('.'))}"`)
        && xml.includes(`name="${warningOnlyMutation.oracle.split('.').at(-1)}"`);
    if (count('total') !== 1 || count('executed') !== 1 || count('notExecuted') !== 0
        || results.length !== 1 || definitions.length !== 1 || !definition
        || !results[0]?.[1].includes(`testName="${warningOnlyMutation.oracle}"`)
        || /\btestId="([^"]+)"/u.exec(results[0]?.[1] ?? '')?.[1] !== /\bid="([^"]+)"/u.exec(definitions[0]?.[1] ?? '')?.[1]
        || ['error', 'timeout', 'aborted', 'notRunnable', 'disconnected'].some((name) => count(name) !== 0))
    {
        throw new Error('physical mutation requires exactly the specified executed oracle, zero skip');
    }
    const expected = variant === 'baseline' ? 'Passed' : 'Failed';
    if (!results[0][1].includes(`outcome="${expected}"`)
        || count('passed') !== (variant === 'baseline' ? 1 : 0)
        || count('failed') !== (variant === 'baseline' ? 0 : 1))
    {
        throw new Error(`physical mutation ${variant} did not produce the required result`);
    }
    if (variant !== 'baseline'
        && (!xml.includes('Assert.Throws() Failure: No exception was thrown')
            || !xml.includes('System.IO.IOException')
            || !xml.includes(warningOnlyMutation.oracle)))
    {
        throw new Error('physical mutation failed for a different reason; not a kill');
    }
    return { total: 1, passed: variant === 'baseline' ? 1 : 0, failed: variant === 'baseline' ? 0 : 1, skipped: 0 };
}

export function validateWarningMutationIdentity(invocation, expected)
{
    if (!expected || !/^[a-f0-9]{40}$/u.test(expected.currentCommit ?? '')
        || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(expected.fingerprint ?? '')
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(expected.runId ?? '')
        || !['development', 'canonical'].includes(expected.purpose))
    {
        throw new Error('independent expected current commit/fingerprint/run ID/purpose required');
    }
    if (invocation.candidateCommit !== expected.currentCommit
        || invocation.candidateFingerprint !== expected.fingerprint || invocation.runId !== expected.runId
        || invocation.purpose !== expected.purpose)
    {
        throw new Error('physical mutation invocation differs from independently expected candidate identity');
    }
    if (!/^[a-f0-9]{40}$/u.test(invocation.parentCommit ?? '')
        || (expected.purpose === 'canonical' && invocation.parentCommit !== expected.currentCommit))
    {
        throw new Error('canonical physical mutation parent must be the current immutable commit');
    }
    return expected;
}

// Kernel observations are taken while the session leader is blocked before exec.
// setsid --wait may fork: its launcher PID is not necessarily the new PGID.
function warningMutationProcesses(processes)
{
    const rows = new Map();
    for (const line of processes.trim().split('\n'))
    {
        const fields = line.trim().split(/\s+/u);
        if (fields.slice(0, 4).join(' ') === 'PID PPID PGID SID')
        {
            continue;
        }
        const values = fields.slice(0, 4).map(Number);
        if (values.length !== 4 || values.some((value) => !Number.isSafeInteger(value) || value < 0)
            || values[0] <= 0 || rows.has(values[0]))
        {
            throw new Error('physical mutation malformed native process inventory');
        }
        rows.set(values[0], values);
    }
    return rows;
}

export function validateWarningMutationReady(ready, processes, launcher, owner)
{
    const values = ready.trim().split(/\s+/u).map(Number);
    const rows = warningMutationProcesses(processes);
    if (values.length !== 4 || values.some((value) => !Number.isSafeInteger(value) || value <= 1)
        || !Number.isSafeInteger(launcher) || !Number.isSafeInteger(owner) || launcher <= 1 || owner <= 1
        || values[0] !== values[2] || values[0] !== values[3]
        || canonical(rows.get(values[0])) !== canonical(values)
        || !rows.has(owner) || !rows.has(launcher) || values[2] === rows.get(owner)[2])
    {
        throw new Error('physical mutation ready kernel PID/PGID/SID ownership mismatch');
    }
    const seen = new Set();
    let current = values[0];
    let sawLauncher = false;
    while (current !== owner)
    {
        if (seen.has(current) || !rows.has(current))
        {
            throw new Error('physical mutation ready process has no owned launcher ancestry');
        }
        seen.add(current);
        sawLauncher ||= current === launcher;
        current = rows.get(current)[1];
    }
    if (!sawLauncher || launcher === owner)
    {
        throw new Error('physical mutation ready process has no owned launcher ancestry');
    }
    return { leader: values[0], parent: values[1], processGroup: values[2], session: values[3], launcher, owner };
}

export function validateWarningMutationTerminal(processes, ready)
{
    const rows = warningMutationProcesses(processes);
    if (!rows.has(ready.owner) || rows.has(ready.launcher)
        || [...rows.values()].some((row) => row[2] === ready.processGroup || row[3] === ready.session))
    {
        throw new Error('physical mutation process group/session/launcher has not terminated or observer is absent');
    }
}

export function validateWarningMutationDllParity(build, runtime)
{
    if (!build.length || !Buffer.from(build).equals(Buffer.from(runtime)))
    {
        throw new Error('physical mutation test-directory Server DLL differs from its variant backend build');
    }
}

export function verifyWarningOnlySourceMutation(directory, expectedCommit, { inputsOnly = false, expected } = {})
{
    const evidenceRoot = fs.realpathSync(directory);
    const read = (relative) => fs.readFileSync(path.join(evidenceRoot, relative));
    const parent = warningMutationParent(read('parent.commit'), read('parent.index'), expectedCommit);
    const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const bindings = [];
    const bind = (relative) =>
    {
        const bytes = read(relative);
        bindings.push({ path: relative, digest: digest(bytes), bytes: bytes.length });
        return bytes;
    };
    ['parent.commit', 'parent.index', 'parent.tar', 'mutation.patch'].forEach(bind);
    const invocation = JSON.parse(bind('invocation.json').toString('utf8'));
    validateWarningMutationIdentity(invocation, expected);
    if (invocation.parentCommit !== expectedCommit)
    {
        throw new Error('physical mutation invocation parent differs from Git-object proof');
    }
    const ownerPaths = ['tools/governance/bounded-channel-contracts.mjs', 'tests/tools/bounded-channel-contracts.test.mjs',
        'tools/test/lanes/_suite-support.sh', 'tests/matrix.yml', 'docs/testing.md',
        'tests/backend/Fixtures/backend-evidence-path-authority.generated.json'];
    const owners = ownerPaths.map((file) => ({ file, digest: digest(fs.readFileSync(path.join(root, file))) }));
    if (canonical(invocation.executionOwnerSources) !== canonical(owners))
    {
        throw new Error('physical mutation execution owner source drift');
    }
    // Development evidence binds the live product and oracle, but does not qualify
    // an old tooling parent. Canonical evidence requires every tracked input clean.
    for (const file of parent.files.filter((file) => expected.purpose === 'canonical'
        || [warningOnlyMutation.source, warningOnlyMutation.oracleSource].includes(file.path)))
    {
        const absolute = path.join(root, file.path);
        const stat = fs.lstatSync(absolute);
        const bytes = file.mode === '120000' ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
        if (gitObject('blob', bytes) !== file.object || (file.mode === '120000') !== stat.isSymbolicLink()
            || (file.mode !== '120000' && Boolean(stat.mode & 0o111) !== (file.mode === '100755')))
        {
            throw new Error(`physical mutation live current source differs from immutable parent: ${file.path}`);
        }
    }
    const baseline = read(`baseline/${warningOnlyMutation.source}`).toString('utf8');
    if (baseline.split(warningOnlyMutation.before).length !== 2)
    {
        throw new Error('physical mutation requires exactly one real store-write callback');
    }
    const expectedMutant = baseline.replace(warningOnlyMutation.before, warningOnlyMutation.after);
    const sourceBindings = {};
    for (const variant of ['baseline', 'mutant'])
    {
        const entries = [];
        for (const file of parent.files)
        {
            const absolute = path.join(evidenceRoot, variant, file.path);
            const stat = fs.lstatSync(absolute);
            const bytes = file.mode === '120000' ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
            if ((file.mode === '120000') !== stat.isSymbolicLink()
                || (file.mode !== '120000' && Boolean(stat.mode & 0o111) !== (file.mode === '100755')))
            {
                throw new Error(`physical mutation source mode drift: ${variant}/${file.path}`);
            }
            if (variant === 'mutant' && file.path === warningOnlyMutation.source)
            {
                if (bytes.toString('utf8') !== expectedMutant)
                {
                    throw new Error('not the single authorized product source mutation');
                }
            }
            else if (gitObject('blob', bytes) !== file.object)
            {
                throw new Error(`physical mutation source drift: ${variant}/${file.path}`);
            }
            entries.push({ ...file, digest: digest(bytes) });
        }
        sourceBindings[variant] = { files: entries, digest: digest(Buffer.from(canonical(entries))) };
    }
    const patch = read('mutation.patch').toString('utf8');
    if ((patch.match(/^diff --git /gmu) ?? []).length !== 1
        || !patch.includes(`-${warningOnlyMutation.before}`) && !patch.includes(`-                ${warningOnlyMutation.before}`)
        || !patch.includes('+                _logger.LogWarning(')
        || !patch.includes(`index ${gitObject('blob', Buffer.from(baseline))}..${gitObject('blob', Buffer.from(expectedMutant))} 100644`))
    {
        throw new Error('physical mutation patch does not bind the single store-write removal');
    }
    if (inputsOnly)
    {
        const expectedPaths = new Set(parent.files.map((file) => file.path));
        function checkInventory(directory, prefix = '')
        {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
            {
                const relative = `${prefix}${entry.name}`;
                if (entry.isDirectory())
                {
                    checkInventory(path.join(directory, entry.name), `${relative}/`);
                }
                else if (!expectedPaths.has(relative))
                {
                    throw new Error(`unexpected physical mutation source input: ${relative}`);
                }
            }
        }
        for (const variant of ['baseline', 'mutant'])
        {
            checkInventory(path.join(evidenceRoot, variant));
        }
        return { parent, invocation, sourceBindings, bindings };
    }
    const inputProof = JSON.parse(bind('inputs.json').toString('utf8'));
    if (canonical(inputProof.parent) !== canonical(parent)
        || canonical(inputProof.sourceBindings) !== canonical(sourceBindings)
        || canonical(inputProof.invocation) !== canonical(invocation))
    {
        throw new Error('physical mutation pre-build source inventory drift');
    }
    const stages = {};
    for (const variant of ['baseline', 'mutant'])
    {
        const variantStages = {};
        for (const stage of ['restore', 'build', 'test'])
        {
            const prefix = `${variant}.${stage}`;
            const status = Number(bind(`${prefix}.exit`).toString('utf8').trim());
            const expectedStatus = variant === 'mutant' && stage === 'test' ? 1 : 0;
            if (status !== expectedStatus)
            {
                throw new Error(`${prefix} exit ${status}: not a kill`);
            }
            const log = bind(`${prefix}.log`).toString('utf8');
            const started = Number(bind(`${prefix}.start`).toString('utf8').trim());
            const ended = Number(bind(`${prefix}.end`).toString('utf8').trim());
            if (!Number.isInteger(started) || !Number.isInteger(ended) || started <= 0 || ended < started)
            {
                throw new Error(`${prefix} lacks actual execution timestamps`);
            }
            const command = bind(`${prefix}.argv`).toString('utf8').split('\0').filter(Boolean);
            if (!command.includes(stage) || !command.includes('-m:1')
                || !command.includes('--disable-build-servers')
                || (stage === 'test' && !command.includes(`FullyQualifiedName=${warningOnlyMutation.oracle}`)))
            {
                throw new Error(`${prefix} is not the resource-bounded canonical target command`);
            }
            if (stage === 'build' && (!/\b0 Warning\(s\)/u.test(log) || !/\b0 Error\(s\)/u.test(log)))
            {
                throw new Error(`${prefix} must compile without warnings/errors`);
            }
            const launcher = Number(bind(`${prefix}.pid`).toString('utf8').trim());
            const ready = validateWarningMutationReady(bind(`${prefix}.ready`).toString('utf8'),
                bind(`${prefix}.ready-processes`).toString('utf8'), launcher, invocation.ownerProcessId);
            if (canonical(JSON.parse(bind(`${prefix}.ready-authority.json`).toString('utf8'))) !== canonical(ready))
            {
                throw new Error(`${prefix} ready authority differs from native observation`);
            }
            const processes = bind(`${prefix}.processes`).toString('utf8');
            validateWarningMutationTerminal(processes, ready);
            variantStages[stage] = { status, command, ...ready, started, ended };
        }
        const output = `${variant}/tests/backend/bin/Debug/net10.0`;
        for (const assembly of ['FsusBlog.Server.Tests.dll', 'FsusBlog.Server.Tests.pdb', 'FsusBlog.Server.dll', 'FsusBlog.Server.pdb'])
        {
            bind(`${output}/${assembly}`);
            const modified = fs.statSync(path.join(evidenceRoot, output, assembly)).mtimeMs / 1000;
            if (modified < variantStages.build.started - 1 || modified > variantStages.build.ended + 1)
            {
                throw new Error(`${variant} assembly is not from its fresh build`);
            }
        }
        validateWarningMutationDllParity(bind(`${variant}/src/backend/bin/Debug/net10.0/FsusBlog.Server.dll`),
            read(`${output}/FsusBlog.Server.dll`));
        const trx = bind(`${variant}.trx`).toString('utf8');
        if (!trx.includes(`codeBase="${path.join(evidenceRoot, output, 'FsusBlog.Server.Tests.dll')}"`))
        {
            throw new Error(`${variant} TRX does not reference its own fresh assembly`);
        }
        const testStart = Date.parse(/\bstartTime="([^"]+)"/u.exec(trx)?.[1] ?? '') / 1000;
        if (!Number.isFinite(testStart) || testStart < variantStages.test.started - 1 || testStart > variantStages.test.ended + 1)
        {
            throw new Error(`${variant} stale TRX execution time`);
        }
        variantStages.oracle = validateWarningMutationTrx(trx, variant);
        stages[variant] = variantStages;
    }
    const memory = Number(bind('memory.max').toString('utf8').trim());
    if (bind('cpu.max').toString('utf8').trim() !== '100000 100000'
        || !Number.isInteger(memory) || memory <= 0 || memory > 3221225472)
    {
        throw new Error('physical mutation requires actual SDK cgroup <=1CPU/3GiB');
    }
    const payload = {
        schema: 'fsusblog.bounded-warning-only-source-mutation.v2',
        owner: 'tools/test/lanes/_suite-support.sh:RunBoundedWarningOnlySourceMutation',
        executionPurpose: invocation.purpose, mutation: 'protected-warning-only-drop',
        parent: { commit: parent.commit, tree: parent.tree }, invocation,
        sourceBindings, stages, bindings,
        killed: true, qualificationEligible: false
    };
    return { ...payload, contentDigest: digest(Buffer.from(canonical(payload))) };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    const ready = process.argv.indexOf('--physical-warning-only-ready');
    const physical = process.argv.indexOf('--physical-warning-only-proof');
    if (physical >= 0 || ready >= 0)
    {
        try
        {
            const option = (name) =>
            {
                const index = process.argv.indexOf(name);
                return index < 0 ? undefined : process.argv[index + 1];
            };
            const proof = ready >= 0 ? validateWarningMutationReady(
                fs.readFileSync(`${process.argv[ready + 1]}.ready`, 'utf8'),
                fs.readFileSync(`${process.argv[ready + 1]}.ready-processes`, 'utf8'),
                Number(process.argv[ready + 2]), Number(process.argv[ready + 3]))
                : verifyWarningOnlySourceMutation(process.argv[physical + 1], process.argv[physical + 2],
                    { inputsOnly: process.argv.includes('--inputs-only'), expected: {
                        currentCommit: option('--expected-current-commit'), fingerprint: option('--expected-fingerprint'),
                        runId: option('--expected-run-id'), purpose: option('--purpose')
                    } });
            const output = process.argv.indexOf('--proof-output');
            const serialized = `${JSON.stringify(proof, null, 2)}\n`;
            if (output >= 0)
            {
                fs.writeFileSync(process.argv[output + 1], serialized, { flag: 'wx' });
                process.stdout.write(`${process.argv[output + 1]}\n`);
            }
            else
            {
                process.stdout.write(serialized);
            }
        }
        catch (error)
        {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        }
        process.exit(process.exitCode ?? 0);
    }
    const errors = validateBoundedChannelCatalog();
    if (errors.length > 0)
    {
        console.error(errors.join('\n'));
        process.exit(1);
    }
    if (process.argv.includes('--receipt'))
    {
        console.log(JSON.stringify(buildBoundedQueueAcceptanceReceipt(), null, 2));
        process.exit(0);
    }
    console.log(JSON.stringify({ digest: JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8')).digest, queues: queueDispositionReport() }, null, 2));
}
