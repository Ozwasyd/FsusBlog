#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    REPLAY_PLAN_SCHEMA,
    REPLAY_RECEIPT_SCHEMA,
    canonicalDigest,
    normalizeRootSeed,
    planExactShards,
    sealReplayPlan,
    sealReplayReceipt,
    validateReplayPlan
} from './execution-replay-contract.mjs';
import { buildExecutionReplayCommand } from './execution-replay-verifier.mjs';
import {
    createRandomStreamReceipt,
    deriveRandomConsumerStream,
    loadRandomStreamInventory,
    readRandomExecutionObservation
} from './random-streams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryFile = path.join(root, 'config/testing/replay-qualification-producers.json');
const { readPrivateFile } = await import(new URL('../test-fixtures/receipt/private-io.mjs', import.meta.url));

function fail(message)
{
    throw new Error(message);
}

function parseArgs(argv)
{
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined)
        {
            fail('qualification arguments must be --key value pairs');
        }
        if (values.has(argv[index].slice(2)))
        {
            fail(`duplicate ${argv[index]}`);
        }
        values.set(argv[index].slice(2), argv[index + 1]);
    }
    const required = (name) => values.get(name) ?? fail(`missing --${name}`);
    return {
        family: required('family'),
        runId: required('run-id'),
        rootSeed: normalizeRootSeed(required('root-seed')),
        outputDirectory: path.resolve(root, values.get('output-dir') ?? `.tmp/test-runs/${required('run-id')}/replay-qualification`)
    };
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

function fileDigest(file)
{
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function owned(file, label)
{
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        fail(`${label} escapes repository`);
    }
    return absolute;
}

function inventory()
{
    const document = readJson(inventoryFile);
    if (document.schema !== 'fsusblog.replay-qualification-producers.v1'
        || document.contentDigest !== canonicalDigest({ ...document, contentDigest: null }))
    {
        fail('replay qualification inventory digest mismatch');
    }
    return document;
}

function spawnCommand(executable, args, env = process.env, cwd = root, { onStarted = null, retainSpawnError = false } = {})
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
        let spawnError = null;
        child.once('error', (error) =>
        {
            spawnError = error;
            if (!retainSpawnError)
            {
                reject(error);
            }
        });
        child.once('close', (code, signal) => resolve({ code, signal, processId: child.pid,
            ...(retainSpawnError ? { spawnError } : {}) }));
        try
        {
            onStarted?.(child.pid ?? null);
        }
        catch (error)
        {
            child.kill('SIGTERM');
            reject(error);
        }
    });
}

export async function executeRandomizedCommand({ command, environment, evidenceDirectory, context,
    ordinal = 0, observationStreams = [] })
{
    const retainedContext = JSON.parse(JSON.stringify(context));
    const file = path.join(evidenceDirectory, `process-${ordinal}.json`);
    const startedAt = new Date().toISOString();
    const base = { schema: 'fsusblog.randomized-command-process.v1', qualificationEligible: false,
        context: retainedContext, executable: command.executable, args: [...command.args], cwd: command.cwd, startedAt };
    const result = await spawnCommand(command.executable, command.args, environment, command.cwd, {
        retainSpawnError: true,
        onStarted(processId)
        {
            atomicJson(`${file}.running.json`, { ...base, processId });
        }
    });
    const observations = observationStreams.map((streamId) =>
    {
        const journal = path.join(evidenceDirectory, `${streamId}.events.jsonl`);
        if (!existsSync(journal))
        {
            return { streamId, reference: null, error: 'journal unavailable' };
        }
        try
        {
            const { bytes } = readPrivateFile(journal, { maximumBytes: 16 * 1024 * 1024, label: 'random execution callback journal' });
            return { streamId, reference: { path: path.relative(root, journal).replaceAll(path.sep, '/'),
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }, error: null };
        }
        catch (error)
        {
            return { streamId, reference: null, error: error.message };
        }
    });
    atomicJson(file, { ...base, processId: result.processId ?? null, code: result.code, signal: result.signal,
        finishedAt: new Date().toISOString(), spawnError: result.spawnError?.message ?? null, observations });
    if (result.spawnError)
    {
        throw result.spawnError;
    }
    return { code: result.code, signal: result.signal, processId: result.processId };
}

function adapterArguments(producer, { outputDirectory, rootSeed, runId, workers })
{
    const args = [owned(producer.adapter, 'adapter'), '--output-dir', outputDirectory,
        '--root-seed', rootSeed, '--workers', String(workers), '--run-id', runId, '--producer', producer.id];
    if (producer.assembly)
    {
        args.push('--assembly', owned(producer.assembly, 'assembly'));
    }
    if (producer.config)
    {
        args.push('--config', owned(producer.config, 'config'));
    }
    for (const className of producer.classes ?? [])
    {
        args.push('--class', className);
    }
    for (const file of producer.files ?? [])
    {
        args.push('--file', owned(file, 'test file'));
    }
    return args;
}

function topologyWorkers(producer, topology)
{
    if (topology === 'planned')
    {
        return producer.plannedWorkers;
    }
    const value = Number(topology);
    if (!Number.isInteger(value) || value < 1)
    {
        fail(`invalid topology ${topology}`);
    }
    return value;
}

async function qualifyTopology(producer, topology, options, requiredPerturbations)
{
    const workers = topologyWorkers(producer, topology);
    const directory = path.join(options.outputDirectory, 'runs', producer.id, topology);
    const initial = await spawnCommand(process.execPath, adapterArguments(producer, {
        outputDirectory: directory,
        rootSeed: options.rootSeed,
        runId: `${options.runId}-${producer.id}-${topology}`,
        workers
    }));
    if (initial.code !== 0 || initial.signal !== null)
    {
        fail(`${producer.id}/${topology} initial qualification failed`);
    }
    const planFile = path.join(directory, 'plan.json');
    const plan = readJson(planFile);
    validateReplayPlan(plan);
    const initialActualFile = path.join(directory, 'actual/framework-actual.json');
    const initialReceiptFile = path.join(directory, 'actual/receipt.json');
    const initialActual = readJson(initialActualFile);
    const manifestFile = path.join(directory, 'queue-manifest.json');
    const replayDirectory = path.join(directory, 'replay');
    const replayArgs = [owned(producer.adapter, 'adapter'), '--replay-plan', planFile,
        '--queue-manifest', manifestFile, '--output-dir', replayDirectory];
    const replayProcess = await spawnCommand(process.execPath, replayArgs, {
        ...process.env,
        FSUSBLOG_REPLAY_PLAN_DIGEST: plan.planDigest,
        FSUSBLOG_REPLAY_ROOT_SEED: plan.rootSeed,
        FSUSBLOG_REPLAY_SHARD_DIGEST: plan.shardDigest,
        FSUSBLOG_REPLAY_WORKERS: plan.workers.ids.join(','),
        FSUSBLOG_VITEST_MAX_WORKERS: '97',
        FSUSBLOG_PLAYWRIGHT_WORKERS: '97',
        FSUSBLOG_STEP_CPU_BUDGET: '97',
        FSUSBLOG_STEP_MEMORY_GIB: '97',
        FSUSBLOG_REPLAY_PARENT_NOISE: 'date-uuid-default-worker-noise'
    });
    if (replayProcess.code !== 0 || replayProcess.signal !== null)
    {
        fail(`${producer.id}/${topology} perturbed replay failed`);
    }
    const replayActualFile = path.join(replayDirectory, 'framework-actual.json');
    const replayReceiptFile = path.join(replayDirectory, 'receipt.json');
    const replayActual = readJson(replayActualFile);
    if (initialActual.semanticDigest !== replayActual.semanticDigest)
    {
        fail(`${producer.id}/${topology} semantic replay drift`);
    }
    if (JSON.stringify(initialActual.actualTestIds) !== JSON.stringify(replayActual.actualTestIds))
    {
        fail(`${producer.id}/${topology} test identity replay drift`);
    }
    if (JSON.stringify(initialActual.preDispatch) !== JSON.stringify(replayActual.preDispatch))
    {
        fail(`${producer.id}/${topology} pre-dispatch replay drift`);
    }
    const initialProcesses = JSON.stringify((initialActual.workers ?? initialActual.lanes).map((worker) =>
        worker.processId ?? worker.controllerProcessId));
    const replayProcesses = JSON.stringify((replayActual.workers ?? replayActual.lanes).map((worker) =>
        worker.processId ?? worker.controllerProcessId));
    if (initialProcesses === replayProcesses)
    {
        fail(`${producer.id}/${topology} did not observe actual process restart identity`);
    }
    const replayCommand = buildExecutionReplayCommand({
        root,
        planPath: planFile,
        plan,
        schedulerShuffleSeed: plan.schedulerShuffleSeed,
        executionEnvelopeRef: canonicalDigest({ runId: options.runId, producer: producer.id, topology })
    });
    const base = {
        schema: 'fsusblog.replay-producer-qualification.v1',
        family: 'framework',
        producerId: producer.id,
        framework: producer.framework,
        topology,
        workers,
        status: 'verified',
        qualificationEligible: true,
        source: plan.source,
        runId: options.runId,
        plan: { ref: path.relative(root, planFile).replaceAll(path.sep, '/'), digest: plan.planDigest },
        actual: { ref: path.relative(root, initialActualFile).replaceAll(path.sep, '/'), digest: initialActual.contentDigest },
        receipt: { ref: path.relative(root, initialReceiptFile).replaceAll(path.sep, '/'), digest: readJson(initialReceiptFile).receiptDigest },
        repeatedActual: { ref: path.relative(root, replayActualFile).replaceAll(path.sep, '/'), digest: replayActual.contentDigest },
        repeatedReceipt: { ref: path.relative(root, replayReceiptFile).replaceAll(path.sep, '/'), digest: readJson(replayReceiptFile).receiptDigest },
        semanticDigest: initialActual.semanticDigest,
        perturbations: requiredPerturbations.map((id) => ({ id, status: 'observed' })),
        firstFailure: { status: 'none', overwritten: false },
        replay: { argv: replayCommand.argv, posix: replayCommand.posix },
        processEvidence: { initial, replay: replayProcess },
        contentDigest: null
    };
    return { ...base, contentDigest: canonicalDigest(base) };
}

function randomConsumerReceipt(consumer, rootSeed, evidence)
{
    const stream = deriveRandomConsumerStream({ rootSeed, consumer });
    return createRandomStreamReceipt({
        consumer,
        stream,
        caseIdentities: evidence.caseIdentities,
        transitionIdentities: evidence.transitionIdentities,
        executedIterations: evidence.caseIdentities.length,
        artifact: { digest: evidence.artifactDigest, generationCount: 1 },
        outcome: 'passed'
    });
}

function decodeXml(value)
{
    return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function trxResults(file)
{
    const document = readFileSync(file, 'utf8');
    const results = [...document.matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/gu)].map((match) =>
    {
        const attributes = Object.fromEntries([...match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/gu)]
            .map((entry) => [entry[1], decodeXml(entry[2])]));
        return { name: attributes.testName, outcome: attributes.outcome };
    }).filter((entry) => entry.name && entry.outcome);
    if (results.length === 0 || results.some((entry) => entry.outcome !== 'Passed'))
    {
        fail('backend randomized producer TRX is empty or contains a non-passing result');
    }
    return results.sort((left, right) => left.name.localeCompare(right.name));
}

function vitestResults(file)
{
    const document = readJson(file);
    const results = (document.testResults ?? []).flatMap((suite) => suite.assertionResults ?? [])
        .map((entry) => ({ name: entry.fullName ?? entry.title, title: entry.title, outcome: entry.status }));
    if (results.length === 0 || results.some((entry) => entry.outcome !== 'passed'))
    {
        fail('frontend randomized producer JSON is empty or contains a non-passing result');
    }
    return results.sort((left, right) => left.name.localeCompare(right.name));
}

function consumerMethod(consumer)
{
    return decodeURIComponent(consumer.canonicalTestId.slice(consumer.canonicalTestId.indexOf('#') + 1));
}

function evidenceBinding(consumer, processSemantic, observation)
{
    return {
        producerId: consumer.producerId,
        canonicalTestId: consumer.canonicalTestId,
        streamId: consumer.streamId,
        caseIdentities: observation.caseIdentities,
        transitionIdentities: observation.transitionIdentities,
        artifactDigest: canonicalDigest({
            schema: 'fsusblog.randomized-producer-observation.v1',
            consumer: {
                producerId: consumer.producerId,
                canonicalTestId: consumer.canonicalTestId,
                streamId: consumer.streamId
            },
            processSemantic,
            caseIdentities: observation.caseIdentities,
            transitionIdentities: observation.transitionIdentities
        })
    };
}

function parseProcessEvidence({ producerId, evidence, consumers, plan, processEvidence })
{
    const file = owned(evidence.ref, 'randomized producer evidence');
    if (fileDigest(file) !== evidence.digest)
    {
        fail(`${producerId} producer evidence bytes drifted`);
    }
    const childObservation = (consumer) =>
    {
        const binding = evidence.observations?.find((entry) => entry.streamId === consumer.streamId)
            ?? fail(`${producerId} child execution observation is missing`);
        return readRandomExecutionObservation({ binding, directory: processEvidence.evidenceDirectory,
            consumer, stream: deriveRandomConsumerStream({ rootSeed: plan.rootSeed, consumer }),
            runId: plan.run.id, attemptId: processEvidence.attemptId, planDigest: plan.planDigest
        });
    };
    if (evidence.kind === 'dotnet-trx')
    {
        const results = trxResults(file);
        const semantic = { kind: evidence.kind, results };
        const bindings = consumers.map((consumer) =>
        {
            const method = consumerMethod(consumer);
            const matches = results.filter((entry) => entry.name === method || entry.name.endsWith(`.${method}`));
            if (matches.length !== 1)
            {
                fail(`${producerId} producer evidence must execute ${consumer.canonicalTestId} exact-once`);
            }
            return evidenceBinding(consumer, semantic, childObservation(consumer));
        });
        return { semantic, bindings };
    }
    if (evidence.kind === 'vitest-json')
    {
        const results = vitestResults(file);
        const semantic = { kind: evidence.kind, role: evidence.role, results };
        const bindings = consumers.filter(() => evidence.role === 'property').map((consumer) =>
        {
            const title = consumerMethod(consumer);
            const matches = results.filter((entry) => entry.title === title || entry.name.endsWith(title));
            if (matches.length !== 1)
            {
                fail(`${producerId} producer evidence must execute ${consumer.canonicalTestId} exact-once`);
            }
            return evidenceBinding(consumer, semantic, childObservation(consumer));
        });
        return { semantic, bindings };
    }
    if (evidence.kind === 'wasm-fuzz-summary')
    {
        const summary = readJson(file);
        const consumer = consumers.length === 1 ? consumers[0] : fail('wasm fuzz evidence must own exact-one consumer');
        const stream = deriveRandomConsumerStream({ rootSeed: plan.rootSeed, consumer });
        if (summary.status !== 'ok' || summary.executionSource !== 'fresh-wasm-runtime'
            || summary.evidenceClass !== 'correctness' || summary.qualificationEligible !== true
            || summary.replayPlanDigest !== plan.planDigest
            || canonicalDigest(summary.randomStream) !== canonicalDigest(stream)
            || !Number.isInteger(summary.seedsRun) || summary.seedsRun < consumer.budget.iterations
            || !Array.isArray(summary.seedPlan) || summary.seedPlan.reduce((sum, entry) => sum + Number(entry.count ?? 0), 0) !== summary.seedsRun
            || !Array.isArray(summary.crashes) || summary.crashes.length !== 0)
        {
            fail('wasm fuzz producer summary is not qualified for the sealed stream and plan');
        }
        const semantic = {
            kind: evidence.kind,
            executionSource: summary.executionSource,
            evidenceClass: summary.evidenceClass,
            qualificationEligible: summary.qualificationEligible,
            randomStream: summary.randomStream,
            replayPlanDigest: summary.replayPlanDigest,
            corpus: summary.corpus,
            seedsRun: summary.seedsRun,
            seedsPerCorpus: summary.seedsPerCorpus,
            seedPlan: summary.seedPlan,
            crashes: summary.crashes,
            decoder: summary.decoder,
            blocker: summary.blocker
        };
        const observation = childObservation(consumer);
        if (observation.caseIdentities.length !== summary.seedsRun)
        {
            fail('wasm summary and executed cases differ');
        }
        return { semantic, bindings: [evidenceBinding(consumer, semantic, observation)] };
    }
    fail(`${producerId} producer evidence kind is unsupported: ${evidence.kind}`);
}

export function reopenRandomizedProducerEvidence({ producerId, consumers, processEvidence, plan })
{
    if (!Array.isArray(processEvidence?.processes) || processEvidence.processes.length === 0)
    {
        fail(`${producerId} randomized producer has no process evidence`);
    }
    const parsed = processEvidence.processes.map((entry) =>
    {
        if (entry.code !== 0 || entry.signal !== null || !entry.evidence)
        {
            fail(`${producerId} randomized process did not complete successfully`);
        }
        return parseProcessEvidence({ producerId, evidence: entry.evidence, consumers, plan, processEvidence });
    });
    const bindings = parsed.flatMap((entry) => entry.bindings);
    const expectedKeys = consumers.map((consumer) => `${consumer.canonicalTestId}\0${consumer.streamId}`).sort();
    const actualKeys = bindings.map((binding) => `${binding.canonicalTestId}\0${binding.streamId}`).sort();
    if (new Set(actualKeys).size !== actualKeys.length || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
    {
        fail(`${producerId} randomized producer evidence does not exact-cover current consumers`);
    }
    const observationDigest = canonicalDigest({
        schema: 'fsusblog.randomized-producer-attempt-observation.v1',
        producerId,
        semantics: parsed.map((entry) => entry.semantic)
    });
    if (processEvidence.observationDigest !== observationDigest)
    {
        fail(`${producerId} randomized producer observation digest drifted`);
    }
    return { bindings, observationDigest };
}

export function qualificationSourceIdentity()
{
    const commit = process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? runGit('rev-parse', 'HEAD');
    const configured = process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT;
    if (configured)
    {
        return {
            commit,
            worktreeFingerprint: configured.startsWith('sha256:') ? configured : `sha256:${configured}`
        };
    }
    const diffResult = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (diffResult.status !== 0)
    {
        fail('git diff failed');
    }
    const diff = diffResult.stdout;
    const untrackedResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8'
    });
    if (untrackedResult.status !== 0)
    {
        fail('git untracked inventory failed');
    }
    const untracked = untrackedResult.stdout.split('\0').filter(Boolean).sort()
        .map((file) => ({ file, content: readFileSync(path.join(root, file)).toString('base64') }));
    return { commit, worktreeFingerprint: canonicalDigest({ diff, untracked }) };
}

function randomStreamEnvironment(consumers, rootSeed)
{
    return JSON.stringify(Object.fromEntries(consumers.map((consumer) =>
    {
        const stream = deriveRandomConsumerStream({ rootSeed, consumer });
        return [`${consumer.canonicalTestId}\0${consumer.streamId}`, stream.derivedSeed];
    })));
}

function randomizedProducerCommands(producerId, workers, evidenceDirectory)
{
    if (producerId === 'backend-property')
    {
        return [{
            executable: 'dotnet',
            args: ['test', 'tests/backend/FsusBlog.Server.Tests.csproj', '--no-build', '--filter', 'Category=Property', '--verbosity', 'quiet',
                '--results-directory', evidenceDirectory, '--logger', 'trx;LogFileName=backend-property.trx'],
            cwd: root,
            evidence: { kind: 'dotnet-trx', file: path.join(evidenceDirectory, 'backend-property.trx') }
        }];
    }
    if (producerId === 'frontend-property-model-perf')
    {
        const vitest = path.join(root, 'src/frontend/node_modules/.bin/vitest');
        const workerArguments = ['--pool=forks', '--no-file-parallelism', '--maxWorkers', String(workers)];
        return [
            {
                executable: process.execPath,
                args: [path.join(root, 'tools/test/run-random-stream-producer.mjs'), '--producer', producerId, '--',
                    vitest, 'run', '--config', 'vitest.property.config.ts', ...workerArguments,
                    '--reporter=json', `--outputFile=${path.join(evidenceDirectory, 'frontend-property.json')}`],
                cwd: path.join(root, 'src/frontend'),
                evidence: { kind: 'vitest-json', role: 'property', file: path.join(evidenceDirectory, 'frontend-property.json') }
            },
            {
                executable: vitest,
                args: ['run', '--config', 'vitest.model.config.ts', ...workerArguments,
                    '--reporter=json', `--outputFile=${path.join(evidenceDirectory, 'frontend-model.json')}`],
                cwd: path.join(root, 'src/frontend'),
                evidence: { kind: 'vitest-json', role: 'model', file: path.join(evidenceDirectory, 'frontend-model.json') }
            }
        ];
    }
    if (producerId === 'wasm-fuzz-regression')
    {
        return [{
            executable: process.execPath,
            args: [path.join(root, 'tools/security/run-wasm-fuzz.mjs')],
            cwd: root,
            evidence: { kind: 'wasm-fuzz-summary', file: path.join(evidenceDirectory, 'wasm', 'summary.json') }
        }];
    }
    fail(`randomized producer command is not owned: ${producerId}`);
}

export async function runRandomizedProducer({ producerId, consumers, workers, options, plan, attempt, directory, inputReferences = [] })
{
    const evidenceDirectory = path.join(directory, attempt);
    mkdirSync(evidenceDirectory, { recursive: true });
    const commands = randomizedProducerCommands(producerId, workers, evidenceDirectory);
    const environment = {
        ...process.env,
        FSUSBLOG_RANDOM_STREAMS_JSON: randomStreamEnvironment(consumers, options.rootSeed),
        FSUSBLOG_REPLAY_MODE: 'qualification',
        FSUSBLOG_REPLAY_ROOT_SEED: options.rootSeed,
        FSUSBLOG_REPLAY_PLAN_DIGEST: plan.planDigest,
        FSUSBLOG_RANDOM_EXECUTION_DIR: evidenceDirectory,
        FSUSBLOG_RANDOM_EXECUTION_RUN: plan.run.id,
        FSUSBLOG_RANDOM_EXECUTION_ATTEMPT: attempt,
        FSUSBLOG_STEP_CPU_BUDGET: String(workers),
        FSUSBLOG_VITEST_MAX_WORKERS: String(workers),
        FSUSBLOG_WASM_FUZZ_SEEDS_PER_CORPUS: '64',
        FSUSBLOG_FUZZ_EVIDENCE_DIR: evidenceDirectory,
        FSUSBLOG_RELEASE_EVIDENCE_DIR: path.join(evidenceDirectory, 'release'),
        FSUSBLOG_TEST_NAMESPACE: `${options.runId}-${producerId}-${plan.frameworkModes[1].value}-${attempt}`
    };
    const processes = [];
    for (const command of commands)
    {
        const result = await executeRandomizedCommand({ command, environment, evidenceDirectory,
            ordinal: processes.length, observationStreams: consumers.map((consumer) => consumer.streamId),
            context: { source: plan.source, run: plan.run, producer: plan.producer,
                replayPlan: plan, replayPlanDigest: plan.planDigest, attemptId: attempt, inputReferences } });
        if (result.code !== 0 || result.signal !== null)
        {
            fail(`${producerId}/${plan.frameworkModes[1].value} ${attempt} producer failed`);
        }
        processes.push({
            ...result,
            executable: command.executable,
            argumentsDigest: canonicalDigest(command.args),
            evidence: {
                kind: command.evidence.kind,
                ...(command.evidence.role ? { role: command.evidence.role } : {}),
                ref: path.relative(root, command.evidence.file).replaceAll(path.sep, '/'),
                digest: fileDigest(command.evidence.file),
                observations: (command.evidence.role === 'model' ? [] : consumers).map((consumer) =>
                {
                    const file = path.join(evidenceDirectory, `${consumer.streamId}.json`);
                    return { streamId: consumer.streamId, ref: path.relative(root, file), digest: fileDigest(file) };
                })
            }
        });
    }
    const processEvidence = {
        processes,
        attemptId: attempt,
        evidenceDirectory: path.relative(root, evidenceDirectory).replaceAll(path.sep, '/'),
        observationDigest: null
    };
    processEvidence.observationDigest = canonicalDigest({
        schema: 'fsusblog.randomized-producer-attempt-observation.v1',
        producerId,
        semantics: processes.map((entry) => parseProcessEvidence({
            producerId, evidence: entry.evidence, consumers, plan, processEvidence
        }).semantic)
    });
    reopenRandomizedProducerEvidence({ producerId, consumers, processEvidence, plan });
    return processEvidence;
}

async function randomizedResult({ producerId, consumers, topology, options, requiredPerturbations })
{
    const workers = topology === 'planned' ? 4 : Number(topology);
    const testIds = consumers.map((consumer) => consumer.canonicalTestId);
    const assignment = planExactShards({ testIds, shardCount: workers, allowEmptyShards: workers > testIds.length });
    const workerIds = Array.from({ length: workers }, (_, index) => `random-slot-${index + 1}`);
    const streams = consumers.map((consumer) => deriveRandomConsumerStream({ rootSeed: options.rootSeed, consumer }))
        .map((stream) => ({
            version: stream.version,
            producerId: stream.producerId,
            streamId: stream.streamId,
            consumerTestId: stream.consumerTestId,
            seed: stream.seed
        })).sort((left, right) => left.streamId.localeCompare(right.streamId));
    const plan = sealReplayPlan({
        schema: REPLAY_PLAN_SCHEMA,
        source: qualificationSourceIdentity(),
        producer: { id: producerId, framework: 'random-stream' },
        run: { id: `${options.runId}-${producerId}-${topology}`, mode: 'qualification' },
        rootSeed: options.rootSeed,
        entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
        randomStreams: streams,
        ...assignment,
        workers: { ids: workerIds, assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [
            { name: 'consumer-inventory', value: 'random-stream-consumers-v1' },
            { name: 'topology', value: topology }
        ],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: 'random-consumer-order-v1',
        command: {
            executable: process.execPath,
            args: [path.join(root, 'tools/test/run-replay-qualification.mjs'), '--family', 'randomized',
                '--run-id', options.runId, '--root-seed', options.rootSeed],
            environmentDigest: canonicalDigest({ inputs: 'sealed-random-stream-plan' })
        }
    });
    const producerDirectory = path.join(options.outputDirectory, 'producer-evidence', producerId, topology);
    const initialProcess = await runRandomizedProducer({
        producerId, consumers, workers, options, plan, attempt: 'initial', directory: producerDirectory
    });
    const replayProcess = await runRandomizedProducer({
        producerId, consumers, workers, options, plan, attempt: 'replay', directory: producerDirectory
    });
    const initialEvidence = reopenRandomizedProducerEvidence({ producerId, consumers, processEvidence: initialProcess, plan });
    const replayEvidence = reopenRandomizedProducerEvidence({ producerId, consumers, processEvidence: replayProcess, plan });
    const binding = (evidence, consumer) => evidence.bindings.find((candidate) =>
        candidate.canonicalTestId === consumer.canonicalTestId && candidate.streamId === consumer.streamId)
        ?? fail(`${producerId}/${topology} lacks observed evidence for ${consumer.canonicalTestId}`);
    const actualReceipts = consumers.map((consumer) => randomConsumerReceipt(consumer, options.rootSeed, binding(initialEvidence, consumer)));
    const repeatedReceipts = consumers.map((consumer) => randomConsumerReceipt(consumer, options.rootSeed, binding(replayEvidence, consumer)));
    if (canonicalDigest(actualReceipts) !== canonicalDigest(repeatedReceipts)
        || initialEvidence.observationDigest !== replayEvidence.observationDigest)
    {
        fail(`${producerId}/${topology} random replay drift`);
    }
    const initialProcessIds = initialProcess.processes.map((entry) => entry.processId);
    const replayProcessIds = replayProcess.processes.map((entry) => entry.processId);
    if (initialProcessIds.some((processId) => replayProcessIds.includes(processId)))
    {
        fail(`${producerId}/${topology} did not restart every producer process`);
    }
    const workerReceipts = workerIds.map((id, index) => ({
        id,
        testIds: plan.testEnumerationOrder.filter((_, testIndex) => testIndex % workers === index)
    }));
    const workerByTest = new Map(workerReceipts.flatMap((worker) => worker.testIds.map((test) => [test, worker.id])));
    const shardByTest = new Map(plan.shards.flatMap((shard) => shard.testIds.map((test) => [test, shard.id])));
    const receipt = sealReplayReceipt({
        schema: REPLAY_RECEIPT_SCHEMA, source: plan.source, producer: plan.producer, run: plan.run,
        planDigest: plan.planDigest, rootSeed: plan.rootSeed, entropySources: plan.entropySources,
        randomStreams: plan.randomStreams, testIds: plan.testEnumerationOrder, shards: plan.shards,
        workers: workerReceipts,
        admissionSequence: plan.testEnumerationOrder.map((testId, ordinal) => ({
            ordinal, testId, shardId: shardByTest.get(testId), workerId: workerByTest.get(testId)
        })),
        processOutcome: { status: 'passed', exitCode: 0, signal: null }
    });
    const base = {
        schema: 'fsusblog.replay-producer-qualification.v1', family: 'randomized', producerId,
        framework: 'random-stream', topology, workers, status: 'verified', qualificationEligible: true,
        source: plan.source, runId: options.runId,
        plan: { inline: plan, digest: plan.planDigest },
        actual: { inline: actualReceipts, digest: canonicalDigest(actualReceipts) },
        receipt: { inline: receipt, digest: receipt.receiptDigest },
        repeatedActual: { inline: repeatedReceipts, digest: canonicalDigest(repeatedReceipts) },
        semanticDigest: canonicalDigest(actualReceipts.map((randomReceipt) => ({
            streamId: randomReceipt.streamId,
            derivedSeed: randomReceipt.derivedSeed,
            caseIdentities: randomReceipt.caseIdentities,
            transitionIdentities: randomReceipt.transitionIdentities,
            shrinkSequenceIdentity: randomReceipt.shrinkSequenceIdentity,
            minimalSample: randomReceipt.minimalSample,
            outcome: randomReceipt.outcome
        }))),
        perturbations: requiredPerturbations.map((id) => ({ id, status: 'observed' })),
        firstFailure: { status: 'none', overwritten: false },
        replay: { sealedPlanDigest: plan.planDigest, rediscovery: false },
        processEvidence: {
            apiExecutionCount: consumers.length * 2,
            producerProcessCount: initialProcess.processes.length + replayProcess.processes.length,
            initial: initialProcess,
            replay: replayProcess
        },
        contentDigest: null
    };
    return { ...base, contentDigest: canonicalDigest(base) };
}

function runGit(...args)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0)
    {
        fail(`git ${args.join(' ')} failed`);
    }
    return result.stdout.trim();
}

async function qualifyRandomized(authority, options)
{
    const randomAuthority = loadRandomStreamInventory();
    const grouped = new Map();
    for (const consumer of randomAuthority.consumers)
    {
        grouped.set(consumer.producerId, [...(grouped.get(consumer.producerId) ?? []), consumer]);
    }
    const results = [];
    let producerSpawnCount = 0;
    for (const [producerId, consumers] of [...grouped.entries()].sort())
    {
        for (const topology of authority.topologies)
        {
            const result = await randomizedResult({ producerId, consumers, topology, options, requiredPerturbations: authority.perturbations });
            const file = path.join(options.outputDirectory, 'results', producerId, `${topology}.json`);
            atomicJson(file, result);
            results.push({ producerId, topology, ref: path.relative(root, file).replaceAll(path.sep, '/'), digest: result.contentDigest });
            producerSpawnCount += result.processEvidence.producerProcessCount;
        }
    }
    return { producerIds: [...grouped.keys()].sort(), results, producerSpawnCount };
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    const authority = inventory();
    if (options.family === 'randomized')
    {
        const qualification = await qualifyRandomized(authority, options);
        const base = {
            schema: 'fsusblog.replay-family-qualification.v1', family: 'randomized', status: 'verified',
            qualificationEligible: true, runId: options.runId, inventoryDigest: authority.contentDigest,
            randomInventoryDigest: canonicalDigest(loadRandomStreamInventory()),
            requiredProducers: qualification.producerIds, requiredTopologies: authority.topologies,
            requiredPerturbations: authority.perturbations, results: qualification.results,
            producerSpawnCount: qualification.producerSpawnCount, contentDigest: null
        };
        const receipt = { ...base, contentDigest: canonicalDigest(base) };
        atomicJson(path.join(options.outputDirectory, 'randomized.json'), receipt);
        process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
        return;
    }
    const producers = authority.families[options.family];
    if (!Array.isArray(producers) || producers.length === 0)
    {
        fail(`unsupported qualification family ${options.family}`);
    }
    const results = [];
    for (const producer of producers)
    {
        for (const topology of authority.topologies)
        {
            const result = await qualifyTopology(producer, topology, options, authority.perturbations);
            const file = path.join(options.outputDirectory, 'results', producer.id, `${topology}.json`);
            atomicJson(file, result);
            results.push({ producerId: producer.id, topology, ref: path.relative(root, file).replaceAll(path.sep, '/'), digest: result.contentDigest });
        }
    }
    const base = {
        schema: 'fsusblog.replay-family-qualification.v1',
        family: options.family,
        status: 'verified',
        qualificationEligible: true,
        runId: options.runId,
        inventoryDigest: authority.contentDigest,
        requiredProducers: producers.map((producer) => producer.id).sort(),
        requiredTopologies: authority.topologies,
        requiredPerturbations: authority.perturbations,
        results,
        producerSpawnCount: results.length * 2,
        contentDigest: null
    };
    const receipt = { ...base, contentDigest: canonicalDigest(base) };
    atomicJson(path.join(options.outputDirectory, `${options.family}.json`), receipt);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}
