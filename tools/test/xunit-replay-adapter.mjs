#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    REPLAY_PLAN_SCHEMA,
    REPLAY_RECEIPT_SCHEMA,
    canonicalDigest,
    canonicalTestId,
    planExactShards,
    sealReplayPlan,
    sealReplayReceipt,
    validateReplayPlan
} from './execution-replay-contract.mjs';
import { verifyExecutionReplay } from './execution-replay-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runnerProject = path.join(root, 'tools/test/xunit-replay-runner/FsusBlog.XunitReplayRunner.csproj');
const runnerDll = path.join(root, 'tools/test/xunit-replay-runner/bin/Release/net10.0/FsusBlog.XunitReplayRunner.dll');

function fail(message)
{
    throw new Error(message);
}

function parseArgs(argv)
{
    const options = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
        {
            fail('usage: xunit-replay-adapter.mjs --assembly <dll> --output-dir <dir> --root-seed <seed> --workers <n> --run-id <id> [--class <exact-name>]');
        }
        const name = key.slice(2);
        const values = options.get(name) ?? [];
        values.push(value);
        options.set(name, values);
    }
    return {
        one(name, required = true)
        {
            const values = options.get(name) ?? [];
            if (values.length > 1)
            {
                fail(`--${name} may appear only once`);
            }
            if (required && values.length !== 1)
            {
                fail(`missing --${name}`);
            }
            return values[0];
        },
        many(name)
        {
            return options.get(name) ?? [];
        }
    };
}

function run(executable, args, { env = process.env, capture = false } = {})
{
    const result = spawnSync(executable, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: capture ? 'pipe' : 'inherit'
    });
    if (result.error)
    {
        throw result.error;
    }
    if (result.status !== 0)
    {
        fail(`${executable} ${args.join(' ')} failed (${result.status}): ${result.stderr ?? ''}`);
    }
    return result.stdout ?? '';
}

function atomicJson(file, value)
{
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, file);
}

function readJson(file)
{
    return JSON.parse(readFileSync(file, 'utf8'));
}

function repoPath(file, label)
{
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        fail(`${label} escapes the repository`);
    }
    return absolute;
}

function sourceIdentity(options)
{
    const commit = options.one('source-commit', false)
        ?? process.env.FSUSBLOG_TEST_SOURCE_COMMIT
        ?? run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
    const configured = options.one('worktree-fingerprint', false)
        ?? process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT;
    if (configured)
    {
        const worktreeFingerprint = configured.startsWith('sha256:') ? configured : `sha256:${configured}`;
        return { commit, worktreeFingerprint };
    }
    const diff = run('git', ['diff', '--binary', 'HEAD'], { capture: true });
    const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { capture: true })
        .split('\0').filter(Boolean).sort()
        .map((file) => ({ file, content: readFileSync(path.join(root, file)).toString('base64') }));
    return { commit, worktreeFingerprint: canonicalDigest({ diff, untracked }) };
}

function buildRunner()
{
    run('dotnet', ['build', runnerProject, '-c', 'Release']);
}

function canonicalize(discovery, selectedClasses)
{
    const classes = new Set(selectedClasses);
    const selected = discovery.tests.filter((test) => classes.size === 0 || classes.has(test.testClassName));
    if (selected.length === 0)
    {
        fail('xUnit selection discovered no tests');
    }
    const casesPerMethod = new Map();
    for (const test of selected)
    {
        casesPerMethod.set(test.testMethodUniqueId, (casesPerMethod.get(test.testMethodUniqueId) ?? 0) + 1);
    }
    return selected.map((test) => ({
        canonicalTestId: canonicalTestId({
            framework: 'xunit',
            source: 'tests/backend/FsusBlog.Server.Tests.csproj',
            name: [test.testClassName, test.testMethodName],
            caseIdentity: casesPerMethod.get(test.testMethodUniqueId) > 1
                || test.testCaseDisplayName !== `${test.testClassName}.${test.testMethodName}`
                ? { kind: 'parameterized', id: test.testCaseUniqueId }
                : null
        }),
        xunit: test
    })).sort((left, right) => Buffer.compare(
        Buffer.from(left.canonicalTestId, 'utf8'),
        Buffer.from(right.canonicalTestId, 'utf8')));
}

function assignCollections(entries, workerIds)
{
    const grouped = new Map();
    for (const entry of entries)
    {
        const collectionId = entry.xunit.testCollectionUniqueId;
        const collection = grouped.get(collectionId) ?? [];
        collection.push(entry);
        grouped.set(collectionId, collection);
    }
    const workers = workerIds.map((id) => ({ id, count: 0, collections: [] }));
    const collections = [...grouped.entries()].map(([id, tests]) => ({ id, tests }))
        .sort((left, right) => left.tests[0].canonicalTestId.localeCompare(right.tests[0].canonicalTestId));
    for (const collection of collections)
    {
        const worker = workers.reduce((best, candidate) =>
            candidate.count < best.count ? candidate : best);
        worker.collections.push(collection);
        worker.count += collection.tests.length;
    }
    return workers;
}

function inventoryDigest(entries, discovery)
{
    return canonicalDigest({
        assemblyUniqueId: discovery.assemblyUniqueId,
        framework: discovery.framework,
        targetFramework: discovery.targetFramework,
        tests: entries.map((entry) => ({
            canonicalTestId: entry.canonicalTestId,
            collectionId: entry.xunit.testCollectionUniqueId,
            classId: entry.xunit.testClassUniqueId,
            methodId: entry.xunit.testMethodUniqueId,
            caseId: entry.xunit.testCaseUniqueId,
            serializationDigest: canonicalDigest(entry.xunit.serialization)
        }))
    });
}

function manifestFrom({ plan, entries, discovery, assignments })
{
    const manifest = {
        schema: 'fsusblog.xunit-replay-queue-manifest.v1',
        planDigest: plan.planDigest,
        inventoryDigest: inventoryDigest(entries, discovery),
        assembly: discovery.assembly,
        assemblyUniqueId: discovery.assemblyUniqueId,
        framework: discovery.framework,
        targetFramework: discovery.targetFramework,
        slots: assignments.map((worker) => ({
            id: worker.id,
            collections: worker.collections.map((collection) => ({
                testCollectionUniqueId: collection.id,
                tests: collection.tests.map((entry) => ({
                    canonicalTestId: entry.canonicalTestId,
                    testCollectionUniqueId: entry.xunit.testCollectionUniqueId,
                    testCaseUniqueId: entry.xunit.testCaseUniqueId,
                    serialization: entry.xunit.serialization
                }))
            }))
        }))
    };
    return { ...manifest, contentDigest: canonicalDigest(manifest) };
}

function validateManifest(plan, manifest)
{
    if (manifest.schema !== 'fsusblog.xunit-replay-queue-manifest.v1'
        || manifest.planDigest !== plan.planDigest
        || manifest.contentDigest !== canonicalDigest(Object.fromEntries(
            Object.entries(manifest).filter(([key]) => key !== 'contentDigest'))))
    {
        fail('xUnit queue manifest schema, plan binding or digest is invalid');
    }
    const mode = plan.frameworkModes.find((candidate) => candidate.name === 'inventory-digest');
    if (mode?.value !== manifest.inventoryDigest)
    {
        fail('xUnit queue manifest inventory drift');
    }
    const actualIds = manifest.slots.flatMap((slot) => slot.collections.flatMap((collection) =>
        collection.tests.map((test) => test.canonicalTestId))).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify([...plan.testEnumerationOrder]))
    {
        fail('xUnit queue manifest does not exact-match sealed test membership');
    }
    if (JSON.stringify(manifest.slots.map((slot) => slot.id)) !== JSON.stringify(plan.workers.ids))
    {
        fail('xUnit queue manifest worker topology drift');
    }
}

function spawnSlot({ manifest, slot, outputDirectory })
{
    const queueFile = path.join(outputDirectory, 'queues', `${slot.id}.json`);
    const receiptFile = path.join(outputDirectory, 'slots', `${slot.id}.json`);
    atomicJson(queueFile, {
        schema: 'fsusblog.xunit-replay-slot-queue.v1',
        planDigest: manifest.planDigest,
        slotId: slot.id,
        collections: slot.collections.map((collection) => ({
            testCollectionUniqueId: collection.testCollectionUniqueId,
            tests: collection.tests.map((test) => ({
                testCollectionUniqueId: test.testCollectionUniqueId,
                testCaseUniqueId: test.testCaseUniqueId,
                serialization: test.serialization
            }))
        }))
    });
    return new Promise((resolve, reject) =>
    {
        const child = spawn('dotnet', [runnerDll, 'run-slot',
            '--assembly', manifest.assembly,
            '--queue', queueFile,
            '--output', receiptFile], {
            cwd: root,
            env: process.env,
            stdio: ['ignore', 'inherit', 'inherit']
        });
        const pid = child.pid;
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ slot, receiptFile, pid, code, signal }));
    });
}

async function execute({ plan, manifest, outputDirectory })
{
    validateReplayPlan(plan);
    validateManifest(plan, manifest);
    mkdirSync(outputDirectory, { recursive: true });
    const dispatches = manifest.slots.map((slot, ordinal) => ({
        ordinal,
        slotId: slot.id,
        collectionIds: slot.collections.map((collection) => collection.testCollectionUniqueId),
        testIds: slot.collections.flatMap((collection) => collection.tests.map((test) => test.canonicalTestId))
    }));
    const results = await Promise.all(manifest.slots.map((slot) => spawnSlot({ manifest, slot, outputDirectory })));
    const slotActuals = results.map((result) =>
    {
        if (!Number.isInteger(result.pid))
        {
            fail(`xUnit slot ${result.slot.id} did not expose a real process ID`);
        }
        const receipt = readJson(result.receiptFile);
        if (receipt.schema !== 'fsusblog.xunit-replay-slot-receipt.v1'
            || receipt.planDigest !== plan.planDigest
            || receipt.slotId !== result.slot.id
            || receipt.processId !== result.pid)
        {
            fail(`xUnit slot ${result.slot.id} process or plan binding drift`);
        }
        return { ...result, receipt };
    });
    const canonicalByCase = new Map(manifest.slots.flatMap((slot) => slot.collections.flatMap((collection) =>
        collection.tests.map((test) => [test.testCaseUniqueId, test.canonicalTestId]))));
    const actualIds = slotActuals.flatMap((slot) => slot.receipt.outcomes.map((outcome) =>
        canonicalByCase.get(outcome.testCaseUniqueId) ?? fail(`unknown actual xUnit case ${outcome.testCaseUniqueId}`)))
        .sort();
    if (JSON.stringify(actualIds) !== JSON.stringify([...plan.testEnumerationOrder]))
    {
        fail('xUnit actual outcome set does not exact-match sealed plan');
    }
    const workerReceipts = slotActuals.map((actual) => ({
        id: actual.slot.id,
        testIds: actual.slot.collections.flatMap((collection) =>
            collection.tests.map((test) => test.canonicalTestId)).sort()
    }));
    const workerByTest = new Map(workerReceipts.flatMap((worker) => worker.testIds.map((testId) => [testId, worker.id])));
    const shardByTest = new Map(plan.shards.flatMap((shard) => shard.testIds.map((testId) => [testId, shard.id])));
    const passed = slotActuals.every((actual) => actual.code === 0 && actual.signal === null);
    const receipt = sealReplayReceipt({
        schema: REPLAY_RECEIPT_SCHEMA,
        source: plan.source,
        producer: plan.producer,
        run: plan.run,
        planDigest: plan.planDigest,
        rootSeed: plan.rootSeed,
        entropySources: plan.entropySources,
        randomStreams: plan.randomStreams,
        testIds: plan.testEnumerationOrder,
        shards: plan.shards,
        workers: workerReceipts,
        admissionSequence: plan.testEnumerationOrder.map((testId, ordinal) => ({
            ordinal,
            testId,
            shardId: shardByTest.get(testId),
            workerId: workerByTest.get(testId)
        })),
        processOutcome: {
            status: passed ? 'passed' : 'failed',
            exitCode: passed ? 0 : (slotActuals.find((actual) => actual.code !== 0)?.code ?? 1),
            signal: slotActuals.find((actual) => actual.signal)?.signal ?? null
        }
    });
    const frameworkActualBase = {
        schema: 'fsusblog.xunit-replay-actual.v1',
        planDigest: plan.planDigest,
        producerId: plan.producer.id,
        sourceCommit: plan.source.commit,
        worktreeFingerprint: plan.source.worktreeFingerprint,
        actualTestIds: plan.testEnumerationOrder,
        evidenceClass: 'correctness',
        qualificationEligible: passed,
        inventory: {
            assembly: manifest.assembly,
            assemblyUniqueId: manifest.assemblyUniqueId,
            framework: manifest.framework,
            targetFramework: manifest.targetFramework,
            inventoryDigest: manifest.inventoryDigest
        },
        preDispatch: dispatches,
        workers: slotActuals.map((actual) => ({
            slotId: actual.slot.id,
            processId: actual.pid,
            exitCode: actual.code,
            signal: actual.signal,
            admissions: actual.receipt.admissions,
            starts: actual.receipt.starts.map((start) => ({
                ...start,
                canonicalTestId: canonicalByCase.get(start.testCaseUniqueId)
            })),
            outcomes: actual.receipt.outcomes.map((outcome) => ({
                ...outcome,
                canonicalTestId: canonicalByCase.get(outcome.testCaseUniqueId)
            }))
        })),
        semanticDigest: canonicalDigest(slotActuals.map((actual) => ({
            slotId: actual.slot.id,
            tests: actual.receipt.outcomes.map((outcome) => ({
                canonicalTestId: canonicalByCase.get(outcome.testCaseUniqueId),
                outcome: outcome.outcome
            })).sort((left, right) => left.canonicalTestId.localeCompare(right.canonicalTestId))
        }))),
        contentDigest: null
    };
    const frameworkActual = {
        ...frameworkActualBase,
        contentDigest: canonicalDigest(frameworkActualBase)
    };
    atomicJson(path.join(outputDirectory, 'receipt.json'), receipt);
    atomicJson(path.join(outputDirectory, 'framework-actual.json'), frameworkActual);
    if (passed)
    {
        const verification = verifyExecutionReplay({ plan, receipt, frameworkActuals: [frameworkActual] });
        atomicJson(path.join(outputDirectory, 'verification.json'), verification);
    }
    return { passed, receipt, frameworkActual };
}

async function createAndExecute(options)
{
    buildRunner();
    const outputDirectory = repoPath(options.one('output-dir'), 'output directory');
    const assembly = repoPath(options.one('assembly'), 'assembly');
    const discoveryFile = path.join(outputDirectory, 'discovery.json');
    run('dotnet', [runnerDll, 'discover', '--assembly', assembly, '--output', discoveryFile]);
    const discovery = readJson(discoveryFile);
    if (discovery.schema !== 'fsusblog.xunit-replay-discovery.v1')
    {
        fail('xUnit discovery schema is invalid');
    }
    const entries = canonicalize(discovery, options.many('class'));
    const workerCount = Number(options.one('workers'));
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > entries.length)
    {
        fail('--workers must be a positive integer no greater than selected tests');
    }
    const workerIds = Array.from({ length: workerCount }, (_, index) => `xunit-slot-${index + 1}`);
    const assignment = planExactShards({ testIds: entries.map((entry) => entry.canonicalTestId), shardCount: workerCount });
    const identity = sourceIdentity(options);
    const planFile = path.join(outputDirectory, 'plan.json');
    const manifestFile = path.join(outputDirectory, 'queue-manifest.json');
    const replayOutput = path.join(outputDirectory, 'replay');
    const plan = sealReplayPlan({
        schema: REPLAY_PLAN_SCHEMA,
        source: identity,
        producer: { id: options.one('producer', false) ?? 'backend-xunit', framework: 'xunit' },
        run: { id: options.one('run-id'), mode: 'qualification' },
        rootSeed: options.one('root-seed'),
        entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
        randomStreams: [],
        ...assignment,
        workers: { ids: workerIds, assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [
            { name: 'collection-mode', value: 'repo-owned-static-collection-queues' },
            { name: 'inventory-digest', value: inventoryDigest(entries, discovery) },
            { name: 'parallelization', value: workerCount === 1 ? 'single-slot' : 'parallel-process-slots' },
            { name: 'runner', value: 'xunit-front-controller' },
            { name: 'runner-version', value: 'xunit.v3.runner.utility-3.2.2' }
        ],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: options.one('scheduler-seed', false) ?? 'xunit-collection-order-v1',
        command: {
            executable: process.execPath,
            args: [path.join(root, 'tools/test/xunit-replay-adapter.mjs'),
                '--replay-plan', planFile,
                '--queue-manifest', manifestFile,
                '--output-dir', replayOutput],
            environmentDigest: canonicalDigest({ inherited: ['PATH'], replayInputs: 'sealed-plan-environment' })
        }
    });
    const assignments = assignCollections(entries, workerIds);
    const manifest = manifestFrom({ plan, entries, discovery, assignments });
    atomicJson(planFile, plan);
    atomicJson(manifestFile, manifest);
    return execute({ plan, manifest, outputDirectory: path.join(outputDirectory, 'actual') });
}

async function replay(options)
{
    buildRunner();
    const planFile = repoPath(options.one('replay-plan'), 'replay plan');
    const manifestFile = repoPath(options.one('queue-manifest'), 'queue manifest');
    const outputDirectory = repoPath(options.one('output-dir'), 'output directory');
    const plan = readJson(planFile);
    const manifest = readJson(manifestFile);
    for (const [name, actual, expected] of [
        ['plan digest', process.env.FSUSBLOG_REPLAY_PLAN_DIGEST, plan.planDigest],
        ['root seed', process.env.FSUSBLOG_REPLAY_ROOT_SEED, plan.rootSeed],
        ['shard membership', process.env.FSUSBLOG_REPLAY_SHARD_DIGEST, plan.shardDigest],
        ['worker topology', process.env.FSUSBLOG_REPLAY_WORKERS, plan.workers.ids.join(',')]
    ])
    {
        if (actual !== undefined && actual !== expected)
        {
            fail(`replay ${name} drift`);
        }
    }
    return execute({ plan, manifest, outputDirectory });
}

try
{
    const options = parseArgs(process.argv.slice(2));
    const result = options.one('replay-plan', false)
        ? await replay(options)
        : await createAndExecute(options);
    if (!result.passed)
    {
        process.exitCode = 1;
    }
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
}
