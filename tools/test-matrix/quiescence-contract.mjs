import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {validateJsonSchema} = await import(new URL('./schema-validator/validate.mjs', import.meta.url));
const {deliveryCatalogDigest, validateBoundedChannelCatalog} = await import(new URL('../governance/bounded-channel-contracts.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
export const observationSchemaPath = 'config/schemas/quiescence-domain-observation.schema.json';

export function canonicalQuiescence(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalQuiescence);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalQuiescence(value[key])]));
    }
    return value;
}

export function quiescenceDigest(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalQuiescence(value))).digest('hex')}`;
}

export function loadQuiescenceAuthorities(repositoryRoot = root)
{
    const read = (file) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
    const catalog = read('config/testing/runtime-state-domain-catalog.json');
    const registry = read(catalog.registry);
    const boundedCatalog = read(registry.quiescence.boundedQueueCatalog);
    const schema = read(observationSchemaPath);
    return {catalog, registry, boundedCatalog, schema};
}

export function discoverQuiescenceWorkerSources(repositoryRoot = root)
{
    const classes = [];
    const walk = (directory) =>
    {
        for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((left, right) => left.name.localeCompare(right.name)))
        {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && !['bin', 'obj', 'node_modules'].includes(entry.name))
            {
                walk(file);
            }
            else if (entry.isFile() && entry.name.endsWith('.cs'))
            {
                // This conservative source guard supplements catalog registration; it is
                // not a C# semantic compiler or a claim of runtime worker enumeration.
                const source = fs.readFileSync(file, 'utf8').replace(
                    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"/gu,
                    (token) => token.replace(/[^\n]/gu, ' '));
                for (const match of source.matchAll(/\bclass\s+(?<type>[A-Za-z][A-Za-z0-9_]*)(?:\s*<[^{};]+?>)?(?:\s*\([^{};]*?\))?\s*(?::\s*(?<bases>[^{};]+))?\s*\{/gu))
                {
                    classes.push({type: match.groups.type,
                        bases: (match.groups.bases ?? '').split(',').map((base) => base.trim().split(/[<\s]/u)[0].split('.').at(-1)),
                        source: `${path.relative(repositoryRoot, file).replaceAll(path.sep, '/')}#${match.groups.type}`});
                }
            }
        }
    };
    walk(path.join(repositoryRoot, 'src/backend'));
    const hostedTypes = new Set(['BackgroundService', 'IHostedService']);
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const entry of classes)
        {
            if (!hostedTypes.has(entry.type) && entry.bases.some((base) => hostedTypes.has(base)))
            {
                hostedTypes.add(entry.type);
                changed = true;
            }
        }
    }
    return classes.filter((entry) => entry.bases.some((base) => hostedTypes.has(base)))
        .map((entry) => entry.source).sort();
}

export function validateQuiescenceWorkerRegistration(registry, observedSources)
{
    const declared = registry.quiescence?.managedWorkerSources;
    if (!Array.isArray(declared) || new Set(declared).size !== declared.length ||
        JSON.stringify([...declared].sort()) !== JSON.stringify([...observedSources].sort()))
    {
        return ['managed worker source roster drift; new/removed worker requires catalog registration and observer review'];
    }
    return [];
}

function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
    {
        throw new Error(`${label}: missing or unsupported fields`);
    }
}

export function deriveQuiescenceInventory({catalog, registry, boundedCatalog, schema})
{
    if (catalog.schema !== 'fsusblog.runtime-state-domain-catalog.v1' ||
        registry.schema !== 'fsusblog.runtime-state-domain-registry.v1' ||
        registry.quiescence?.schema !== 'fsusblog.quiescence-contract-registration.v1' ||
        boundedCatalog.schema !== 'fsusblog.bounded-channel-delivery-contracts.v1' ||
        schema.$id !== 'fsusblog.quiescence-domain-observation.v1')
    {
        throw new Error('quiescence source authority schema drift');
    }
    if (boundedCatalog.digest !== deliveryCatalogDigest(boundedCatalog.queues))
    {
        throw new Error('quiescence bounded catalog digest drift');
    }
    const access = new Set(catalog.steps.flatMap((step) =>
        ['reads', 'creates', 'writes', 'deletes', 'invalidates'].flatMap((operation) => step[operation] ?? [])));
    // These are background access declarations in the catalog's own registry,
    // not inferred access from a terminal runtime test script.
    for (const entry of registry.quiescence.contracts)
    {
        for (const domain of entry.stateDomains ?? [])
        {
            access.add(domain);
        }
    }
    const declaredDomains = new Set(registry.domains);
    const contracts = registry.quiescence.contracts.map((entry) =>
    {
        exactKeys(entry, ['domainId', 'owner', 'stateDomains', 'observerApi', 'namespaceScope',
            'highWatermarkSource', 'generationSource', 'freezeAdmissionHook', 'commitPostcondition',
            'qualificationImpact', 'proofTests'], 'quiescence registration');
        if (!/^[a-z][a-z0-9.-]*$/u.test(entry.domainId) || entry.domainId.includes('*') ||
            !Array.isArray(entry.stateDomains) || entry.stateDomains.length === 0 ||
            new Set(entry.stateDomains).size !== entry.stateDomains.length ||
            entry.stateDomains.some((domain) => !declaredDomains.has(domain) || !access.has(domain)))
        {
            throw new Error(`quiescence registration has orphan/wildcard state domain: ${entry.domainId}`);
        }
        for (const field of ['owner', 'observerApi', 'namespaceScope', 'highWatermarkSource',
            'generationSource', 'freezeAdmissionHook', 'commitPostcondition', 'qualificationImpact'])
        {
            if (typeof entry[field] !== 'string' || !entry[field].trim())
            {
                throw new Error(`quiescence registration lacks ${field}: ${entry.domainId}`);
            }
        }
        if (!Array.isArray(entry.proofTests) || !entry.proofTests.length ||
            entry.proofTests.some((proof) => typeof proof !== 'string' || !proof))
        {
            throw new Error(`quiescence registration lacks proof tests: ${entry.domainId}`);
        }
        return {...entry, stateDomains: [...entry.stateDomains].sort(), proofTests: [...entry.proofTests].sort()};
    });
    for (const queue of boundedCatalog.queues.filter((entry) => entry.drainParticipant))
    {
        if (!queue.participantAdapter?.token || !queue.failureSemantics?.commitPostcondition ||
            !queue.failureSemantics?.qualificationImpact || !queue.proofTestIds?.length)
        {
            throw new Error(`quiescence queue has no complete authoritative adapter: ${queue.queueId}`);
        }
        contracts.push({domainId: `bounded-queue.${queue.queueId}`, owner: queue.implementationOwner,
            stateDomains: [], queueId: queue.queueId,
            observerApi: `${queue.participantAdapter.token}.Observe/v1`,
            namespaceScope: 'requires independent current-runtime namespace proof; Observe(runId) does not supply it',
            highWatermarkSource: 'owner-issued immutable Sequence captured before admission freeze',
            generationSource: 'owner-issued Generation plus verified runtime/process incarnation',
            freezeAdmissionHook: 'required before admission; delivery participant is not a freeze capability',
            commitPostcondition: queue.failureSemantics.commitPostcondition,
            qualificationImpact: queue.failureSemantics.qualificationImpact,
            proofTests: queue.proofTestIds.map((proof) => `${proof.file}#${proof.token}`).sort()});
    }
    for (const contract of contracts)
    {
        contract.observationSchema = schema.$id;
        contract.requiredObservationFields = [...schema.required].sort();
    }
    contracts.sort((left, right) => left.domainId.localeCompare(right.domainId, 'en'));
    if (new Set(contracts.map((entry) => entry.domainId)).size !== contracts.length)
    {
        throw new Error('quiescence inventory has duplicate domains');
    }
    const payload = {schema: 'fsusblog.quiescence-inventory.v1',
        stateDomainCatalogDigest: quiescenceDigest(catalog), registryDigest: quiescenceDigest(registry),
        boundedQueueCatalogDigest: boundedCatalog.digest, observerSchemaDigest: quiescenceDigest(schema),
        managedWorkerSources: registry.quiescence.managedWorkerSources, contracts};
    return {...payload, contentDigest: quiescenceDigest(payload)};
}

export function validateQuiescenceInventory(inventory, authorities)
{
    const expected = deriveQuiescenceInventory(authorities);
    if (JSON.stringify(canonicalQuiescence(inventory)) !== JSON.stringify(canonicalQuiescence(expected)))
    {
        throw new Error('quiescence inventory is not bidirectionally exact with its source authorities');
    }
    return inventory;
}

export function inspectQuiescenceObservation(observation, {inventory, expectedIdentity, requiredHighWatermark,
    expectedGeneration, measurementContract = 'foreground-quiescent', schema})
{
    if (measurementContract !== 'foreground-quiescent')
    {
        throw new Error('non-quiescent worker measurement cannot consume a quiescence observation');
    }
    const errors = validateJsonSchema(observation, schema);
    if (errors.length)
    {
        throw new Error(`quiescence observation schema: ${errors.join('; ')}`);
    }
    const {contentDigest, ...payload} = observation;
    if (contentDigest !== quiescenceDigest(payload))
    {
        throw new Error('quiescence observation digest drift');
    }
    const contract = inventory.contracts.find((entry) => entry.domainId === observation.domainId);
    if (!contract)
    {
        throw new Error('quiescence observer domain is orphaned');
    }
    if (observation.observerIdentity.api !== contract.observerApi ||
        observation.observerIdentity.schemaDigest !== inventory.observerSchemaDigest)
    {
        throw new Error('quiescence observer API/schema drift');
    }
    const blockers = [];
    for (const field of ['runId', 'namespace', 'candidateIdentityDigest', 'runtimeIdentityDigest'])
    {
        if (!expectedIdentity?.[field] || observation[field] !== expectedIdentity[field])
        {
            blockers.push(`${field}:unknown-or-mismatch`);
        }
    }
    if (observation.stateDomainCatalogDigest !== inventory.stateDomainCatalogDigest ||
        observation.inventoryDigest !== inventory.contentDigest)
    {
        blockers.push('catalog/inventory:drift');
    }
    if (!requiredHighWatermark || observation.highWatermark !== requiredHighWatermark ||
        !expectedGeneration || observation.observedGeneration !== expectedGeneration)
    {
        blockers.push('high-watermark/generation:unknown-or-drift');
    }
    if (!expectedIdentity?.observerIdentity?.incarnation ||
        observation.observerIdentity.incarnation !== expectedIdentity.observerIdentity.incarnation ||
        observation.observerIdentity.sourceDigest !== expectedIdentity.observerIdentity.sourceDigest)
    {
        blockers.push('observer-incarnation/source:unknown-or-drift');
    }
    const identityBlockers = [...blockers];
    for (const field of ['pendingCount', 'inFlightCount', 'activeMutationTransactionCount',
        'unacknowledgedInvalidationCount', 'terminalFailureCount'])
    {
        if (observation[field] !== 0)
        {
            blockers.push(`${field}:${observation[field] ?? 'unknown'}`);
        }
    }
    if (!Array.isArray(observation.activeClaims) || observation.activeClaims.length)
    {
        blockers.push('activeClaims:unknown-or-active');
    }
    if (observation.commitPostcondition !== 'verified')
    {
        blockers.push('commitPostcondition:not-verified');
    }
    if (observation.status !== 'quiescent')
    {
        blockers.push(`status:${observation.status}`);
    }
    return {observation, identityBlockers, activityBlockers: blockers.slice(identityBlockers.length), blockers};
}

export function validateQuiescenceObservation(observation, options)
{
    const inspection = inspectQuiescenceObservation(observation, options);
    if (inspection.blockers.length)
    {
        throw new Error(`quiescence observation refused: ${inspection.blockers.join('; ')}`);
    }
    return observation;
}

export function classifyManagedMutationTransactions(transactions, {namespace, workerOwners})
{
    if (!namespace || !Array.isArray(transactions) || !(workerOwners instanceof Set))
    {
        throw new Error('mutation transaction inventory is unavailable');
    }
    return transactions.filter((entry) =>
    {
        if (!entry || !['idle', 'active'].includes(entry.status))
        {
            throw new Error('mutation transaction identity/status is unknown');
        }
        if (entry.status === 'idle')
        {
            return false;
        }
        if (typeof entry.namespace !== 'string')
        {
            throw new Error('active transaction namespace is unknown');
        }
        if (entry.namespace !== namespace)
        {
            return false;
        }
        if (typeof entry.mutation !== 'boolean' || typeof entry.owner !== 'string')
        {
            throw new Error('active transaction ownership/mutation state is unknown');
        }
        return entry.mutation && workerOwners.has(entry.owner);
    });
}

export function quiescenceSourceGates(repositoryRoot = root)
{
    const authorities = loadQuiescenceAuthorities(repositoryRoot);
    const errors = validateBoundedChannelCatalog(path.join(repositoryRoot, authorities.registry.quiescence.boundedQueueCatalog));
    errors.push(...validateQuiescenceWorkerRegistration(authorities.registry, discoverQuiescenceWorkerSources(repositoryRoot)));
    const inventory = deriveQuiescenceInventory(authorities);
    return {inventory, errors, runtimeQualification: 'not-run'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const result = quiescenceSourceGates();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.errors.length)
        {
            process.exitCode = 1;
        }
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
