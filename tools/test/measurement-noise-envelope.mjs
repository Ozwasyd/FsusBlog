import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { performanceSteps } from './bundles/bundle-steps.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultPolicyFile = path.join(repositoryRoot, 'config/testing/measurement-noise-policy.json');
export const measurementNoiseSchema = 'fsusblog.measurement-noise-envelope.v1';
export const measurementNoiseAuthoritySchema = 'fsusblog.measurement-noise-authority.v1';
export const measurementNoiseAuthorityManifestSchema =
    'fsusblog.measurement-noise-authority-manifest.v1';
export const noisyMeasurementClassification = 'infra.noisy-measurement-window';

const requiredMetrics = Object.freeze([
    'hostCpuUtilization',
    'hostRunQueueOrCpuPressure',
    'cpuStealOrReadyTime',
    'currentRunCpuThrottleTime',
    'hostMemoryPressure',
    'currentRunMemoryEvents',
    'majorPageFaults',
    'hostDiskReadWriteBytes',
    'hostDiskQueueOrIoPressure',
    'currentRunIoBytes',
    'externalProcessCpuEstimate',
    'externalProcessIoEstimate',
    'collectorCoverage'
]);

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));
const finite = (value) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : 0;
const clamp = (value, minimum = 0, maximum = Number.POSITIVE_INFINITY) =>
    Math.min(maximum, Math.max(minimum, value));

export class MeasurementCollectorUnavailableError extends Error
{
    constructor(message, options)
    {
        super(message, options);
        this.name = 'MeasurementCollectorUnavailableError';
        this.classification = 'infra.measurement-collector-unavailable';
    }
}

export function readMeasurementNoisePolicy(file = defaultPolicyFile)
{
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (policy?.schema !== 'fsusblog.measurement-noise-policy.v1')
    {
        throw new Error('measurement noise policy schema is invalid');
    }
    const names = Object.keys(policy.metrics ?? {}).sort();
    if (JSON.stringify(names) !== JSON.stringify([...requiredMetrics].sort()))
    {
        throw new Error('measurement noise policy metric set must exactly match the envelope contract');
    }
    for (const [name, declaration] of Object.entries(policy.metrics))
    {
        if (!['blocking', 'diagnostic-only'].includes(declaration.qualification))
        {
            throw new Error(`${name} must declare blocking or diagnostic-only qualification`);
        }
        if (declaration.qualification === 'blocking'
      && !Number.isFinite(declaration.maximum)
      && !Number.isFinite(declaration.minimum))
        {
            throw new Error(`${name} blocking metric must declare a finite limit`);
        }
        if (declaration.qualification === 'diagnostic-only'
      && (declaration.maximum !== undefined || declaration.minimum !== undefined))
        {
            throw new Error(`${name} diagnostic-only metric must not declare a qualification limit`);
        }
    }
    return policy;
}

function parseKeyValues(text)
{
    return Object.fromEntries(String(text).trim().split(/\r?\n/u).filter(Boolean).map((line) =>
    {
        const [key, value] = line.trim().split(/\s+/u);
        return [key, Number(value)];
    }));
}

function readRequired(file, reader = fs.readFileSync)
{
    try
    {
        return reader(file, 'utf8');
    }
    catch (error)
    {
        throw new MeasurementCollectorUnavailableError(
            `required measurement collector source unavailable: ${file}: ${error.code ?? error.message}`,
            { cause: error }
        );
    }
}

function processTree(rootPid, reader)
{
    const pending = [rootPid];
    const seen = new Set();
    while (pending.length > 0)
    {
        const pid = pending.pop();
        if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid))
        {
            continue;
        }
        seen.add(pid);
        const children = readRequired(`/proc/${pid}/task/${pid}/children`, reader).trim();
        for (const childPid of children.split(/\s+/u).filter(Boolean).map(Number))
        {
            const identity = readProcessIdentity(childPid, reader, { strict: false });
            if (identity && !['Z', 'X', 'x'].includes(identity.state))
            {
                pending.push(childPid);
            }
        }
    }
    return [...seen];
}

function readProcessIdentity(pid, reader, { strict = true } = {})
{
    try
    {
        const stat = readRequired(`/proc/${pid}/stat`, reader);
        const close = stat.lastIndexOf(')');
        const statFields = stat.slice(close + 1).trim().split(/\s+/u);
        const state = statFields[0];
        const startTimeTicks = Number(statFields[19]);
        if (close < 0 || !/^[A-Z]$/iu.test(state) || !Number.isFinite(startTimeTicks) || startTimeTicks < 0)
        {
            throw new MeasurementCollectorUnavailableError(`process identity is malformed: /proc/${pid}/stat`);
        }
        return {
            pid,
            command: stat.slice(stat.indexOf('(') + 1, close),
            state,
            startTimeTicks
        };
    }
    catch (error)
    {
        if (strict && error instanceof MeasurementCollectorUnavailableError)
        {
            throw error;
        }
        return null;
    }
}

function readPressure(file, reader)
{
    const text = readRequired(file, reader);
    const value = text.match(/^some\s+.*?avg10=(\d+(?:\.\d+)?)/mu)?.[1];
    if (value === undefined)
    {
        throw new MeasurementCollectorUnavailableError(`required pressure metric is malformed: ${file}`);
    }
    return Number(value) / 100;
}

function cgroupDirectory(rootPid, reader)
{
    const record = readRequired(`/proc/${rootPid}/cgroup`, reader)
        .split(/\r?\n/u).find((line) => line.startsWith('0::'));
    if (!record)
    {
        throw new MeasurementCollectorUnavailableError('current run cgroup v2 identity is unavailable');
    }
    const relative = record.slice(3).replace(/^\/+/u, '');
    return path.join('/sys/fs/cgroup', relative);
}

function cgroupThrottleUsec(cgroup, cpuStat, reader)
{
    if (Number.isFinite(cpuStat.throttled_usec))
    {
        return cpuStat.throttled_usec;
    }
    const root = '/sys/fs/cgroup';
    let current = cgroup;
    let controllerObserved = false;
    while (current.startsWith(root))
    {
        let cpuMaximum;
        try
        {
            cpuMaximum = readRequired(path.join(current, 'cpu.max'), reader).trim().split(/\s+/u)[0];
            controllerObserved = true;
        }
        catch (error)
        {
            if (error.cause?.code !== 'ENOENT')
            {
                throw error;
            }
        }
        if (cpuMaximum && cpuMaximum !== 'max')
        {
            throw new MeasurementCollectorUnavailableError(
                `current-run CPU throttle counter is unavailable under quota-bearing cgroup: ${current}`
            );
        }
        if (current === root)
        {
            break;
        }
        current = path.dirname(current);
    }
    if (!controllerObserved)
    {
        throw new MeasurementCollectorUnavailableError('CPU cgroup quota and throttle authority are unavailable');
    }
    return 0;
}

function readExternalProcesses(currentPids, reader, listProcesses)
{
    const identities = [];
    const records = [];
    let unknownCount = 0;
    let names;
    try
    {
        names = listProcesses().filter((name) => /^\d+$/u.test(name))
            .map(Number).sort((left, right) => right - left).map(String);
    }
    catch (error)
    {
        throw new MeasurementCollectorUnavailableError(`external process inventory unavailable: ${error.code ?? error.message}`);
    }
    for (const name of names)
    {
        const pid = Number(name);
        if (currentPids.has(pid))
        {
            continue;
        }
        try
        {
            const record = readProcessIdentity(pid, reader, { strict: false });
            if (!record)
            {
                unknownCount += 1;
                continue;
            }
            records.push(record);
        }
        catch
        {
            unknownCount += 1;
        }
    }
    records.sort((left, right) =>
        right.startTimeTicks - left.startTimeTicks || right.pid - left.pid);
    identities.push(...records.slice(0, 64).map(({ pid, command }) =>
        ({ pid, command, status: 'observed' })));
    const inventoryCount = records.length + unknownCount;
    return {
        records,
        identities,
        unknownCount,
        inventoryCount,
        identityCoverage: inventoryCount === 0 ? 1 : records.length / inventoryCount
    };
}

function readCgroupIoBytes(cgroup, reader)
{
    const text = readRequired(path.join(cgroup, 'io.stat'), reader);
    return text.trim().split(/\r?\n/u).filter(Boolean).reduce((total, line) =>
    {
        const fields = line.trim().split(/\s+/u).slice(1);
        const values = Object.fromEntries(fields.map((field) =>
        {
            const [name, value] = field.split('=');
            return [name, Number(value)];
        }));
        if (!Number.isFinite(values.rbytes) || !Number.isFinite(values.wbytes))
        {
            throw new MeasurementCollectorUnavailableError(`current-run cgroup I/O collector is malformed: ${cgroup}`);
        }
        return total + values.rbytes + values.wbytes;
    }, 0);
}

export function createLinuxMeasurementCollector({
    rootPid = process.pid,
    cgroupPath = null,
    reader = fs.readFileSync,
    listProcesses = () => fs.readdirSync('/proc'),
    monotonicNow = () => Number(process.hrtime.bigint()) / 1e6,
    clockTicks = 100
} = {})
{
    if (process.platform !== 'linux')
    {
        throw new MeasurementCollectorUnavailableError(`measurement qualification is unsupported on ${process.platform}`);
    }
    const optional = (source, collect, errors) =>
    {
        try
        {
            const value = collect();
            if (!Number.isFinite(value))
            {
                throw new MeasurementCollectorUnavailableError(`${source} collector is malformed`);
            }
            return value;
        }
        catch (error)
        {
            errors.push({
                source,
                classification: error.classification ?? 'infra.measurement-collector-unavailable',
                message: error.message
            });
            return null;
        }
    };
    return {
        collect()
        {
            const statFields = readRequired('/proc/stat', reader).split(/\r?\n/u)[0].trim().split(/\s+/u).slice(1).map(Number);
            if (statFields.length < 8 || statFields.some((value) => !Number.isFinite(value)))
            {
                throw new MeasurementCollectorUnavailableError('/proc/stat CPU collector is malformed');
            }
            const [user, nice, system, idle, iowait, irq, softirq, steal] = statFields;
            const load = readRequired('/proc/loadavg', reader).trim().split(/\s+/u);
            const runnable = Number(load[3]?.split('/')[0]);
            if (!Number.isFinite(runnable))
            {
                throw new MeasurementCollectorUnavailableError('/proc/loadavg run queue is malformed');
            }
            const diskBytes = readRequired('/proc/diskstats', reader).trim().split(/\r?\n/u).filter(Boolean)
                .reduce((total, line) =>
                {
                    const fields = line.trim().split(/\s+/u);
                    const name = fields[2] ?? '';
                    if (/^(?:loop|ram|fd|sr|dm-)\d*/u.test(name))
                    {
                        return total;
                    }
                    return total + ((Number(fields[5]) || 0) + (Number(fields[9]) || 0)) * 512;
                }, 0);
            const cgroup = cgroupPath ?? cgroupDirectory(rootPid, reader);
            let treePids = [];
            let cgroupPids = [];
            for (let attempt = 0; attempt < 3; attempt += 1)
            {
                try
                {
                    const before = readRequired(path.join(cgroup, 'cgroup.procs'), reader).trim()
                        .split(/\s+/u).filter(Boolean).map(Number).sort((left, right) => left - right);
                    treePids = processTree(rootPid, reader).sort((left, right) => left - right);
                    const after = readRequired(path.join(cgroup, 'cgroup.procs'), reader).trim()
                        .split(/\s+/u).filter(Boolean).map(Number).sort((left, right) => left - right);
                    cgroupPids = after;
                    if (JSON.stringify(before) === JSON.stringify(after)
            && JSON.stringify(treePids) === JSON.stringify(after))
                    {
                        break;
                    }
                }
                catch (error)
                {
                    if (attempt === 2)
                    {
                        throw error;
                    }
                }
            }
            if (JSON.stringify(treePids) !== JSON.stringify(cgroupPids))
            {
                throw new MeasurementCollectorUnavailableError(
                    `current-run cgroup is shared or incomplete: tree=${treePids.join(',')} cgroup=${cgroupPids.join(',')}`
                );
            }
            const cpuStat = parseKeyValues(readRequired(path.join(cgroup, 'cpu.stat'), reader));
            if (!Number.isFinite(cpuStat.usage_usec))
            {
                throw new MeasurementCollectorUnavailableError(`current-run cgroup CPU collector is malformed: ${cgroup}`);
            }
            const collectorErrors = [];
            const cpuThrottleUsec = optional(
                'currentRunCpuThrottleTime',
                () => cgroupThrottleUsec(cgroup, cpuStat, reader),
                collectorErrors
            );
            const memoryEvents = optional('currentRunMemoryEvents', () =>
            {
                const events = parseKeyValues(readRequired(path.join(cgroup, 'memory.events'), reader));
                const names = ['high', 'max', 'oom', 'oom_kill'];
                if (names.some((name) => !Number.isFinite(events[name])))
                {
                    throw new MeasurementCollectorUnavailableError(
                        `current-run cgroup memory event collector is malformed: ${cgroup}`
                    );
                }
                return names.reduce((total, name) => total + events[name], 0);
            }, collectorErrors);
            const majorPageFaults = optional('majorPageFaults', () =>
            {
                const memoryStat = parseKeyValues(readRequired(path.join(cgroup, 'memory.stat'), reader));
                return memoryStat.pgmajfault;
            }, collectorErrors);
            const ioBytes = optional(
                'currentRunIoBytes',
                () => readCgroupIoBytes(cgroup, reader),
                collectorErrors
            );
            const currentPids = new Set(treePids);
            const externalProcesses = readExternalProcesses(currentPids, reader, listProcesses);
            const collectorSourceCount = 4;
            return {
                collectedAtMonotonicMs: monotonicNow(),
                hostCpu: {
                    totalTicks: statFields.reduce((total, value) => total + value, 0),
                    idleTicks: idle + iowait,
                    stealTicks: steal,
                    busyTicks: user + nice + system + irq + softirq + steal
                },
                hostCpuCount: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
                runnable,
                cpuPressure: readPressure('/proc/pressure/cpu', reader),
                memoryPressure: readPressure('/proc/pressure/memory', reader),
                ioPressure: readPressure('/proc/pressure/io', reader),
                diskBytes,
                currentRun: {
                    cpuTicks: Number(cpuStat.usage_usec) / 1e6 * clockTicks,
                    cpuThrottleUsec,
                    memoryEvents,
                    majorPageFaults,
                    ioBytes
                },
                externalProcesses: {
                    identities: externalProcesses.identities,
                    unknownCount: externalProcesses.unknownCount,
                    inventoryCount: externalProcesses.inventoryCount,
                    identityCoverage: externalProcesses.identityCoverage
                },
                collectorErrors,
                clockTicks,
                collectorCoverage: (collectorSourceCount - collectorErrors.length) / collectorSourceCount
            };
        }
    };
}

export function deriveMeasurementObservation(previous, current)
{
    if (!previous || !current)
    {
        throw new MeasurementCollectorUnavailableError('measurement interval requires two snapshots');
    }
    const durationMs = current.collectedAtMonotonicMs - previous.collectedAtMonotonicMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0)
    {
        throw new MeasurementCollectorUnavailableError('measurement collector monotonic interval is invalid');
    }
    const seconds = durationMs / 1000;
    const cpuDelta = current.hostCpu.totalTicks - previous.hostCpu.totalTicks;
    const busyDelta = current.hostCpu.busyTicks - previous.hostCpu.busyTicks;
    const stealDelta = current.hostCpu.stealTicks - previous.hostCpu.stealTicks;
    const runCpuTicks = current.currentRun.cpuTicks - previous.currentRun.cpuTicks;
    const diskDelta = current.diskBytes - previous.diskBytes;
    const runIoDelta = finite(current.currentRun.ioBytes) !== null
      && finite(previous.currentRun.ioBytes) !== null
        ? current.currentRun.ioBytes - previous.currentRun.ioBytes
        : null;
    const hostCpuUtilization = clamp(ratio(busyDelta, cpuDelta), 0, 1);
    return {
        durationMs,
        metrics: {
            hostCpuUtilization,
            hostRunQueueOrCpuPressure: Math.max(
                current.cpuPressure,
                ratio(current.runnable, current.hostCpuCount)
            ),
            cpuStealOrReadyTime: clamp(ratio(stealDelta, cpuDelta), 0, 1),
            currentRunCpuThrottleTime: finite(current.currentRun.cpuThrottleUsec) !== null
          && finite(previous.currentRun.cpuThrottleUsec) !== null
                ? clamp(
            ratio(
              current.currentRun.cpuThrottleUsec - previous.currentRun.cpuThrottleUsec,
              durationMs * 1000
            ),
            0
          )
                : null,
            hostMemoryPressure: current.memoryPressure,
            currentRunMemoryEvents: finite(current.currentRun.memoryEvents) !== null
          && finite(previous.currentRun.memoryEvents) !== null
                ? Math.max(0, current.currentRun.memoryEvents - previous.currentRun.memoryEvents)
                : null,
            majorPageFaults: finite(current.currentRun.majorPageFaults) !== null
          && finite(previous.currentRun.majorPageFaults) !== null
                ? Math.max(0, current.currentRun.majorPageFaults - previous.currentRun.majorPageFaults) / seconds
                : null,
            hostDiskReadWriteBytes: Math.max(0, diskDelta) / seconds,
            hostDiskQueueOrIoPressure: current.ioPressure,
            currentRunIoBytes: runIoDelta === null ? null : Math.max(0, runIoDelta) / seconds,
            externalProcessCpuEstimate: Math.max(0, busyDelta - runCpuTicks)
        / current.clockTicks / seconds,
            externalProcessIoEstimate: runIoDelta === null
                ? null
                : Math.max(0, diskDelta - runIoDelta) / seconds,
            collectorCoverage: Math.min(previous.collectorCoverage, current.collectorCoverage)
        },
        externalProcesses: current.externalProcesses,
        collectorErrors: [...(previous.collectorErrors ?? []), ...(current.collectorErrors ?? [])]
    };
}

export function evaluateMeasurementObservation(observation, policy = readMeasurementNoisePolicy())
{
    const evaluations = requiredMetrics.map((name) =>
    {
        const declaration = policy.metrics[name];
        const value = finite(observation?.metrics?.[name]);
        const unavailable = value === null;
        const exceeded = declaration.qualification === 'blocking' && (
            unavailable
      || (Number.isFinite(declaration.maximum) && value > declaration.maximum)
      || (Number.isFinite(declaration.minimum) && value < declaration.minimum)
        );
        return { name, value, ...declaration, unavailable, exceeded };
    });
    const blockingFailures = evaluations.filter((entry) => entry.exceeded);
    return {
        status: blockingFailures.length === 0 ? 'clean' : 'noisy',
        qualificationEligible: blockingFailures.length === 0,
        classification: blockingFailures.length === 0 ? null : noisyMeasurementClassification,
        evaluations,
        blockingFailures
    };
}

function atomicWriteJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function contentDigest(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function receiptWithoutDigest(receipt)
{
    const candidate = structuredClone(receipt);
    if (candidate.authority)
    {
        delete candidate.authority.contentDigest;
    }
    return candidate;
}

function authorityWindowDirectory(authorityRoot, runId, windowId)
{
    const identity = contentDigest({ runId, windowId }).slice('sha256:'.length);
    return path.join(authorityRoot, identity);
}

function authorityManifestWindowDirectory(authorityManifestRoot, runId, windowId)
{
    const identity = contentDigest({ runId, windowId }).slice('sha256:'.length);
    return path.join(authorityManifestRoot, identity);
}

const authorityReceiptNamePattern =
    /^\d{6}-\d{6}-[a-f0-9]{64}\.measurement-noise\.json$/u;
const authorityManifestNamePattern =
    /^\d{6}-[a-f0-9]{64}\.measurement-noise-manifest\.json$/u;
const authorityWindowNamePattern = /^[a-f0-9]{64}$/u;

function assertWindowRootLayout(root, label)
{
    if (!fs.existsSync(root))
    {
        return;
    }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
    {
        throw new Error(`${label} root is not a real directory: ${root}`);
    }
    for (const name of fs.readdirSync(root))
    {
        const directory = path.join(root, name);
        const entry = fs.lstatSync(directory);
        if (!authorityWindowNamePattern.test(name)
      || !entry.isDirectory()
      || entry.isSymbolicLink())
        {
            throw new Error(`${label} root contains an unexpected entry: ${directory}`);
        }
    }
}

function strictRegularFiles(directory, pattern, label, { required = false } = {})
{
    if (!fs.existsSync(directory))
    {
        if (required)
        {
            throw new Error(`${label} directory is missing: ${directory}`);
        }
        return [];
    }
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    {
        throw new Error(`${label} path is not a real directory: ${directory}`);
    }
    return fs.readdirSync(directory).sort().map((name) =>
    {
        if (!pattern.test(name))
        {
            throw new Error(`${label} contains an unexpected entry: ${path.join(directory, name)}`);
        }
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            throw new Error(`${label} entry is not a regular file: ${file}`);
        }
        return file;
    });
}

function readAuthorityDirectoryEntries(directory, options)
{
    return strictRegularFiles(
        directory,
        authorityReceiptNamePattern,
        'measurement noise authority',
        options
    ).map((file) =>
    {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            throw new Error(`measurement noise authority receipt is not a regular file: ${file}`);
        }
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        const filenameDigest = /^\d{6}-\d{6}-([a-f0-9]{64})\.measurement-noise\.json$/u
            .exec(path.basename(file))?.[1];
        if (receipt?.authority?.contentDigest !== `sha256:${filenameDigest}`)
        {
            throw new Error(`measurement noise authority filename digest mismatch: ${file}`);
        }
        return { file, receipt };
    });
}

function manifestWithoutDigest(manifest)
{
    const candidate = structuredClone(manifest);
    delete candidate.contentDigest;
    return candidate;
}

function rootRosterDigest(authorityRoot, receipts)
{
    return contentDigest({ authorityRoot, receipts });
}

function appendManifestSnapshot(previous, appendedReceipt)
{
    const manifestSequence = (previous?.manifestSequence ?? 0) + 1;
    const attempts = structuredClone(previous?.attempts ?? []);
    const authorityRoots = structuredClone(previous?.authorityRoots ?? []);
    const priorAttempt = attempts.at(-1) ?? null;
    let attempt;
    if (appendedReceipt.attemptSequence === priorAttempt?.attemptSequence)
    {
        if (priorAttempt.attemptId !== appendedReceipt.attemptId
      || priorAttempt.authorityRoot !== appendedReceipt.authorityRoot
      || priorAttempt.terminal === true
      || appendedReceipt.eventSequence !== priorAttempt.receipts.length + 1)
        {
            throw new Error('measurement noise manifest cannot rewrite the current attempt roster');
        }
        attempt = priorAttempt;
    }
    else
    {
        if (appendedReceipt.attemptSequence !== attempts.length + 1
      || appendedReceipt.eventSequence !== 1
      || (priorAttempt && priorAttempt.terminal !== true))
        {
            throw new Error('measurement noise manifest attempt roster is not contiguous');
        }
        attempt = {
            attemptId: appendedReceipt.attemptId,
            attemptSequence: appendedReceipt.attemptSequence,
            authorityRoot: appendedReceipt.authorityRoot,
            receipts: [],
            chainHeadDigest: null,
            terminal: false
        };
        attempts.push(attempt);
    }
    const expectedPreviousReceiptDigest = previous?.chainHeadDigest ?? null;
    if (appendedReceipt.previousReceiptDigest !== expectedPreviousReceiptDigest)
    {
        throw new Error('measurement noise manifest receipt chain head is broken');
    }
    attempt.receipts.push({
        eventSequence: appendedReceipt.eventSequence,
        authorityFile: appendedReceipt.authorityFile,
        receiptDigest: appendedReceipt.receiptDigest,
        previousReceiptDigest: appendedReceipt.previousReceiptDigest,
        terminal: appendedReceipt.terminal
    });
    attempt.chainHeadDigest = appendedReceipt.receiptDigest;
    attempt.terminal = appendedReceipt.terminal;

    let rootRoster = authorityRoots.find(
        (candidate) => candidate.authorityRoot === appendedReceipt.authorityRoot
    );
    if (!rootRoster)
    {
        rootRoster = {
            authorityRoot: appendedReceipt.authorityRoot,
            receipts: [],
            authorityRootDigest: null
        };
        authorityRoots.push(rootRoster);
    }
    rootRoster.receipts.push({
        authorityFile: appendedReceipt.authorityFile,
        attemptSequence: appendedReceipt.attemptSequence,
        eventSequence: appendedReceipt.eventSequence,
        receiptDigest: appendedReceipt.receiptDigest
    });
    rootRoster.authorityRootDigest = rootRosterDigest(
        rootRoster.authorityRoot,
        rootRoster.receipts
    );

    const document = {
        schema: measurementNoiseAuthorityManifestSchema,
        runId: appendedReceipt.runId,
        windowId: appendedReceipt.windowId,
        manifestSequence,
        previousManifestDigest: previous?.contentDigest ?? null,
        appendedReceipt,
        attempts,
        authorityRoots,
        chainHeadDigest: appendedReceipt.receiptDigest,
        contentDigest: null
    };
    document.contentDigest = contentDigest(manifestWithoutDigest(document));
    return document;
}

function readAuthorityManifestSequence(authorityManifestRoot, runId, windowId)
{
    if (!authorityManifestRoot)
    {
        return [];
    }
    assertWindowRootLayout(
        path.resolve(authorityManifestRoot),
        'measurement noise authority manifest'
    );
    const directory = authorityManifestWindowDirectory(
        path.resolve(authorityManifestRoot),
        runId,
        windowId
    );
    const files = strictRegularFiles(
        directory,
        authorityManifestNamePattern,
        'measurement noise authority manifest'
    );
    let previous = null;
    return files.map((file, index) =>
    {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        const filenameDigest = /^\d{6}-([a-f0-9]{64})\.measurement-noise-manifest\.json$/u
            .exec(path.basename(file))?.[1];
        if (manifest?.schema !== measurementNoiseAuthorityManifestSchema
      || manifest.runId !== runId
      || manifest.windowId !== windowId
      || manifest.manifestSequence !== index + 1
      || manifest.previousManifestDigest !== (previous?.contentDigest ?? null)
      || manifest.contentDigest !== `sha256:${filenameDigest}`
      || manifest.contentDigest !== contentDigest(manifestWithoutDigest(manifest)))
        {
            throw new Error(`measurement noise authority manifest chain is invalid: ${file}`);
        }
        const rebuilt = appendManifestSnapshot(previous, manifest.appendedReceipt);
        if (!isDeepStrictEqual(rebuilt, manifest))
        {
            throw new Error(`measurement noise authority manifest roster is invalid: ${file}`);
        }
        previous = manifest;
        return manifest;
    });
}

function appendedReceiptBinding(authorityRoot, authorityFile, receipt)
{
    const relative = path.relative(authorityRoot, authorityFile).replaceAll(path.sep, '/');
    if (!relative || relative.startsWith('../') || path.posix.isAbsolute(relative))
    {
        throw new Error('measurement noise authority file escapes its declared root');
    }
    return {
        runId: receipt.authority.runId,
        windowId: receipt.windowId,
        attemptId: receipt.authority.attemptId,
        attemptSequence: receipt.authority.attemptSequence,
        eventSequence: receipt.authority.eventSequence,
        authorityRoot,
        authorityFile: relative,
        receiptDigest: receipt.authority.contentDigest,
        previousReceiptDigest: receipt.authority.previousReceiptDigest,
        terminal: receipt.authority.terminal
    };
}

function loadAuthorityManifestState({
    authorityManifestRoot,
    runId,
    windowId,
    policy = readMeasurementNoisePolicy()
})
{
    const manifests = readAuthorityManifestSequence(authorityManifestRoot, runId, windowId);
    const head = manifests.at(-1) ?? null;
    if (!head)
    {
        return { manifests, head: null, receipts: [] };
    }
    const entries = head.authorityRoots.flatMap((rootRoster) =>
    {
        const authorityRoot = path.resolve(rootRoster.authorityRoot);
        assertWindowRootLayout(authorityRoot, 'measurement noise authority');
        const directory = authorityWindowDirectory(authorityRoot, runId, windowId);
        const actual = readAuthorityDirectoryEntries(directory, { required: true });
        const actualRoster = actual.map(({ file, receipt }) => ({
            authorityFile: path.relative(authorityRoot, file).replaceAll(path.sep, '/'),
            attemptSequence: receipt.authority.attemptSequence,
            eventSequence: receipt.authority.eventSequence,
            receiptDigest: receipt.authority.contentDigest
        }));
        if (!isDeepStrictEqual(actualRoster, rootRoster.receipts)
      || rootRoster.authorityRootDigest !== rootRosterDigest(authorityRoot, actualRoster))
        {
            throw new Error(`measurement noise authority root roster changed: ${authorityRoot}`);
        }
        return actual;
    });
    const receipts = validateMeasurementNoiseAuthoritySequence(
        entries.map(({ receipt }) => receipt),
        { expectedRunId: runId, expectedWindowId: windowId, policy }
    );
    if (receipts.at(-1).authority.contentDigest !== head.chainHeadDigest
    || receipts.length !== head.manifestSequence)
    {
        throw new Error('measurement noise authority manifest chain head does not match its receipts');
    }
    return { manifests, head, receipts };
}

export function inspectMeasurementNoiseAuthorityManifest({
    authorityManifestRoot,
    runId,
    windowId,
    policy = readMeasurementNoisePolicy()
})
{
    return loadAuthorityManifestState({
        authorityManifestRoot,
        runId,
        windowId,
        policy
    });
}

function assertNoUnregisteredAuthorityEntries({
    roots,
    registeredRoots,
    runId,
    windowId
})
{
    for (const candidate of roots)
    {
        if (!String(candidate ?? '').trim())
        {
            continue;
        }
        const root = path.resolve(candidate);
        if (registeredRoots.has(root))
        {
            continue;
        }
        assertWindowRootLayout(root, 'measurement noise authority');
        const entries = readAuthorityDirectoryEntries(
            authorityWindowDirectory(root, runId, windowId)
        );
        if (entries.length > 0)
        {
            throw new Error(`measurement noise authority root is absent from the expected manifest: ${root}`);
        }
    }
}

export function bindMeasurementNoiseAuthority(receipt, {
    runId,
    attemptId = randomUUID(),
    attemptSequence = 1,
    eventSequence = 1,
    previousReceiptDigest = null,
    terminal = true
} = {})
{
    if (!String(runId ?? '').trim())
    {
        throw new Error('measurement noise authority run id is required');
    }
    if (!String(receipt?.windowId ?? '').trim())
    {
        throw new Error('measurement noise authority window id is required');
    }
    if (!String(attemptId ?? '').trim())
    {
        throw new Error('measurement noise authority attempt id is required');
    }
    if (!Number.isInteger(attemptSequence) || attemptSequence <= 0)
    {
        throw new Error('measurement noise authority attempt sequence must be positive');
    }
    if (!Number.isInteger(eventSequence) || eventSequence <= 0)
    {
        throw new Error('measurement noise authority event sequence must be positive');
    }
    const bound = {
        ...structuredClone(receipt),
        authority: {
            schema: measurementNoiseAuthoritySchema,
            runId,
            windowId: receipt.windowId,
            attemptId,
            attemptSequence,
            eventSequence,
            previousReceiptDigest,
            terminal,
            contentDigest: null
        }
    };
    bound.authority.contentDigest = contentDigest(receiptWithoutDigest(bound));
    return bound;
}

export function validateMeasurementNoiseAuthoritySequence(receipts, {
    expectedRunId = null,
    expectedWindowId = null,
    policy = readMeasurementNoisePolicy()
} = {})
{
    if (!Array.isArray(receipts) || receipts.length === 0)
    {
        throw new Error('measurement noise authority sequence is empty');
    }
    const unique = new Map();
    for (const receipt of receipts)
    {
        validateMeasurementNoiseAuthorityReceipt(receipt, { expectedWindowId, policy });
        const digest = receipt.authority.contentDigest;
        const existing = unique.get(digest);
        if (existing && !isDeepStrictEqual(existing, receipt))
        {
            throw new Error(`measurement noise authority digest collision: ${digest}`);
        }
        unique.set(digest, receipt);
    }
    const sequence = [...unique.values()].sort((left, right) =>
        left.authority.attemptSequence - right.authority.attemptSequence
    || left.authority.eventSequence - right.authority.eventSequence);
    const runIds = new Set(sequence.map((receipt) => receipt.authority.runId));
    const windowIds = new Set(sequence.map((receipt) => receipt.windowId));
    if (runIds.size !== 1 || windowIds.size !== 1)
    {
        throw new Error('measurement noise authority sequence must contain one run and one window');
    }
    const runId = sequence[0].authority.runId;
    const windowId = sequence[0].windowId;
    if (expectedRunId !== null && runId !== expectedRunId)
    {
        throw new Error(`measurement noise authority run mismatch: expected ${expectedRunId}, got ${runId}`);
    }
    if (expectedWindowId !== null && windowId !== expectedWindowId)
    {
        throw new Error(`measurement noise authority window mismatch: expected ${expectedWindowId}, got ${windowId}`);
    }
    let previous = null;
    let attemptSequence = 0;
    let eventSequence = 0;
    let attemptId = null;
    const terminalAttempts = new Set();
    for (const receipt of sequence)
    {
        const authority = receipt.authority;
        if (authority.attemptSequence === attemptSequence)
        {
            if (authority.attemptId !== attemptId || authority.eventSequence !== eventSequence + 1)
            {
                throw new Error('measurement noise authority event sequence is not contiguous');
            }
            if (terminalAttempts.has(attemptSequence))
            {
                throw new Error('measurement noise authority contains an event after a terminal receipt');
            }
        }
        else
        {
            if (authority.attemptSequence !== attemptSequence + 1 || authority.eventSequence !== 1)
            {
                throw new Error('measurement noise authority attempt sequence is not contiguous');
            }
            if (attemptSequence > 0 && !terminalAttempts.has(attemptSequence))
            {
                throw new Error('measurement noise authority starts a new attempt before the prior attempt is terminal');
            }
            attemptSequence = authority.attemptSequence;
            attemptId = authority.attemptId;
        }
        if (authority.previousReceiptDigest !== (previous?.authority?.contentDigest ?? null))
        {
            throw new Error('measurement noise authority hash chain is broken');
        }
        eventSequence = authority.eventSequence;
        if (authority.terminal)
        {
            terminalAttempts.add(attemptSequence);
        }
        previous = receipt;
    }
    return sequence;
}

export function readMeasurementNoiseAuthoritySequence(evidenceFile, {
    authorityRoot = process.env.FSUSBLOG_MEASUREMENT_AUTHORITY_ROOT
    || `${path.resolve(evidenceFile)}.authority`,
    authorityManifestRoot = process.env.FSUSBLOG_MEASUREMENT_AUTHORITY_MANIFEST_ROOT
    || `${path.resolve(authorityRoot)}.manifest`,
    priorAuthorityRoots = [],
    expectedRunId = null,
    expectedWindowId = null,
    policy = readMeasurementNoisePolicy()
} = {})
{
    const latest = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    const runId = expectedRunId ?? latest?.authority?.runId;
    const windowId = expectedWindowId ?? latest?.windowId;
    if (!String(runId ?? '').trim() || !String(windowId ?? '').trim())
    {
        throw new Error('measurement noise latest receipt has no authority identity');
    }
    const state = loadAuthorityManifestState({
        authorityManifestRoot,
        runId,
        windowId,
        policy
    });
    if (!state.head)
    {
        throw new Error('measurement noise expected attempt manifest is missing');
    }
    const registeredRoots = new Set(
        state.head.authorityRoots.map(({ authorityRoot: candidate }) => path.resolve(candidate))
    );
    assertNoUnregisteredAuthorityEntries({
        roots: [...priorAuthorityRoots, authorityRoot],
        registeredRoots,
        runId,
        windowId
    });
    const sequence = validateMeasurementNoiseAuthoritySequence(state.receipts, {
        expectedRunId: runId,
        expectedWindowId: windowId,
        policy
    });
    if (sequence.at(-1).authority.contentDigest !== latest.authority.contentDigest)
    {
        throw new Error('measurement noise latest receipt does not match the authority chain head');
    }
    return sequence;
}

export function createMeasurementNoiseEnvelope({
    windowId,
    evidenceFile,
    runId = process.env.FSUSBLOG_MEASUREMENT_RUN_ID
    || process.env.FSUSBLOG_TEST_RUN_ID
    || `standalone-${randomUUID()}`,
    attemptId = randomUUID(),
    attemptSequence = null,
    authorityRoot = process.env.FSUSBLOG_MEASUREMENT_AUTHORITY_ROOT
    || (evidenceFile ? `${path.resolve(evidenceFile)}.authority` : null),
    authorityManifestRoot = process.env.FSUSBLOG_MEASUREMENT_AUTHORITY_MANIFEST_ROOT
    || (authorityRoot ? `${path.resolve(authorityRoot)}.manifest` : null),
    priorAuthorityRoots = [],
    policy = readMeasurementNoisePolicy(),
    collector = createLinuxMeasurementCollector(),
    now = () => performance.now(),
    wait = sleep,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
} = {})
{
    if (!String(windowId ?? '').trim())
    {
        throw new Error('measurement window id is required');
    }
    if (!String(runId ?? '').trim())
    {
        throw new Error('measurement run id is required');
    }
    const resolvedAuthorityRoot = authorityRoot ? path.resolve(authorityRoot) : null;
    if (resolvedAuthorityRoot && !authorityManifestRoot)
    {
        throw new Error('measurement noise authority persistence requires an expected attempt manifest');
    }
    const resolvedAuthorityManifestRoot = authorityManifestRoot
        ? path.resolve(authorityManifestRoot)
        : null;
    const manifestState = loadAuthorityManifestState({
        authorityManifestRoot: resolvedAuthorityManifestRoot,
        runId,
        windowId,
        policy
    });
    const registeredRoots = new Set(
        (manifestState.head?.authorityRoots ?? [])
            .map(({ authorityRoot: candidate }) => path.resolve(candidate))
    );
    assertNoUnregisteredAuthorityEntries({
        roots: [...priorAuthorityRoots, resolvedAuthorityRoot],
        registeredRoots,
        runId,
        windowId
    });
    const authorityDirectory = resolvedAuthorityRoot
        ? authorityWindowDirectory(resolvedAuthorityRoot, runId, windowId)
        : null;
    if (authorityDirectory)
    {
        fs.mkdirSync(authorityDirectory, { recursive: true });
    }
    const priorReceipts = manifestState.receipts;
    const priorSequence = priorReceipts.length > 0
        ? validateMeasurementNoiseAuthoritySequence(priorReceipts, {
        expectedRunId: runId,
        expectedWindowId: windowId,
        policy
      })
        : [];
    const lastPrior = priorSequence.at(-1) ?? null;
    const nextAttemptSequence = (lastPrior?.authority?.attemptSequence ?? 0) + 1;
    const resolvedAttemptSequence = attemptSequence === null
        ? nextAttemptSequence
        : Number(attemptSequence);
    if (!Number.isInteger(resolvedAttemptSequence)
    || resolvedAttemptSequence <= 0
    || resolvedAttemptSequence !== nextAttemptSequence)
    {
        throw new Error(
            `measurement attempt sequence must be the next authority attempt: `
      + `expected ${nextAttemptSequence}, got ${String(attemptSequence)}`
        );
    }
    if (lastPrior && lastPrior.authority.terminal !== true)
    {
        throw new Error('measurement prior authority attempt has no terminal receipt');
    }
    let admissionStartedAtMs;
    let measurementStartedAtMs;
    let previousSnapshot;
    let timer;
    const during = [];
    let firstNoisyObservation = null;
    let previousReceiptDigest = lastPrior?.authority?.contentDigest ?? null;
    let eventSequence = 0;
    let terminalPersisted = false;
    let previousManifest = manifestState.head;

    const collectInterval = async (durationMs) =>
    {
        const before = collector.collect();
        await wait(durationMs);
        const after = collector.collect();
        return deriveMeasurementObservation(before, after);
    };
    const persist = (document, { terminal = true } = {}) =>
    {
        if (terminalPersisted)
        {
            throw new Error('measurement authority attempt is already terminal');
        }
        eventSequence += 1;
        const receipt = bindMeasurementNoiseAuthority(document, {
            runId,
            attemptId,
            attemptSequence: resolvedAttemptSequence,
            eventSequence,
            previousReceiptDigest,
            terminal
        });
        const digest = receipt.authority.contentDigest.slice('sha256:'.length);
        if (authorityDirectory)
        {
            const refreshedManifestState = loadAuthorityManifestState({
                authorityManifestRoot: resolvedAuthorityManifestRoot,
                runId,
                windowId,
                policy
            });
            if (refreshedManifestState.head?.contentDigest !== previousManifest?.contentDigest)
            {
                throw new Error('measurement noise expected attempt manifest changed during collection');
            }
            const authorityFile = path.join(
                authorityDirectory,
                `${String(resolvedAttemptSequence).padStart(6, '0')}-`
        + `${String(eventSequence).padStart(6, '0')}-${digest}.measurement-noise.json`
            );
            fs.writeFileSync(authorityFile, `${JSON.stringify(receipt, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600
            });
            const manifest = appendManifestSnapshot(
                previousManifest,
                appendedReceiptBinding(resolvedAuthorityRoot, authorityFile, receipt)
            );
            const manifestDirectory = authorityManifestWindowDirectory(
                resolvedAuthorityManifestRoot,
                runId,
                windowId
            );
            fs.mkdirSync(manifestDirectory, { recursive: true });
            const manifestDigest = manifest.contentDigest.slice('sha256:'.length);
            const manifestFile = path.join(
                manifestDirectory,
                `${String(manifest.manifestSequence).padStart(6, '0')}-`
        + `${manifestDigest}.measurement-noise-manifest.json`
            );
            fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o400
            });
            previousManifest = manifest;
        }
        previousReceiptDigest = receipt.authority.contentDigest;
        terminalPersisted = terminal;
        if (evidenceFile)
        {
            atomicWriteJson(evidenceFile, receipt);
        }
        return receipt;
    };
    return {
        async preflight()
        {
            admissionStartedAtMs = now();
            const attempts = [];
            while (true)
            {
                let observation;
                try
                {
                    observation = await collectInterval(policy.preflightObservationMs);
                }
                catch (error)
                {
                    const document = {
                        schema: measurementNoiseSchema,
                        windowId,
                        status: 'blocked',
                        classification: error.classification ?? 'infra.measurement-collector-unavailable',
                        qualificationEligible: false,
                        productConclusionEligible: false,
                        collectorError: error.message,
                        phases: { preflight: { attempts }, during: null, post: null }
                    };
                    persist(document);
                    throw error;
                }
                const evaluation = evaluateMeasurementObservation(observation, policy);
                attempts.push({ observation, evaluation });
                if (evaluation.status === 'clean')
                {
                    return {
                        status: 'admitted',
                        admissionWaitMs: now() - admissionStartedAtMs,
                        attempts,
                        cleanObservation: attempts.at(-1)
                    };
                }
                if (now() - admissionStartedAtMs >= policy.admissionDeadlineMs)
                {
                    const error = new Error('measurement admission deadline expired in a noisy host window');
                    error.classification = noisyMeasurementClassification;
                    error.evidence = persist({
                        schema: measurementNoiseSchema,
                        windowId,
                        status: 'blocked',
                        classification: noisyMeasurementClassification,
                        qualificationEligible: false,
                        productConclusionEligible: false,
                        phases: { preflight: { status: 'blocked', attempts }, during: null, post: null }
                    });
                    throw error;
                }
            }
        },
        start(preflight)
        {
            measurementStartedAtMs = now();
            try
            {
                previousSnapshot = collector.collect();
            }
            catch (error)
            {
                persist({
                    schema: measurementNoiseSchema,
                    windowId,
                    status: 'blocked',
                    classification: error.classification ?? 'infra.measurement-collector-unavailable',
                    qualificationEligible: false,
                    productConclusionEligible: false,
                    collectorError: error.message,
                    phases: {
                        preflight: { status: 'clean', attempts: preflight.attempts },
                        during: { status: 'blocked', observations: [], collectorError: error.message },
                        post: null
                    }
                });
                throw error;
            }
            const sample = () =>
            {
                try
                {
                    const current = collector.collect();
                    const observation = deriveMeasurementObservation(previousSnapshot, current);
                    const evaluation = evaluateMeasurementObservation(observation, policy);
                    const record = { observation, evaluation };
                    during.push(record);
                    if (!firstNoisyObservation && evaluation.status === 'noisy')
                    {
                        firstNoisyObservation = record;
                    }
                    previousSnapshot = current;
                }
                catch (error)
                {
                    if (!firstNoisyObservation)
                    {
                        firstNoisyObservation = {
                            collectorError: error.message,
                            evaluation: {
                                status: 'noisy',
                                qualificationEligible: false,
                                classification: error.classification ?? 'infra.measurement-collector-unavailable'
                            }
                        };
                        persist({
                            schema: measurementNoiseSchema,
                            windowId,
                            status: 'blocked',
                            classification: firstNoisyObservation.evaluation.classification,
                            qualificationEligible: false,
                            productConclusionEligible: false,
                            collectorError: error.message,
                            phases: {
                                preflight: { status: 'clean', attempts: preflight.attempts },
                                during: {
                                    status: 'blocked',
                                    observations: during,
                                    firstNoisyObservation
                                },
                                post: null
                            }
                        }, { terminal: false });
                    }
                }
            };
            persist({
                schema: measurementNoiseSchema,
                windowId,
                status: 'in-progress',
                classification: 'infra.measurement-incomplete',
                qualificationEligible: false,
                productConclusionEligible: false,
                productOutcome: null,
                phases: {
                    preflight: { status: 'clean', attempts: preflight.attempts },
                    during: { status: 'in-progress', observations: during, firstNoisyObservation: null },
                    post: null
                }
            }, { terminal: false });
            timer = setIntervalFn(sample, policy.sampleIntervalMs);
            timer?.unref?.();
            return {
                admissionWaitMs: preflight.admissionWaitMs,
                measurementStartedAtMs
            };
        },
        async finish({ preflight, productOutcome = null } = {})
        {
            if (timer)
            {
                clearIntervalFn(timer);
            }
            if (previousSnapshot)
            {
                try
                {
                    const current = collector.collect();
                    if (current.collectedAtMonotonicMs > previousSnapshot.collectedAtMonotonicMs)
                    {
                        const observation = deriveMeasurementObservation(previousSnapshot, current);
                        const evaluation = evaluateMeasurementObservation(observation, policy);
                        const record = { observation, evaluation };
                        during.push(record);
                        if (!firstNoisyObservation && evaluation.status === 'noisy')
                        {
                            firstNoisyObservation = record;
                        }
                    }
                }
                catch (error)
                {
                    if (!firstNoisyObservation)
                    {
                        firstNoisyObservation = {
                            collectorError: error.message,
                            evaluation: {
                                status: 'noisy',
                                qualificationEligible: false,
                                classification: error.classification ?? 'infra.measurement-collector-unavailable'
                            }
                        };
                    }
                }
            }
            const measurementFinishedAtMs = now();
            let post;
            try
            {
                const observation = await collectInterval(policy.postObservationMs);
                post = { observation, evaluation: evaluateMeasurementObservation(observation, policy) };
            }
            catch (error)
            {
                post = {
                    collectorError: error.message,
                    evaluation: {
                        status: 'noisy',
                        qualificationEligible: false,
                        classification: error.classification ?? 'infra.measurement-collector-unavailable'
                    }
                };
            }
            const noisy = firstNoisyObservation
        || post.evaluation.status === 'noisy'
        || during.length === 0;
            const classification = firstNoisyObservation?.evaluation?.classification
        ?? post.evaluation.classification
        ?? (during.length === 0 ? 'infra.measurement-collector-unavailable' : null);
            return persist({
                schema: measurementNoiseSchema,
                windowId,
                status: noisy ? 'noisy' : 'clean',
                classification: noisy ? classification ?? noisyMeasurementClassification : null,
                qualificationEligible: !noisy,
                productConclusionEligible: !noisy,
                productOutcome: noisy ? null : productOutcome,
                timing: {
                    admissionWaitMs: preflight.admissionWaitMs,
                    measurementDurationMs: measurementFinishedAtMs - measurementStartedAtMs,
                    measurementStartedAfterAdmission: true
                },
                phases: {
                    preflight: { status: 'clean', attempts: preflight.attempts },
                    during: { status: noisy ? 'noisy' : 'clean', observations: during, firstNoisyObservation },
                    post
                }
            });
        }
    };
}

export function validateMeasurementNoiseAuthorityReceipt(receipt, {
    expectedWindowId = null,
    policy = readMeasurementNoisePolicy()
} = {})
{
    if (receipt?.schema !== measurementNoiseSchema)
    {
        throw new Error(`measurement noise receipt schema must be ${measurementNoiseSchema}`);
    }
    if (!String(receipt.windowId ?? '').trim())
    {
        throw new Error('measurement noise receipt window id is missing');
    }
    if (expectedWindowId !== null && receipt.windowId !== expectedWindowId)
    {
        throw new Error(`measurement noise receipt window mismatch: expected ${expectedWindowId}, got ${receipt.windowId}`);
    }
    const authority = receipt.authority;
    if (authority?.schema !== measurementNoiseAuthoritySchema
    || !String(authority.runId ?? '').trim()
    || authority.windowId !== receipt.windowId
    || !String(authority.attemptId ?? '').trim()
    || !Number.isInteger(authority.attemptSequence)
    || authority.attemptSequence <= 0
    || !Number.isInteger(authority.eventSequence)
    || authority.eventSequence <= 0
    || typeof authority.terminal !== 'boolean'
    || (authority.previousReceiptDigest !== null
      && !/^sha256:[a-f0-9]{64}$/u.test(String(authority.previousReceiptDigest)))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(authority.contentDigest)))
    {
        throw new Error('measurement noise receipt authority identity is invalid');
    }
    const recomputedDigest = contentDigest(receiptWithoutDigest(receipt));
    if (authority.contentDigest !== recomputedDigest)
    {
        throw new Error('measurement noise receipt authority content digest is invalid');
    }
    const records = [
        ...(receipt.phases?.preflight?.attempts ?? []),
        ...(receipt.phases?.during?.observations ?? []),
        ...(receipt.phases?.post?.observation ? [receipt.phases.post] : [])
    ];
    if (records.length === 0 && !receipt.collectorError)
    {
        throw new Error('measurement noise receipt contains no observation or collector error');
    }
    for (const [index, record] of records.entries())
    {
        const recomputed = evaluateMeasurementObservation(record?.observation, policy);
        if (!isDeepStrictEqual(record.evaluation, recomputed))
        {
            throw new Error(`measurement noise receipt phase record ${index} does not match policy recomputation`);
        }
    }
    if (receipt.qualificationEligible === true && receipt.status !== 'clean')
    {
        throw new Error('measurement noise receipt cannot qualify with a non-clean status');
    }
    if (receipt.status !== 'clean' && (
        receipt.qualificationEligible !== false
    || receipt.productConclusionEligible === true
    || receipt.productOutcome != null
    ))
    {
        throw new Error('non-clean measurement noise receipt must suppress qualification and product outcome');
    }
    return receipt;
}

export function validateMeasurementNoiseReceipt(receipt, {
    expectedWindowId = null,
    policy = readMeasurementNoisePolicy(),
    authoritySequence = null
} = {})
{
    if (authoritySequence)
    {
        const sequence = validateMeasurementNoiseAuthoritySequence(authoritySequence, {
            expectedRunId: receipt?.authority?.runId,
            expectedWindowId: expectedWindowId ?? receipt?.windowId,
            policy
        });
        if (sequence.at(-1).authority.contentDigest !== receipt?.authority?.contentDigest)
        {
            throw new Error('measurement noise receipt is not the authority sequence head');
        }
        if (sequence.at(-1).authority.attemptSequence !== 1)
        {
            throw new Error('measurement noise qualification cannot replace the first attempt with a retry');
        }
    }
    validateMeasurementNoiseAuthorityReceipt(receipt, { expectedWindowId, policy });
    if (receipt.status !== 'clean'
    || receipt.qualificationEligible !== true
    || receipt.productConclusionEligible !== true
    || receipt.authority.terminal !== true)
    {
        throw new Error('measurement noise receipt must be clean and product-conclusion eligible');
    }
    const preflightAttempts = receipt.phases?.preflight?.attempts;
    const duringObservations = receipt.phases?.during?.observations;
    const post = receipt.phases?.post;
    if (receipt.phases?.preflight?.status !== 'clean'
    || !Array.isArray(preflightAttempts)
    || preflightAttempts.length === 0
    || preflightAttempts.at(-1)?.evaluation?.status !== 'clean')
    {
        throw new Error('measurement noise receipt must end preflight with a clean observation');
    }
    if (receipt.phases?.during?.status !== 'clean'
    || !Array.isArray(duringObservations)
    || duringObservations.length === 0)
    {
        throw new Error('measurement noise receipt must contain a clean during-window observation');
    }
    const phaseRecords = [...preflightAttempts, ...duringObservations, post];
    for (const [index, record] of phaseRecords.entries())
    {
        const recomputed = evaluateMeasurementObservation(record?.observation, policy);
        const preflightWaitingObservation = index < preflightAttempts.length - 1;
        if (!isDeepStrictEqual(record?.evaluation, recomputed)
      || (!preflightWaitingObservation && (
          recomputed.status !== 'clean'
        || recomputed.qualificationEligible !== true
        || recomputed.classification !== null
      )))
        {
            throw new Error(`measurement noise receipt phase record ${index} is invalid`);
        }
        const metricNames = record.evaluation.evaluations?.map((entry) => entry.name).sort();
        if (JSON.stringify(metricNames) !== JSON.stringify([...requiredMetrics].sort()))
        {
            throw new Error(`measurement noise receipt phase record ${index} metric set is incomplete`);
        }
    }
    if (receipt.timing?.measurementStartedAfterAdmission !== true
    || !Number.isFinite(receipt.timing?.admissionWaitMs)
    || !Number.isFinite(receipt.timing?.measurementDurationMs)
    || receipt.timing.measurementDurationMs <= 0)
    {
        throw new Error('measurement noise receipt timing is invalid');
    }
    return receipt;
}

export function qualifyMeasurementCohort(rounds)
{
    if (!Array.isArray(rounds) || rounds.length !== 3)
    {
        throw new Error('performance qualification cohort requires exactly three fresh rounds');
    }
    const normalized = rounds.map((round, index) =>
    {
        if (round?.schema !== 'fsusblog.measurement-noise-round.v1')
        {
            throw new Error(`measurement noise cohort round ${index + 1} schema is invalid`);
        }
        const receipts = (round.windows ?? []).flatMap((window) => window.authorityReceipts ?? []);
        const rebuilt = buildMeasurementNoiseRound(receipts, {
            requiredWindowSuffixes: round.requiredWindowSuffixes
        });
        if (!isDeepStrictEqual(round, rebuilt))
        {
            throw new Error(`measurement noise cohort round ${index + 1} does not match authority receipts`);
        }
        return {
            round: index + 1,
            runId: rebuilt.runId,
            status: round.status,
            qualificationEligible: round.qualificationEligible,
            firstAttempt: round,
            attempts: [round]
        };
    });
    const runIds = normalized.map((round) => round.runId);
    const freshRunIdentities = runIds.every((runId) => String(runId ?? '').trim())
    && new Set(runIds).size === normalized.length;
    const qualificationEligible = freshRunIdentities
    && normalized.every((round) => round.qualificationEligible);
    return {
        schema: 'fsusblog.measurement-noise-cohort.v1',
        status: qualificationEligible ? 'qualified' : 'not-qualified',
        qualificationEligible,
        productConclusionEligible: qualificationEligible,
        classification: qualificationEligible ? null : noisyMeasurementClassification,
        freshRunIdentities,
        runIds,
        rounds: normalized
    };
}

export function buildMeasurementNoiseRound(receipts, {
    requiredWindowSuffixes = performanceSteps()
        .filter((step) => step.evidencePhase === 'measurement')
        .map((step) => `/performance-evidence/${step.id}`)
} = {})
{
    if (!Array.isArray(receipts))
    {
        throw new Error('measurement noise round receipts must be an array');
    }
    const authorities = receipts.filter((receipt) => receipt?.schema === measurementNoiseSchema);
    for (const receipt of authorities)
    {
        if (receipt.status === 'clean' && receipt.qualificationEligible === true)
        {
            validateMeasurementNoiseReceipt(receipt);
        }
        else
        {
            validateMeasurementNoiseAuthorityReceipt(receipt);
        }
    }
    const runIds = new Set(authorities.map((receipt) => receipt.authority.runId));
    if (runIds.size > 1)
    {
        throw new Error('measurement noise round cannot combine multiple run identities');
    }
    const runId = [...runIds][0] ?? null;
    const byWindow = new Map();
    for (const receipt of authorities)
    {
        const sequence = byWindow.get(receipt.windowId) ?? [];
        sequence.push(receipt);
        byWindow.set(receipt.windowId, sequence);
    }
    const missing = requiredWindowSuffixes.filter((suffix) =>
        ![...byWindow.keys()].some((windowId) => String(windowId).endsWith(suffix)));
    const windows = [...byWindow.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([windowId, receiptsForWindow]) =>
        {
            const authorityReceipts = validateMeasurementNoiseAuthoritySequence(receiptsForWindow, {
                expectedRunId: runId,
                expectedWindowId: windowId
            });
            const attemptEvents = new Map();
            for (const receipt of authorityReceipts)
            {
                const events = attemptEvents.get(receipt.authority.attemptSequence) ?? [];
                events.push(receipt);
                attemptEvents.set(receipt.authority.attemptSequence, events);
            }
            const attempts = [...attemptEvents.values()].map((events) => events.at(-1));
            const firstAttempt = attempts[0];
            const qualificationEligible = attempts.length === 1
        && firstAttempt.authority.terminal === true
        && firstAttempt.status === 'clean'
        && firstAttempt.qualificationEligible === true;
            return { windowId, authorityReceipts, attempts, firstAttempt, qualificationEligible };
        });
    const qualificationEligible = missing.length === 0
    && windows.length >= requiredWindowSuffixes.length
    && windows.every((window) => window.qualificationEligible);
    return {
        schema: 'fsusblog.measurement-noise-round.v1',
        runId,
        requiredWindowSuffixes,
        status: qualificationEligible ? 'clean' : 'noisy',
        qualificationEligible,
        productConclusionEligible: qualificationEligible,
        classification: qualificationEligible ? null : noisyMeasurementClassification,
        missingRequiredWindows: missing,
        windows
    };
}
