import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { MeasurementCollectorUnavailableError, bindMeasurementNoiseAuthority, buildMeasurementNoiseRound, createLinuxMeasurementCollector, createMeasurementNoiseEnvelope, deriveMeasurementObservation, evaluateMeasurementObservation, qualifyMeasurementCohort, readMeasurementNoiseAuthoritySequence, readMeasurementNoisePolicy, validateMeasurementNoiseReceipt } = await import(new URL("../../tools/test/measurement-noise-envelope.mjs", import.meta.url));
const { runTaskScopedPerformanceAdmission, runWithPerformanceAdmission } = await import(new URL("../../tools/test/performance-admission.mjs", import.meta.url));
const { performanceSteps } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskFixture = path.join(root, 'tests/tools/fixtures/measurement-task.mjs');
const laneFixture = path.join(root, 'tests/tools/fixtures/measurement-lane.sh');

const policy = {
    ...readMeasurementNoisePolicy(),
    preflightObservationMs: 10,
    postObservationMs: 10,
    sampleIntervalMs: 10,
    admissionDeadlineMs: 10
};

function snapshot(at, {
    busy = at,
    total = at * 2,
    steal = 0,
    runnable = 0,
    cpuPressure = 0,
    memoryPressure = 0,
    ioPressure = 0,
    faults = 0,
    disk = 0,
    runCpu = 0,
    throttle = 0,
    memoryEvents = 0,
    runIo = 0,
    externalCpu = 0,
    externalIo = 0,
    unknown = 0,
    coverage = 1
} = {})
{
    return {
        collectedAtMonotonicMs: at,
        hostCpu: { totalTicks: total, busyTicks: busy, idleTicks: total - busy, stealTicks: steal },
        hostCpuCount: 4,
        runnable,
        cpuPressure,
        memoryPressure,
        ioPressure,
        majorPageFaults: faults,
        diskBytes: disk,
        currentRun: {
            cpuTicks: runCpu,
            cpuThrottleUsec: throttle,
            memoryEvents,
            majorPageFaults: faults,
            ioBytes: runIo
        },
        externalProcesses: {
            identities: [],
            unknownCount: unknown,
            identityCoverage: unknown === 0 ? 1 : 0,
            cpuTicks: externalCpu,
            ioBytes: externalIo
        },
        clockTicks: 100,
        collectorCoverage: coverage
    };
}

function sequenceCollector(entries)
{
    let index = 0;
    return {
        collect()
        {
            if (index >= entries.length)
            {
                throw new Error(`collector sequence exhausted at ${index}`);
            }
            const entry = entries[index++];
            if (entry instanceof Error)
            {
                throw entry;
            }
            return structuredClone(entry);
        }
    };
}

function cleanPair(start = 0)
{
    return [
        snapshot(start, { busy: 0, total: 0 }),
        snapshot(start + 1000, { busy: 100, total: 1000, runCpu: 50 })
    ];
}

function authorityReceipt(windowId, {
    noisy = false,
    runId = 'round-run',
    attemptSequence = 1,
    previousReceiptDigest = null
} = {})
{
    const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, declaration]) => [
        name,
    Number.isFinite(declaration.minimum) ? declaration.minimum : 0
    ]));
    if (noisy)
    {
        metrics.hostCpuUtilization = 1;
    }
    const record = {
        observation: {
            durationMs: 1000,
            metrics,
            externalProcesses: { identities: [], unknownCount: 0, identityCoverage: 1 }
        },
        evaluation: evaluateMeasurementObservation({ metrics }, policy)
    };
    const receipt = noisy
        ? {
      schema: 'fsusblog.measurement-noise-envelope.v1',
      windowId,
      status: 'blocked',
      classification: 'infra.noisy-measurement-window',
      qualificationEligible: false,
      productConclusionEligible: false,
      phases: {
        preflight: { status: 'blocked', attempts: [record] },
        during: null,
        post: null
      }
      }
        : {
        schema: 'fsusblog.measurement-noise-envelope.v1',
        windowId,
        status: 'clean',
        classification: null,
        qualificationEligible: true,
        productConclusionEligible: true,
        productOutcome: { status: 'completed' },
        timing: {
          admissionWaitMs: 1000,
          measurementDurationMs: 1000,
          measurementStartedAfterAdmission: true
        },
        phases: {
          preflight: { status: 'clean', attempts: [structuredClone(record)] },
          during: {
            status: 'clean',
            observations: [structuredClone(record)],
            firstNoisyObservation: null
          },
          post: structuredClone(record)
        }
      };
    return bindMeasurementNoiseAuthority(receipt, {
        runId,
        attemptId: `${runId}:${windowId}:attempt-${attemptSequence}`,
        attemptSequence,
        previousReceiptDigest
    });
}

function authorityRound(receipts, requiredWindowSuffixes)
{
    return buildMeasurementNoiseRound(receipts, { requiredWindowSuffixes });
}

test('default noise round requires every canonical measurement including compression', () =>
{
    const measurementIds = performanceSteps().filter((step) => step.evidencePhase === 'measurement')
        .map((step) => step.id);
    const receipts = measurementIds.map((id) => authorityReceipt(`round/performance-evidence/${id}`, {
        runId: 'inventory-noise-contract'
    }));
    const complete = buildMeasurementNoiseRound(receipts);
    assert.equal(complete.qualificationEligible, true);
    assert.deepEqual(complete.requiredWindowSuffixes, measurementIds.map((id) => `/performance-evidence/${id}`));
    for (const id of measurementIds)
    {
        const incomplete = buildMeasurementNoiseRound(receipts.filter((receipt) => !receipt.windowId.endsWith(`/${id}`)));
        assert.equal(incomplete.qualificationEligible, false);
        assert.ok(incomplete.missingRequiredWindows.includes(`/performance-evidence/${id}`));
    }
});

function terminateOwnedProcess(child)
{
    if (child.exitCode !== null || child.signalCode !== null)
    {
        return;
    }
    child.kill('SIGTERM');
    setTimeout(() =>
    {
        if (child.exitCode === null && child.signalCode === null)
        {
            child.kill('SIGKILL');
        }
    }, 500).unref();
}

async function terminateOwnedProcessAndWait(child)
{
    if (child.exitCode !== null || child.signalCode !== null)
    {
        return;
    }
    await new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() =>
        {
            reject(new Error(`owned process did not exit after termination: ${child.pid}`));
        }, 2000);
        child.once('exit', () =>
        {
            clearTimeout(timeout);
            resolve();
        });
        terminateOwnedProcess(child);
    });
}

function shortRealPolicy(overrides = {})
{
    return {
        ...readMeasurementNoisePolicy(),
        preflightObservationMs: 300,
        postObservationMs: 100,
        sampleIntervalMs: 25,
        admissionDeadlineMs: 300,
        ...overrides
    };
}

function hostTolerantRealPolicy()
{
    const candidate = structuredClone(shortRealPolicy());
    for (const name of [
        'hostCpuUtilization',
        'hostRunQueueOrCpuPressure',
        'cpuStealOrReadyTime',
        'hostMemoryPressure',
        'majorPageFaults',
        'externalProcessCpuEstimate'
    ])
    {
        candidate.metrics[name].maximum = Number.MAX_SAFE_INTEGER;
    }
    return candidate;
}

function processProofEnvelopeFactory(options)
{
    return createMeasurementNoiseEnvelope({
        ...options,
        policy,
        collector: sequenceCollector([
            ...cleanPair(),
            snapshot(2000, { busy: 100, total: 1000, runCpu: 50 }),
            snapshot(3000, { busy: 200, total: 2000, runCpu: 100 }),
            ...cleanPair(4000)
        ]),
        wait: async () =>
        {},
        setIntervalFn: () => ({ unref()
        {} }),
        clearIntervalFn: () =>
        {}
    });
}

function realHostDiskEnvelopeFactory(options)
{
    const collector = {
        collect()
        {
            const monotonicMs = performance.now();
            const diskBytes = fs.readFileSync('/proc/diskstats', 'utf8').trim().split(/\r?\n/u)
                .filter(Boolean)
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
            return {
                collectedAtMonotonicMs: monotonicMs,
                hostCpu: {
                    totalTicks: monotonicMs,
                    busyTicks: monotonicMs * 0.01,
                    idleTicks: monotonicMs * 0.99,
                    stealTicks: 0
                },
                hostCpuCount: 1,
                runnable: 0,
                cpuPressure: 0,
                memoryPressure: 0,
                ioPressure: 0,
                diskBytes,
                currentRun: {
                    cpuTicks: 0,
                    cpuThrottleUsec: 0,
                    memoryEvents: 0,
                    majorPageFaults: 0,
                    ioBytes: 0
                },
                externalProcesses: {
                    identities: [],
                    unknownCount: 0,
                    inventoryCount: 0,
                    identityCoverage: 1
                },
                collectorErrors: [],
                clockTicks: 100,
                collectorCoverage: 1
            };
        }
    };
    return createMeasurementNoiseEnvelope({
        ...options,
        policy: shortRealPolicy(),
        collector
    });
}

function processStat(pid, command, startTimeTicks, state = 'S')
{
    return `${pid} (${command}) ${state} 1 1 1 0 -1 4194560 0 0 0 0 1 1 0 0 20 0 1 0 ${startTimeTicks} 0\n`;
}

function cgroupFixture({
    externalProcesses = [],
    unreadableExternal = false,
    missingIo = false,
    zombieChild = false
} = {})
{
    let phase = 0;
    const cgroup = '/sys/fs/cgroup/task';
    const reader = (file) =>
    {
        const childPresent = phase === 0;
        const values = new Map([
            ['/proc/stat', `cpu ${100 + phase * 10} 0 0 ${900 + phase * 90} 0 0 0 0\n`],
            ['/proc/loadavg', '0.00 0.00 0.00 0/1 100\n'],
            ['/proc/vmstat', `pgmajfault ${phase * 4}\n`],
            ['/proc/diskstats', `8 0 sda 0 0 ${phase * 819200} 0 0 0 ${phase * 819200} 0\n`],
            ['/proc/pressure/cpu', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
            ['/proc/pressure/memory', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
            ['/proc/pressure/io', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
            ['/proc/100/task/100/children', childPresent ? '101\n' : '\n'],
            ['/proc/101/task/101/children', '\n'],
            ['/proc/101/stat', processStat(101, 'child', 101, zombieChild ? 'Z' : 'S')],
            [path.join(cgroup, 'cgroup.procs'), childPresent && !zombieChild ? '100\n101\n' : '100\n'],
            [path.join(cgroup, 'cpu.stat'), `usage_usec ${phase * 100000}\nthrottled_usec 0\n`],
            [path.join(cgroup, 'memory.events'), 'high 0\nmax 0\noom 0\noom_kill 0\n'],
            [path.join(cgroup, 'memory.stat'), `pgmajfault ${phase * 4}\n`],
            ...externalProcesses.map(({ pid, command, startTimeTicks }) =>
                [`/proc/${pid}/stat`, processStat(pid, command, startTimeTicks)]),
            ...(!missingIo
                ? [[path.join(cgroup, 'io.stat'), `8:0 rbytes=${phase * 157286400} wbytes=${phase * 157286400} rios=0 wios=0\n`]]
                : [])
        ]);
        if (unreadableExternal && file.startsWith('/proc/200/'))
        {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        if (!values.has(file))
        {
            throw Object.assign(new Error(`missing ${file}`), { code: 'ENOENT' });
        }
        return values.get(file);
    };
    return {
        collector: createLinuxMeasurementCollector({
            rootPid: 100,
            cgroupPath: cgroup,
            reader,
            monotonicNow: () => phase * 1000,
            listProcesses: () => [
                '100',
                ...(phase === 0 ? ['101'] : []),
                ...(unreadableExternal ? ['200'] : []),
                ...externalProcesses.map(({ pid }) => String(pid))
            ]
        }),
        advance()
        {
            phase = 1;
        }
    };
}

test('external CPU burner makes preflight block instead of starting the product window', async () =>
{
    const collector = sequenceCollector([
        snapshot(0, { busy: 0, total: 0 }),
        snapshot(1000, { busy: 950, total: 1000, runnable: 8 })
    ]);
    let productStarted = false;
    const envelope = createMeasurementNoiseEnvelope({
        windowId: 'cpu-burner-fixture',
        policy,
        collector,
        now: (() =>
        {
            let value = 0;
            return () => (value += 10);
        })(),
        wait: async () =>
        {}
    });
    await assert.rejects(runWithPerformanceAdmission({
        windowId: 'cpu-burner-fixture',
        envelopeFactory: () => envelope,
        execute: async () =>
        {
            productStarted = true;
        }
    }), (error) =>
    {
        assert.equal(error.classification, 'infra.noisy-measurement-window');
        return true;
    });
    assert.equal(productStarted, false);
});

test('disk writer starting during measurement creates a noisy-window classification', async () =>
{
    const entries = [
        ...cleanPair(),
        snapshot(2000, { busy: 100, total: 1000, runCpu: 50 }),
        snapshot(3000, { busy: 200, total: 2000, runCpu: 100, disk: 300 * 1024 * 1024 }),
        ...cleanPair(4000)
    ];
    const envelope = createMeasurementNoiseEnvelope({
        windowId: 'disk-writer-fixture',
        policy,
        collector: sequenceCollector(entries),
        now: (() =>
        {
            let value = 0;
            return () => (value += 1000);
        })(),
        wait: async () =>
        {},
        setIntervalFn: (callback) =>
        {
            callback();
            return { unref()
            {} };
        },
        clearIntervalFn: () =>
        {}
    });
    const preflight = await envelope.preflight();
    envelope.start(preflight);
    const evidence = await envelope.finish({ preflight, productOutcome: { status: 'fast' } });
    assert.equal(evidence.status, 'noisy');
    assert.equal(evidence.classification, 'infra.noisy-measurement-window');
    assert.equal(evidence.productOutcome, null);
    assert.equal(evidence.productConclusionEligible, false);
});

test('unthrottled current cgroup does not hide host CPU saturation', () =>
{
    const observation = deriveMeasurementObservation(
        snapshot(0, { busy: 0, total: 0, throttle: 0 }),
        snapshot(1000, { busy: 950, total: 1000, throttle: 0, runCpu: 100 })
    );
    const result = evaluateMeasurementObservation(observation, policy);
    assert.equal(result.status, 'noisy');
    assert.ok(result.blockingFailures.some((entry) => entry.name === 'hostCpuUtilization'));
});

test('collector missing and permission denied fail closed rather than filling zero', async () =>
{
    for (const code of ['ENOENT', 'EACCES'])
    {
        const error = Object.assign(new Error(code), { code });
        const collector = { collect()
        {
            throw new MeasurementCollectorUnavailableError(`collector ${code}`, { cause: error });
        } };
        const envelope = createMeasurementNoiseEnvelope({
            windowId: `collector-${code}`,
            policy,
            collector,
            wait: async () =>
            {}
        });
        await assert.rejects(envelope.preflight(), (failure) =>
        {
            assert.equal(failure.classification, 'infra.measurement-collector-unavailable');
            return true;
        });
    }
    const missingMetric = evaluateMeasurementObservation({ metrics: Object.fromEntries(
        Object.keys(policy.metrics).map((name) => [name, name === 'collectorCoverage' ? null : 0])
    ) }, policy);
    assert.equal(missingMetric.qualificationEligible, false);
    assert.equal(missingMetric.blockingFailures[0].name, 'collectorCoverage');
    assert.equal(missingMetric.blockingFailures[0].unavailable, true);
    const denied = Object.assign(new Error('permission denied fixture'), { code: 'EACCES' });
    assert.throws(
        () => createLinuxMeasurementCollector({ reader()
        {
            throw denied;
        } }).collect(),
        (error) => error instanceof MeasurementCollectorUnavailableError
      && error.classification === 'infra.measurement-collector-unavailable'
      && /EACCES/u.test(error.message)
    );
});

test('admission waiting is separate from the effective measurement duration', async () =>
{
    let monotonic = 0;
    const wait = async (duration) =>
    {
        monotonic += duration;
    };
    const entries = [
        ...cleanPair(),
        snapshot(2000, { busy: 100, total: 1000 }),
        snapshot(3000, { busy: 200, total: 2000 }),
        ...cleanPair(4000)
    ];
    const envelope = createMeasurementNoiseEnvelope({
        windowId: 'duration-separation-fixture',
        policy: { ...policy, preflightObservationMs: 7000 },
        collector: sequenceCollector(entries),
        now: () => monotonic,
        wait,
        setIntervalFn: () => ({ unref()
        {} }),
        clearIntervalFn: () =>
        {}
    });
    const preflight = await envelope.preflight();
    envelope.start(preflight);
    monotonic += 30_000;
    const evidence = await envelope.finish({ preflight });
    assert.equal(evidence.timing.admissionWaitMs, 7000);
    assert.equal(evidence.timing.measurementDurationMs, 30_000);
});

test('external identity unreadable still fails from pressure and never requests a kill', () =>
{
    const observation = deriveMeasurementObservation(
        snapshot(0, { busy: 0, total: 0 }),
        snapshot(1000, { busy: 100, total: 1000, cpuPressure: 1.5, unknown: 3 })
    );
    const result = evaluateMeasurementObservation(observation, policy);
    assert.equal(result.status, 'noisy');
    assert.equal(observation.externalProcesses.unknownCount, 3);
    assert.equal(observation.externalProcesses.identityCoverage, 0);
    assert.equal(observation.metrics.collectorCoverage, 1);
    assert.equal(JSON.stringify(result).includes('kill'), false);
});

test('clean host and current-run fixture passes all three evidence phases', async () =>
{
    const entries = [
        ...cleanPair(),
        snapshot(2000, { busy: 100, total: 1000 }),
        snapshot(3000, { busy: 200, total: 2000, runCpu: 50 }),
        ...cleanPair(4000)
    ];
    const evidenceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-clean-')), 'evidence.json');
    const envelope = createMeasurementNoiseEnvelope({
        windowId: 'clean-fixture',
        evidenceFile,
        policy,
        collector: sequenceCollector(entries),
        now: (() =>
        {
            let value = 0;
            return () => (value += 1000);
        })(),
        wait: async () =>
        {},
        setIntervalFn: () => ({ unref()
        {} }),
        clearIntervalFn: () =>
        {}
    });
    const preflight = await envelope.preflight();
    envelope.start(preflight);
    const evidence = await envelope.finish({ preflight, productOutcome: { status: 'within-budget' } });
    assert.equal(evidence.status, 'clean');
    assert.equal(evidence.qualificationEligible, true);
    assert.equal(evidence.phases.preflight.status, 'clean');
    assert.equal(evidence.phases.during.status, 'clean');
    assert.equal(evidence.phases.post.evaluation.status, 'clean');
    assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')), evidence);
});

test('preflight may wait through noisy observations before one clean admission', async () =>
{
    const envelope = createMeasurementNoiseEnvelope({
        windowId: 'preflight-wait-fixture',
        policy: { ...policy, admissionDeadlineMs: 100 },
        collector: sequenceCollector([
            snapshot(0, { busy: 0, total: 0 }),
            snapshot(1000, { busy: 950, total: 1000 }),
            ...cleanPair(2000),
            snapshot(4000, { busy: 100, total: 1000, runCpu: 50 }),
            snapshot(5000, { busy: 200, total: 2000, runCpu: 100 }),
            ...cleanPair(6000)
        ]),
        now: (() =>
        {
            let value = 0;
            return () => (value += 10);
        })(),
        wait: async () =>
        {},
        setIntervalFn: () => ({ unref()
        {} }),
        clearIntervalFn: () =>
        {}
    });
    const preflight = await envelope.preflight();
    assert.equal(preflight.attempts.length, 2);
    assert.equal(preflight.attempts[0].evaluation.status, 'noisy');
    assert.equal(preflight.attempts[1].evaluation.status, 'clean');
    envelope.start(preflight);
    const evidence = await envelope.finish({ preflight, productOutcome: { status: 'completed' } });
    assert.equal(evidence.status, 'clean');
    validateMeasurementNoiseReceipt(evidence);
});

test('noisy first attempt cannot be overwritten by a clean retry', () =>
{
    const noisy = authorityReceipt('round/only', { noisy: true, runId: 'retry-run' });
    const clean = authorityReceipt('round/only', {
        runId: 'retry-run',
        attemptSequence: 2,
        previousReceiptDigest: noisy.authority.contentDigest
    });
    const retried = authorityRound([clean, noisy], ['/only']);
    const cleanRoundTwo = authorityRound([
        authorityReceipt('round/only', { runId: 'clean-run-two' })
    ], ['/only']);
    const cleanRoundThree = authorityRound([
        authorityReceipt('round/only', { runId: 'clean-run-three' })
    ], ['/only']);
    const cohort = qualifyMeasurementCohort([
        retried,
        cleanRoundTwo,
        cleanRoundThree
    ]);
    assert.equal(cohort.qualificationEligible, false);
    assert.equal(cohort.rounds[0].firstAttempt, retried);
    assert.equal(cohort.rounds[0].status, 'noisy');
});

test('run manifest rejects deleted, hidden, unknown, reordered, or overwritten authority evidence', async () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-authority-chain-'));
    const evidenceFile = path.join(directory, 'latest.json');
    const firstAuthorityRoot = path.join(directory, 'attempt-0001-authority');
    const secondAuthorityRoot = path.join(directory, 'attempt-0002-authority');
    const authorityManifestRoot = path.join(directory, 'run-authority-manifest');
    try
    {
        const first = createMeasurementNoiseEnvelope({
            windowId: 'round/only',
            evidenceFile,
            authorityRoot: firstAuthorityRoot,
            authorityManifestRoot,
            runId: 'authority-run',
            attemptSequence: 1,
            policy,
            collector: sequenceCollector([
                snapshot(0, { busy: 0, total: 0 }),
                snapshot(1000, { busy: 950, total: 1000 })
            ]),
            now: (() =>
            {
                let value = 0;
                return () => (value += 10);
            })(),
            wait: async () =>
            {}
        });
        await assert.rejects(first.preflight(), /admission deadline expired/u);
        const firstTerminal = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));

        const second = createMeasurementNoiseEnvelope({
            windowId: 'round/only',
            evidenceFile,
            authorityRoot: secondAuthorityRoot,
            authorityManifestRoot,
            priorAuthorityRoots: [firstAuthorityRoot],
            runId: 'authority-run',
            attemptSequence: 2,
            policy,
            collector: sequenceCollector([
                ...cleanPair(),
                snapshot(2000, { busy: 100, total: 1000, runCpu: 50 }),
                snapshot(3000, { busy: 200, total: 2000, runCpu: 100 }),
                ...cleanPair(4000)
            ]),
            now: (() =>
            {
                let value = 0;
                return () => (value += 10);
            })(),
            wait: async () =>
            {},
            setIntervalFn: () => ({ unref()
            {} }),
            clearIntervalFn: () =>
            {}
        });
        const preflight = await second.preflight();
        second.start(preflight);
        const latest = await second.finish({ preflight, productOutcome: { status: 'completed' } });
        assert.equal(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).authority.attemptSequence, 2);

        const sequence = readMeasurementNoiseAuthoritySequence(evidenceFile, {
            authorityRoot: secondAuthorityRoot,
            authorityManifestRoot,
            priorAuthorityRoots: [firstAuthorityRoot],
            expectedRunId: 'authority-run',
            expectedWindowId: 'round/only',
            policy
        });
        assert.equal(sequence[0].authority.attemptSequence, 1);
        assert.equal(sequence.at(-1).authority.contentDigest, latest.authority.contentDigest);
        const manifestWindowDirectory = path.join(
            authorityManifestRoot,
            fs.readdirSync(authorityManifestRoot)[0]
        );
        const manifestFiles = fs.readdirSync(manifestWindowDirectory).sort();
        const missingManifest = path.join(directory, manifestFiles[1]);
        fs.renameSync(path.join(manifestWindowDirectory, manifestFiles[1]), missingManifest);
        assert.throws(
            () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                authorityRoot: secondAuthorityRoot,
                authorityManifestRoot,
                priorAuthorityRoots: [firstAuthorityRoot],
                expectedRunId: 'authority-run',
                expectedWindowId: 'round/only',
                policy
            }),
            /manifest chain is invalid/u
        );
        fs.renameSync(missingManifest, path.join(manifestWindowDirectory, manifestFiles[1]));
        const [firstManifest, secondManifest] = manifestFiles;
        const firstDigestSuffix = firstManifest.slice(6);
        const secondDigestSuffix = secondManifest.slice(6);
        const reorderedFirst = path.join(manifestWindowDirectory, `000001${secondDigestSuffix}`);
        const reorderedSecond = path.join(manifestWindowDirectory, `000002${firstDigestSuffix}`);
        const manifestSwap = path.join(directory, 'manifest-swap');
        fs.renameSync(path.join(manifestWindowDirectory, firstManifest), manifestSwap);
        fs.renameSync(path.join(manifestWindowDirectory, secondManifest), reorderedFirst);
        fs.renameSync(manifestSwap, reorderedSecond);
        try
        {
            assert.throws(
                () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                    authorityRoot: secondAuthorityRoot,
                    authorityManifestRoot,
                    priorAuthorityRoots: [firstAuthorityRoot],
                    expectedRunId: 'authority-run',
                    expectedWindowId: 'round/only',
                    policy
                }),
                /manifest chain is invalid/u
            );
        }
        finally
        {
            fs.renameSync(reorderedSecond, manifestSwap);
            fs.renameSync(reorderedFirst, path.join(manifestWindowDirectory, secondManifest));
            fs.renameSync(manifestSwap, path.join(manifestWindowDirectory, firstManifest));
        }
        const firstWindowDirectory = path.join(
            firstAuthorityRoot,
            fs.readdirSync(firstAuthorityRoot)[0]
        );
        const unknownEntry = path.join(firstWindowDirectory, 'unknown-entry.json');
        fs.writeFileSync(unknownEntry, '{}\n');
        assert.throws(
            () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                authorityRoot: secondAuthorityRoot,
                authorityManifestRoot,
                priorAuthorityRoots: [firstAuthorityRoot],
                expectedRunId: 'authority-run',
                expectedWindowId: 'round/only',
                policy
            }),
            /contains an unexpected entry/u
        );
        fs.rmSync(unknownEntry);
        const unknownRootEntry = path.join(firstAuthorityRoot, 'unknown-root-entry');
        fs.writeFileSync(unknownRootEntry, '{}\n');
        assert.throws(
            () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                authorityRoot: secondAuthorityRoot,
                authorityManifestRoot,
                priorAuthorityRoots: [firstAuthorityRoot],
                expectedRunId: 'authority-run',
                expectedWindowId: 'round/only',
                policy
            }),
            /root contains an unexpected entry/u
        );
        fs.rmSync(unknownRootEntry);
        const firstReceiptName = fs.readdirSync(firstWindowDirectory)[0];
        const firstReceipt = path.join(firstWindowDirectory, firstReceiptName);
        const hiddenReceipt = `${firstReceipt}.hidden`;
        fs.renameSync(firstReceipt, hiddenReceipt);
        assert.throws(
            () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                authorityRoot: secondAuthorityRoot,
                authorityManifestRoot,
                priorAuthorityRoots: [firstAuthorityRoot],
                expectedRunId: 'authority-run',
                expectedWindowId: 'round/only',
                policy
            }),
            /contains an unexpected entry/u
        );
        fs.renameSync(hiddenReceipt, firstReceipt);
        assert.throws(
            () => validateMeasurementNoiseReceipt(latest, {
                expectedWindowId: 'round/only',
                authoritySequence: sequence,
                policy
            }),
            /cannot replace the first attempt with a retry/u
        );
        fs.writeFileSync(evidenceFile, `${JSON.stringify(firstTerminal, null, 2)}\n`);
        assert.throws(
            () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                authorityRoot: secondAuthorityRoot,
                authorityManifestRoot,
                priorAuthorityRoots: [firstAuthorityRoot],
                expectedRunId: 'authority-run',
                expectedWindowId: 'round/only',
                policy
            }),
            /latest receipt does not match the authority chain head/u
        );
        assert.equal(authorityRound([...sequence].reverse(), ['/only']).qualificationEligible, false);
        assert.throws(
            () => authorityRound(sequence.filter((receipt) => receipt.authority.attemptSequence === 2), ['/only']),
            /attempt sequence is not contiguous|hash chain is broken/u
        );
        fs.writeFileSync(evidenceFile, `${JSON.stringify(latest, null, 2)}\n`);
        fs.rmSync(firstAuthorityRoot, { recursive: true, force: true });
        assert.throws(
            () => readMeasurementNoiseAuthoritySequence(evidenceFile, {
                authorityRoot: secondAuthorityRoot,
                authorityManifestRoot,
                priorAuthorityRoots: [],
                expectedRunId: 'authority-run',
                expectedWindowId: 'round/only',
                policy
            }),
            /authority directory is missing/u
        );
        assert.throws(
            () => createMeasurementNoiseEnvelope({
                windowId: 'round/only',
                evidenceFile,
                authorityRoot: path.join(directory, 'attempt-0003-authority'),
                authorityManifestRoot,
                priorAuthorityRoots: [],
                runId: 'authority-run',
                attemptSequence: 3,
                policy,
                collector: sequenceCollector([])
            }),
            /authority directory is missing/u
        );
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('one noisy round makes the three-round cohort not qualified', () =>
{
    const firstClean = authorityRound([
        authorityReceipt('round/only', { runId: 'cohort-run-one' })
    ], ['/only']);
    const noisy = authorityRound([
        authorityReceipt('round/only', { noisy: true, runId: 'cohort-run-two' })
    ], ['/only']);
    const thirdClean = authorityRound([
        authorityReceipt('round/only', { runId: 'cohort-run-three' })
    ], ['/only']);
    const cohort = qualifyMeasurementCohort([firstClean, noisy, thirdClean]);
    assert.equal(cohort.status, 'not-qualified');
    assert.equal(cohort.productConclusionEligible, false);
    assert.deepEqual(cohort.rounds.map((round) => round.status), ['clean', 'noisy', 'clean']);
});

test('cohort qualification requires three distinct fresh run identities', () =>
{
    const duplicated = authorityRound([
        authorityReceipt('round/only', { runId: 'reused-run' })
    ], ['/only']);
    const third = authorityRound([
        authorityReceipt('round/only', { runId: 'fresh-run' })
    ], ['/only']);
    const cohort = qualifyMeasurementCohort([duplicated, duplicated, third]);
    assert.equal(cohort.freshRunIdentities, false);
    assert.equal(cohort.qualificationEligible, false);
    assert.deepEqual(cohort.runIds, ['reused-run', 'reused-run', 'fresh-run']);
});

test('forged clean authority receipt cannot enter a round or cohort', () =>
{
    const forged = authorityReceipt('round/only');
    forged.phases.during.observations[0].observation.metrics.hostCpuUtilization = 1;
    assert.throws(
        () => authorityRound([forged], ['/only']),
        /content digest|does not match policy recomputation/u
    );
});

test('policy separates blocking limits from diagnostic-only fields and does not rely on load1', () =>
{
    assert.equal(policy.metrics.currentRunIoBytes.qualification, 'diagnostic-only');
    assert.equal(Object.hasOwn(policy.metrics.currentRunIoBytes, 'maximum'), false);
    for (const [name, declaration] of Object.entries(policy.metrics))
    {
        if (declaration.qualification === 'blocking')
        {
            assert.ok(Number.isFinite(declaration.maximum) || Number.isFinite(declaration.minimum), name);
        }
    }
    assert.equal(Object.hasOwn(policy.metrics, 'load1'), false);
});

test('Linux collector rejects a shared cgroup instead of attributing sibling work to the run', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux cgroup contract');
    }
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    t.after(async () =>
    {
        await Promise.all([
            terminateOwnedProcessAndWait(sibling),
            terminateOwnedProcessAndWait(target)
        ]);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(
        () => createLinuxMeasurementCollector({ rootPid: target.pid }).collect(),
        (error) => error instanceof MeasurementCollectorUnavailableError
      && /cgroup is shared or incomplete/u.test(error.message)
    );
});

test('cgroup cumulative I/O and major faults retain a short-lived child after it exits', () =>
{
    const fixture = cgroupFixture();
    const before = fixture.collector.collect();
    fixture.advance();
    const after = fixture.collector.collect();
    const observation = deriveMeasurementObservation(before, after);
    assert.equal(observation.metrics.currentRunIoBytes, 300 * 1024 * 1024);
    assert.equal(observation.metrics.majorPageFaults, 4);
    assert.equal(observation.metrics.collectorCoverage, 1);
});

test('zombie child absent from cgroup.procs does not create a false incomplete-tree failure', () =>
{
    const fixture = cgroupFixture({ zombieChild: true });
    const observation = fixture.collector.collect();
    assert.equal(observation.currentRun.ioBytes, 0);
    assert.equal(observation.collectorCoverage, 1);
});

test('unreadable external identity is diagnostic and does not reduce metric collector coverage', () =>
{
    const fixture = cgroupFixture({ unreadableExternal: true });
    const before = fixture.collector.collect();
    fixture.advance();
    const after = fixture.collector.collect();
    const observation = deriveMeasurementObservation(before, after);
    const evaluation = evaluateMeasurementObservation(observation, policy);
    assert.equal(observation.metrics.collectorCoverage, 1);
    assert.equal(observation.externalProcesses.identityCoverage, 0);
    assert.equal(evaluation.qualificationEligible, false);
    assert.equal(evaluation.blockingFailures.some((entry) => entry.name === 'collectorCoverage'), false);
    assert.ok(evaluation.blockingFailures.some((entry) => entry.name === 'hostDiskReadWriteBytes'));
});

test('external process identities retain a recent low PID after PID namespace wraparound', () =>
{
    const oldestHighPid = 10_001;
    const recentLowPid = 200;
    const fixture = cgroupFixture({
        externalProcesses: [
            ...Array.from({ length: 64 }, (_, index) => ({
                pid: oldestHighPid + index,
                command: `old-${index + 1}`,
                startTimeTicks: index + 1
            })),
            { pid: recentLowPid, command: 'recent-low-pid', startTimeTicks: 1000 }
        ]
    });
    const observation = fixture.collector.collect();
    assert.equal(observation.externalProcesses.identities.length, 64);
    assert.ok(observation.externalProcesses.identities.some(({ pid }) => pid === recentLowPid));
    assert.ok(observation.externalProcesses.identities.every(({ pid }) => pid !== oldestHighPid));
    assert.equal(observation.externalProcesses.inventoryCount, 65);
    assert.equal(observation.externalProcesses.identityCoverage, 1);
});

test('missing cgroup I/O authority retains partial metrics and fails qualification closed', () =>
{
    const fixture = cgroupFixture({ missingIo: true });
    const before = fixture.collector.collect();
    fixture.advance();
    const after = fixture.collector.collect();
    const observation = deriveMeasurementObservation(before, after);
    const evaluation = evaluateMeasurementObservation(observation, policy);
    assert.equal(observation.metrics.currentRunIoBytes, null);
    assert.equal(observation.metrics.externalProcessIoEstimate, null);
    assert.equal(observation.metrics.collectorCoverage, 0.75);
    assert.ok(observation.collectorErrors.some((entry) => entry.source === 'currentRunIoBytes'));
    assert.equal(evaluation.qualificationEligible, false);
    assert.ok(evaluation.blockingFailures.some((entry) => entry.name === 'collectorCoverage'));
});

test('real external Linux CPU burner blocks task admission before the measured command starts', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux systemd task contract');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-cpu-real-'));
    const productMarker = path.join(directory, 'product.json');
    const evidenceFile = path.join(directory, 'evidence.json');
    let burner = null;
    t.after(async () =>
    {
        if (burner)
        {
            await terminateOwnedProcessAndWait(burner);
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const execution = runTaskScopedPerformanceAdmission({
        windowId: 'real-external-cpu-burner',
        evidenceFile,
        command: [process.execPath, taskFixture, 'timed', '100', productMarker],
        policy: shortRealPolicy(),
        envelopeFactory(options)
        {
            burner = spawn(process.execPath, ['-e', 'while (true) {}'], { stdio: 'ignore' });
            return createMeasurementNoiseEnvelope(options);
        }
    });
    await assert.rejects(execution, (error) =>
    {
        assert.equal(error.classification, 'infra.noisy-measurement-window');
        return true;
    });
    assert.equal(fs.existsSync(productMarker), false);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.phases.preflight.status, 'blocked');
    assert.ok(evidence.phases.preflight.attempts[0].observation.externalProcesses.identities
        .some((identity) => identity.pid === burner.pid));
    assert.ok(evidence.phases.preflight.attempts[0].evaluation.blockingFailures
        .some((entry) => entry.name === 'externalProcessCpuEstimate'));
});

test('real external disk writer started during measurement invalidates the task-scoped conclusion', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux systemd task contract');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-disk-real-'));
    const evidenceFile = path.join(directory, 'evidence.json');
    const productMarker = path.join(directory, 'product.json');
    const writers = [];
    t.after(async () =>
    {
        await Promise.all(writers.map((writer) => terminateOwnedProcessAndWait(writer)));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await assert.rejects(runTaskScopedPerformanceAdmission({
        windowId: 'real-external-disk-writer',
        evidenceFile,
        command: [process.execPath, taskFixture, 'timed', '6000', productMarker],
        policy: shortRealPolicy(),
        envelopeFactory: realHostDiskEnvelopeFactory,
        onMeasurementStarted()
        {
            for (let index = 0; index < 8; index += 1)
            {
                writers.push(spawn(process.execPath, [
                    taskFixture,
                    'disk-burn',
                    path.join(directory, `external-writer-${index}.bin`),
                    '5000'
                ], { stdio: 'ignore' }));
            }
        }
    }), (error) =>
    {
        assert.equal(error.classification, 'infra.noisy-measurement-window');
        assert.equal(error.evidence.productConclusionEligible, false);
        assert.equal(error.evidence.phases.preflight.status, 'clean');
        assert.ok(error.evidence.phases.during.observations.some(({ evaluation }) =>
            evaluation.blockingFailures.some((entry) =>
                entry.name === 'hostDiskReadWriteBytes' && entry.unavailable === false)));
        return true;
    });
    assert.equal(JSON.parse(fs.readFileSync(productMarker, 'utf8')).requestedDurationMs, 6000);
});

test('real task collector either qualifies or fails closed with complete evidence', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux systemd task contract');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-incomplete-real-'));
    const evidenceFile = path.join(directory, 'evidence.json');
    const productMarker = path.join(directory, 'product.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let result;
    try
    {
        result = await runTaskScopedPerformanceAdmission({
            windowId: 'real-platform-collector',
            evidenceFile,
            command: [process.execPath, taskFixture, 'timed', '100', productMarker],
            policy: hostTolerantRealPolicy()
        });
    }
    catch (error)
    {
        assert.equal(error.classification, 'infra.noisy-measurement-window');
        assert.equal(error.evidence.productConclusionEligible, false);
        const preflightAttempts = error.evidence.phases.preflight.attempts;
        const collectorUnavailable = preflightAttempts.some(({ evaluation }) =>
            evaluation.blockingFailures.some((entry) => entry.name === 'collectorCoverage'));
        if (collectorUnavailable)
        {
            assert.equal(fs.existsSync(productMarker), false);
            return;
        }

        const observations = [
            ...preflightAttempts,
            ...(error.evidence.phases.during?.observations ?? []),
            ...(error.evidence.phases.post ? [error.evidence.phases.post] : [])
        ];
        assert.ok(observations.length > 0);
        for (const { observation } of observations)
        {
            assert.equal(observation.metrics.collectorCoverage, 1);
            assert.ok(Number.isFinite(observation.metrics.currentRunIoBytes));
            assert.ok(Number.isFinite(observation.metrics.externalProcessIoEstimate));
        }
        assert.ok(observations.some(({ evaluation }) =>
            evaluation.blockingFailures.some((entry) => entry.name !== 'collectorCoverage')));
        if (error.evidence.phases.preflight.status !== 'clean')
        {
            assert.equal(fs.existsSync(productMarker), false);
        }
        return;
    }

    assert.equal(result.status, 'completed');
    assert.equal(fs.existsSync(productMarker), true);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.status, 'clean');
    assert.equal(evidence.qualificationEligible, true);
    for (const attempt of evidence.phases.preflight.attempts)
    {
        assert.equal(attempt.observation.metrics.collectorCoverage, 1);
        assert.ok(Number.isFinite(attempt.observation.metrics.currentRunIoBytes));
        assert.ok(Number.isFinite(attempt.observation.metrics.externalProcessIoEstimate));
    }
});

test('real bundle owner delegates through a lane process to one command without nested collection', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux systemd task contract');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-nested-real-'));
    const outerEvidence = path.join(directory, 'outer.json');
    const innerEvidence = path.join(directory, 'inner.json');
    const durationFile = path.join(directory, 'duration.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const result = await runTaskScopedPerformanceAdmission({
        windowId: 'real-outer-owner',
        evidenceFile: outerEvidence,
        command: [
            '/usr/bin/env',
            'bash',
            laneFixture,
            innerEvidence,
            durationFile
        ],
        policy,
        envelopeFactory: processProofEnvelopeFactory
    });
    const delegation = JSON.parse(fs.readFileSync(innerEvidence, 'utf8'));
    const duration = JSON.parse(fs.readFileSync(durationFile, 'utf8'));
    assert.equal(result.evidence.status, 'clean');
    assert.equal(delegation.status, 'delegated-to-outer-owner');
    assert.equal(delegation.collectorStarted, false);
    assert.equal(delegation.owner, result.owner);
    assert.ok(duration.measuredDurationMs >= 275);
    assert.ok(result.evidence.timing.measurementDurationMs >= 275);
    validateMeasurementNoiseReceipt(result.evidence, { expectedWindowId: 'real-outer-owner' });
});

test('task environment carrier keeps sensitive values out of argv and qualification receipts', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux systemd task contract');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-env-real-'));
    const evidenceFile = path.join(directory, 'evidence.json');
    const resultFile = path.join(directory, 'result.json');
    const secret = `fsusblog-sensitive-${Date.now()}-${Math.random()}`;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let argvMatches = [];
    let supervisorArgv = [];
    const result = await runTaskScopedPerformanceAdmission({
        windowId: 'real-environment-carrier',
        evidenceFile,
        command: [process.execPath, taskFixture, 'env-check', 'FSUSBLOG_FAKE_SECRET', resultFile],
        env: { ...process.env, FSUSBLOG_FAKE_SECRET: secret },
        policy,
        envelopeFactory: processProofEnvelopeFactory,
        onMeasurementStarted(context)
        {
            supervisorArgv = context.supervisorArgv;
            argvMatches = fs.readdirSync('/proc').filter((name) => /^\d+$/u.test(name)).flatMap((name) =>
            {
                try
                {
                    const commandLine = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
                    return commandLine.includes(secret) ? [Number(name)] : [];
                }
                catch
                {
                    return [];
                }
            });
        }
    });
    assert.equal(supervisorArgv.join('\0').includes(secret), false);
    assert.equal(supervisorArgv.some((argument) => argument.startsWith('--setenv=')), false);
    assert.deepEqual(argvMatches, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), {
        present: true,
        valueLength: secret.length
    });
    assert.equal(JSON.stringify(result.evidence).includes(secret), false);
});

test('collector failures at start, during, and post all persist terminal fail-closed evidence', async () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noise-terminal-'));
    try
    {
        const startFile = path.join(directory, 'start.json');
        const startEnvelope = createMeasurementNoiseEnvelope({
            windowId: 'collector-start-failure',
            evidenceFile: startFile,
            policy,
            collector: sequenceCollector([
                ...cleanPair(),
                Object.assign(new Error('start source vanished'), {
                    classification: 'infra.measurement-collector-unavailable'
                })
            ]),
            wait: async () =>
            {}
        });
        const startPreflight = await startEnvelope.preflight();
        assert.throws(() => startEnvelope.start(startPreflight));
        assert.equal(JSON.parse(fs.readFileSync(startFile, 'utf8')).status, 'blocked');

        for (const phase of ['during', 'post'])
        {
            const evidenceFile = path.join(directory, `${phase}.json`);
            const failure = Object.assign(new Error(`${phase} source vanished`), {
                classification: 'infra.measurement-collector-unavailable'
            });
            const entries = phase === 'during'
                ? [...cleanPair(), snapshot(2000), failure, snapshot(3000), ...cleanPair(4000)]
                : [...cleanPair(), snapshot(2000), snapshot(3000), failure];
            const collector = sequenceCollector(entries);
            const envelope = createMeasurementNoiseEnvelope({
                windowId: `collector-${phase}-failure`,
                evidenceFile,
                policy,
                collector,
                wait: async () =>
                {},
                setIntervalFn: phase === 'during'
                    ? (callback) =>
{
                        callback();
                        return { unref()
                        {} };
                    }
                    : () => ({ unref()
{} }),
                clearIntervalFn: () =>
                {}
            });
            const preflight = await envelope.preflight();
            envelope.start(preflight);
            if (phase === 'during')
            {
                const immediate = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
                assert.equal(immediate.status, 'blocked');
                assert.equal(immediate.productConclusionEligible, false);
            }
            const evidence = await envelope.finish({ preflight });
            assert.equal(evidence.qualificationEligible, false);
            assert.equal(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).qualificationEligible, false);
            assert.match(JSON.stringify(evidence), new RegExp(`${phase} source vanished`, 'u'));
        }
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
