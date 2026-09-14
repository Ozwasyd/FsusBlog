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
const frontendRoot = path.join(root, 'src/frontend');
const vitest = path.join(frontendRoot, 'node_modules/.bin/vitest');

function fail(message)
{
    throw new Error(message);
}

function parseArgs(argv)
{
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        if (!key?.startsWith('--') || argv[index + 1] === undefined)
        {
            fail('invalid Vitest replay arguments');
        }
        values.set(key.slice(2), [...(values.get(key.slice(2)) ?? []), argv[index + 1]]);
    }
    return {
        one(name, required = true)
        {
            const found = values.get(name) ?? [];
            if (found.length > 1)
            {
                fail(`--${name} may appear only once`);
            }
            if (required && found.length !== 1)
            {
                fail(`missing --${name}`);
            }
            return found[0];
        },
        many: (name) => values.get(name) ?? []
    };
}

function repoPath(file, label)
{
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        fail(`${label} escapes repository`);
    }
    return absolute;
}

function run(executable, args, { cwd = root, env = process.env, capture = false } = {})
{
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
    if (result.error)
    {
        throw result.error;
    }
    if (result.status !== 0)
    {
        fail(`${executable} failed (${result.status}): ${result.stderr ?? ''}`);
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

function sourceIdentity(options)
{
    const commit = options.one('source-commit', false) ?? process.env.FSUSBLOG_TEST_SOURCE_COMMIT
        ?? run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
    const configured = options.one('worktree-fingerprint', false) ?? process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT;
    if (configured)
    {
        return { commit, worktreeFingerprint: configured.startsWith('sha256:') ? configured : `sha256:${configured}` };
    }
    const diff = run('git', ['diff', '--binary', 'HEAD'], { capture: true });
    const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { capture: true })
        .split('\0').filter(Boolean).sort().map((file) => ({ file, content: readFileSync(path.join(root, file)).toString('base64') }));
    return { commit, worktreeFingerprint: canonicalDigest({ diff, untracked }) };
}

function canonicalDiscovery(items)
{
    if (!Array.isArray(items) || items.length === 0)
    {
        fail('Vitest discovery returned no tests');
    }
    return items.map((item) =>
    {
        const file = path.relative(root, path.resolve(item.file)).replaceAll(path.sep, '/');
        return {
            canonicalTestId: canonicalTestId({
                framework: 'vitest',
                source: file,
                name: 'test',
                caseIdentity: { kind: 'parameterized', id: item.name }
            }),
            name: item.name,
            file: path.resolve(item.file)
        };
    }).sort((left, right) => Buffer.compare(Buffer.from(left.canonicalTestId), Buffer.from(right.canonicalTestId)));
}

function assignFiles(entries, workerIds)
{
    const byFile = new Map();
    for (const entry of entries)
    {
        byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
    }
    if (workerIds.length > byFile.size)
    {
        fail(`Vitest topology ${workerIds.length} exceeds discovered file atoms ${byFile.size}`);
    }
    const workers = workerIds.map((id) => ({ id, count: 0, files: [] }));
    const files = [...byFile.entries()].map(([file, tests]) => ({ file, tests }))
        .sort((left, right) => left.tests[0].canonicalTestId.localeCompare(right.tests[0].canonicalTestId));
    for (const file of files)
    {
        const worker = workers.reduce((best, candidate) => candidate.count < best.count ? candidate : best);
        worker.files.push(file);
        worker.count += file.tests.length;
    }
    return workers;
}

function makeManifest(plan, config, assignments)
{
    const base = {
        schema: 'fsusblog.vitest-replay-queue-manifest.v1',
        planDigest: plan.planDigest,
        config,
        slots: assignments.map((worker) => ({
            id: worker.id,
            files: worker.files.map((file) => ({
                file: file.file,
                tests: file.tests.map((test) => ({ canonicalTestId: test.canonicalTestId, name: test.name }))
            }))
        }))
    };
    return { ...base, contentDigest: canonicalDigest(base) };
}

function validateManifest(plan, manifest)
{
    const { contentDigest, ...base } = manifest;
    if (manifest.schema !== 'fsusblog.vitest-replay-queue-manifest.v1'
        || manifest.planDigest !== plan.planDigest || contentDigest !== canonicalDigest(base))
    {
        fail('Vitest queue manifest is invalid');
    }
    const ids = manifest.slots.flatMap((slot) => slot.files.flatMap((file) => file.tests.map((test) => test.canonicalTestId))).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...plan.testEnumerationOrder]))
    {
        fail('Vitest queue membership drift');
    }
    if (JSON.stringify(manifest.slots.map((slot) => slot.id)) !== JSON.stringify(plan.workers.ids))
    {
        fail('Vitest slot topology drift');
    }
}

function spawnSlot({ plan, manifest, slot, outputDirectory })
{
    const resultFile = path.join(outputDirectory, 'slots', `${slot.id}.json`);
    const topologyFile = path.join(outputDirectory, 'slots', `${slot.id}.workers.jsonl`);
    mkdirSync(path.dirname(resultFile), { recursive: true });
    const files = slot.files.map((file) => path.relative(frontendRoot, file.file).replaceAll(path.sep, '/'));
    const args = ['run', ...files, '--config', manifest.config, '--reporter=json', `--outputFile=${resultFile}`,
        '--pool=forks', '--maxWorkers=1', '--no-fileParallelism', '--retry=0'];
    return new Promise((resolve, reject) =>
    {
        const child = spawn(vitest, args, {
            cwd: frontendRoot,
            env: {
                ...process.env,
                FSUSBLOG_VITEST_MAX_WORKERS: '1',
                FSUSBLOG_VITEST_RUNTIME_TOPOLOGY_EVIDENCE: topologyFile,
                FSUSBLOG_REPLAY_PLAN_DIGEST: plan.planDigest
            },
            stdio: ['ignore', 'inherit', 'inherit']
        });
        const pid = child.pid;
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ slot, resultFile, topologyFile, pid, code, signal }));
    });
}

function actualName(assertion)
{
    return [...assertion.ancestorTitles, assertion.title].join(' > ');
}

async function execute(plan, manifest, outputDirectory)
{
    validateReplayPlan(plan);
    validateManifest(plan, manifest);
    const dispatch = manifest.slots.map((slot, ordinal) => ({
        ordinal, slotId: slot.id, files: slot.files.map((file) => file.file),
        testIds: slot.files.flatMap((file) => file.tests.map((test) => test.canonicalTestId))
    }));
    const results = await Promise.all(manifest.slots.map((slot) => spawnSlot({ plan, manifest, slot, outputDirectory })));
    const canonicalByFileName = new Map(manifest.slots.flatMap((slot) => slot.files.flatMap((file) =>
        file.tests.map((test) => [`${path.resolve(file.file)}\0${test.name}`, test.canonicalTestId]))));
    const workers = results.map((result) =>
    {
        if (!Number.isInteger(result.pid))
        {
            fail(`Vitest slot ${result.slot.id} has no real controller PID`);
        }
        const report = readJson(result.resultFile);
        const outcomes = report.testResults.flatMap((module) => module.assertionResults.map((assertion) => ({
            canonicalTestId: canonicalByFileName.get(`${path.resolve(module.name)}\0${actualName(assertion)}`)
                ?? fail(`Vitest emitted unknown test ${module.name} ${actualName(assertion)}`),
            status: assertion.status,
            duration: assertion.duration,
            failureMessages: assertion.failureMessages
        })));
        const topology = readFileSync(result.topologyFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const workerProcessIds = [...new Set(topology.map((event) => event.workerProcessId))];
        if (workerProcessIds.length === 0 || workerProcessIds.some((processId) => !Number.isInteger(processId)))
        {
            fail(`Vitest slot ${result.slot.id} did not report actual pool worker identities`);
        }
        if (topology.filter((event) => event.event === 'start').length !== outcomes.length
            || topology.filter((event) => event.event === 'finish').length !== outcomes.length)
        {
            fail(`Vitest slot ${result.slot.id} worker event drift`);
        }
        return { ...result, report, outcomes, topology, workerProcessIds };
    });
    const actualIds = workers.flatMap((worker) => worker.outcomes.map((outcome) => outcome.canonicalTestId)).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify([...plan.testEnumerationOrder]))
    {
        fail('Vitest actual set drift');
    }
    const workerReceipts = workers.map((worker) => ({
        id: worker.slot.id,
        testIds: worker.outcomes.map((outcome) => outcome.canonicalTestId).sort()
    }));
    const workerByTest = new Map(workerReceipts.flatMap((worker) => worker.testIds.map((test) => [test, worker.id])));
    const shardByTest = new Map(plan.shards.flatMap((shard) => shard.testIds.map((test) => [test, shard.id])));
    const passed = workers.every((worker) => worker.code === 0 && worker.signal === null && worker.report.success);
    const receipt = sealReplayReceipt({
        schema: REPLAY_RECEIPT_SCHEMA, source: plan.source, producer: plan.producer, run: plan.run,
        planDigest: plan.planDigest, rootSeed: plan.rootSeed, entropySources: plan.entropySources,
        randomStreams: plan.randomStreams, testIds: plan.testEnumerationOrder, shards: plan.shards,
        workers: workerReceipts,
        admissionSequence: plan.testEnumerationOrder.map((testId, ordinal) => ({
            ordinal, testId, shardId: shardByTest.get(testId), workerId: workerByTest.get(testId)
        })),
        processOutcome: { status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, signal: null }
    });
    const actualBase = {
        schema: 'fsusblog.vitest-replay-actual.v1', planDigest: plan.planDigest, producerId: plan.producer.id,
        sourceCommit: plan.source.commit, worktreeFingerprint: plan.source.worktreeFingerprint,
        actualTestIds: plan.testEnumerationOrder, evidenceClass: 'correctness', qualificationEligible: passed,
        preDispatch: dispatch,
        workers: workers.map((worker) => ({
            slotId: worker.slot.id, controllerProcessId: worker.pid, poolWorkerProcessIds: worker.workerProcessIds,
            exitCode: worker.code, signal: worker.signal, topology: worker.topology, outcomes: worker.outcomes
        })),
        semanticDigest: canonicalDigest(workers.map((worker) => ({
            slotId: worker.slot.id,
            tests: worker.outcomes.map((outcome) => ({ canonicalTestId: outcome.canonicalTestId, status: outcome.status })).sort()
        }))),
        contentDigest: null
    };
    const actual = { ...actualBase, contentDigest: canonicalDigest(actualBase) };
    atomicJson(path.join(outputDirectory, 'receipt.json'), receipt);
    atomicJson(path.join(outputDirectory, 'framework-actual.json'), actual);
    if (passed)
    {
        atomicJson(path.join(outputDirectory, 'verification.json'), verifyExecutionReplay({ plan, receipt, frameworkActuals: [actual] }));
    }
    return { passed };
}

async function create(options)
{
    const outputDirectory = repoPath(options.one('output-dir'), 'output directory');
    const config = repoPath(options.one('config'), 'Vitest config');
    const discoveryFile = path.join(outputDirectory, 'discovery.json');
    const filters = options.many('file').map((file) => repoPath(file, 'Vitest file'));
    run(vitest, ['list', ...filters, '--config', config, `--json=${discoveryFile}`], { cwd: frontendRoot });
    const entries = canonicalDiscovery(readJson(discoveryFile));
    const workerCount = Number(options.one('workers'));
    if (!Number.isInteger(workerCount) || workerCount < 1)
    {
        fail('invalid Vitest workers');
    }
    const ids = Array.from({ length: workerCount }, (_, index) => `vitest-slot-${index + 1}`);
    const assignment = planExactShards({ testIds: entries.map((entry) => entry.canonicalTestId), shardCount: workerCount });
    const planFile = path.join(outputDirectory, 'plan.json');
    const manifestFile = path.join(outputDirectory, 'queue-manifest.json');
    const plan = sealReplayPlan({
        schema: REPLAY_PLAN_SCHEMA, source: sourceIdentity(options),
        producer: { id: options.one('producer', false) ?? 'frontend-vitest', framework: 'vitest' },
        run: { id: options.one('run-id'), mode: 'qualification' }, rootSeed: options.one('root-seed'),
        entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [], ...assignment,
        workers: { ids, assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [
            { name: 'file-isolation', value: 'preserved-file-atoms' },
            { name: 'pool', value: 'forks' },
            { name: 'runner-version', value: 'vitest-4.1.5' },
            { name: 'slot-model', value: 'repo-owned-process-lanes' }
        ],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: options.one('scheduler-seed', false) ?? 'vitest-file-order-v1',
        command: {
            executable: process.execPath,
            args: [path.join(root, 'tools/test/vitest-replay-adapter.mjs'), '--replay-plan', planFile,
                '--queue-manifest', manifestFile, '--output-dir', path.join(outputDirectory, 'replay')],
            environmentDigest: canonicalDigest({ inherited: ['PATH'], replayInputs: 'sealed-plan-environment' })
        }
    });
    const manifest = makeManifest(plan, config, assignFiles(entries, ids));
    atomicJson(planFile, plan);
    atomicJson(manifestFile, manifest);
    return execute(plan, manifest, path.join(outputDirectory, 'actual'));
}

async function replay(options)
{
    const plan = readJson(repoPath(options.one('replay-plan'), 'plan'));
    const manifest = readJson(repoPath(options.one('queue-manifest'), 'manifest'));
    for (const [actual, expected, label] of [
        [process.env.FSUSBLOG_REPLAY_PLAN_DIGEST, plan.planDigest, 'plan'],
        [process.env.FSUSBLOG_REPLAY_ROOT_SEED, plan.rootSeed, 'root seed'],
        [process.env.FSUSBLOG_REPLAY_WORKERS, plan.workers.ids.join(','), 'workers']
    ])
    {
        if (actual !== undefined && actual !== expected)
        {
            fail(`Vitest replay ${label} drift`);
        }
    }
    return execute(plan, manifest, repoPath(options.one('output-dir'), 'output directory'));
}

try
{
    const options = parseArgs(process.argv.slice(2));
    const result = options.one('replay-plan', false) ? await replay(options) : await create(options);
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
