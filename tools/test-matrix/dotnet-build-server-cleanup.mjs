import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { schedulerRunLockActivity } from './scheduler-run-owner.mjs';

const msbuildFlags = new Set(['/noautoresponse', '/nologo', '/nodemode:1', '/nodeReuse:true', '/low:false']);

function serverKind(args)
{
    if (exactMsbuildNode(args))
    {
        return 'msbuild-node';
    }
    if (exactVbcsCompiler(args))
    {
        return 'roslyn-compiler';
    }
    return null;
}

function positiveInteger(value)
{
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function exactMsbuildNode(args)
{
    if (args.length !== 7 || path.basename(String(args[0] ?? '')) !== 'dotnet')
    {
        return false;
    }
    const assembly = String(args[1] ?? '');
    if (path.basename(assembly) !== 'MSBuild.dll'
    || !/[/\\]sdk[/\\]\d+\.\d+\.\d+[/\\]MSBuild\.dll$/u.test(assembly))
    {
        return false;
    }
    const flags = args.slice(2);
    return flags.length === msbuildFlags.size
    && new Set(flags).size === msbuildFlags.size
    && flags.every((flag) => msbuildFlags.has(flag));
}

function exactVbcsCompiler(args)
{
    const pipeName = String(args.at(-1) ?? '');
    if (!/^-pipename:[A-Za-z0-9+._=-]{16,256}$/u.test(pipeName))
    {
        return false;
    }
    if (args.length === 4
    && path.basename(String(args[0] ?? '')) === 'dotnet'
    && args[1] === 'exec')
    {
        const assembly = String(args[2] ?? '');
        return /[/\\]sdk[/\\]\d+\.\d+\.\d+[/\\]Roslyn[/\\]bincore[/\\]VBCSCompiler\.dll$/u.test(assembly);
    }
    if (args.length !== 2)
    {
        return false;
    }
    const executable = String(args[0] ?? '');
    return path.isAbsolute(executable)
    && /\/sdk\/\d+\.\d+\.\d+\/Roslyn\/bincore\/VBCSCompiler(?:\.exe)?$/u.test(executable);
}

function nativeVbcsCompiler(args)
{
    return args.length === 2 && exactVbcsCompiler(args);
}

export function managedOrphanDotnetBuildServer(record, { root })
{
    // MSBuild worker nodes chdir into the selected SDK directory before they
    // detach, so their /proc/<pid>/cwd no longer identifies the repository that
    // launched them. Ownership is instead proven by the exact server command and
    // the run-bound environment inherited from the production scheduler.
    path.resolve(root);
    const env = record?.env ?? {};
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '');
    const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '');
    return dotnetBuildServerShape(record)
    && runId.length > 0
    && namespace.length > 0;
}

function dotnetBuildServerShape(record)
{
    return dotnetBuildServerProcessShape(record)
    && record.ppid === 1;
}

function dotnetBuildServerProcessShape(record)
{
    const args = Array.isArray(record?.args) ? record.args : [];
    const nativeCompilerCwdMatches = !nativeVbcsCompiler(args)
    || (
        path.resolve(String(record?.cwd ?? '')) === path.dirname(path.resolve(args[0]))
        && path.resolve(String(record?.executable ?? '')) === path.resolve(args[0])
    );
    return positiveInteger(record?.pid) !== null
    && positiveInteger(record?.ppid) !== null
    && /^\d+$/u.test(String(record.startTimeTicks ?? ''))
    && serverKind(args) !== null
    && nativeCompilerCwdMatches;
}

function schedulerOwnerActivity(runsRoot, runId)
{
    if (!runId)
    {
        return { status: 'unverifiable', reason: 'build-server-run-id-missing' };
    }
    return schedulerRunLockActivity({ runsRoot, runId });
}

function buildServerStartSource(record)
{
    const source = String(record?.env?.FSUSBLOG_TEST_EXECUTION_SOURCE ?? '');
    return ['fresh', 'resume'].includes(source) ? source : null;
}

export function dotnetBuildServerInventory(records, {
    root,
    currentRunId = '',
    currentNamespace = '',
    currentStartSource = '',
    includeAttachedCurrentBinding = false,
    runsRoot = path.join(path.resolve(root), '.tmp/test-runs'),
    runActivity = ({ runId }) => schedulerOwnerActivity(runsRoot, runId)
})
{
    if (!Array.isArray(records))
    {
        throw new Error('dotnet build-server inventory requires a process array');
    }
    if (typeof runActivity !== 'function')
    {
        throw new Error('dotnet build-server inventory requires a scheduler run-owner activity probe');
    }
    const expectedBuildRoot = currentRunId ? path.join(path.resolve(root), '.tmp/build', currentRunId) : '';
    return records
        .filter((record) =>
        {
            if (dotnetBuildServerShape(record))
            {
                return true;
            }
            const env = record?.env ?? {};
            return includeAttachedCurrentBinding
            && dotnetBuildServerProcessShape(record)
            && env.FSUSBLOG_TEST_RUN_ID === currentRunId
            && env.FSUSBLOG_TEST_NAMESPACE === currentNamespace
            && env.FSUSBLOG_PRODUCTION_BUILD_ROOT === expectedBuildRoot
            && buildServerStartSource(record) === currentStartSource;
        })
        .map((record) =>
        {
            const env = record.env ?? {};
            const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '');
            const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '');
            const buildRoot = String(env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '');
            const startSource = buildServerStartSource(record);
            const startedByCurrentRun = runId === currentRunId && namespace === currentNamespace
        && buildRoot === expectedBuildRoot && startSource === currentStartSource;
            const ownerActivity = startedByCurrentRun || !runId
                ? null
                : runActivity({ runId, namespace, buildRoot, startSource });
            const ownerState = startedByCurrentRun
                ? 'current'
                : (!runId || !namespace
          ? 'external-unknown'
          : (runId === currentRunId
            ? 'unknown-current-run'
            : (ownerActivity?.status === 'active'
              ? 'active-other-run'
              : ownerActivity?.status === 'inactive'
                ? 'inactive-or-unknown'
                : 'owner-unverifiable')));
            return {
                processIdentity: {
                    pid: record.pid,
                    ppid: record.ppid,
                    startTimeTicks: record.startTimeTicks,
                    executable: record.executable,
                    cwd: record.cwd,
                    args: [...record.args]
                },
                serverKind: serverKind(record.args),
                runId,
                namespace,
                buildRoot,
                startSource,
                pipeOrSocketIdentity: serverKind(record.args) === 'roslyn-compiler' ? record.args.at(-1) : null,
                startedByCurrentRun,
                sharedWithOtherRun: ownerState !== 'current',
                ownerState,
                record
            };
        });
}

export function selectOrphanDotnetBuildServers(records, {
    root,
    currentRunId = '',
    currentNamespace = '',
    currentStartSource = '',
    includeCurrentBinding = false,
    includeAttachedCurrentBinding = false,
    runsRoot = path.join(path.resolve(root), '.tmp/test-runs'),
    runActivity = ({ runId }) => schedulerOwnerActivity(runsRoot, runId)
})
{
    if (!Array.isArray(records))
    {
        throw new Error('dotnet build-server cleanup requires a process array');
    }
    if (typeof runActivity !== 'function')
    {
        throw new Error('dotnet build-server cleanup requires a scheduler run-owner activity probe');
    }
    return dotnetBuildServerInventory(records, {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource,
        includeAttachedCurrentBinding,
        runsRoot,
        runActivity
    }).filter((entry) => (
        includeCurrentBinding && entry.startedByCurrentRun
    )).map((entry) => entry.record);
}

export function readProcProcess(pid)
{
    try
    {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const statTail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
        const startTimeTicks = statTail[19] ?? '';
        if (!/^\d+$/u.test(startTimeTicks))
        {
            return null;
        }
        const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
            .split('\0')
            .filter(Boolean)
            .map((entry) =>
            {
                const separator = entry.indexOf('=');
                return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
            }));
        return {
            pid,
            ppid: positiveInteger(statTail[1]),
            startTimeTicks,
            executable: fs.realpathSync(`/proc/${pid}/exe`),
            cwd: fs.realpathSync(`/proc/${pid}/cwd`),
            args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
            env
        };
    }
    catch (error)
    {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code))
        {
            return null;
        }
        throw error;
    }
}

export function discoverOrphanDotnetBuildServers()
{
    return discoverDotnetBuildServers().filter(dotnetBuildServerShape);
}

export function discoverDotnetBuildServers()
{
    if (process.platform !== 'linux' || !fs.existsSync('/proc'))
    {
        return [];
    }
    return fs.readdirSync('/proc', { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
        .map((entry) => readProcProcess(Number.parseInt(entry.name, 10)))
        .filter((record) => record && dotnetBuildServerProcessShape(record));
}

function sameProcessIdentity(expected, observed = readProcProcess(expected.pid))
{
    return observed !== null
    && observed.ppid === expected.ppid
    && observed.startTimeTicks === expected.startTimeTicks
    && observed.executable === expected.executable
    && observed.cwd === expected.cwd
    && observed.args.join('\0') === expected.args.join('\0')
    && observed.env.FSUSBLOG_TEST_RUN_ID === expected.env.FSUSBLOG_TEST_RUN_ID
    && observed.env.FSUSBLOG_TEST_NAMESPACE === expected.env.FSUSBLOG_TEST_NAMESPACE
    && observed.env.FSUSBLOG_PRODUCTION_BUILD_ROOT === expected.env.FSUSBLOG_PRODUCTION_BUILD_ROOT
    && observed.env.FSUSBLOG_TEST_EXECUTION_SOURCE === expected.env.FSUSBLOG_TEST_EXECUTION_SOURCE;
}

export function terminateOrphanDotnetBuildServers(records, {
    root,
    currentRunId = '',
    currentNamespace = '',
    currentStartSource = '',
    includeCurrentBinding = false,
    includeAttachedCurrentBinding = false,
    runsRoot = path.join(path.resolve(root), '.tmp/test-runs'),
    runActivity = ({ runId }) => schedulerOwnerActivity(runsRoot, runId),
    terminationGraceMs = 250,
    readProcess = readProcProcess,
    signalProcess = process.kill,
    processExists = (pid) => fs.existsSync(`/proc/${pid}`)
})
{
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs <= 0)
    {
        throw new Error('dotnet build-server cleanup requires a positive termination grace');
    }
    const selected = selectOrphanDotnetBuildServers(records, {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource,
        includeCurrentBinding,
        includeAttachedCurrentBinding,
        runsRoot,
        runActivity
    });
    const signalled = [];
    for (const record of selected)
    {
        const observed = readProcess(record.pid);
        if (!sameProcessIdentity(record, observed))
        {
            continue;
        }
        try
        {
            signalProcess(record.pid, 'SIGTERM');
            signalled.push(record);
        }
        catch (error)
        {
            if (error.code !== 'ESRCH')
            {
                throw error;
            }
        }
    }
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + terminationGraceMs;
    while (signalled.some((record) => processExists(record.pid)) && Date.now() < deadline)
    {
        Atomics.wait(waitBuffer, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())));
    }
    const terminatedPids = [];
    for (const record of signalled)
    {
        if (!processExists(record.pid))
        {
            terminatedPids.push(record.pid);
            continue;
        }
        const observed = readProcess(record.pid);
        if (!sameProcessIdentity(record, observed))
        {
            continue;
        }
        try
        {
            signalProcess(record.pid, 'SIGKILL');
            terminatedPids.push(record.pid);
        }
        catch (error)
        {
            if (error.code === 'ESRCH')
            {
                terminatedPids.push(record.pid);
            }
            else
            {
                throw error;
            }
        }
    }
    return terminatedPids;
}

export function cleanupOrphanDotnetBuildServers(options)
{
    const records = discoverOrphanDotnetBuildServers({ root: options.root });
    return terminateOrphanDotnetBuildServers(records, options);
}

const benchmarkCleanupReceiptSchema = 'fsusblog.benchmark-build-server-cleanup.v2';
const benchmarkCleanupReceiptFields = ['binding', 'contentDigest', 'events', 'schema', 'status'];
const benchmarkCleanupEventFields = [
    'failures',
    'inventoryAfter',
    'inventoryBefore',
    'observedAt',
    'selectedCurrentPids',
    'sequence',
    'startSource',
    'status',
    'terminatedPids'
];
const benchmarkCleanupBindingFields = ['buildRoot', 'namespace', 'runId'];
const benchmarkCleanupInventoryFields = [
    'buildRoot',
    'namespace',
    'ownerState',
    'pipeOrSocketIdentity',
    'processIdentity',
    'runId',
    'serverKind',
    'sharedWithOtherRun',
    'startSource',
    'startedByCurrentRun'
];
const benchmarkCleanupProcessIdentityFields = [
    'args',
    'cwd',
    'executable',
    'pid',
    'ppid',
    'startTimeTicks'
];
const benchmarkCleanupOwnerStates = new Set([
    'active-other-run',
    'current',
    'external-unknown',
    'inactive-or-unknown',
    'owner-unverifiable',
    'unknown-current-run'
]);

function digestDocument(document)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`;
}

function exactPlainObjectFields(value, fields)
{
    return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields);
}

function validBenchmarkCleanupBinding(binding, expected)
{
    return exactPlainObjectFields(binding, benchmarkCleanupBindingFields)
    && binding.runId === expected.runId
    && binding.namespace === expected.namespace
    && binding.buildRoot === expected.buildRoot;
}

function validBenchmarkCleanupInventoryItem(item, binding, eventStartSource)
{
    const matchesCurrentBinding = item?.runId === binding.runId
    && item?.namespace === binding.namespace
    && item?.buildRoot === binding.buildRoot
    && item?.startSource === eventStartSource;
    if (!exactPlainObjectFields(item, benchmarkCleanupInventoryFields)
    || !exactPlainObjectFields(
        item.processIdentity,
        benchmarkCleanupProcessIdentityFields
    )
    || !Number.isInteger(item.processIdentity.pid)
    || item.processIdentity.pid <= 0
    || !Number.isInteger(item.processIdentity.ppid)
    || item.processIdentity.ppid <= 0
    || !/^\d+$/u.test(item.processIdentity.startTimeTicks)
    || typeof item.processIdentity.executable !== 'string'
    || typeof item.processIdentity.cwd !== 'string'
    || !Array.isArray(item.processIdentity.args)
    || !item.processIdentity.args.every((argument) => typeof argument === 'string')
    || !['msbuild-node', 'roslyn-compiler'].includes(item.serverKind)
    || typeof item.runId !== 'string'
    || typeof item.namespace !== 'string'
    || typeof item.buildRoot !== 'string'
    || ![null, 'fresh', 'resume'].includes(item.startSource)
    || !(item.pipeOrSocketIdentity === null
      || typeof item.pipeOrSocketIdentity === 'string')
    || typeof item.startedByCurrentRun !== 'boolean'
    || typeof item.sharedWithOtherRun !== 'boolean'
    || !benchmarkCleanupOwnerStates.has(item.ownerState)
    || item.startedByCurrentRun !== (item.ownerState === 'current')
    || item.startedByCurrentRun !== matchesCurrentBinding
    || item.sharedWithOtherRun !== (item.ownerState !== 'current'))
    {
        return false;
    }
    return true;
}

function validBenchmarkCleanupInventory(inventory, binding, eventStartSource)
{
    if (!Array.isArray(inventory)
    || !inventory.every((item) =>
        validBenchmarkCleanupInventoryItem(item, binding, eventStartSource)))
    {
        return false;
    }
    const pids = inventory.map((item) => item.processIdentity.pid);
    return new Set(pids).size === pids.length;
}

function positiveUniquePids(pids)
{
    return Array.isArray(pids)
    && pids.every((pid) => Number.isInteger(pid) && pid > 0)
    && new Set(pids).size === pids.length;
}

function validBenchmarkCleanupEvent(event, index, binding)
{
    if (!exactPlainObjectFields(event, benchmarkCleanupEventFields))
    {
        return false;
    }
    if (event.sequence !== index + 1
    || !['fresh', 'resume'].includes(event.startSource)
    || typeof event.observedAt !== 'string'
    || event.observedAt.length === 0
    || !['complete', 'failed'].includes(event.status)
    || !validBenchmarkCleanupInventory(event.inventoryBefore, binding, event.startSource)
    || !positiveUniquePids(event.selectedCurrentPids)
    || !positiveUniquePids(event.terminatedPids)
    || !event.terminatedPids.every((pid) => event.selectedCurrentPids.includes(pid))
    || !validBenchmarkCleanupInventory(event.inventoryAfter, binding, event.startSource)
    || !Array.isArray(event.failures)
    || !event.failures.every((failure) => typeof failure === 'string'))
    {
        return false;
    }
    const expectedSelectedPids = event.inventoryBefore
        .filter((item) => item.startedByCurrentRun)
        .map((item) => item.processIdentity.pid);
    return JSON.stringify(event.selectedCurrentPids) === JSON.stringify(expectedSelectedPids)
    && (event.status === 'complete') === (event.failures.length === 0)
    && (event.status !== 'complete'
      || !event.inventoryAfter.some((item) => item.startedByCurrentRun));
}

function runBoundBenchmarkBinding(root, env)
{
    const resolvedRoot = path.resolve(root);
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
    const buildRoot = String(env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim();
    const startSource = String(env.FSUSBLOG_TEST_EXECUTION_SOURCE ?? '').trim();
    if (![runId, namespace, buildRoot, startSource].some(Boolean))
    {
        return null;
    }
    if (![runId, namespace, buildRoot, startSource].every(Boolean))
    {
        throw new Error('benchmark build-server cleanup requires a complete run-bound identity');
    }
    if (!/^[A-Za-z0-9._-]+$/u.test(runId) || !/^[A-Za-z0-9._-]+$/u.test(namespace))
    {
        throw new Error('benchmark build-server cleanup requires safe run and namespace identities');
    }
    if (!['fresh', 'resume'].includes(startSource))
    {
        throw new Error('benchmark build-server cleanup requires a Fresh or resume start source');
    }
    const expectedBuildRoot = path.join(resolvedRoot, '.tmp/build', runId);
    if (path.resolve(buildRoot) !== expectedBuildRoot)
    {
        throw new Error('benchmark build-server cleanup production build root does not match the current run');
    }
    return { runId, namespace, buildRoot: expectedBuildRoot, startSource };
}

function safeBuildServerInventory(entries)
{
    return entries.map((entry) => ({
        processIdentity: entry.processIdentity,
        serverKind: entry.serverKind,
        runId: entry.runId,
        namespace: entry.namespace,
        buildRoot: entry.buildRoot,
        startSource: entry.startSource,
        pipeOrSocketIdentity: entry.pipeOrSocketIdentity,
        startedByCurrentRun: entry.startedByCurrentRun,
        sharedWithOtherRun: entry.sharedWithOtherRun,
        ownerState: entry.ownerState
    }));
}

function readPriorBenchmarkCleanupReceipt(receiptFile, binding)
{
    if (!fs.existsSync(receiptFile))
    {
        return [];
    }
    const stat = fs.lstatSync(receiptFile);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('benchmark build-server cleanup receipt must be a regular file');
    }
    const document = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const { contentDigest, ...payload } = document;
    if (Object.getPrototypeOf(document) !== Object.prototype
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(benchmarkCleanupReceiptFields)
    || document.schema !== benchmarkCleanupReceiptSchema
    || !['complete', 'failed'].includes(document.status)
    || !Array.isArray(document.events)
    || document.events.length === 0
    || !validBenchmarkCleanupBinding(document.binding, binding)
    || !document.events.every((event, index) =>
        validBenchmarkCleanupEvent(event, index, binding))
    || document.status !== document.events.at(-1).status
    || contentDigest !== digestDocument(payload))
    {
        throw new Error('benchmark build-server cleanup receipt integrity validation failed');
    }
    return document.events;
}

function writeBenchmarkCleanupReceipt(receiptFile, document)
{
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    const temporary = `${receiptFile}.next-${process.pid}`;
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
    });
    fs.renameSync(temporary, receiptFile);
}

export function prepareBenchmarkMeasurementBuildServers({
    root,
    env = process.env,
    discover = discoverDotnetBuildServers,
    terminate = terminateOrphanDotnetBuildServers,
    now = () => new Date().toISOString()
})
{
    const resolvedRoot = path.resolve(root);
    const invocation = runBoundBenchmarkBinding(resolvedRoot, env);
    if (invocation === null)
    {
        return { status: 'not-run-bound', receiptFile: null, document: null };
    }
    const binding = {
        runId: invocation.runId,
        namespace: invocation.namespace,
        buildRoot: invocation.buildRoot
    };
    const receiptFile = path.join(
        resolvedRoot,
        '.tmp/run-once',
        binding.namespace,
        'backend-benchmark-release-build.cleanup.json'
    );
    const priorEvents = readPriorBenchmarkCleanupReceipt(receiptFile, binding);
    const inventoryOptions = {
        root: resolvedRoot,
        currentRunId: binding.runId,
        currentNamespace: binding.namespace,
        currentStartSource: invocation.startSource,
        includeAttachedCurrentBinding: true
    };
    let recordsBefore = [];
    let inventoryBefore = [];
    let terminatedPids = [];
    let inventoryAfter = [];
    const failures = [];
    try
    {
        recordsBefore = discover({ root: resolvedRoot });
        inventoryBefore = dotnetBuildServerInventory(recordsBefore, inventoryOptions);
    }
    catch (error)
    {
        failures.push(`pre-cleanup inventory failed: ${error.message}`);
    }
    if (failures.length === 0)
    {
        try
        {
            terminatedPids = terminate(recordsBefore, {
                ...inventoryOptions,
                includeCurrentBinding: true,
                terminationGraceMs: 250
            });
            const selectedPids = new Set(inventoryBefore
                .filter((entry) => entry.startedByCurrentRun)
                .map((entry) => entry.processIdentity.pid));
            if (!Array.isArray(terminatedPids)
        || terminatedPids.some((pid) => !Number.isInteger(pid) || !selectedPids.has(pid)))
            {
                failures.push('cleanup returned a PID outside the exact pre-cleanup current-run inventory');
                terminatedPids = [];
            }
        }
        catch (error)
        {
            failures.push(`current-run cleanup failed: ${error.message}`);
        }
    }
    try
    {
        inventoryAfter = dotnetBuildServerInventory(discover({ root: resolvedRoot }), inventoryOptions);
        const remaining = inventoryAfter.filter((entry) => entry.startedByCurrentRun);
        if (remaining.length > 0)
        {
            failures.push(`current-run build servers remain after cleanup: ${remaining
                .map((entry) => entry.processIdentity.pid)
                .join(',')}`);
        }
    }
    catch (error)
    {
        failures.push(`post-cleanup inventory failed: ${error.message}`);
    }
    const event = {
        sequence: priorEvents.length + 1,
        startSource: invocation.startSource,
        observedAt: now(),
        status: failures.length === 0 ? 'complete' : 'failed',
        inventoryBefore: safeBuildServerInventory(inventoryBefore),
        selectedCurrentPids: inventoryBefore
            .filter((entry) => entry.startedByCurrentRun)
            .map((entry) => entry.processIdentity.pid),
        terminatedPids,
        inventoryAfter: safeBuildServerInventory(inventoryAfter),
        failures
    };
    const payload = {
        schema: benchmarkCleanupReceiptSchema,
        status: event.status,
        binding,
        events: [...priorEvents, event]
    };
    const document = { ...payload, contentDigest: digestDocument(payload) };
    writeBenchmarkCleanupReceipt(receiptFile, document);
    if (failures.length > 0)
    {
        const error = new Error(`benchmark build-server cleanup blocked: ${failures.join('; ')}`);
        error.receiptFile = receiptFile;
        throw error;
    }
    return { status: 'complete', receiptFile, document };
}

function parseCli(args)
{
    if (args.length !== 3 || args[0] !== 'prepare-benchmark-measurement' || args[1] !== '--root')
    {
        throw new Error('usage: dotnet-build-server-cleanup.mjs prepare-benchmark-measurement --root ROOT');
    }
    return { root: path.resolve(args[2]) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const result = prepareBenchmarkMeasurementBuildServers(parseCli(process.argv.slice(2)));
        if (result.status === 'not-run-bound')
        {
            console.log('[dotnet-build-server-cleanup] skipped non-run-bound benchmark build');
        }
        else
        {
            const event = result.document.events.at(-1);
            console.log(`[dotnet-build-server-cleanup] complete selected=${event.selectedCurrentPids.length} terminated=${event.terminatedPids.length} receipt=${result.receiptFile}`);
        }
    }
    catch (error)
    {
        console.error(`[dotnet-build-server-cleanup] ${error.message}`);
        process.exitCode = 1;
    }
}
