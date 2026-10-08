import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {canonicalQuiescence, classifyManagedMutationTransactions, deriveQuiescenceInventory,
    discoverQuiescenceWorkerSources, loadQuiescenceAuthorities, quiescenceDigest,
    validateQuiescenceInventory, validateQuiescenceObservation, validateQuiescenceWorkerRegistration} =
    await import(new URL('../../tools/test-matrix/quiescence-contract.mjs', import.meta.url));
const {deliveryCatalogDigest} = await import(new URL('../../tools/governance/bounded-channel-contracts.mjs', import.meta.url));
const authorities = loadQuiescenceAuthorities();
const inventory = deriveQuiescenceInventory(authorities);
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const expectedIdentity = {runId: 'model-run', namespace: 'model-namespace',
    candidateIdentityDigest: digest('a'), runtimeIdentityDigest: digest('b'),
    observerIdentity: {incarnation: 'model-worker-epoch', sourceDigest: digest('c')}};

function modelObservation()
{
    const payload = {schema: 'fsusblog.quiescence-domain-observation.v1', domainId: 'comment-mutation-outbox',
        ...expectedIdentity, stateDomainCatalogDigest: inventory.stateDomainCatalogDigest,
        inventoryDigest: inventory.contentDigest, highWatermark: 'model-event:7', observedGeneration: 'model-generation:3',
        pendingCount: 0, inFlightCount: 0, activeClaims: [], activeMutationTransactionCount: 0,
        unacknowledgedInvalidationCount: 0, terminalFailureCount: 0, commitPostcondition: 'verified', status: 'quiescent',
        evidenceDigest: digest('d'), observerIdentity: {...expectedIdentity.observerIdentity,
            api: inventory.contracts.find((entry) => entry.domainId === 'comment-mutation-outbox').observerApi,
            version: 'v1', schemaDigest: inventory.observerSchemaDigest}};
    return {...payload, contentDigest: quiescenceDigest(payload)};
}

const options = {inventory, expectedIdentity, requiredHighWatermark: 'model-event:7',
    expectedGeneration: 'model-generation:3', schema: authorities.schema};
const seal = (value) =>
{
    const payload = {...value};
    delete payload.contentDigest;
    return {...payload, contentDigest: quiescenceDigest(payload)};
};

test('source inventory derives all registered background contracts and every actual bounded participant', () =>
{
    assert.equal(inventory.contracts.length, authorities.registry.quiescence.contracts.length + authorities.boundedCatalog.queues.filter((q) => q.drainParticipant).length);
    assert.deepEqual(inventory.contracts.filter((entry) => entry.queueId).map((entry) => entry.queueId).sort(),
        authorities.boundedCatalog.queues.filter((q) => q.drainParticipant).map((q) => q.queueId).sort());
    assert.equal(validateQuiescenceInventory(inventory, authorities), inventory);
    assert.ok(inventory.contracts.find((entry) => entry.domainId === 'scheduled-publication'));
    assert.equal(inventory.boundedQueueCatalogDigest, authorities.boundedCatalog.digest);
});

test('missing, orphaned, duplicate, altered and stale inventories cannot replace derivation', () =>
{
    for (const mutate of [
        (copy) => copy.contracts.pop(),
        (copy) => copy.contracts.push(copy.contracts[0]),
        (copy) =>
        {
            copy.contracts[0].domainId = 'orphan-domain';
        },
        (copy) =>
        {
            copy.registryDigest = digest('e');
        },
        (copy) =>
        {
            copy.observerSchemaDigest = digest('f');
        },
        (copy) =>
        {
            copy.contracts[0].commitPostcondition = 'queue-empty';
        }
    ])
    {
        const copy = structuredClone(inventory);
        mutate(copy);
        assert.throws(() => validateQuiescenceInventory(copy, authorities), /bidirectionally exact/u);
    }
});

test('registration refuses missing observer, watermark, generation, failure policy, proof and unknown domains', () =>
{
    for (const field of ['observerApi', 'highWatermarkSource', 'generationSource', 'qualificationImpact', 'proofTests'])
    {
        const copy = structuredClone(authorities);
        delete copy.registry.quiescence.contracts[0][field];
        assert.throws(() => deriveQuiescenceInventory(copy));
    }
    for (const domain of ['*', 'postgres.undeclared'])
    {
        const copy = structuredClone(authorities);
        copy.registry.quiescence.contracts[0].stateDomains = [domain];
        assert.throws(() => deriveQuiescenceInventory(copy), /orphan\/wildcard/u);
    }
    const duplicate = structuredClone(authorities);
    duplicate.registry.quiescence.contracts.push(duplicate.registry.quiescence.contracts[0]);
    assert.throws(() => deriveQuiescenceInventory(duplicate), /duplicate domains/u);
});

test('new canonical queue enters inventory automatically; malformed observer and catalog/schema drift fail', () =>
{
    const copy = structuredClone(authorities);
    const queue = structuredClone(copy.boundedCatalog.queues[0]);
    queue.queueId = 'new-mutation-queue';
    copy.boundedCatalog.queues.push(queue);
    copy.boundedCatalog.digest = deliveryCatalogDigest(copy.boundedCatalog.queues);
    assert.ok(deriveQuiescenceInventory(copy).contracts.some((entry) => entry.domainId === 'bounded-queue.new-mutation-queue'));
    delete queue.participantAdapter;
    copy.boundedCatalog.digest = deliveryCatalogDigest(copy.boundedCatalog.queues);
    assert.throws(() => deriveQuiescenceInventory(copy), /complete authoritative adapter/u);
    const stale = structuredClone(authorities);
    stale.boundedCatalog.digest = digest('a');
    assert.throws(() => deriveQuiescenceInventory(stale), /catalog digest drift/u);
    stale.boundedCatalog = authorities.boundedCatalog;
    stale.schema.$id += '.unsupported';
    assert.throws(() => deriveQuiescenceInventory(stale), /schema drift/u);
});

test('actual new BackgroundService source requires matrix registration without worker-name state guessing', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-quiescence-discovery-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    fs.mkdirSync(path.join(directory, 'src/backend'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'src/backend/Unknown.cs'), 'public sealed class UnexpectedActor(IService service) : BackgroundService { }');
    const observed = discoverQuiescenceWorkerSources(directory);
    assert.deepEqual(observed, ['src/backend/Unknown.cs#UnexpectedActor']);
    assert.equal(validateQuiescenceWorkerRegistration(authorities.registry, observed).length, 1);
    assert.equal(validateQuiescenceWorkerRegistration(authorities.registry, discoverQuiescenceWorkerSources()).length, 0);
});

test('derived workers and non-first hosted interfaces are registered; comments and strings are not workers', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-quiescence-inheritance-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    fs.mkdirSync(path.join(directory, 'src/backend'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'src/backend/Actors.cs'), `
        // class CommentActor : BackgroundService { }
        class Holder { string value = "class StringActor : BackgroundService { }"; }
        class DerivedActor : BaseActor { }
        class InterfaceActor : IDisposable, Microsoft.Extensions.Hosting.IHostedService { }
        abstract class BaseActor : BackgroundService { }
    `);
    assert.deepEqual(discoverQuiescenceWorkerSources(directory), [
        'src/backend/Actors.cs#BaseActor', 'src/backend/Actors.cs#DerivedActor', 'src/backend/Actors.cs#InterfaceActor'
    ]);
});

test('complete matching model passes only the pure observation contract, not runtime qualification', () =>
{
    const observation = modelObservation();
    assert.equal(validateQuiescenceObservation(observation, options), observation);
    assert.deepEqual(canonicalQuiescence({b: 2, a: 1}), {a: 1, b: 2});
});

for (const field of ['pendingCount', 'inFlightCount', 'activeMutationTransactionCount', 'unacknowledgedInvalidationCount', 'terminalFailureCount'])
{
    test(`observation refuses missing, unknown and positive ${field} even after resealing`, () =>
    {
        for (const value of [undefined, null, 1, -1])
        {
            const observation = modelObservation();
            if (value === undefined)
            {
                delete observation[field];
            }
            else
            {
                observation[field] = value;
            }
            assert.throws(() => validateQuiescenceObservation(seal(observation), options));
        }
    });
}

test('scope, worker incarnation, schema, catalog, watermark and generation cannot be caller-defaulted', () =>
{
    for (const field of ['runId', 'namespace', 'candidateIdentityDigest', 'runtimeIdentityDigest',
        'highWatermark', 'observedGeneration', 'stateDomainCatalogDigest', 'inventoryDigest'])
    {
        const observation = modelObservation();
        observation[field] = field.endsWith('Digest') ? digest('f') : 'other';
        assert.throws(() => validateQuiescenceObservation(seal(observation), options));
    }
    for (const field of ['incarnation', 'sourceDigest', 'api', 'schemaDigest'])
    {
        const observation = modelObservation();
        observation.observerIdentity[field] = field.endsWith('Digest') ? digest('f') : 'restarted';
        assert.throws(() => validateQuiescenceObservation(seal(observation), options));
    }
    assert.throws(() => validateQuiescenceObservation(modelObservation(), {...options, expectedIdentity: null}));
});

test('claims, unavailable, poison and unknown commit postconditions cannot certify quiescence', () =>
{
    for (const patch of [{activeClaims: null}, {activeClaims: [{namespace: 'model-namespace', owner: 'worker', leaseId: 'active', generation: 'g'}]},
        {status: 'unavailable'}, {status: 'unknown'}, {commitPostcondition: 'unknown'}, {commitPostcondition: 'failed'}])
    {
        assert.throws(() => validateQuiescenceObservation(seal({...modelObservation(), ...patch}), options));
    }
    assert.throws(() => validateQuiescenceObservation(modelObservation(), {...options, measurementContract: 'worker-throughput'}), /cannot consume/u);
    const tamper = modelObservation();
    tamper.pendingCount = 1;
    assert.throws(() => validateQuiescenceObservation(tamper, options), /digest drift/u);
});

test('idle connections are nonblocking; only verified namespace-owned active mutation transactions count', () =>
{
    const records = [{status: 'idle'}, {status: 'active', namespace: 'other', owner: 'worker', mutation: true},
        {status: 'active', namespace: 'current', owner: 'foreground', mutation: true},
        {status: 'active', namespace: 'current', owner: 'worker', mutation: false},
        {status: 'active', namespace: 'current', owner: 'worker', mutation: true}];
    const filter = {namespace: 'current', workerOwners: new Set(['worker'])};
    assert.deepEqual(classifyManagedMutationTransactions(records, filter), [records[4]]);
    assert.throws(() => classifyManagedMutationTransactions([{status: 'active'}], filter), /namespace is unknown/u);
    assert.throws(() => classifyManagedMutationTransactions([{status: 'active', namespace: 'current'}], filter), /ownership\/mutation state/u);
});

test('source inventory digest is stable under source declaration ordering and sensitive to semantics', () =>
{
    const copy = structuredClone(authorities);
    copy.registry.quiescence.contracts.reverse();
    const first = deriveQuiescenceInventory(copy);
    assert.deepEqual(first.contracts, inventory.contracts);
    assert.notEqual(first.registryDigest, inventory.registryDigest, 'exact source identity still binds ordering');
    assert.equal(quiescenceDigest(first.contracts), quiescenceDigest(inventory.contracts));
    copy.registry.quiescence.contracts[0].commitPostcondition += ':changed';
    assert.notEqual(quiescenceDigest(deriveQuiescenceInventory(copy).contracts), quiescenceDigest(inventory.contracts));
});
