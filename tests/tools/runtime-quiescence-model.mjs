// Pure protocol model: these owner facts are unit-test inputs, never runtime receipts.
const {deriveQuiescenceInventory, loadQuiescenceAuthorities, quiescenceDigest} = await import(new URL('../../tools/test-matrix/quiescence-contract.mjs', import.meta.url));

export const authorities = loadQuiescenceAuthorities();
export const inventory = deriveQuiescenceInventory(authorities);
const digest = (letter) => `sha256:${letter.repeat(64)}`;
export const identity = {runId: 'unit-model-run', namespace: 'unit-model-namespace',
    candidateIdentityDigest: digest('a'), runtimeIdentityDigest: digest('b'),
    stateDomainCatalogDigest: inventory.stateDomainCatalogDigest};
export const reseal = (value) =>
{
    const payload = {...value};
    delete payload.contentDigest;
    return {...payload, contentDigest: quiescenceDigest(payload)};
};

export function modelOwner(overrides = {})
{
    const calls = [];
    const model = {active: false, frozen: false, sequence: 0, acceptedClaimCount: 0, rejectedClaimCount: 0, generation: 7, attemptId: null};
    const grant = () => ({status: 'active', identity: structuredClone(identity), leaseId: 'unit-model-lease',
        generation: model.generation, remainingLeaseMs: 5_000,
        admissionFenceStatus: model.frozen ? 'frozen' : 'unfrozen', fenceGeneration: model.generation,
        acceptedClaimCount: model.acceptedClaimCount, rejectedClaimCount: model.rejectedClaimCount});
    const owner = {
        async readIdentity()
        {
            calls.push('readIdentity');
            return structuredClone(identity);
        },
        async acquire(request)
        {
            calls.push('acquire');
            model.active = true;
            model.attemptId = request.attemptId;
            return grant();
        },
        async validate()
        {
            calls.push('validate');
            if (!model.active)
            {
                throw new Error('model lease no longer active');
            }
            return grant();
        },
        async renew()
        {
            calls.push('renew');
            return grant();
        },
        async freeze()
        {
            calls.push('freeze');
            model.frozen = true;
            return {status: 'frozen', identity: structuredClone(identity), leaseId: 'unit-model-lease', generation: model.generation,
                domainIds: inventory.contracts.map((entry) => entry.domainId)};
        },
        async capturePlan()
        {
            calls.push('capturePlan');
            return reseal({schema: 'fsusblog.quiescence-barrier-plan.v1', identity: structuredClone(identity),
                leaseId: 'unit-model-lease', leaseGeneration: model.generation,
                inventoryDigest: inventory.contentDigest, observerSchemaDigest: inventory.observerSchemaDigest,
                domains: inventory.contracts.map((contract) => ({domainId: contract.domainId,
                    highWatermark: `unit-model-watermark:${contract.domainId}:8`, observedGeneration: 'unit-model-generation:3',
                    observerIdentity: {api: contract.observerApi, version: 'v1', incarnation: 'unit-model-incarnation',
                        sourceDigest: digest('c'), schemaDigest: inventory.observerSchemaDigest}}))});
        },
        async readObservations({plan})
        {
            calls.push('readObservations');
            model.sequence += 1;
            return {identity: structuredClone(identity), leaseId: 'unit-model-lease', leaseGeneration: model.generation,
                sequence: model.sequence, domains: plan.domains.map((entry) => reseal({
                    schema: authorities.schema.$id, ...identity, domainId: entry.domainId,
                    highWatermark: entry.highWatermark, observedGeneration: entry.observedGeneration,
                    inventoryDigest: inventory.contentDigest, observerIdentity: structuredClone(entry.observerIdentity),
                    pendingCount: 0, inFlightCount: 0, activeClaims: [], activeMutationTransactionCount: 0,
                    unacknowledgedInvalidationCount: 0, terminalFailureCount: 0, commitPostcondition: 'verified',
                    status: 'quiescent', evidenceDigest: digest('d')
                }))};
        },
        async abortAttempt(request)
        {
            calls.push('abortAttempt');
            return {identity: structuredClone(identity), attemptId: request.attemptId, status: 'settled'};
        },
        async release({lease})
        {
            calls.push('release');
            model.active = false;
            model.frozen = false;
            return {identity: structuredClone(identity), leaseId: lease.leaseId, generation: lease.generation, status: 'released'};
        },
        async postObserve(request)
        {
            calls.push('postObserve');
            return {identity: structuredClone(identity), attemptId: request.attemptId,
                leaseActive: model.active, fenceActive: model.frozen, pendingOperations: 0};
        },
        ...overrides
    };
    return {owner, model, calls, grant};
}

export function memoryJournal()
{
    const events = [];
    return {events, append(event)
    {
        events.push(structuredClone(event));
    }};
}

export function barrierOptions(owner, extras = {})
{
    return {authorities, owner, identity, journal: memoryJournal(), pollIntervalMs: 0,
        stabilityWindowMs: 0, timeoutMs: 5_000, operationTimeoutMs: 100, cleanupTimeoutMs: 100, ...extras};
}
