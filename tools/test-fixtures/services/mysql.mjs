import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { dockerResourceArguments } = await import(new URL('../../test-matrix/production-resource-enforcement.mjs', import.meta.url));
const { snapshotSourceState } = await import(new URL('../../test-matrix/scheduler.mjs', import.meta.url));
const { createAndAdmitServiceEnvelope, loadExecutionServiceCatalog, observeContainerService, observeDockerRuntime, validateExecutionServiceCatalog, verifyLiveServiceEnvelope } = await import(new URL('../../test/execution-envelope-services.mjs', import.meta.url));
const { canonicalJson, digestCanonical, digestReceiptBody, freezeDeep } = await import(new URL('../receipt/canonical.mjs', import.meta.url));
const { readPrivateFile, writePrivateJson } = await import(new URL('../receipt/private-io.mjs', import.meta.url));
const { currentProcessIdentity, processIdentityStatus } = await import(new URL('../../test/process-identity.mjs', import.meta.url));

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sourceFingerprint = (value) => String(value ?? '').replace(/^sha256:/u, '');
const rootSqlCommand = [
    'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --no-defaults --no-login-paths --user=root --protocol=TCP --host=127.0.0.1 --port=3306 --batch --raw --skip-column-names'
];

function validateContext(context)
{
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());
    if (!context || typeof context.root !== 'string'
        || !exact(context, ['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState', 'resourceGrant',
            'startupBudgetMs', 'commandBudgetMs', 'cleanupBudgetMs'])
        || !exact(context.sourceState, ['commit', 'worktreeFingerprint'])
        || !exact(context.resourceGrant, ['cpuUnits', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax'])
        || fs.realpathSync(context.root) !== context.root
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(context.runId ?? '')
        || ['namespace', 'bundleId', 'stepId'].some((key) =>
            typeof context[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(context[key]))
        || !/^[a-f0-9]{40}$/u.test(context.sourceState?.commit ?? '')
        || !/^[a-f0-9]{64}$/u.test(sourceFingerprint(context.sourceState?.worktreeFingerprint)))
    {
        throw new Error('MySQL lifecycle requires an exact repository/run/source/namespace/producer identity');
    }
    for (const key of ['startupBudgetMs', 'commandBudgetMs', 'cleanupBudgetMs'])
    {
        if (!Number.isSafeInteger(context[key]) || context[key] <= 0)
        {
            throw new Error(`MySQL lifecycle requires an explicit positive ${key}`);
        }
    }
    const grant = context.resourceGrant;
    const environment = {
        FSUSBLOG_TEST_RUN_ID: context.runId,
        FSUSBLOG_PHYSICAL_BUNDLE_ID: context.bundleId,
        FSUSBLOG_STEP_ID: context.stepId,
        FSUSBLOG_DOCKER_CPU_UNITS: grant?.cpuUnits,
        FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: grant?.memoryHighBytes,
        FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: grant?.memoryMaxBytes,
        FSUSBLOG_DOCKER_PIDS_MAX: grant?.pidsMax
    };
    const args = dockerResourceArguments(environment);
    if (args.length === 0 || typeof grant.cpuUnits !== 'number' || !Number.isSafeInteger(grant.cpuUnits * 1e9)
        || !Number.isSafeInteger(grant.memoryHighBytes)
        || !Number.isSafeInteger(grant.memoryMaxBytes) || !Number.isSafeInteger(grant.pidsMax))
    {
        throw new Error('MySQL lifecycle cannot use absent, rounded or unbounded resource grants');
    }
    return args;
}

function requireOwnedDirectory(root, directory, exclusive = false)
{
    const relative = path.relative(root, directory);
    if (!relative.startsWith('.tmp/') || relative.split(path.sep).includes('..'))
    {
        throw new Error('MySQL lifecycle files must stay in the repository temporary root');
    }
    let cursor = root;
    for (const segment of relative.split(path.sep))
    {
        cursor = path.join(cursor, segment);
        if (exclusive && (cursor === directory || !fs.existsSync(cursor)))
        {
            fs.mkdirSync(cursor, { mode: 0o700 });
        }
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error('MySQL lifecycle directory cannot be a symlink or special file');
        }
        if (cursor === directory && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
        {
            throw new Error('MySQL lifecycle directory must be private and owned by the current user');
        }
    }
}

function lifecyclePaths(context)
{
    const identityDigest = digest(JSON.stringify({
        runId: context.runId, namespace: context.namespace, bundleId: context.bundleId,
        stepId: context.stepId, source: context.sourceState, root: context.root
    })).slice(7);
    const directory = path.join(context.root, '.tmp/test-runs', context.runId, 'mysql-service', identityDigest);
    return {
        directory, name: `fsus-mysql-${identityDigest.slice(0, 32)}`,
        prefix: `ddl_${identityDigest.slice(0, 20)}_`,
        secretFile: path.join(directory, 'container.env'), clientFile: path.join(directory, 'client.cnf'),
        cidFile: path.join(directory, 'container.id'), stateFile: path.join(directory, 'lifecycle.json')
    };
}

function readLifecycleFile(file, options = {})
{
    const stat = fs.lstatSync(file);
    if (stat.nlink !== 1 || stat.uid !== process.getuid?.())
    {
        throw new Error('MySQL lifecycle file must have one link and the current owner');
    }
    return readPrivateFile(file, options);
}

function lifecycleBinding(state)
{
    return digestCanonical({
        schema: state.schema, qualificationEligible: state.qualificationEligible,
        identity: state.identity, name: state.name, databasePrefix: state.databasePrefix,
        labels: state.labels, imageReference: state.imageReference, imageId: state.imageId,
        controllerIdentity: state.controllerIdentity, runtimeIdentity: state.runtimeIdentity
    });
}

function dockerInvoker(context, docker)
{
    return (args, { input, budgetMs = context.commandBudgetMs, allowFailure = false } = {}) =>
    {
        const result = docker('docker', args, {
            encoding: 'utf8', shell: false, windowsHide: true,
            timeout: budgetMs, maxBuffer: 4 * 1024 * 1024, input
        });
        if (result?.error || result?.status !== 0)
        {
            if (allowFailure)
            {
                return null;
            }
            // SQL/passwords and daemon stderr must not enter a public failure.
            throw new Error(`MySQL lifecycle Docker ${args[0]} failed`);
        }
        return String(result.stdout ?? '').trim();
    };
}

function parseOne(output, label)
{
    const rows = decodeJson(output, label);
    if (!Array.isArray(rows) || rows.length !== 1)
    {
        throw new Error(`MySQL lifecycle ${label} requires exactly one identity`);
    }
    return rows[0];
}

function lifecycleRuntime(invoke, remainingBudget = () => undefined)
{
    return observeDockerRuntime((_command, args) => ({
        status: 0, stdout: invoke(args, { budgetMs: remainingBudget() })
    }));
}

function requireRuntimeIdentity(state, invoke, remainingBudget)
{
    if (canonicalJson(lifecycleRuntime(invoke, remainingBudget)) !== canonicalJson(state.runtimeIdentity))
    {
        throw new Error('MySQL lifecycle Docker runtime identity changed from its retained creation binding');
    }
}

/** One deletion owner shared by preparation failures, normal cleanup and recovery. */
function lifecycleOwner(state, paths, invoke, persistedDigest = null)
{
    const context = state.identity;
    const { directory, stateFile, cidFile, secretFile, clientFile, name } = paths;
    let cleanupPromise;
    const assertJournal = () =>
    {
        requireOwnedDirectory(context.root, directory);
        if (persistedDigest !== null
            && digest(readLifecycleFile(stateFile, { label: 'MySQL lifecycle state' }).bytes) !== persistedDigest)
        {
            throw new Error('MySQL lifecycle private state changed outside its owner');
        }
    };
    const publish = () =>
    {
        assertJournal();
        state.stateDigest = digestReceiptBody(state, 'stateDigest');
        persistedDigest = writePrivateJson(stateFile, state, { label: 'MySQL lifecycle state' }).contentDigest;
    };
    const inspectOwned = (target, budgetMs) =>
    {
        const container = parseOne(invoke(['inspect', target], { budgetMs }), 'container');
        if (!/^[a-f0-9]{64}$/u.test(container.Id ?? '') || container.Id !== target
            || (state.containerId !== null && state.containerId !== container.Id)
            || (state.createdAt !== null && state.createdAt !== container.Created)
            || !Number.isFinite(Date.parse(container.Created ?? ''))
            || container.Config?.Image !== state.imageReference || container.Image !== state.imageId
            || Object.entries(state.labels).some(([key, value]) => container.Config?.Labels?.[key] !== value)
            || container.Config?.Labels?.['io.fsusblog.test.mysql-recovery-binding'] !== state.bindingDigest)
        {
            throw new Error('MySQL lifecycle refuses a container ownership or image mismatch');
        }
        return container;
    };
    const cleanup = () => cleanupPromise ??= (async () =>
    {
        // Cleanup is independent of current source/grants, but never of ownership.
        const deadline = Date.now() + context.cleanupBudgetMs;
        const remainingBudget = () =>
        {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
            {
                throw new Error('MySQL lifecycle exhausted its total cleanup budget');
            }
            return Math.min(context.commandBudgetMs, remaining);
        };
        assertJournal();
        requireRuntimeIdentity(state, invoke, remainingBudget);
        let target = state.containerId;
        if (fs.lstatSync(cidFile, { throwIfNoEntry: false }))
        {
            const cid = readLifecycleFile(cidFile, { expectedModeMask: 0, label: 'MySQL container ID' }).bytes.toString('utf8').trim();
            if (!/^[a-f0-9]{64}$/u.test(cid) || (target !== null && target !== cid))
            {
                throw new Error('MySQL lifecycle cleanup has an invalid creation identity');
            }
            target = cid;
        }
        const filter = target === null ? `name=^/${name}$` : `id=${target}`;
        const remaining = invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', filter], {
            budgetMs: remainingBudget()
        });
        if (remaining)
        {
            if (!state.creationAttempted || !/^[a-f0-9]{64}$/u.test(remaining))
            {
                throw new Error('MySQL lifecycle cleanup cannot establish its created container');
            }
            const owned = inspectOwned(target ?? remaining, remainingBudget());
            if (owned.Id !== remaining)
            {
                throw new Error('MySQL lifecycle cleanup lookup drifted from its exact container');
            }
            state.containerId = owned.Id;
            state.createdAt = owned.Created;
            publish();
            assertJournal();
            requireRuntimeIdentity(state, invoke, remainingBudget);
            invoke(['rm', '-f', '-v', owned.Id], { budgetMs: remainingBudget() });
            if (invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${owned.Id}`], {
                budgetMs: remainingBudget()
            }) !== '')
            {
                throw new Error('MySQL lifecycle cleanup did not remove the exact container');
            }
        }
        assertJournal();
        requireRuntimeIdentity(state, invoke, remainingBudget);
        for (const file of [secretFile, clientFile])
        {
            if (fs.lstatSync(file, { throwIfNoEntry: false }))
            {
                readLifecycleFile(file, { label: 'MySQL lifecycle credential' });
                fs.unlinkSync(file);
            }
        }
        state.phase = 'cleaned';
        state.cleanup = { containerAbsent: true, credentialsRemoved: true };
        publish();
        return structuredClone(state.cleanup);
    })().catch((error) =>
    {
        cleanupPromise = undefined;
        state.phase = 'cleanup-failed';
        state.cleanup = { containerAbsent: false, credentialsRemoved: false };
        try
        {
            publish();
        }
        catch (recordError)
        {
            throw new AggregateError([error, recordError], 'MySQL cleanup and private failure recording failed', { cause: recordError });
        }
        throw error;
    });
    return { publish, inspectOwned, cleanup };
}

function decodeJson(result, label)
{
    try
    {
        return JSON.parse(result);
    }
    catch
    {
        throw new Error(`MySQL lifecycle ${label} returned malformed JSON`);
    }
}

/**
 * Service preparation/cleanup only. The caller must hold its scheduler resource
 * reservation for this handle's entire lifetime and supply assertResourcesHeld.
 * This is neither a scheduler lease nor a FixtureReceipt producer/admission.
 * There is deliberately no CLI, implicit Docker grant, image pull or host fallback.
 */
export async function prepareMySqlFixtureService(context, {
    catalog = loadExecutionServiceCatalog(),
    docker = spawnSync,
    observeSource = snapshotSourceState,
    assertResourcesHeld,
    retainRecoveryBinding,
    signal
} = {})
{
    context = freezeDeep(structuredClone(context));
    const resourceArgs = validateContext(context);
    if (typeof assertResourcesHeld !== 'function')
    {
        throw new Error('MySQL lifecycle requires the enclosing resource owner to retain its grant');
    }
    if (typeof retainRecoveryBinding !== 'function')
    {
        throw new Error('MySQL lifecycle requires its supervisor to retain the recovery binding before creation');
    }
    catalog = freezeDeep(structuredClone(catalog));
    const errors = validateExecutionServiceCatalog(catalog, {
        tiers: [{ services: Object.keys(catalog?.services ?? {}) }]
    });
    const entry = catalog?.services?.mysql;
    if (errors.length || entry?.kind !== 'container')
    {
        throw new Error('MySQL lifecycle requires a registered pinned MySQL service contract');
    }
    if (canonicalJson(context.resourceGrant) !== canonicalJson(entry.resourceGrant))
    {
        throw new Error('MySQL lifecycle resource grant differs from its registered service contract');
    }
    if (context.startupBudgetMs > entry.lifecycleBudgets.startupMs
        || context.commandBudgetMs > entry.lifecycleBudgets.commandMs
        || context.cleanupBudgetMs > entry.lifecycleBudgets.cleanupMs)
    {
        throw new Error('MySQL lifecycle budgets exceed its registered service contract');
    }
    const requireCurrentSource = async () =>
    {
        const current = await observeSource(context.root);
        if (current.commit !== context.sourceState.commit
            || sourceFingerprint(current.worktreeFingerprint) !== sourceFingerprint(context.sourceState.worktreeFingerprint))
        {
            throw new Error('MySQL lifecycle source identity drift');
        }
        return current;
    };
    const source = await requireCurrentSource();
    signal?.throwIfAborted();
    await assertResourcesHeld(context);

    const paths = lifecyclePaths(context);
    const { name, directory, secretFile, clientFile, cidFile, stateFile, prefix } = paths;
    const token = randomBytes(32).toString('hex');
    const labels = {
        'io.fsusblog.test.namespace': context.namespace,
        'io.fsusblog.test.repository-root-digest': digest(context.root),
        'io.fsusblog.test.source-commit': source.commit,
        'io.fsusblog.test.source-fingerprint': sourceFingerprint(source.worktreeFingerprint),
        'io.fsusblog.test.mysql-lifecycle-token': token
    };
    for (let index = 0; index < resourceArgs.length; index++)
    {
        if (resourceArgs[index] === '--label')
        {
            const value = resourceArgs[++index];
            const separator = value.indexOf('=');
            labels[value.slice(0, separator)] = value.slice(separator + 1);
        }
    }
    const invoke = dockerInvoker(context, docker);
    const runtimeIdentity = lifecycleRuntime(invoke);
    const image = parseOne(invoke(['image', 'inspect', entry.imageReference]), 'image');
    if (!/^sha256:[a-f0-9]{64}$/u.test(image.Id ?? '') || !image.RepoDigests?.includes(entry.imageReference))
    {
        throw new Error('MySQL lifecycle pinned local image identity is incomplete');
    }
    if (invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`]) !== '')
    {
        throw new Error('MySQL lifecycle refuses to adopt or replace an existing container');
    }
    const state = {
        schema: 'fsusblog.mysql-service-lifecycle.v3', qualificationEligible: false,
        identity: context, name, databasePrefix: prefix, labels,
        imageReference: entry.imageReference, imageId: image.Id,
        controllerIdentity: currentProcessIdentity(), runtimeIdentity, creationAttempted: false,
        containerId: null, createdAt: null, phase: 'creating', cleanup: null
    };
    state.bindingDigest = lifecycleBinding(state);
    requireOwnedDirectory(context.root, directory, true);
    const { publish, inspectOwned, cleanup } = lifecycleOwner(state, paths, invoke);
    let envelope;
    try
    {
        publish();
        await retainRecoveryBinding(freezeDeep({ context: structuredClone(context), stateFile, bindingDigest: state.bindingDigest }));
        requireRuntimeIdentity(state, invoke);
        const password = randomBytes(32).toString('hex');
        fs.writeFileSync(secretFile, `MYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(clientFile, `[client]\npassword=${password}\n`, { flag: 'wx', mode: 0o600 });
        publish();
        signal?.throwIfAborted();
        await assertResourcesHeld(context);
        requireRuntimeIdentity(state, invoke);
        const args = ['run', '-d', '--pull', 'never', '--name', name, '--cidfile', cidFile,
            '--network', 'bridge', '--publish', '127.0.0.1::3306',
            ...resourceArgs, '--tmpfs', `/var/lib/mysql:rw,nosuid,nodev,size=${context.resourceGrant.memoryHighBytes}`,
            '--env-file', secretFile];
        for (const [key, value] of Object.entries(labels))
        {
            if (!resourceArgs.includes(`${key}=${value}`))
            {
                args.push('--label', `${key}=${value}`);
            }
        }
        state.creationAttempted = true;
        publish();
        state.containerId = invoke([...args, '--label', `io.fsusblog.test.mysql-recovery-binding=${state.bindingDigest}`, entry.imageReference]);
        if (!/^[a-f0-9]{64}$/u.test(state.containerId))
        {
            state.containerId = null;
            throw new Error('MySQL lifecycle create returned an invalid container ID');
        }
        state.createdAt = inspectOwned(state.containerId, context.commandBudgetMs).Created;
        publish();
        const deadline = Date.now() + context.startupBudgetMs;
        let ready = false;
        while (Date.now() < deadline)
        {
            signal?.throwIfAborted();
            await assertResourcesHeld(context);
            const value = invoke(['exec', '-i', state.containerId, ...rootSqlCommand], {
                input: 'SELECT 1;', budgetMs: Math.min(context.commandBudgetMs, Math.max(1, deadline - Date.now())), allowFailure: true
            });
            if (value === '1')
            {
                ready = true;
                break;
            }
            await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
        }
        if (!ready)
        {
            throw new Error('MySQL lifecycle exhausted its admitted startup budget');
        }
        const pattern = prefix.replaceAll('_', '\\_') + '%';
        const upperPattern = prefix.toUpperCase().replaceAll('_', '\\_') + '%';
        invoke(['exec', '-i', state.containerId, ...rootSqlCommand], {
            input: `CREATE USER 'fixture_user'@'%' IDENTIFIED BY '${password}'; GRANT CREATE, ALTER, DROP, INDEX, SELECT, INSERT, UPDATE, DELETE ON \`${pattern}\`.* TO 'fixture_user'@'%'; GRANT CREATE, ALTER, DROP, INDEX, SELECT, INSERT, UPDATE, DELETE ON \`${upperPattern}\`.* TO 'fixture_user'@'%';`
        });
        invoke(['exec', state.containerId, 'mkdir', '-m', '700', '-p', path.posix.dirname(entry.clientOptionsFile)]);
        invoke(['cp', clientFile, `${state.containerId}:${entry.clientOptionsFile}`]);
        signal?.throwIfAborted();
        await assertResourcesHeld(context);
        const boundedDocker = (command, args, options) => docker(command, args, {
            ...options, timeout: context.commandBudgetMs, maxBuffer: 4 * 1024 * 1024
        });
        const observeService = (options) => observeContainerService({ ...options, docker: boundedDocker });
        const observeRuntime = () => observeDockerRuntime(boundedDocker);
        envelope = createAndAdmitServiceEnvelope({
            producerId: context.stepId, runId: context.runId, catalog,
            containers: { mysql: state.containerId }, requiredServices: ['mysql'], observeService,
            observeRuntime
        });
        if (canonicalJson(envelope.actual.runtime) !== canonicalJson(state.runtimeIdentity))
        {
            throw new Error('MySQL lifecycle admitted Docker runtime differs from its creation binding');
        }
        const observed = envelope.actual.services[0];
        const limits = context.resourceGrant;
        if (observed.resourceLimits.nanoCpus !== limits.cpuUnits * 1e9
            || observed.resourceLimits.memory !== limits.memoryMaxBytes
            || observed.resourceLimits.memoryReservation !== limits.memoryHighBytes
            || observed.resourceLimits.pidsLimit !== limits.pidsMax)
        {
            throw new Error('MySQL lifecycle observed resource limits differ from its held grant');
        }
        state.phase = 'prepared';
        state.observation = envelope.actual;
        publish();
        return Object.freeze({
            stateFile, directory, bindingDigest: state.bindingDigest, clientOptionsFile: clientFile, databasePrefix: prefix,
            envelope: structuredClone(envelope),
            async verify()
            {
                if (state.phase !== 'prepared')
                {
                    throw new Error('MySQL lifecycle is no longer prepared');
                }
                signal?.throwIfAborted();
                await requireCurrentSource();
                await assertResourcesHeld(context);
                inspectOwned(state.containerId, context.commandBudgetMs);
                return verifyLiveServiceEnvelope({ envelope, catalog, observeService, observeRuntime });
            },
            cleanup
        });
    }
    catch (error)
    {
        try
        {
            await cleanup();
        }
        catch (cleanupError)
        {
            throw new AggregateError([error, cleanupError], 'MySQL lifecycle preparation and exact cleanup failed', { cause: cleanupError });
        }
        throw error;
    }
}

/** Keep the enclosing grant held until both the consumer and exact cleanup settle. */
export async function withMySqlFixtureService(context, options, consume)
{
    if (typeof consume !== 'function')
    {
        throw new Error('MySQL lifecycle requires an explicit consumer');
    }
    const service = await prepareMySqlFixtureService(context, options);
    let result;
    let failure;
    try
    {
        await service.verify();
        result = await consume(service);
        await service.verify();
    }
    catch (error)
    {
        failure = error;
    }
    try
    {
        await service.cleanup();
    }
    catch (cleanupError)
    {
        if (failure)
        {
            throw new AggregateError([failure, cleanupError], 'MySQL consumer and exact cleanup failed', { cause: cleanupError });
        }
        throw cleanupError;
    }
    if (failure)
    {
        throw failure;
    }
    return result;
}

export function readRetainedMySqlFixtureLifecycle(context, expectedBindingDigest)
{
    validateContext(context);
    if (!/^sha256:[a-f0-9]{64}$/u.test(expectedBindingDigest ?? ''))
    {
        throw new Error('MySQL recovery requires the supervisor-retained creation binding');
    }
    const paths = lifecyclePaths(context);
    requireOwnedDirectory(context.root, paths.directory);
    const bytes = readLifecycleFile(paths.stateFile, { label: 'MySQL recovery state' }).bytes;
    const state = decodeJson(bytes.toString('utf8'), 'recovery state');
    const keys = ['schema', 'qualificationEligible', 'identity', 'name', 'databasePrefix', 'labels',
        'imageReference', 'imageId', 'controllerIdentity', 'runtimeIdentity', 'creationAttempted', 'containerId',
        'createdAt', 'phase', 'cleanup', 'bindingDigest', 'stateDigest'];
    if (state && Object.hasOwn(state, 'observation'))
    {
        keys.push('observation');
    }
    if (!state || Array.isArray(state) || canonicalJson(Object.keys(state).sort()) !== canonicalJson(keys.sort())
        || state.schema !== 'fsusblog.mysql-service-lifecycle.v3' || state.qualificationEligible !== false
        || canonicalJson(state.identity) !== canonicalJson(context)
        || state.name !== paths.name || state.databasePrefix !== paths.prefix
        || state.stateDigest !== digestReceiptBody(state, 'stateDigest')
        || state.bindingDigest !== expectedBindingDigest || lifecycleBinding(state) !== expectedBindingDigest
        || !['creating', 'prepared', 'cleanup-failed', 'cleaned'].includes(state.phase)
        || typeof state.creationAttempted !== 'boolean'
        || !(state.containerId === null || /^[a-f0-9]{64}$/u.test(state.containerId))
        || !(state.createdAt === null || typeof state.createdAt === 'string' && Number.isFinite(Date.parse(state.createdAt)))
        || (state.createdAt !== null && state.containerId === null)
        || !/^sha256:[a-f0-9]{64}$/u.test(state.imageId ?? '')
        || !/^mysql@sha256:[a-f0-9]{64}$/u.test(state.imageReference ?? '')
        || !state.runtimeIdentity || Array.isArray(state.runtimeIdentity)
        || canonicalJson(Object.keys(state.runtimeIdentity).sort())
            !== canonicalJson(['architecture', 'cgroupDriver', 'operatingSystem', 'serverId', 'serverVersion'])
        || Object.values(state.runtimeIdentity).some((value) => typeof value !== 'string' || !value.trim())
        || !state.labels || Array.isArray(state.labels)
        || !/^[a-f0-9]{64}$/u.test(state.labels['io.fsusblog.test.mysql-lifecycle-token'] ?? '')
        || (state.phase === 'prepared' && (!state.creationAttempted || state.containerId === null || state.createdAt === null))
        || canonicalJson(state.cleanup) !== canonicalJson(state.phase === 'cleaned'
            ? { containerAbsent: true, credentialsRemoved: true }
            : state.phase === 'cleanup-failed' ? { containerAbsent: false, credentialsRemoved: false } : null))
    {
        throw new Error('MySQL recovery state is incomplete, changed or crosses its retained binding');
    }
    return { paths, bytes, state };
}

/**
 * Read-only supervisor check, not the child's cleanup declaration. It uses the
 * independently retained pre-create binding and observes exact absence again.
 * It never deletes, adopts, changes a lock, or establishes fixture admission.
 */
export function verifyMySqlFixtureServiceCleanup(context, {
    expectedBindingDigest,
    docker = spawnSync
} = {})
{
    context = freezeDeep(structuredClone(context));
    const { paths, bytes, state } = readRetainedMySqlFixtureLifecycle(context, expectedBindingDigest);
    if (state.phase !== 'cleaned')
    {
        throw new Error('MySQL cleanup verification requires a completed lifecycle cleanup');
    }
    const directoryIdentity = fs.lstatSync(paths.directory);
    const assertUnchanged = () =>
    {
        requireOwnedDirectory(context.root, paths.directory);
        const currentDirectory = fs.lstatSync(paths.directory);
        if (currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino
            || !bytes.equals(readLifecycleFile(paths.stateFile, { label: 'MySQL cleanup state' }).bytes))
        {
            throw new Error('MySQL cleanup verification state changed during observation');
        }
        if (fs.lstatSync(path.join(paths.directory, 'recovery.lock'), { throwIfNoEntry: false }))
        {
            throw new Error('MySQL cleanup verification refuses an unresolved recovery lock');
        }
        for (const file of [paths.secretFile, paths.clientFile])
        {
            // lstat also rejects a dangling link masquerading as an absent secret.
            if (fs.lstatSync(file, { throwIfNoEntry: false }))
            {
                throw new Error('MySQL cleanup verification found a retained credential path');
            }
        }
    };
    assertUnchanged();
    const cidBytes = fs.lstatSync(paths.cidFile, { throwIfNoEntry: false })
        ? readLifecycleFile(paths.cidFile, { expectedModeMask: 0, label: 'MySQL container ID' }).bytes : null;
    const cid = cidBytes?.toString('utf8').trim() ?? null;
    if (cid !== null && (!/^[a-f0-9]{64}$/u.test(cid)
        || (state.containerId !== null && state.containerId !== cid)))
    {
        throw new Error('MySQL cleanup verification has an invalid creation identity');
    }
    const deadline = Date.now() + context.cleanupBudgetMs;
    const invoke = dockerInvoker(context, docker);
    const remainingBudget = () =>
    {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
        {
            throw new Error('MySQL cleanup verification exhausted its total cleanup budget');
        }
        return Math.min(context.commandBudgetMs, remaining);
    };
    requireRuntimeIdentity(state, invoke, remainingBudget);
    const filters = [
        `label=io.fsusblog.test.mysql-recovery-binding=${expectedBindingDigest}`,
        `name=^/${paths.name}$`
    ];
    if (state.containerId ?? cid)
    {
        filters.push(`id=${state.containerId ?? cid}`);
    }
    for (const filter of filters)
    {
        // The immutable creation binding also finds an owned container whose
        // name was changed and whose mutable local ID record was lost/forged.
        if (invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', filter], {
            budgetMs: remainingBudget()
        }) !== '')
        {
            throw new Error('MySQL cleanup verification found a remaining or conflicting container');
        }
    }
    requireRuntimeIdentity(state, invoke, remainingBudget);
    assertUnchanged();
    const currentCid = fs.lstatSync(paths.cidFile, { throwIfNoEntry: false })
        ? readLifecycleFile(paths.cidFile, { expectedModeMask: 0, label: 'MySQL container ID' }).bytes : null;
    if ((cidBytes === null) !== (currentCid === null) || (cidBytes !== null && !cidBytes.equals(currentCid)))
    {
        throw new Error('MySQL cleanup verification creation identity changed during observation');
    }
    if (Date.now() >= deadline)
    {
        throw new Error('MySQL cleanup verification exhausted its total cleanup budget');
    }
    return freezeDeep({
        qualificationEligible: false, stateFile: paths.stateFile,
        bindingDigest: expectedBindingDigest, stateDigest: state.stateDigest,
        cleanup: { containerAbsent: true, credentialsRemoved: true }
    });
}

/**
 * Recover only an explicitly named, supervisor-bound allocation after its
 * controller is proven dead. Never discover or adopt by a label-wide scan.
 * A leftover recovery lock is fail-closed; this API does not steal locks.
 */
export async function recoverMySqlFixtureService(context, {
    expectedBindingDigest,
    docker = spawnSync,
    observeController = processIdentityStatus
} = {})
{
    context = freezeDeep(structuredClone(context));
    const { paths, bytes, state } = readRetainedMySqlFixtureLifecycle(context, expectedBindingDigest);
    const requireDeadController = () =>
    {
        if (observeController(state.controllerIdentity)?.status !== 'dead')
        {
            throw new Error('MySQL recovery requires a proven dead controller; live, reused or unverifiable identities are refused');
        }
    };
    requireDeadController();
    const lock = path.join(paths.directory, 'recovery.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    const lockIdentity = fs.lstatSync(lock);
    let result;
    let failure;
    try
    {
        writePrivateJson(path.join(lock, 'owner.json'), currentProcessIdentity(), { label: 'MySQL recovery lock owner' });
        requireDeadController();
        const owner = lifecycleOwner(state, paths, dockerInvoker(context, docker), digest(bytes));
        result = { qualificationEligible: false, stateFile: paths.stateFile, cleanup: await owner.cleanup() };
    }
    catch (error)
    {
        failure = error;
    }
    try
    {
        requireOwnedDirectory(context.root, paths.directory);
        const currentLock = fs.lstatSync(lock);
        if (!currentLock.isDirectory() || currentLock.isSymbolicLink()
            || currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino)
        {
            throw new Error('MySQL recovery lock identity changed; refusing to remove it');
        }
        const ownerFile = path.join(lock, 'owner.json');
        if (fs.lstatSync(ownerFile, { throwIfNoEntry: false }))
        {
            readLifecycleFile(ownerFile, { label: 'MySQL recovery lock owner' });
            fs.unlinkSync(ownerFile);
        }
        fs.rmdirSync(lock);
    }
    catch (releaseError)
    {
        if (failure)
        {
            throw new AggregateError([failure, releaseError], 'MySQL recovery and exact lock release failed', { cause: releaseError });
        }
        throw releaseError;
    }
    if (failure)
    {
        throw failure;
    }
    return result;
}
