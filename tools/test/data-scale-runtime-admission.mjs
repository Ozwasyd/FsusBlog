import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { productionCapacityReservationSchema } = await import(new URL('../test-matrix/production-capacity-reservation.mjs', import.meta.url));
const { productionDiskDemandDigest, producerRemainingDiskDemand } = await import(new URL('../test-matrix/production-disk-demand.mjs', import.meta.url));
const { canonicalRepositoryIdentity } = await import(new URL('../test-matrix/production-fresh-orphan-runtime-discovery.mjs', import.meta.url));
const {
    createPortLeaseAllocator, defaultRoleCatalog, writePortLeaseTerminalReceipt
} = await import(new URL('../test-matrix/production-fresh-port-lease.mjs', import.meta.url));
const { dockerResourceArguments } = await import(new URL('../test-matrix/production-resource-enforcement.mjs', import.meta.url));
const {
    bindResidentLeaseEnforcement, createResidentLeaseInventory, finalizeResidentLeaseCleanup,
    residentEnforcementScopeLimits, residentLeaseDigest, writeResidentLeaseDocument
} = await import(new URL('../test-matrix/resident-resource-leases.mjs', import.meta.url));

const roles = Object.freeze(['postgres', 'redis', 'debug-backend']);
const bytesPerGiB = 1024 ** 3;

function requiredText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value;
}

function checkedGrant(value, label)
{
    const grant = { cpuUnits: Number(value?.cpuUnits), memoryGiB: Number(value?.memoryGiB) };
    if (!Number.isFinite(grant.cpuUnits) || grant.cpuUnits <= 0
    || !Number.isFinite(grant.memoryGiB) || grant.memoryGiB <= 0)
    {
        throw new Error(`${label} requires positive CPU and memory grants`);
    }
    return grant;
}

function sourceFingerprint(value)
{
    if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(String(value ?? '')))
    {
        throw new Error('DataScale native container source fingerprint is invalid');
    }
    return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function checkedNativeLimits(value)
{
    const fields = ['cpuUnits', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax'];
    if (!value || fields.some((field) => !Number.isFinite(value[field]) || value[field] <= 0)
    || !Number.isInteger(value.cpuUnits * 1000) || value.cpuUnits * 1000 < 3
    || !Number.isSafeInteger(value.memoryHighBytes) || value.memoryHighBytes % 4096 !== 0
    || !Number.isSafeInteger(value.memoryMaxBytes) || value.memoryMaxBytes % 4096 !== 0
    || value.memoryHighBytes > value.memoryMaxBytes
    || Math.floor(value.memoryHighBytes / 3 / 4096) * 4096 < 16 * 1024 ** 2
    || !Number.isSafeInteger(value.pidsMax) || value.pidsMax < 3)
    {
        throw new Error('DataScale native container grant requires bounded CPU, page-aligned memory and PID limits');
    }
    return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function nativeCpuUnits(value)
{
    const nanos = Math.floor(value * 1e9);
    const units = nanos / 1e9;
    if (!Number.isSafeInteger(nanos) || nanos < 1 || !Number.isInteger(units * 1e9))
    {
        throw new Error('DataScale role CPU grant cannot be represented by exact OCI nanocpus');
    }
    return { units, nanos };
}

// This API accepts the scheduler's live capabilities, never serialized substitutes.
// The scheduler retains ownership of its shared capacity reservation and checkpoint.
export async function createDataScaleRuntimeAdmission({
    repositoryRoot, plan, productionCapacityReservation, productionCapacityPlan,
    capacityProducerId, candidateIdentityDigest, resourceGrant, schedulerResourceGrant,
    ownerBundleId, checkpointAuthority, checkpointFile, nativeContainerReservation,
    nativeContainerContext, execute = spawnSync
})
{
    const repository = canonicalRepositoryIdentity(repositoryRoot);
    const root = repository.canonicalRepositoryRoot;
    for (const key of ['parentSchedulerRunId', 'namespace', 'dataScaleRunId', 'invocationId', 'attemptId'])
    {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(String(plan?.[key] ?? '')))
        {
            throw new Error(`DataScale admission plan.${key} is invalid`);
        }
    }
    if (!/^[a-f0-9]{40}$/u.test(plan.sourceCommit ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(plan.worktreeFingerprint ?? ''))
    {
        throw new Error('DataScale admission requires the exact source state');
    }
    requiredText(ownerBundleId, 'ownerBundleId');
    requiredText(checkpointFile, 'checkpointFile');
    requiredText(capacityProducerId, 'capacityProducerId');
    if (typeof nativeContainerReservation?.assertHeld !== 'function')
    {
        throw new Error('DataScale admission requires the live native container reservation capability');
    }
    if (nativeContainerContext?.root !== root || nativeContainerContext.runId !== plan.parentSchedulerRunId
    || nativeContainerContext.bundleId !== ownerBundleId || nativeContainerContext.stepId !== capacityProducerId
    || !String(nativeContainerContext.namespace ?? '').trim()
    || nativeContainerContext.sourceState?.commit !== plan.sourceCommit
    || sourceFingerprint(nativeContainerContext.sourceState?.worktreeFingerprint) !== sourceFingerprint(plan.worktreeFingerprint))
    {
        throw new Error('DataScale admission native container original scheduler context mismatch');
    }
    const originalNativeContext = structuredClone(nativeContainerContext);
    const originalNativeIdentity = Object.fromEntries(['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState']
        .map((key) => [key, originalNativeContext[key]]));
    let nativeLimits = null;
    let nativeReservationId = null;
    let retainedCleanupCustody = null;
    function checkedNativeReceipt(held)
    {
        const limits = checkedNativeLimits(held?.reservation?.limits);
        if (held?.runId !== originalNativeContext.runId || held.bundleId !== originalNativeContext.bundleId
        || typeof held.reservation.id !== 'string' || !held.reservation.id
        || (nativeReservationId !== null && held.reservation.id !== nativeReservationId)
        || productionDiskDemandDigest(held.reservation.identity) !== productionDiskDemandDigest(originalNativeIdentity)
        || productionDiskDemandDigest(limits) !== productionDiskDemandDigest(originalNativeContext.resourceGrant)
        || (nativeLimits !== null && productionDiskDemandDigest(limits) !== productionDiskDemandDigest(nativeLimits)))
        {
            throw new Error('DataScale admission held native container grant/context drift');
        }
        nativeReservationId ??= held.reservation.id;
        return limits;
    }
    function assertNativeHeld()
    {
        if (retainedCleanupCustody !== null)
        {
            throw new Error('DataScale admission is retained for cleanup only; provisioning is closed');
        }
        return checkedNativeReceipt(nativeContainerReservation.assertHeld(originalNativeContext));
    }
    function assertCleanupHeld()
    {
        return retainedCleanupCustody === null ? assertNativeHeld()
            : checkedNativeReceipt(retainedCleanupCustody.assertRetained());
    }
    function activateRetainedCleanup(capability)
    {
        if (typeof nativeContainerReservation.retainCleanupCustody !== 'function'
        || typeof capability?.assertRetained !== 'function'
        || capability !== nativeContainerReservation.retainCleanupCustody(originalNativeContext))
        {
            throw new Error('DataScale cleanup requires its original opaque native custody capability');
        }
        checkedNativeReceipt(capability.assertRetained());
        retainedCleanupCustody = capability;
    }
    nativeLimits = assertNativeHeld();
    if (typeof checkpointAuthority !== 'function')
    {
        throw new Error('DataScale admission requires scheduler checkpoint authority');
    }
    const capacity = productionCapacityReservation;
    for (const method of ['assertPlan', 'heartbeat'])
    {
        if (typeof capacity?.[method] !== 'function')
        {
            throw new Error(`DataScale admission requires live capacity capability ${method}`);
        }
    }
    const grant = checkedGrant(resourceGrant, 'resourceGrant');
    const schedulerGrant = checkedGrant(schedulerResourceGrant, 'schedulerResourceGrant');
    if (grant.cpuUnits > schedulerGrant.cpuUnits || grant.memoryGiB > schedulerGrant.memoryGiB)
    {
        throw new Error('DataScale admission step grant exceeds scheduler grant');
    }
    if (grant.cpuUnits !== schedulerGrant.cpuUnits || grant.memoryGiB !== schedulerGrant.memoryGiB)
    {
        // The current resident owner allocates elastic limits across its whole
        // resourceBudget. Until a scheduler supplies a dedicated subgrant, using
        // a larger parent budget here would exceed this step's admitted envelope.
        throw new Error('DataScale resident owner requires a dedicated scheduler grant equal to the step grant');
    }
    if (grant.cpuUnits !== nativeLimits.cpuUnits || grant.memoryGiB * bytesPerGiB !== nativeLimits.memoryHighBytes
    || nativeLimits.memoryMaxBytes !== nativeLimits.memoryHighBytes)
    {
        throw new Error('DataScale admission resource grant must match the held native CPU/memory envelope');
    }
    const receipt = capacity.receipt;
    if (receipt?.schema !== productionCapacityReservationSchema || receipt.state !== 'active'
    || receipt.runId !== plan.parentSchedulerRunId
    || receipt.repositoryIdentity !== productionDiskDemandDigest(root)
    || !/^sha256:[a-f0-9]{64}$/u.test(candidateIdentityDigest ?? '')
    || receipt.candidateIdentityDigest !== candidateIdentityDigest
    || receipt.planDigest !== productionCapacityPlan?.planDigest
    || receipt.producerDeclarationDigest !== productionCapacityPlan?.producerDeclarationDigest)
    {
        throw new Error('DataScale admission capacity run/repository/candidate/plan binding mismatch');
    }
    producerRemainingDiskDemand(productionCapacityPlan, capacityProducerId);
    capacity.assertPlan(productionCapacityPlan);
    capacity.heartbeat();
    assertNativeHeld();

    const directory = path.join(root, '.tmp', 'data-scale-admissions', plan.dataScaleRunId);
    // Reject symlink ancestry before creating task-owned evidence.
    let ancestor = root;
    for (const part of path.relative(root, directory).split(path.sep))
    {
        ancestor = path.join(ancestor, part);
        if (fs.existsSync(ancestor) && (fs.lstatSync(ancestor).isSymbolicLink()
        || !fs.lstatSync(ancestor).isDirectory()))
        {
            throw new Error('DataScale admission evidence ancestry is unsafe');
        }
    }
    if (fs.existsSync(directory))
    {
        throw new Error('DataScale admission already exists; retain the live capability for retry');
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manifestFile = path.join(directory, 'port-leases.json');
    const terminalReceiptFile = path.join(directory, 'port-terminal.json');
    const inventoryFile = path.join(directory, 'resident-leases.json');
    const allocator = createPortLeaseAllocator({
        runId: plan.parentSchedulerRunId, namespace: plan.namespace,
        roles: defaultRoleCatalog().filter((role) => roles.includes(role.role))
    });
    assertNativeHeld();
    await allocator.allocate();
    const containers = new Map();
    let inventory = null;
    let terminal = null;

    function command(program, args, assertAuthority = assertNativeHeld)
    {
        assertAuthority();
        capacity.assertPlan(productionCapacityPlan);
        capacity.heartbeat();
        const result = execute(program, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 ** 2 });
        if (result.error || result.status !== 0)
        {
            throw new Error(`DataScale admission ${program} observation/control failed: ${result.error?.code ?? result.status}`);
        }
        return String(result.stdout ?? '');
    }

    function persistPorts()
    {
        assertCleanupHeld();
        // The allocator is held by this process's live capability. Do not declare
        // daemon/socket/token paths that this admission does not actually own.
        const payload = {
            schema: 'fsusblog.data-scale-port-admission.v1', controlMode: 'in-process-capability',
            runId: plan.parentSchedulerRunId, namespace: plan.namespace,
            dataScaleRunId: plan.dataScaleRunId, ownerBundleId,
            sourceState: { commit: plan.sourceCommit, worktreeFingerprint: plan.worktreeFingerprint },
            reservationOwnerIdentity: allocator.reservationOwnerIdentity,
            observedAt: new Date().toISOString(), terminalReceiptPath: terminalReceiptFile,
            leases: allocator.snapshot()
        };
        const manifest = { ...payload, contentDigest: productionDiskDemandDigest(payload) };
        fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        return manifest;
    }

    function port(role)
    {
        const lease = allocator.snapshot().find((item) => item.role === role);
        if (!lease)
        {
            throw new Error(`DataScale admission unknown port role: ${role}`);
        }
        return lease.port;
    }

    function labelValues(role)
    {
        if (role !== undefined && ![...roles, 'helper', 'permission-helper', 'network', 'volume'].includes(role))
        {
            throw new Error(`DataScale admission unknown custody role: ${role}`);
        }
        return {
            'io.fsusblog.test.run-id': plan.parentSchedulerRunId,
            'io.fsusblog.test.namespace': plan.namespace,
            'io.fsusblog.test.invocation-id': plan.invocationId,
            'io.fsusblog.test.attempt-id': plan.attemptId,
            'io.fsusblog.test.data-scale-run-id': plan.dataScaleRunId,
            'io.fsusblog.test.bundle-id': ownerBundleId,
            'io.fsusblog.test.step-id': capacityProducerId,
            'io.fsusblog.test.preparation-id': plan.dataScaleRunId,
            'io.fsusblog.test.repository-root-digest': repository.repositoryRootDigest,
            'io.fsusblog.test.source-commit': plan.sourceCommit,
            'io.fsusblog.test.source-fingerprint': plan.worktreeFingerprint,
            'io.fsusblog.test.resource-grant-digest': residentLeaseDigest(grant),
            ...(role === undefined ? {} : { 'io.fsusblog.test.runtime-role': role })
        };
    }

    function labels(role)
    {
        assertNativeHeld();
        return Object.entries(labelValues(role)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    }

    function owns(document)
    {
        const actual = document?.Config?.Labels ?? document?.Labels ?? {};
        return Object.entries(labelValues()).every(([key, value]) => actual[key] === value);
    }

    function inspect(role, containerId)
    {
        if (!/^[a-f0-9]{64}$/u.test(containerId ?? ''))
        {
            throw new Error('DataScale requires a full OCI container identity');
        }
        const document = JSON.parse(command('docker', ['inspect', containerId]))?.[0];
        if (document?.Id !== containerId || !Number.isFinite(Date.parse(document.Created))
        || document.State?.Running !== true)
        {
            throw new Error('DataScale resident container identity/liveness mismatch');
        }
        for (const [key, expected] of Object.entries(labelValues(role)))
        {
            if (document.Config?.Labels?.[key] !== expected)
            {
                throw new Error(`DataScale container custody mismatch: ${key}`);
            }
        }
        const containerPort = role === 'postgres' ? 5432 : role === 'redis' ? 6379 : 8080;
        const mappings = document.NetworkSettings?.Ports?.[`${containerPort}/tcp`] ?? [];
        if (!mappings.some((mapping) => mapping.HostIp === '127.0.0.1' && Number(mapping.HostPort) === port(role)))
        {
            throw new Error('DataScale container does not own its exact leased loopback port');
        }
        return document;
    }

    function initialLimits(role)
    {
        assertNativeHeld();
        if (![...roles, 'helper'].includes(role))
        {
            throw new Error(`DataScale admission unknown resource role: ${role}`);
        }
        return {
            cpuUnits: nativeCpuUnits(Math.floor(nativeLimits.cpuUnits * 1e9 / 3) / 1e9).units,
            memoryGiB: Math.floor(nativeLimits.memoryMaxBytes / 3 / 4096) * 4096 / bytesPerGiB,
            memoryHighBytes: Math.floor(nativeLimits.memoryHighBytes / 3 / 4096) * 4096,
            pidsMax: Math.floor(nativeLimits.pidsMax / 3)
        };
    }

    function dockerArguments(role)
    {
        const limit = initialLimits(role);
        return dockerResourceArguments({
            FSUSBLOG_DOCKER_CPU_UNITS: limit.cpuUnits,
            FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: limit.memoryHighBytes,
            FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: Math.round(limit.memoryGiB * bytesPerGiB),
            FSUSBLOG_DOCKER_PIDS_MAX: limit.pidsMax,
            FSUSBLOG_TEST_RUN_ID: plan.parentSchedulerRunId,
            FSUSBLOG_PHYSICAL_BUNDLE_ID: ownerBundleId,
            FSUSBLOG_STEP_ID: capacityProducerId
        });
    }

    function observeService(service)
    {
        try
        {
            // A failed Docker inspect is not evidence of absence. Query the complete
            // container inventory successfully before accepting a removed identity.
            const ids = command('docker', ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'], assertCleanupHeld)
                .split('\n').map((value) => value.trim()).filter(Boolean);
            if (!ids.includes(service.identity.containerId))
            {
                return { status: 'exited', reason: 'exact-OCI-identity-absent' };
            }
            const document = JSON.parse(command('docker', ['inspect', service.identity.containerId], assertCleanupHeld))?.[0];
            if (document?.Id !== service.identity.containerId || document.Created !== service.identity.createdAt)
            {
                return { status: 'identity-changed' };
            }
            return { status: 'live', reason: document.State?.Running ? 'container-running' : 'container-retained-stopped' };
        }
        catch (error)
        {
            return { status: 'unknown', reason: error.message };
        }
    }

    try
    {
        persistPorts();
    }
    catch (error)
    {
        await allocator.releaseAll('manifest-failed');
        throw error;
    }

    return {
        port, labels, owns, dockerArguments, limits: initialLimits,
        assertHeld: assertNativeHeld, assertCleanupHeld, activateRetainedCleanup,
        manifestFile, inventoryFile, terminalReceiptFile,
        async beginHandoff(role)
        {
            assertNativeHeld();
            if (terminal)
            {
                throw new Error('DataScale admission is terminal');
            }
            capacity.heartbeat();
            const lease = await allocator.beginHandoff(role);
            persistPorts();
            return lease;
        },
        async completeHandoff(role, containerId)
        {
            assertNativeHeld();
            if (allocator.snapshot().find((lease) => lease.role === role)?.handoffState !== 'handing-off')
            {
                throw new Error('DataScale container handoff must begin before binding');
            }
            const document = inspect(role, containerId);
            const lease = await allocator.completeHandoff(role, `container:${containerId}`);
            containers.set(role, { containerId, createdAt: document.Created });
            persistPorts();
            return lease;
        },
        async publishResident({ services })
        {
            assertNativeHeld();
            if (inventory)
            {
                throw new Error('DataScale resident inventory is already published');
            }
            if (!Array.isArray(services) || services.length !== roles.length
            || new Set(services.map((service) => service.role)).size !== roles.length
            || !roles.every((role) => services.some((service) => service.role === role)))
            {
                throw new Error('DataScale resident inventory requires the exact three-service roster');
            }
            const observed = services.map((service) =>
            {
                const owned = containers.get(service.role);
                if (owned?.containerId !== service.containerId)
                {
                    throw new Error('DataScale resident service lacks a completed port handoff');
                }
                const document = inspect(service.role, service.containerId);
                const stats = JSON.parse(command('docker', ['stats', '--no-stream', '--format', '{{json .}}', service.containerId]).trim());
                const memory = /^([\d.]+)([KMGT]?i?B)\s*\//u.exec(String(stats.MemUsage ?? ''));
                if (!memory)
                {
                    throw new Error('DataScale resident RSS observation is unavailable');
                }
                const scale = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: bytesPerGiB, TB: 1e12, TiB: 1024 ** 4 }[memory[2]];
                if (!scale)
                {
                    throw new Error('DataScale resident RSS unit is unsupported');
                }
                return { id: service.role, kind: 'container', identity: { containerId: document.Id, createdAt: document.Created },
                    port: port(service.role), generation: residentLeaseDigest({ id: document.Id, createdAt: document.Created }),
                    health: service.health, observedRssBytes: Number(memory[1]) * scale };
            });
            const next = createResidentLeaseInventory({ runId: plan.parentSchedulerRunId, namespace: plan.namespace,
                ownerBundleId, sourceState: { commit: plan.sourceCommit, worktreeFingerprint: plan.worktreeFingerprint },
                resourceGrant: grant, schedulerResourceGrant: schedulerGrant, resourceBudget: grant, services: observed });
            const limits = residentEnforcementScopeLimits(next).containers;
            if (Object.values(limits).reduce((sum, limit) => sum + Math.round(limit.memoryGiB * bytesPerGiB), 0) > nativeLimits.memoryMaxBytes
            || Object.values(limits).reduce((sum, limit) => sum + limit.cpuUnits, 0) > nativeLimits.cpuUnits + 1e-9)
            {
                throw new Error('DataScale resident hard limits exceed the held aggregate native grant');
            }
            const evidence = {};
            for (const service of next.services)
            {
                const limit = limits[service.id];
                const roleCpu = nativeCpuUnits(limit.cpuUnits);
                const high = Math.round(service.reservation.memoryGiB * bytesPerGiB);
                const max = Math.round(limit.memoryGiB * bytesPerGiB);
                command('docker', ['update', '--cpus', String(roleCpu.units), '--memory-reservation', String(high),
                    '--memory', String(max), '--memory-swap', String(max), service.identity.containerId]);
                const document = inspect(service.id, service.identity.containerId);
                const config = document.HostConfig ?? {};
                const cpu = Number(config.NanoCpus) / 1e9;
                if (config.NanoCpus !== roleCpu.nanos || config.MemoryReservation !== high || config.Memory !== max)
                {
                    throw new Error('DataScale observed OCI limits do not match the resident grant');
                }
                evidence[service.id] = { containerId: service.identity.containerId, status: 'enforced',
                    reservation: service.reservation, limit, observed: { cpuUnits: cpu, memoryHighBytes: config.MemoryReservation, memoryMaxBytes: config.Memory } };
            }
            const bound = bindResidentLeaseEnforcement(next, { mode: 'enforced', containers: evidence, boundAt: new Date().toISOString() });
            writeResidentLeaseDocument(inventoryFile, bound);
            assertNativeHeld();
            await checkpointAuthority(checkpointFile, (checkpoint) =>
            {
                if (checkpoint.runId !== plan.parentSchedulerRunId)
                {
                    throw new Error('DataScale checkpoint belongs to another run');
                }
                if (checkpoint.residentResourceLeases && checkpoint.residentResourceLeases.status !== 'not-acquired')
                {
                    throw new Error('DataScale must not replace another resident lease inventory');
                }
                checkpoint.residentResourceLeases = { status: 'acquired', inventoryFile: path.relative(root, inventoryFile),
                    services: {}, events: [], reservation: bound.reservation };
                return checkpoint;
            });
            inventory = bound;
            return inventory;
        },
        async release({ cleanup })
        {
            assertCleanupHeld();
            if (terminal)
            {
                return terminal;
            }
            const failures = [];
            const leaseObservations = [];
            if (cleanup?.status !== 'complete')
            {
                return { status: 'blocked', failures: ['DataScale resource cleanup is incomplete'], leaseObservations };
            }
            for (const [role, identity] of containers)
            {
                const observation = observeService({ identity });
                if (observation.status !== 'exited')
                {
                    failures.push(`DataScale ${role} retained: ${observation.status}`);
                }
            }
            for (const lease of allocator.snapshot())
            {
                if (lease.handoffState !== 'reserved')
                {
                    try
                    {
                        if (command('ss', ['-H', '-ltn', `( sport = :${lease.port} )`], assertCleanupHeld).trim())
                        {
                            failures.push(`DataScale port ${lease.port} retains a listener`);
                        }
                    }
                    catch (error)
                    {
                        failures.push(error.message);
                    }
                }
            }
            if (failures.length)
            {
                return { status: 'blocked', failures, leaseObservations };
            }
            if (inventory)
            {
                const ownCheckpointAuthority = (file, update) => checkpointAuthority(file, (checkpoint) =>
                {
                    if (checkpoint.runId !== plan.parentSchedulerRunId
                    || checkpoint.residentResourceLeases?.inventoryFile !== path.relative(root, inventoryFile)
                    || JSON.parse(fs.readFileSync(inventoryFile, 'utf8')).digest !== inventory.digest)
                    {
                        throw new Error('DataScale resident cleanup checkpoint/inventory binding drift');
                    }
                    return update(checkpoint);
                });
                const checkpoint = await finalizeResidentLeaseCleanup({ root, checkpointFile, checkpointAuthority: ownCheckpointAuthority,
                    cleanup, observeService, timeoutMs: 0 });
                if (checkpoint.residentResourceLeases?.status !== 'released')
                {
                    return { status: 'blocked', failures: ['DataScale resident release was not confirmed by scheduler authority'], leaseObservations };
                }
                leaseObservations.push({ id: inventory.generation, postStatus: 'released', receiptFile: checkpointFile, role: 'resident' });
            }
            await allocator.releaseAll('owned-resources-observed-absent');
            const manifest = persistPorts();
            writePortLeaseTerminalReceipt({ terminalReceiptPath: terminalReceiptFile, runId: plan.parentSchedulerRunId,
                namespace: plan.namespace, reservationOwnerIdentity: allocator.reservationOwnerIdentity,
                terminalState: 'released', reason: 'owned-OCI-identities-and-port-listeners-observed-absent',
                manifestDigest: manifest.contentDigest, leases: allocator.snapshot() });
            const portTerminal = JSON.parse(fs.readFileSync(terminalReceiptFile, 'utf8'));
            if (portTerminal.terminalState !== 'released')
            {
                throw new Error('DataScale port terminal receipt was not released');
            }
            for (const lease of allocator.snapshot())
            {
                leaseObservations.push({ id: lease.portLeaseId, role: lease.role, postStatus: portTerminal.terminalState,
                    receiptFile: terminalReceiptFile });
            }
            terminal = { status: 'complete', failures, leaseObservations };
            return terminal;
        }
    };
}
