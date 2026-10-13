import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { executeRandomizedCommand, qualificationSourceIdentity } = await import(new URL('../../tools/test/run-replay-qualification.mjs', import.meta.url));
const { canonicalDigest, canonicalTestId, planExactShards, sealReplayPlan, REPLAY_PLAN_SCHEMA } = await import(new URL('../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { deriveRandomConsumerStream, validateRandomExecutionObservation } = await import(new URL('../../tools/test/random-streams.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const childSource = 'tests/tools/fixtures/backend-outcome-reporter/random-child.mjs';
const assembly = 'tests/tools/fixtures/backend-outcome-reporter/journal/bin/Release/net10.0/FsusBlog.XunitJournalFixture.dll';

function read(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function events(file)
{
    if (!fs.existsSync(file))
    {
        return [];
    }
    const bytes = fs.readFileSync(file, 'utf8');
    return bytes.slice(0, bytes.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
}

async function control(kind, mode)
{
    const successful = mode === 'success' || mode === 'legacy';
    const directory = fs.mkdtempSync(path.join(root, '.tmp/property-publication-'));
    const runId = path.basename(directory);
    const attemptId = `ordinary-${runId}`;
    const source = qualificationSourceIdentity();
    const inputReferences = [];
    let plan;
    let consumer;
    let stream;
    let command;
    let environment = { ...process.env, FSUSBLOG_RANDOM_EXECUTION_DIR: directory,
        FSUSBLOG_RANDOM_EXECUTION_RUN: runId, FSUSBLOG_RANDOM_EXECUTION_ATTEMPT: attemptId };
    const streamId = kind === 'js' ? 'ordinary-js-samples' : 'ordinary-native-samples';
    if (kind === 'js')
    {
        consumer = { producerId: 'ordinary-property-control',
            canonicalTestId: canonicalTestId({ framework: 'node-test', source: childSource, name: ['ordinary-samples'] }),
            kind: 'property', entrypoint: childSource, runner: 'node', runnerConfig: childSource,
            streamId, version: 'ordinary-v1', budget: { iterations: 3, transitions: 0, shrinks: 0 },
            receiptOwner: path.relative(root, directory), evidenceClass: 'correctness', qualificationEligible: true,
            usesRandomness: true, randomStreams: [streamId] };
        const rootSeed = `seed256:${'17'.repeat(32)}`;
        stream = deriveRandomConsumerStream({ rootSeed, consumer });
        command = { executable: process.execPath, args: [childSource, mode], cwd: root };
        plan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA, source, producer: { id: consumer.producerId, framework: 'node-test' },
            run: { id: runId, mode: 'qualification' }, rootSeed, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
            randomStreams: [], ...planExactShards({ testIds: [consumer.canonicalTestId], shardCount: 1 }),
            workers: { ids: ['ordinary-worker'], assignmentPolicy: 'framework-owned-after-seal' }, frameworkModes: [],
            schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false }, schedulerShuffleSeed: 'ordinary-seed',
            command: { executable: command.executable, args: command.args, environmentDigest: canonicalDigest(environment) } });
        const planFile = path.join(directory, 'plan.json');
        fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
        inputReferences.push({ kind: 'replay-plan', path: path.relative(root, planFile), digest: plan.planDigest });
        environment = { ...environment, ORDINARY_PLAN_FILE: planFile, FSUSBLOG_REPLAY_PLAN_DIGEST: plan.planDigest,
            FSUSBLOG_RANDOM_STREAMS_JSON: JSON.stringify({ [`${consumer.canonicalTestId}\0${streamId}`]: stream.derivedSeed }) };
    }
    else
    {
        const dotnet = process.env.FSUSBLOG_BACKEND_DOTNET;
        assert.ok(dotnet && fs.existsSync(dotnet), 'actual native controls require the task SDK');
        assert.ok(fs.existsSync(path.join(root, assembly)), 'build the isolated fixture first');
        const className = { success: 'PropertyJournalSuccessTests', failure: 'PropertyJournalFailureTests', cancel: 'PropertyJournalCancelTests' }[mode];
        command = { executable: process.execPath, cwd: root, args: ['tools/test/xunit-replay-adapter.mjs', '--assembly', assembly,
            '--output-dir', path.relative(root, directory), '--root-seed', `seed256:${'17'.repeat(32)}`,
            '--workers', '1', '--run-id', runId, '--class', `FsusBlog.BackendOutcomeReporterFixture.${className}`] };
        environment = { ...environment, PATH: `${path.dirname(dotnet)}:${process.env.PATH}`,
            FSUSBLOG_BACKEND_REPLAY_MATERIAL: directory };
    }
    const completion = executeRandomizedCommand({ command, environment, evidenceDirectory: directory,
        context: { scope: 'ordinary-task-control', source, run: { id: runId }, attemptId, inputReferences },
        observationStreams: [streamId] });
    const deadline = Date.now() + 20000;
    const runningFile = path.join(directory, 'process-0.json.running.json');
    const journalFile = path.join(directory, `${streamId}.events.jsonl`);
    let killId = null;
    try
    {
        if (mode === 'cancel')
        {
            while (events(journalFile).filter((event) => event.kind === 'case-generated').length < 2)
            {
                assert.ok(Date.now() < deadline, 'actual second sample did not reach the before-oracle callback');
                await delay(20);
            }
            killId = kind === 'js' ? read(runningFile).processId
                : read(path.join(directory, 'actual/processes/xunit-slot-1.json.running.json')).processId;
            process.kill(killId, 'SIGKILL');
        }
        const result = await completion;
        assert.equal(result.code, successful ? 0 : kind === 'js' && mode === 'cancel' ? null : 1);
        assert.equal(result.signal, kind === 'js' && mode === 'cancel' ? 'SIGKILL' : null);
        const processResult = read(path.join(directory, 'process-0.json'));
        assert.equal(processResult.qualificationEligible, false);
        assert.equal(processResult.processId, result.processId);
        assert.deepEqual(processResult.args, command.args);
        assert.deepEqual(processResult.context.inputReferences, inputReferences);
        assert.equal(processResult.context.attemptId, attemptId);
        const records = events(journalFile);
        const bytes = fs.readFileSync(journalFile);
        assert.equal(processResult.observations[0].reference.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
        plan ??= read(path.join(directory, 'plan.json'));
        for (const [sequence, record] of records.entries())
        {
            assert.equal(record.sequence, sequence);
            assert.equal(record.qualificationEligible, false);
            assert.equal(record.identity.runId, runId);
            assert.equal(record.identity.attemptId, attemptId);
            assert.equal(record.identity.replayPlanDigest, plan.planDigest);
            assert.equal(record.identity.canonicalTestId, plan.testEnumerationOrder[0]);
        }
        const generated = records.filter((record) => record.kind === (mode === 'legacy' ? 'case-observed' : 'case-generated'));
        const outcomes = mode === 'legacy' ? generated : records.filter((record) => record.kind === 'case-outcome');
        assert.equal(generated.length, successful ? 3 : 2);
        assert.deepEqual(outcomes.map((record) => record.payload.outcome), successful ? ['passed', 'passed', 'passed']
            : mode === 'failure' ? ['passed', 'failed'] : ['passed']);
        for (const generatedCase of generated)
        {
            const outcome = outcomes.find((record) => (record.payload.caseIndex ?? record.payload.failure?.caseIndex) === generatedCase.payload.caseIndex);
            if (outcome)
            {
                assert.ok(mode === 'legacy' || generatedCase.sequence < outcome.sequence);
            }
        }
        if (mode === 'failure')
        {
            const failed = outcomes[1].payload;
            assert.equal(failed.firstFailure.caseIndex, 1);
            assert.equal(failed.firstFailure.caseIdentity, generated[1].payload.caseIdentity);
        }
        if (kind === 'js' && successful)
        {
            const document = read(path.join(directory, `${streamId}.json`));
            validateRandomExecutionObservation(document, { consumer, stream, runId, attemptId, planDigest: plan.planDigest });
            assert.deepEqual(document.caseIdentities, generated.map((record) => record.payload.caseIdentity));
        }
        if (!successful)
        {
            assert.equal(records.some((record) => record.kind === 'execution-completed'), false);
            assert.equal(fs.existsSync(path.join(directory, `${streamId}.json`)), false);
        }
        if (kind === 'native' && mode === 'cancel')
        {
            const native = read(path.join(directory, 'actual/processes/xunit-slot-1.json'));
            assert.equal(native.processId, killId);
            assert.equal(native.exitCode, null);
            assert.equal(native.signal, 'SIGKILL');
        }
    }
    finally
    {
        if (!fs.existsSync(path.join(directory, 'process-0.json')))
        {
            const nativeRunning = path.join(directory, 'actual/processes/xunit-slot-1.json.running.json');
            if (kind === 'native' && fs.existsSync(nativeRunning))
            {
                killId ??= read(nativeRunning).processId;
            }
            if (killId)
            {
                try
                {
                    process.kill(killId, 'SIGKILL');
                }
                catch
                { /* Task child already closed. */ }
            }
            const running = read(runningFile);
            try
            {
                process.kill(running.processId, 'SIGKILL');
            }
            catch
            { /* Task child already closed. */ }
            await completion;
        }
    }
}

test('ordinary legacy post-oracle record keeps the original successful complete-budget API', { timeout: 30000 }, () => control('js', 'legacy'));

for (const kind of ['js', 'native'])
{
    for (const mode of ['success', 'failure', 'cancel'])
    {
        test(`ordinary ${kind} generated samples and original process ${mode} retain actual evidence`, { timeout: 30000 }, () => control(kind, mode));
    }
}
