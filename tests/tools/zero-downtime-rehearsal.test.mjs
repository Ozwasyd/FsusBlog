import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// eslint-disable-next-line import-x/order
import { spawn, spawnSync } from 'node:child_process';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {behaviorTest, concurrencyHarnessId} = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
const {FAULT_CASES, HOST_INTERRUPTION_STAGES, ROLLOUT_STAGES, materializeFaultPlan, resolveRehearsalPlan} = await import(new URL('../../tools/deployment/zero-downtime-rehearsal-plan.mjs', import.meta.url));
import { boundedSemanticScale } from './support/timing-policy.mjs';
import { createReleaseManifest } from '../../tools/release/release-manifest.mjs';
import { createEmptySlotState, recordSlotStart, setActiveSlot, writeSlotStateAtomic } from '../../tools/deployment/slot-lib.mjs';
import { completeRollout, readRolloutState, writeRolloutStateAtomic } from '../../tools/deployment/release-rollout-lib.mjs';
import { createReleaseRolloutEvidenceFixture } from './support/release-rollout-evidence-fixture.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const orchestratorSource = path.join(repositoryRoot, 'tools/deployment/zero-downtime-rehearsal.sh');
const planToolSource = path.join(repositoryRoot, 'tools/deployment/zero-downtime-rehearsal-plan.mjs');
const releaseIdToolSource = path.join(repositoryRoot, 'tools/release/release-id.mjs');
const releaseIdContractSource = path.join(repositoryRoot, 'src/shared/Contracts/Validation/release-id-contract.json');
const faultTemplateSource = path.join(repositoryRoot, 'tests/fixtures/deployment/zero-downtime-fault-plan.template.json');
const migrationQualificationTemplateSource = path.join(repositoryRoot, 'tests/fixtures/deployment/release-migration-qualification-scenario.template.json');
const activeRehearsalProcessGroups = new Set();

function killActiveRehearsalProcessGroups()
{
    for (const pid of activeRehearsalProcessGroups)
    {
        try
        {
            if (process.platform === 'win32')
            {
                process.kill(pid, 'SIGKILL');
            }
            else
            {
                process.kill(-pid, 'SIGKILL');
            }
        }
        catch
        // eslint-disable-next-line no-empty
        {}
    }
    activeRehearsalProcessGroups.clear();
}

process.once('exit', killActiveRehearsalProcessGroups);
for (const signal of ['SIGTERM', 'SIGINT'])
{
    process.once(signal, () =>
    {
        killActiveRehearsalProcessGroups();
        process.exit(signal === 'SIGTERM' ? 143 : 130);
    });
}

function positiveNumber(value)
{
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRehearsalMachineTiming({ hostCpu, grantedCpu, load1 })
{
    const pressureScale = Math.max(1, hostCpu / grantedCpu, (load1 + 1) / grantedCpu);
    const wait = milliseconds => Math.ceil(milliseconds * pressureScale);
    const semanticWait = milliseconds => Math.ceil(milliseconds * boundedSemanticScale(pressureScale));
    const seconds = value => Math.max(1, Math.ceil(wait(value * 1_000) / 1_000));
    return {
        stageDelayMs: semanticWait(80),
        activeFenceDelayMs: semanticWait(1_500),
        // The production worker drill has 30-second minimum probe windows and a
        // 300-second coordination window. Preserve the smaller test bound, but do
        // not let scheduler pressure reduce it below the shortest real probe.
        coordinationTimeoutMs: Math.min(900_000, wait(30_000)),
        // Worker qualification starts several process groups and a local observer
        // service. Keep enough base headroom for load that rises after this single
        // startup-time pressure sample while leaving the outer rehearsal a separate
        // cleanup window; the machine grant still scales the value.
        workerTimeoutSeconds: Math.min(1_800, seconds(90)),
        hostInterruptionTimeoutSeconds: Math.min(300, seconds(10)),
        migrationTimeoutSeconds: Math.min(1_800, seconds(60)),
        // Explicit rollback performs a second rollout and a second worker
        // qualification before cleanup. Give that composed real-process path
        // headroom under sustained local scheduler pressure while keeping a
        // bounded outer cleanup deadline.
        rehearsalTimeoutMs: Math.min(1_800_000, wait(300_000))
    };
}

function machineTiming()
{
    const hostCpu = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
    const grantedCpu = Math.min(
        hostCpu,
        positiveNumber(process.env.FSUSBLOG_STEP_CPU_BUDGET)
      ?? positiveNumber(process.env.FSUSBLOG_BUNDLE_CPU_BUDGET)
      ?? hostCpu
    );
    const load1 = Math.max(0, os.loadavg()[0] ?? 0);
    return resolveRehearsalMachineTiming({ hostCpu, grantedCpu, load1 });
}

const fixtureShard = String(process.env.FSUSBLOG_ZDT_FIXTURE_SHARD ?? '').trim();
const fixtureShardIds = new Set([
    '',
    'base',
    'normal',
    'explicit-rollback',
    'post-switch-rollback',
    'sigkill-resume',
    'all'
]);
if (!fixtureShardIds.has(fixtureShard))
{
    throw new Error(`unknown zero-downtime fixture shard: ${fixtureShard}`);
}
const runsFixtureShard = id => !fixtureShard || fixtureShard === id;

if (runsFixtureShard('base'))
{
    test('rehearsal timing wires shared semantic scale to delays and preserves wait caps', () =>
    {
        const timing = resolveRehearsalMachineTiming({ hostCpu: 8, grantedCpu: 2, load1: 0 });

        assert.deepEqual(timing, {
            stageDelayMs: 110,
            activeFenceDelayMs: 2_063,
            coordinationTimeoutMs: 120_000,
            workerTimeoutSeconds: 360,
            hostInterruptionTimeoutSeconds: 40,
            migrationTimeoutSeconds: 240,
            rehearsalTimeoutMs: 1_200_000
        });
    });
}

if (runsFixtureShard('base'))
{
    test('plan resolution is local-only, private-file-only and materializes exact isolated fault cases', (t) =>
    {
        const fixture = createFixture(t);
        const raw = JSON.parse(fs.readFileSync(fixture.plan, 'utf8'));
        const resolved = resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root });
        assert.equal(resolved.environment, 'Test');
        assert.equal(resolved.source.slot, 'blue');
        assert.equal(resolved.source.previousRollbackRelease, '20260709010101-cccccccccccc');
        assert.equal(resolved.target.slot, 'green');
        assert.match(resolved.workRoot, /\.tmp[/\\]rehearsal$/u);
        assert.equal(resolved.workers.observerEnvFile, fs.realpathSync(path.join(fixture.root, 'secrets', 'worker-observer.env')));
        assert.equal(resolved.workers.deploy.observerServicePlan.baseUrl, 'http://127.0.0.1:19031');
        assert.equal(resolved.workers.deploy.normalScenario.baseUrl, resolved.workers.deploy.observerServicePlan.baseUrl);

        const faultRoot = path.join(resolved.workRoot, 'fixture-run', 'faults');
        const faultPlan = materializeFaultPlan(resolved, faultRoot, 'rollback');
        assert.deepEqual(faultPlan.cases.map(item => item.case), FAULT_CASES);
        assert.equal(faultPlan.rolloutId, `rollback-${resolved.source.releaseId}`);
        assert.equal(faultPlan.sourceContainer, 'fsus-app-green');
        assert.equal(faultPlan.targetContainer, 'fsus-app-blue');
        for (const definition of faultPlan.cases)
        {
            assert.ok(definition.rolloutState.startsWith(path.join(faultRoot, 'cases', definition.case)));
            assert.ok(definition.slotState.startsWith(path.join(faultRoot, 'cases', definition.case)));
            assert.equal(definition.setup[0].id, 'prepare-case');
            assert.equal(definition.rollout.id, 'case-rollout');
            assert.equal(definition.teardown[0].id, 'teardown-case');
            assert.equal(definition.publicUrl, 'http://127.0.0.1:18080/health/ready');
        }
        assert.equal(
            faultPlan.cases.find(item => item.case === 'drain-timeout').inject.url,
            'http://127.0.0.1:8081/fixture/hold');

        const production = structuredClone(raw);
        production.environment = 'Production';
        assert.throws(
            () => resolveRehearsalPlan(production, { planFile: fixture.plan, repoRoot: fixture.root }),
            /non-production.*Test/u);
        fs.chmodSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 0o644);
        assert.throws(
            () => resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root }),
            /mode 0400 or 0600/u);
        fs.chmodSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 0o600);
        fs.writeFileSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 'X-Fsus-Admin-Secret: rejected\n', { mode: 0o600 });
        assert.throws(
            () => resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root }),
            /Authorization: Bearer or Cookie/u);

        fs.writeFileSync(path.join(fixture.root, 'secrets', 'admin-header.txt'), 'Authorization: Bearer fixture-admin\n', { mode: 0o600 });
        const servicePlanFile = path.join(fixture.root, 'worker-observer-service-plan.json');
        const mismatchedServicePlan = JSON.parse(fs.readFileSync(servicePlanFile, 'utf8'));
        mismatchedServicePlan.listen.port = 19032;
        writeJson(servicePlanFile, mismatchedServicePlan);
        assert.throws(
            () => resolveRehearsalPlan(raw, { planFile: fixture.plan, repoRoot: fixture.root }),
            /normalScenario\.baseUrl must equal observer service listen origin/u);
    });
}

if (runsFixtureShard('normal'))
{
    behaviorTest('deployment-blue-green-runtime-role', 'positive', 'current component subprocess retains fresh admission and all original release evidence', async t =>
    {
        const fixture = createCurrentFixture(t);
        const result = await runCurrentFixture(fixture, 'normal', 'current-normal');
        assert.equal(result.status, 0, result.stderr);
        const report = currentSummary(fixture, 'current-normal');
        assert.equal(report.status, 'pass');
        assert.equal(report.scope, 'current-release-consumption');
        assert.equal(Object.hasOwn(report, 'qualificationEligible'), false);
        assert.equal(report.releaseEvidence.verification.status, 'pass');
        const evidence = readJson(report.releaseEvidence.path);
        assert.equal(evidence.stages.length, 15);
        assert.equal(Object.keys(evidence.artifacts).length, 6);
        assert.equal(Object.keys(evidence.auxiliary).length, 24);
        const records = readRecords(fixture.log);
        assert.deepEqual(records.map(item => item.kind),
            ['create', 'start', 'inspect', 'rm', 'create', 'start', 'inspect', 'rm', 'release']);
        for (const created of records.filter(item => item.kind === 'create'))
        {
            for (const required of ['current-schema-check', '--candidate-source-revision', '--receipt-sha256', '--network'])
                assert.ok(created.args.includes(required));
            assert.ok(created.args.some(item => item.startsWith('type=bind,source=') && item.endsWith(',readonly')));
            assert.equal(created.args.includes('--user'), false);
        }
        assert.deepEqual(fs.readdirSync(fixture.containers), []);
        assert.equal(readRolloutState(fixture.raw.rollout.stateFile).status, 'completed');
        assert.equal(readJson(fixture.raw.runtime.slotState).activeReleaseId, fixture.manifests.target.releaseId);
        assert.ok(fs.statSync(report.commands.find(item => item.name === 'current-release').stdout.path).size > 1024 * 1024);
        assert.doesNotMatch(records.flatMap(item => item.args).join('\n'), /expand|--rollback|FsusBlog[.]Migration/u);
    });
}

if (runsFixtureShard('explicit-rollback'))
{
    test('explicit image rollback is retired before current native commands or state mutation', t =>
    {
        const fixture = createCurrentFixture(t);
        const before = fs.readFileSync(fixture.raw.runtime.slotState);
        const result = spawnSync('bash', [orchestratorSource, '--plan', fixture.plan, '--mode', 'explicit-rollback'], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /image rollback.*retired/u);
        assert.deepEqual(fs.readFileSync(fixture.raw.runtime.slotState), before);
        assert.equal(fs.existsSync(fixture.log), false);
        assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
    });
}

if (runsFixtureShard('post-switch-rollback'))
{
    test('post-switch image rollback cannot substitute for a current forward-only release', async t =>
    {
        const fixture = createCurrentFixture(t);
        const result = spawnSync('bash', [orchestratorSource, '--plan', fixture.plan, '--mode', 'post-switch-rollback'], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /image rollback.*retired/u);
        assert.equal(fs.existsSync(fixture.log), false);
        const current = await runCurrentFixture(fixture, 'normal', 'forward-control');
        assert.equal(current.status, 0, current.stderr);
        assert.equal(readRolloutState(fixture.raw.rollout.stateFile).kind, 'deploy');
        assert.deepEqual(readRolloutState(fixture.raw.rollout.stateFile).recoveries, []);
    });
}

if (runsFixtureShard('sigkill-resume'))
{
    behaviorTest('deployment-blue-green-runtime-role', 'concurrency', {
        title: 'actual child SIGKILL retains current durable state and explicit resume performs fresh admission',
        concurrencyHarness: concurrencyHarnessId
    }, async t =>
    {
        const fixture = createCurrentFixture(t);
        const interrupted = await runCurrentFixture(fixture, 'normal', 'interrupted-current', { FSUSBLOG_CURRENT_FIXTURE_KILL: '1' });
        assert.notEqual(interrupted.status, 0);
        const failed = currentSummary(fixture, 'interrupted-current');
        assert.equal(failed.status, 'fail');
        assert.equal(failed.commands.find(item => item.name === 'current-release').signal, 'SIGKILL');
        assert.equal(readRolloutState(fixture.raw.rollout.stateFile).status, 'running');
        const resumed = await runCurrentFixture(fixture, 'resume', 'resumed-current');
        assert.equal(resumed.status, 0, resumed.stderr);
        const records = readRecords(fixture.log);
        assert.equal(records.filter(item => item.kind === 'start').length, 4);
        assert.ok(records.filter(item => item.kind === 'release').at(-1).args.includes('--resume'));
        assert.equal(currentSummary(fixture, 'resumed-current').releaseEvidence.verification.status, 'pass');
        assert.equal(readRolloutState(fixture.raw.rollout.stateFile).status, 'completed');
        assert.deepEqual(fs.readdirSync(fixture.containers), []);
    });
}

if (runsFixtureShard('all'))
{
    behaviorTest('deployment-blue-green-runtime-role', 'negative', {
        title: 'a failed current invocation is retained and a separately explicit later run proceeds without legacy modes',
        invariantIds: ['deployment-mode-failure-continuation']
    }, async t =>
    {
        const fixture = createCurrentFixture(t);
        const failed = await runCurrentFixture(fixture, 'normal', 'rejected-current', { FSUSBLOG_CURRENT_FIXTURE_BAD_OUTPUT: '1' });
        assert.notEqual(failed.status, 0);
        assert.equal(currentSummary(fixture, 'rejected-current').status, 'fail');
        assert.equal(readRecords(fixture.log).some(item => item.kind === 'release'), false);
        assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
        assert.deepEqual(fs.readdirSync(fixture.containers), []);
        const later = await runCurrentFixture(fixture, 'normal', 'later-explicit-current');
        assert.equal(later.status, 0, later.stderr);
        assert.equal(currentSummary(fixture, 'later-explicit-current').status, 'pass');
        assert.equal(currentSummary(fixture, 'rejected-current').status, 'fail');
        const retired = spawnSync('bash', [orchestratorSource, '--plan', fixture.plan, '--mode', 'all'], { encoding: 'utf8' });
        assert.notEqual(retired.status, 0);
        assert.match(retired.stderr, /retired/u);
    });
}

if (runsFixtureShard('base'))
{
    test('current plan rejects legacy, missing and drifted whole-byte inputs before mutable work', async t =>
    {
        const { resolveCurrentRehearsalPlan } = await import('../../tools/deployment/zero-downtime-rehearsal-plan.mjs');
        const fixture = createCurrentFixture(t);
        const context = { planFile: fixture.plan, repoRoot: fixture.root };
        assert.equal((await resolveCurrentRehearsalPlan(fixture.raw, context)).schema, 'fsusblog.zero-downtime-rehearsal-resolved-plan.v2');
        for (const [mutate, expected] of [
            [raw => { raw.schema = 'fsusblog.zero-downtime-rehearsal-plan.v1'; }, /schema/u],
            [raw => { raw.environment = 'Production'; }, /non-production/u],
            [raw => { raw.source.sha256 = '9'.repeat(64); }, /SHA mismatch/u],
            [raw => { raw.target.sha256 = null; }, /SHA is invalid/u],
            [raw => { raw.target.extra = true; }, /exact current contract/u],
            [raw => { delete raw.evidenceInputs.workerLedger; }, /exact current contract/u],
            [raw => { raw.currentSchema = {}; }, /exact current contract/u],
            [raw => { raw.workRoot = path.join(fixture.root, '.tmp'); }, /dedicated child/u]
        ])
        {
            const raw = structuredClone(fixture.raw); mutate(raw); writeJson(fixture.plan, raw);
            await assert.rejects(resolveCurrentRehearsalPlan(raw, context), expected);
        }
        writeJson(fixture.plan, fixture.raw);
        await assert.rejects(resolveCurrentRehearsalPlan({ ...fixture.raw, timeoutSeconds: 11 }, context), /bytes differ/u);
        const receipt = fixture.manifests.target.currentSchema.receipt.reference;
        const original = fs.readFileSync(receipt);
        fs.appendFileSync(receipt, ' ');
        await assert.rejects(resolveCurrentRehearsalPlan(fixture.raw, context), /whole-artifact SHA/u);
        fs.writeFileSync(receipt, original);
        fs.chmodSync(fixture.raw.envFile, 0o644);
        await assert.rejects(resolveCurrentRehearsalPlan(fixture.raw, context), /0400 or 0600/u);
        assert.equal(fs.existsSync(fixture.log), false);
        assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
    });

    test('current runner rejects plan drift and cleans an owned admission container after lost create response', async t =>
    {
        const { resolveCurrentRehearsalPlan, runCurrentRehearsal } = await import('../../tools/deployment/zero-downtime-rehearsal-plan.mjs');
        const fixture = createCurrentFixture(t);
        const resolved = await resolveCurrentRehearsalPlan(fixture.raw, { planFile: fixture.plan, repoRoot: fixture.root });
        fs.appendFileSync(fixture.plan, ' ');
        const drift = await runCurrentRehearsal(resolved, { mode: 'normal', runId: 'drift-current' });
        assert.equal(drift.status, 'fail');
        assert.match(drift.errors.join('\n'), /plan changed/u);
        assert.equal(fs.existsSync(fixture.log), false);
        writeJson(fixture.plan, fixture.raw);
        const lost = await runCurrentFixture(fixture, 'normal', 'lost-create-current', { FSUSBLOG_CURRENT_FIXTURE_LOST_CREATE: '1' });
        assert.notEqual(lost.status, 0);
        const report = currentSummary(fixture, 'lost-create-current');
        assert.equal(report.status, 'fail');
        assert.ok(report.commands.some(item => item.name === 'source-create' && item.exitCode === 22));
        assert.deepEqual(readRecords(fixture.log).map(item => item.kind), ['create', 'inspect', 'rm']);
        assert.deepEqual(fs.readdirSync(fixture.containers), []);
        assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
    });

    test('current resume refuses legacy recovery and mismatched durable binding before native work', async t =>
    {
        const fixture = createCurrentFixture(t);
        const state = readJson(fixture.fixtureState);
        for (const mutate of [
            value => { value.kind = 'rollback'; },
            value => { value.manifestSha256 = 'f'.repeat(64); },
            value => { value.candidateSourceRevision = 'f'.repeat(40); },
            value => { value.currentSchema.actualSchemaDigest = 'f'.repeat(64); },
            value => { value.recovery = { action: 'rollback-gateway-to-source' }; }
        ])
        {
            const changed = structuredClone(state); mutate(changed);
            writeJson(fixture.raw.rollout.stateFile, changed);
            const before = fs.readFileSync(fixture.raw.rollout.stateFile);
            const result = await runCurrentFixture(fixture, 'resume', 'refused-resume');
            assert.notEqual(result.status, 0);
            assert.deepEqual(fs.readFileSync(fixture.raw.rollout.stateFile), before);
            assert.equal(fs.existsSync(fixture.log), false);
        }
    });

    test('fresh target admission rejects each missing or mismatched Server binding before release, with a full positive control', async t =>
    {
        const fixture = createCurrentFixture(t);
        const before = fs.readFileSync(fixture.raw.runtime.slotState);
        for (const field of ['candidate', 'receipt', 'target', 'database', 'observation', 'status', 'extra'])
        {
            const result = await runCurrentFixture(fixture, 'normal', 'rejected-' + field, {
                FSUSBLOG_CURRENT_FIXTURE_BAD_OUTPUT: field, FSUSBLOG_CURRENT_FIXTURE_BAD_ROLE: 'target'
            });
            assert.notEqual(result.status, 0, field);
            const report = currentSummary(fixture, 'rejected-' + field);
            assert.equal(report.status, 'fail');
            assert.ok(report.commands.some(command => command.name === 'source-admission' && command.exitCode === 0));
            assert.ok(report.commands.some(command => command.name === 'target-admission' && command.exitCode === 0));
            assert.equal(report.commands.some(command => command.name === 'current-release'), false);
            assert.deepEqual(fs.readFileSync(fixture.raw.runtime.slotState), before);
            assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
            assert.deepEqual(fs.readdirSync(fixture.containers), []);
        }
        const control = await runCurrentFixture(fixture, 'normal', 'all-bindings-control');
        assert.equal(control.status, 0, control.stderr);
        assert.equal(currentSummary(fixture, 'all-bindings-control').releaseEvidence.verification.status, 'pass');
    });

    test('complete current replay binds the caller rollout, both durable identities and the exact final file after a positive control', async t =>
    {
        const fixture = createCurrentFixture(t);
        const slots = fs.readFileSync(fixture.raw.runtime.slotState);
        const completed = readJson(fixture.completedState);
        const actor = readJson(fixture.actorConfig);
        const control = await runCurrentFixture(fixture, 'normal', 'complete-binding-control');
        assert.equal(control.status, 0, control.stderr);
        for (const [name, mutate] of [
            ['source', state => { state.source.imageDigest = 'sha256:' + 'f'.repeat(64); }],
            ['target', state => { state.target.imageDigest = 'sha256:' + 'f'.repeat(64); }],
            ['path', state => { state.finalEvidencePath = actor.finalEvidence; }]
        ])
        {
            fs.unlinkSync(fixture.raw.rollout.stateFile);
            fs.writeFileSync(fixture.raw.runtime.slotState, slots);
            const changed = structuredClone(completed); mutate(changed); writeJson(fixture.completedState, changed);
            const result = await runCurrentFixture(fixture, 'normal', 'different-completed-' + name);
            assert.notEqual(result.status, 0, name);
            assert.match(currentSummary(fixture, 'different-completed-' + name).errors.join('\n'), /completed current evidence bindings differ/u);
            assert.deepEqual(fs.readdirSync(fixture.containers), []);
        }
        writeJson(fixture.completedState, completed);
        fs.unlinkSync(fixture.raw.rollout.stateFile);
        fs.writeFileSync(fixture.raw.runtime.slotState, slots);
        const other = createReleaseRolloutEvidenceFixture({ manifest: fixture.manifests.target,
            rolloutId: 'different-complete-rollout', source: completed.source, target: completed.target });
        const directory = path.join(fixture.root, 'different-sealed-complete-evidence'); fs.mkdirSync(directory);
        actor.finalEvidence = other.createFinalEvidence(directory).file;
        writeJson(fixture.actorConfig, actor);
        const different = await runCurrentFixture(fixture, 'normal', 'different-report-rollout');
        assert.notEqual(different.status, 0);
        assert.match(currentSummary(fixture, 'different-report-rollout').errors.join('\n'), /completed current evidence bindings differ/u);
    });

    test('native stderr stays in raw files while oversized typed create and admission stdout refuse without heap capture', async t =>
    {
        const fixture = createCurrentFixture(t);
        for (const [name, flag, commandName] of [
            ['create', 'FSUSBLOG_CURRENT_FIXTURE_LARGE_CREATE', 'source-create'],
            ['admission', 'FSUSBLOG_CURRENT_FIXTURE_LARGE_ADMISSION', 'source-admission']
        ])
        {
            const rejected = await runCurrentFixture(fixture, 'normal', 'large-typed-' + name, { [flag]: '1' });
            assert.notEqual(rejected.status, 0);
            const report = currentSummary(fixture, 'large-typed-' + name);
            assert.equal(fs.statSync(report.commands.find(command => command.name === commandName).stdout.path).size, 2 * 1024 * 1024);
            assert.equal(report.commands.some(command => command.name === 'current-release'), false);
            assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
            assert.deepEqual(fs.readdirSync(fixture.containers), []);
        }
        const control = await runCurrentFixture(fixture, 'normal', 'large-stderr-control', { FSUSBLOG_CURRENT_FIXTURE_STDERR: '1' });
        assert.equal(control.status, 0, control.stderr);
        const report = currentSummary(fixture, 'large-stderr-control');
        assert.equal(fs.statSync(report.commands.find(command => command.name === 'source-create').stderr.path).size, 2 * 1024 * 1024);
        for (const command of report.commands)
        {
            assert.equal(command.processGroup.postObservation, 'zero-members');
            assert.equal(command.processGroup.zeroObservations, 2);
            assert.equal(command.processGroup.authority.leaderPid, command.pid);
            assert.match(command.processGroup.authority.leaderProcessStartIdentity, /^linux:[0-9a-f-]+:\d+$/u);
        }
    });

    test('command deadline terminates actual owned TERM and KILL leaders and observes stable zero membership', async t =>
    {
        for (const kind of ['term', 'kill'])
        {
            const fixture = createCurrentFixture(t);
            const result = await runCurrentFixture(fixture, 'normal', 'deadline-' + kind,
                { FSUSBLOG_CURRENT_FIXTURE_HANG: kind });
            assert.notEqual(result.status, 0, result.stderr);
            const report = currentSummary(fixture, 'deadline-' + kind);
            const command = report.commands.find(command => command.name === 'current-release');
            assert.match(command.failure, /timed out/u);
            assert.equal(command.processGroup.termination.terminated, true);
            assert.equal(command.processGroup.termination.forced, kind === 'kill');
            assert.equal(command.processGroup.zeroObservations, 2);
            assert.equal(command.processGroup.postObservation, 'zero-members');
            const pid = Number(fs.readFileSync(path.join(fixture.root, 'owned-command.pid'), 'utf8'));
            assert.equal(command.pid, pid);
            assert.equal(fs.existsSync('/proc/' + pid), false);
            assert.equal(fs.existsSync(fixture.raw.rollout.stateFile), false);
            assert.deepEqual(fs.readdirSync(fixture.containers), []);
        }
    });

    test('kernel group collector refuses reused leader and unowned members instead of treating leader close as terminal', async t =>
    {
        const { observeCurrentCommandGroup } = await import('../../tools/deployment/zero-downtime-rehearsal-plan.mjs');
        const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-group-kernel-fixture-'));
        t.after(() => fs.rmSync(procRoot, { recursive: true, force: true }));
        fs.mkdirSync(path.join(procRoot, 'sys/kernel/random'), { recursive: true });
        fs.writeFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'fixture-boot\n');
        const writeProcess = (pid, start, token, group = 42) => {
            const directory = path.join(procRoot, String(pid)); fs.mkdirSync(directory, { recursive: true });
            const fields = Array(20).fill('0');
            fields[0] = 'S'; fields[1] = '1'; fields[2] = String(group); fields[3] = '42'; fields[19] = String(start);
            fs.writeFileSync(path.join(directory, 'stat'), String(pid) + ' (fixture) ' + fields.join(' '));
            fs.writeFileSync(path.join(directory, 'environ'), 'FSUSBLOG_CURRENT_REHEARSAL_COMMAND_OWNER=' + token + '\0');
        };
        const authority = { schema: 'fsusblog.process-group-or-job-identity.v1', platform: 'linux', kind: 'process-group',
            groupId: 42, leaderPid: 42, leaderProcessStartIdentity: 'linux:fixture-boot:100' };
        writeProcess(42, 100, 'owned'); writeProcess(43, 200, 'owned');
        const knownStarts = new Map();
        assert.equal(observeCurrentCommandGroup(authority, 'owned', { procRoot, knownStarts }).identities.length, 2);
        writeProcess(42, 101, 'owned');
        assert.equal(observeCurrentCommandGroup(authority, 'owned', { procRoot, knownStarts }).status, 'unverifiable');
        writeProcess(42, 100, 'owned'); writeProcess(43, 200, 'foreign');
        assert.equal(observeCurrentCommandGroup(authority, 'owned', { procRoot, knownStarts }).status, 'unverifiable');
        writeProcess(43, 201, 'owned');
        assert.equal(observeCurrentCommandGroup(authority, 'owned', { procRoot, knownStarts }).status, 'unverifiable');
        fs.rmSync(path.join(procRoot, '42'), { recursive: true });
        writeProcess(43, 200, 'owned');
        assert.equal(observeCurrentCommandGroup(authority, 'owned', { procRoot, knownStarts }).identities.length, 1);
        fs.rmSync(path.join(procRoot, '43'), { recursive: true });
        assert.deepEqual(observeCurrentCommandGroup(authority, 'owned', { procRoot, knownStarts }), { status: 'verified', identities: [] });
    });
}

/** Recording component actors only; never issued/native/provider/backup qualification. */
function createCurrentFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zdt-current-component-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workRoot = path.join(root, '.tmp', 'rehearsal'), runtime = path.join(workRoot, 'runtime');
    const bin = path.join(root, 'bin'), containers = path.join(root, 'containers');
    for (const directory of [runtime, bin, containers, path.join(root, 'tools', 'deployment')])
        fs.mkdirSync(directory, { recursive: true });
    const log = path.join(root, 'recording.jsonl');
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const tuple = {
        target: { modelVersion: 'fixture-model.v1', extractorVersion: 'fixture-extractor.v1',
            generatorVersion: 'fixture-generator.v1', sourceDigest: '2'.repeat(64), contentDigest: '3'.repeat(64) },
        database: { provider: 0, instanceId: 'fixture-instance', databaseId: 'fixture-database' },
        actualSchemaDigest: '4'.repeat(64)
    };
    const manifests = {}, references = {};
    for (const [role, character, date] of [['source', 'a', '20260710010101'], ['target', 'b', '20260711010101']])
    {
        const receipt = path.join(root, role + '-current-receipt.json');
        writeJson(receipt, { format: 'fsusblog.current-schema-receipt.v1', status: 'verified-current', ...tuple });
        const currentSchema = { receipt: { reference: receipt, sha256: sha(fs.readFileSync(receipt)) }, ...tuple };
        const value = createReleaseManifest({
            releaseId: date + '-' + character.repeat(12), commitSha: character.repeat(40),
            imageRepository: 'ghcr.io/fsusblog/app', imageTag: 'ghcr.io/fsusblog/app:' + date + '-' + character.repeat(12),
            imageDigest: 'sha256:' + character.repeat(64), registryDigestVerified: true,
            createdAtUtc: '2026-07-' + date.slice(6, 8) + 'T01:01:01Z',
            frontendManifestHash: 'sha256:' + '5'.repeat(64), wasmArtifactHash: 'sha256:' + '6'.repeat(64),
            currentSchema, dotnetVersion: '10.0.100', nodeVersion: '24.16.0', dockerVersion: '29.0.0',
            dockerfileDigest: 'sha256:' + '7'.repeat(64),
            runtimeProfile: { id: 'throughput-musl', manifestDigest: 'sha256:' + '8'.repeat(64),
                profileDigest: 'sha256:' + '9'.repeat(64), baseImageFamily: 'musl', targetRuntime: 'linux-musl-x64',
                singleFile: true, readyToRun: false, tieredPgo: true, quickJitForLoops: true,
                serverGc: true, nativeAot: false, threadPoolMode: 'runtime-default', topologyMode: 'smt-visible' }
        });
        const file = path.join(root, role + '-manifest.json');
        writeJson(file, value); manifests[role] = value;
        references[role] = { manifest: file, sha256: sha(fs.readFileSync(file)) };
    }
    const envFile = path.join(root, 'test.env'), adminHeaderFile = path.join(root, 'admin.header');
    fs.writeFileSync(envFile, ['ASPNETCORE_ENVIRONMENT=Test', 'SITE_BASEURL=http://127.0.0.1:18080',
        'EXTERNAL_DB_HOST=global-postgres', 'EXTERNAL_REDIS_HOST=global-redis', 'DB_NAME=fsusblog_rehearsal',
        ...['POSTGRES', 'REDIS', 'OPENRESTY'].map(name => 'FSUSBLOG_REHEARSAL_' + name + '_IMAGE=fixture@sha256:' + 'c'.repeat(64))
    ].join('\n') + '\n', { mode: 0o600 });
    fs.writeFileSync(adminHeaderFile, 'Authorization: Bearer fixture-admin\n', { mode: 0o600 });
    const evidenceInputs = {};
    for (const key of ['backupRestore', 'productionBuildReceipt', 'trafficScenario', 'trafficBindingKey',
        'notificationAuthStorageState', 'assetScenario', 'assetBrowserBindingKey', 'workerLedger',
        'faultInjection', 'challengeKindTargetMap', 'perceptionReleaseTarget', 'perceptionPoolManifest'])
    {
        const file = path.join(root, key + '.json');
        fs.writeFileSync(file, key.endsWith('Key') ? 'k'.repeat(32) : '{}\n', { mode: 0o600 });
        evidenceInputs[key] = file;
    }
    const notificationResyncScenario = path.join(root, 'notification-resync.json');
    writeJson(notificationResyncScenario, { schema: 'fsusblog.release-notification-resync-scenario.v1' });
    const slots = createEmptySlotState('2026-07-11T00:00:00.000Z');
    for (const [role, slot] of [['source', 'blue'], ['target', 'green']])
        recordSlotStart(slots, { slot, releaseId: manifests[role].releaseId,
            imageRef: manifests[role].imageRef, imageDigest: manifests[role].imageDigest, startedAt: '2026-07-11T00:01:00.000Z' });
    setActiveSlot(slots, { slot: 'blue', kind: 'bootstrap', changedAt: '2026-07-11T00:02:00.000Z' });
    const slotState = path.join(runtime, 'slots.json');
    writeSlotStateAtomic(slotState, slots);
    setActiveSlot(slots, { slot: 'green', kind: 'switch', changedAt: '2026-07-11T00:30:00.000Z' });
    const targetSlots = path.join(root, 'completed-slots.json'); writeSlotStateAtomic(targetSlots, slots);
    const rolloutId = 'current-component-release';
    const evidenceFixture = createReleaseRolloutEvidenceFixture({
        manifest: manifests.target, rolloutId,
        source: { slot: 'blue', releaseId: manifests.source.releaseId, imageDigest: manifests.source.imageDigest, runtimeGeneration: 1 },
        target: { slot: 'green', releaseId: manifests.target.releaseId, imageDigest: manifests.target.imageDigest, runtimeGeneration: 2 }
    });
    const fixtureDirectory = path.join(root, 'sealed-component-evidence'); fs.mkdirSync(fixtureDirectory);
    const final = evidenceFixture.createFinalEvidence(fixtureDirectory);
    const fixtureState = path.join(fixtureDirectory, 'state.json'), completedState = path.join(root, 'completed-state.json');
    writeRolloutStateAtomic(completedState, completeRollout(readRolloutState(fixtureState), {
        evidencePath: path.join(workRoot, 'evidence', rolloutId, 'evidence', 'release-rollout.json'),
        completedAtUtc: '2026-07-11T00:30:00.000Z'
    }));
    const raw = {
        schema: 'fsusblog.zero-downtime-rehearsal-plan.v2', environment: 'Test',
        nonProductionOnly: true, acknowledgement: 'DESTROY_ISOLATED_LOCAL_REHEARSAL_ONLY', rehearsalId: 'fixture-current',
        workRoot, publicUrl: 'http://127.0.0.1:18080/health/ready', controlOrigin: 'http://127.0.0.1:18080',
        envFile, adminHeaderFile, ...references, runtime: { directory: runtime, slotState },
        rollout: { id: rolloutId, stateFile: path.join(workRoot, 'state.json'),
            evidenceRoot: path.join(workRoot, 'evidence'), assetStore: path.join(workRoot, 'assets'),
            retentionState: path.join(workRoot, 'retention.json') },
        evidenceInputs, notificationResyncScenario, perceptionPolicyVersion: 'fixture-policy.v1', timeoutSeconds: 10
    };
    const plan = path.join(root, 'current-plan.json'); writeJson(plan, raw);
    const actorConfig = path.join(root, 'actors.json');
    writeJson(actorConfig, { root, log, containers, manifests, raw, finalEvidence: final.file, fixtureState, completedState, targetSlots });
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env -S node --\n' + String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const config = JSON.parse(fs.readFileSync(process.env.FSUSBLOG_CURRENT_FIXTURE_CONFIG));
const args = process.argv.slice(2), kind = args[0], field = key => args[args.indexOf(key) + 1];
fs.appendFileSync(config.log, JSON.stringify({ kind, args }) + '\n');
if (kind === 'create') {
    const name = field('--name'), id = crypto.createHash('sha256').update(name).digest('hex');
    const role = Object.keys(config.manifests).find(role => config.manifests[role].commitSha === field('--candidate-source-revision'));
    if (!role || !args.includes(config.manifests[role].imageRef)) process.exit(40);
    fs.writeFileSync(path.join(config.containers, name + '.json'), JSON.stringify({
        Id: id, Name: '/' + name, Config: { Labels: { 'io.fsusblog.rehearsal.owner': name } }, role }));
    if (process.env.FSUSBLOG_CURRENT_FIXTURE_STDERR === '1') process.stderr.write('e'.repeat(2 * 1024 * 1024));
    if (process.env.FSUSBLOG_CURRENT_FIXTURE_LOST_CREATE === '1') process.exit(22);
    process.stdout.write(process.env.FSUSBLOG_CURRENT_FIXTURE_LARGE_CREATE === '1' ? 'f'.repeat(2 * 1024 * 1024) : id + '\n');
} else if (kind === 'start') {
    const owned = fs.readdirSync(config.containers).map(name => JSON.parse(fs.readFileSync(path.join(config.containers, name))))
        .find(value => value.Id === args.at(-1));
    if (!owned) process.exit(41);
    const manifest = config.manifests[owned.role];
    const output = { status: 'verified-current', candidateSourceRevision: manifest.commitSha,
        artifactSha256: manifest.currentSchema.receipt.sha256, target: manifest.currentSchema.target,
        database: manifest.currentSchema.database, actualSchemaDigest: manifest.currentSchema.actualSchemaDigest };
    const bad = process.env.FSUSBLOG_CURRENT_FIXTURE_BAD_OUTPUT;
    if (!process.env.FSUSBLOG_CURRENT_FIXTURE_BAD_ROLE || process.env.FSUSBLOG_CURRENT_FIXTURE_BAD_ROLE === owned.role) {
        if (bad === '1' || bad === 'candidate') output.candidateSourceRevision = 'f'.repeat(40);
        else if (bad === 'receipt') output.artifactSha256 = 'f'.repeat(64);
        else if (bad === 'target') output.target = { ...output.target, sourceDigest: 'f'.repeat(64) };
        else if (bad === 'database') output.database = { ...output.database, databaseId: 'wrong-database' };
        else if (bad === 'observation') output.actualSchemaDigest = 'f'.repeat(64);
        else if (bad === 'status') delete output.status;
        else if (bad === 'extra') output.approved = true;
    }
    process.stdout.write(process.env.FSUSBLOG_CURRENT_FIXTURE_LARGE_ADMISSION === '1' ? 'x'.repeat(2 * 1024 * 1024) : JSON.stringify(output) + '\n');
} else if (kind === 'inspect') {
    const value = JSON.parse(fs.readFileSync(path.join(config.containers, args.at(-1) + '.json')));
    process.stdout.write(JSON.stringify({ Id: value.Id, Name: value.Name,
        Owner: value.Config.Labels['io.fsusblog.rehearsal.owner'] }) + '\n');
} else if (kind === 'rm') {
    const name = fs.readdirSync(config.containers).find(name => JSON.parse(fs.readFileSync(path.join(config.containers, name))).Id === args.at(-1));
    if (!name) process.exit(42);
    fs.unlinkSync(path.join(config.containers, name));
} else process.exit(43);
`, { mode: 0o755 });
    const releaseActor = path.join(root, 'release-actor.cjs');
    fs.writeFileSync(releaseActor, String.raw`
const fs = require('node:fs'), path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.FSUSBLOG_CURRENT_FIXTURE_CONFIG));
const args = process.argv.slice(2);
fs.appendFileSync(config.log, JSON.stringify({ kind: 'release', args }) + '\n');
if (process.env.FSUSBLOG_CURRENT_FIXTURE_HANG) {
    fs.writeFileSync(path.join(config.root, 'owned-command.pid'), String(process.pid));
    if (process.env.FSUSBLOG_CURRENT_FIXTURE_HANG === 'kill') process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
} else if (process.env.FSUSBLOG_CURRENT_FIXTURE_KILL === '1') {
    fs.copyFileSync(config.fixtureState, config.raw.rollout.stateFile);
    process.kill(process.pid, 'SIGKILL');
} else {
    fs.copyFileSync(config.completedState, config.raw.rollout.stateFile);
    fs.copyFileSync(config.targetSlots, config.raw.runtime.slotState);
    const directory = path.join(config.raw.rollout.evidenceRoot, config.raw.rollout.id, 'evidence');
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(config.finalEvidence, path.join(directory, 'release-rollout.json'));
    process.stdout.write('r'.repeat(1024 * 1024 + 1));
}
`);
    fs.writeFileSync(path.join(root, 'tools/deployment/release-rollout.sh'),
        '#!/usr/bin/env bash\nexec ' + JSON.stringify(process.execPath) + ' -- ' + JSON.stringify(releaseActor) + ' "$@"\n', { mode: 0o755 });
    return { root, plan, raw, manifests, log, bin, containers, actorConfig, fixtureState, completedState };
}

function runCurrentFixture(fixture, mode, runId, overrides = {})
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(process.execPath, [planToolSource, 'run-current', '--plan', fixture.plan,
            '--repo-root', fixture.root, '--mode', mode, '--run-id', runId], {
            cwd: fixture.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: fixture.bin + path.delimiter + process.env.PATH,
                FSUSBLOG_CURRENT_FIXTURE_CONFIG: fixture.actorConfig, ...overrides }
        });
        activeRehearsalProcessGroups.add(child.pid);
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 30_000);
        child.once('error', error => { clearTimeout(timeout); activeRehearsalProcessGroups.delete(child.pid); reject(error); });
        child.once('close', (status, signal) => {
            clearTimeout(timeout); activeRehearsalProcessGroups.delete(child.pid);
            const summary = path.join(fixture.raw.workRoot, fixture.raw.rehearsalId, runId, 'rehearsal-summary.json');
            if (status !== 0 && fs.existsSync(summary)) {
                const report = readJson(summary);
                stderr += JSON.stringify(report.errors);
            }
            resolve({ status, signal, stdout, stderr });
        });
    });
}

function currentSummary(fixture, runId)
{
    return readJson(path.join(fixture.raw.workRoot, fixture.raw.rehearsalId, runId, 'rehearsal-summary.json'));
}

function createFixture(t, {
    continuationOnly = false,
    delayedSetsidMs = 0,
    delayFirstSetsidOnly = false
} = {})
{
    const timing = machineTiming();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zdt-rehearsal-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const deployment = path.join(root, 'tools/deployment');
    const fixtureDirectory = path.join(root, 'tests/fixtures/deployment');
    const secrets = path.join(root, 'secrets');
    fs.mkdirSync(deployment, { recursive: true });
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    fs.mkdirSync(secrets, { recursive: true });
    fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools/db'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools/release'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/shared/Contracts/Validation'), { recursive: true });
    fs.mkdirSync(path.join(root, '.tmp/docker-failure-bin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tmp/docker-failure-bin/docker'), '#!/usr/bin/env bash\nexit 73\n', { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin/docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    if (delayedSetsidMs > 0)
    {
        const setsid = spawnSync('sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).stdout.trim();
        assert.ok(path.isAbsolute(setsid), 'system setsid path is unavailable');
        const delayGate = path.join(root, '.tmp/delayed-setsid-once');
        const delayCommand = delayFirstSetsidOnly
            ? `if mkdir ${JSON.stringify(delayGate)} 2>/dev/null; then sleep ${delayedSetsidMs / 1_000}; fi`
            : `sleep ${delayedSetsidMs / 1_000}`;
        fs.writeFileSync(
            path.join(root, 'bin/setsid'),
            `#!/usr/bin/env bash\n${delayCommand}\nexec ${JSON.stringify(setsid)} "$@"\n`,
            { mode: 0o755 });
    }
    fs.copyFileSync(orchestratorSource, path.join(deployment, 'zero-downtime-rehearsal.sh'));
    if (continuationOnly)
    {
        installContinuationModeFixture(path.join(deployment, 'zero-downtime-rehearsal.sh'));
    };
    fs.copyFileSync(planToolSource, path.join(deployment, 'zero-downtime-rehearsal-plan.mjs'));
    fs.copyFileSync(releaseIdToolSource, path.join(root, 'tools/release/release-id.mjs'));
    fs.copyFileSync(releaseIdContractSource, path.join(root, 'src/shared/Contracts/Validation/release-id-contract.json'));
    fs.copyFileSync(faultTemplateSource, path.join(fixtureDirectory, 'zero-downtime-fault-plan.template.json'));
    fs.copyFileSync(migrationQualificationTemplateSource, path.join(fixtureDirectory, 'release-migration-qualification-scenario.template.json'));
    fs.writeFileSync(path.join(root, 'fixture-runner.mjs'), fixtureRunnerSource());
    fs.writeFileSync(path.join(deployment, 'rehearsal-schema-qualification-probe.mjs'), 'export {}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'tools/db/run-online-migrations.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });

    for (const [name, action] of [
        ['zero-downtime-topology.sh', 'topology'],
        ['release-rollout.sh', 'release'],
        ['rollout-state.mjs', 'rollout-state'],
        ['release-worker-drill.mjs', 'worker-drill'],
        ['release-worker-observer-service.mjs', 'observer-service'],
        ['release-worker-reconciliation.mjs', 'worker-reconciliation'],
        ['release-migration-qualification.mjs', 'migration-qualification'],
        ['release-worker-normal-observer.mjs', 'normal-worker-ledger'],
        ['zero-downtime-fault-matrix.mjs', 'fault-matrix'],
        ['release-asset-compatibility-probe.mjs', 'probe-asset'],
        ['release-notification-probe.mjs', 'probe-notification'],
        ['release-resource-probe.mjs', 'probe-resource']
    ])
    {
        writeRunner(deployment, name, action);
    }
    for (const name of ['rehearsal-openresty.sh', 'fault-wrapper.sh', 'failing-openresty.sh'])
    {
        fs.writeFileSync(path.join(deployment, name), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    }

    const blueManifest = path.join(root, 'blue-manifest.json');
    const greenManifest = path.join(root, 'green-manifest.json');
    writeJson(blueManifest, releaseManifest('20260710010101-aaaaaaaaaaaa', '1'));
    writeJson(greenManifest, releaseManifest('20260711010101-bbbbbbbbbbbb', '2'));
    const deployAsset = path.join(root, 'asset-blue-green.json');
    const rollbackAsset = path.join(root, 'asset-green-blue.json');
    writeJson(deployAsset, assetScenario('20260710010101-aaaaaaaaaaaa', '20260711010101-bbbbbbbbbbbb'));
    writeJson(rollbackAsset, assetScenario('20260711010101-bbbbbbbbbbbb', '20260710010101-aaaaaaaaaaaa'));
    const workerPlan = path.join(root, 'worker-plan.json');
    writeJson(workerPlan, {
        schema: 'fsusblog.release-worker-drill-plan.v1',
        security: { allowedHttpOrigins: ['http://127.0.0.1:19031'] },
        coordination: {
            mode: 'file-handshake',
            armedFile: 'signals/armed.json',
            authorizeFile: 'signals/authorize.json',
            terminatedFile: 'signals/terminated.json',
            timeoutMs: timing.coordinationTimeoutMs,
            pollMs: 10
        },
        sourceTermination: { type: 'process-signal', signal: 'SIGKILL', pidFile: 'source.pid', commandContains: 'fixture-source-worker' }
    });
    const normalWorkerPlan = path.join(root, 'normal-worker-plan.json');
    writeJson(normalWorkerPlan, {
        schema: 'fsusblog.release-worker-normal-observer-plan.v1',
        baseUrl: 'http://127.0.0.1:19031',
        startPath: '/fixture/normal/start',
        statusPath: '/fixture/normal/status',
        finalizePath: '/fixture/normal/finalize',
        requiredKinds: ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control'],
        timeoutMs: timing.coordinationTimeoutMs,
        pollMs: 50
    });
    const observerServicePlan = path.join(root, 'worker-observer-service-plan.json');
    writeJson(observerServicePlan, {
        schema: 'fsusblog.release-worker-observer-service-plan.v1',
        nonProductionOnly: true,
        acknowledgement: 'OBSERVE_ISOLATED_TEST_WORKERS_ONLY',
        listen: { host: '127.0.0.1', port: 19031 }
    });
    const envFile = path.join(secrets, 'rehearsal.env');
    fs.writeFileSync(envFile, [
        'ASPNETCORE_ENVIRONMENT=Test',
        'SITE_BASEURL=http://127.0.0.1:18080',
        'EXTERNAL_DB_HOST=global-postgres',
        'EXTERNAL_REDIS_HOST=global-redis',
        'DB_NAME=fsusblog_rehearsal_test',
        `FSUSBLOG_REHEARSAL_POSTGRES_IMAGE=postgres@sha256:${'a'.repeat(64)}`,
        `FSUSBLOG_REHEARSAL_REDIS_IMAGE=redis@sha256:${'b'.repeat(64)}`,
        `FSUSBLOG_REHEARSAL_OPENRESTY_IMAGE=openresty@sha256:${'c'.repeat(64)}`,
        'FSUSBLOG_REHEARSAL_POSTGRES_VOLUME=fsusblog-zdt-postgres-fixture',
        'FSUSBLOG_REHEARSAL_REDIS_VOLUME=fsusblog-zdt-redis-fixture',
        'FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME=fsusblog-zdt-public-assets-fixture',
        'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME=fsusblog-zdt-data-protection-fixture',
        ''
    ].join('\n'), { mode: 0o600 });
    const observerEnvFile = path.join(secrets, 'worker-observer.env');
    fs.writeFileSync(observerEnvFile, [
        'FSUSBLOG_WORKER_OBSERVER_PGHOST=127.0.0.1',
        'FSUSBLOG_WORKER_OBSERVER_PGPORT=5432',
        'FSUSBLOG_WORKER_OBSERVER_PGDATABASE=fsusblog_rehearsal_test',
        'FSUSBLOG_WORKER_OBSERVER_PGUSER=fsusblog',
        'FSUSBLOG_WORKER_OBSERVER_PGPASSWORD=fixture-only-password',
        'FSUSBLOG_WORKER_OBSERVER_REDIS_HOST=127.0.0.1',
        'FSUSBLOG_WORKER_OBSERVER_REDIS_PORT=6379',
        'FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE=0',
        ''
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(secrets, 'admin-header.txt'), 'Authorization: Bearer fixture-only-token\n', { mode: 0o600 });
    writeJson(path.join(secrets, 'auth-state.json'), { cookies: [], origins: [] }, 0o600);
    fs.writeFileSync(path.join(secrets, 'traffic-binding.key'), Buffer.alloc(32, 0x41), { mode: 0o600 });
    fs.writeFileSync(path.join(secrets, 'asset-browser-binding.key'), Buffer.alloc(32, 0x42), { mode: 0o600 });
    for (const name of ['backup.json', 'traffic.json', 'server.dll', 'retained.js', 'corrupt.js'])
    {
        fs.writeFileSync(path.join(root, name), name, { mode: 0o600 });
    }
    writeJson(path.join(root, 'notification-resync.json'), {
        schema: 'fsusblog.release-notification-resync-scenario.v1'
    });
    writeJson(path.join(root, 'config/deployment/zero-downtime-resource-policy.json'), {
        schema: 'fsusblog.zero-downtime-resource-policy.v1',
        minimumSupported: { cpuCores: 4, memoryMiB: 6144, freeDiskMiB: 10240 },
        budgets: { dualSlotCpuPercent: 300 },
        sampling: { intervalMs: 250 }
    });

    const plan = path.join(root, 'rehearsal-plan.json');
    writeJson(plan, {
        schema: 'fsusblog.zero-downtime-rehearsal-plan.v1',
        rehearsalId: 'fixture-zdt',
        nonProductionOnly: true,
        environment: 'Test',
        acknowledgement: 'DESTROY_ISOLATED_LOCAL_REHEARSAL_ONLY',
        workRoot: '.tmp/rehearsal',
        publicUrl: 'http://127.0.0.1:18080/health/ready',
        controlOrigin: 'http://127.0.0.1:18080',
        publicPort: 18080,
        envFile,
        adminHeaderFile: path.join(secrets, 'admin-header.txt'),
        notificationAuthStorageState: path.join(secrets, 'auth-state.json'),
        source: {
            slot: 'blue',
            manifest: blueManifest,
            previousRollbackRelease: '20260709010101-cccccccccccc'
        },
        target: { slot: 'green', manifest: greenManifest, migrationServerDll: path.join(root, 'server.dll') },
        evidenceInputs: {
            backupRestore: path.join(root, 'backup.json'),
            trafficScenario: path.join(root, 'traffic.json'),
            trafficBindingKey: path.join(secrets, 'traffic-binding.key'),
            assetBrowserBindingKey: path.join(secrets, 'asset-browser-binding.key'),
            notificationResyncScenario: path.join(root, 'notification-resync.json')
        },
        migrationQualification: {
            scenarioTemplate: path.join(fixtureDirectory, 'release-migration-qualification-scenario.template.json'),
            timeoutSeconds: timing.migrationTimeoutSeconds,
            expandMigrationId: '20260711-pre-account-subject-hash-expand',
            backfillMigrationId: '20260711-post-account-subject-hash-backfill',
            contractMigrationId: '20260629-post-audit-chain-tail-index'
        },
        assets: {
            deployScenario: deployAsset,
            rollbackScenario: rollbackAsset,
            store: '.tmp/rehearsal/assets',
            retentionState: '.tmp/rehearsal/assets/retention-state.json'
        },
        workers: {
            timeoutSeconds: timing.workerTimeoutSeconds,
            observerEnvFile,
            deploy: { scenario: workerPlan, normalScenario: normalWorkerPlan, observerServicePlan, startStage: 'candidate-start' },
            rollback: { scenario: workerPlan, normalScenario: normalWorkerPlan, observerServicePlan, startStage: 'candidate-start' },
            resume: { scenario: workerPlan, normalScenario: normalWorkerPlan, observerServicePlan, startStage: 'candidate-start' }
        },
        faults: {
            planTemplate: path.join(fixtureDirectory, 'zero-downtime-fault-plan.template.json'),
            tokens: {
                failingOpenRestyWrapper: path.join(deployment, 'failing-openresty.sh'),
                dockerFailureBinPath: path.join(root, '.tmp/docker-failure-bin'),
                retainedAsset: path.join(root, 'retained.js'),
                corruptAsset: path.join(root, 'corrupt.js'),
                longRequestPath: '/fixture/hold'
            }
        },
        hostInterruption: {
            stages: ['source-drain', 'source-stop', 'release-evidence'],
            timeoutSeconds: timing.hostInterruptionTimeoutSeconds
        }
    });
    return { root, plan, log: path.join(root, 'records.jsonl'), bin: path.join(root, 'bin'), timing };
}

function installContinuationModeFixture(orchestrator)
{
    const marker = 'Log "run=$RUN_ID modes=${REQUESTED_MODES[*]} root=$RUN_ROOT"';
    const source = fs.readFileSync(orchestrator, 'utf8');
    assert.ok(source.includes(marker), 'zero-downtime all-mode dispatch marker is missing');
    const fixtureFunctions = [
        'FixtureWriteContinuationMode() {',
        '  local mode="$1" status="$2" report="$RUN_ROOT/modes/$1/evidence/rehearsal-mode.json"',
        '  mkdir -p "$(dirname "$report")"',
        "  jq -n --arg mode \"$mode\" --arg status \"$status\" '{schema:\"fsusblog.zero-downtime-rehearsal-mode.v1\",mode:$mode,status:$status,checks:[],errors:(if $status == \"pass\" then [] else [\"fixture mode failure\"] end)}' >\"$report\"",
        '}',
        'FixtureRecordContinuation() {',
        '  printf \'{"kind":"%s"}\\n\' "$1" >>"$FSUSBLOG_FIXTURE_LOG"',
        '}',
        'RunNormalLikeMode() {',
        '  if [[ "$1" == "normal" && "${FSUSBLOG_FIXTURE_FAIL_NORMAL:-}" == "1" ]]; then',
        '    FixtureWriteContinuationMode "$1" fail',
        '    return 17',
        '  fi',
        '  FixtureWriteContinuationMode "$1" pass',
        '}',
        'RunExplicitRollbackMode() {',
        '  FixtureRecordContinuation release:rollback',
        '  FixtureWriteContinuationMode explicit-rollback pass',
        '}',
        'RunSigkillResumeMode() {',
        '  FixtureRecordContinuation release:resume',
        '  FixtureWriteContinuationMode sigkill-resume pass',
        '}',
        ''
    ].join('\n');
    fs.writeFileSync(orchestrator, source.replace(marker, `${fixtureFunctions}${marker}`), { mode: 0o755 });
}

async function runRehearsal(fixture, mode, overrides = {})
{
    const timing = fixture.timing;
    const child = spawn('bash', [
        path.join(fixture.root, 'tools/deployment/zero-downtime-rehearsal.sh'),
        '--plan', fixture.plan,
        '--mode', mode,
        '--run-id', `fixture-${mode.replaceAll('-', '')}`
    ], {
        cwd: fixture.root,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
            FSUSBLOG_FIXTURE_LOG: fixture.log,
            FSUSBLOG_FIXTURE_STAGE_DELAY_MS: String(timing.stageDelayMs),
            FSUSBLOG_FIXTURE_ACTIVE_FENCE_DELAY_MS: String(timing.activeFenceDelayMs),
            FSUSBLOG_FIXTURE_POLL_TIMEOUT_MS: String(timing.coordinationTimeoutMs),
            ...overrides
        }
    });
    activeRehearsalProcessGroups.add(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk =>
    {
        stdout += chunk;
    });
    child.stderr.on('data', chunk =>
    {
        stderr += chunk;
    });
    return await new Promise((resolve) =>
    {
        let timedOut = false;
        const deadline = setTimeout(() =>
        {
            timedOut = true;
            try
            {
                if (process.platform === 'win32')
                {
                    child.kill('SIGKILL');
                }
                else
                {
                    process.kill(-child.pid, 'SIGKILL');
                }
            }
            catch
            // eslint-disable-next-line no-empty
            {}
        }, timing.rehearsalTimeoutMs);
        child.once('error', error =>
        {
            clearTimeout(deadline);
            activeRehearsalProcessGroups.delete(child.pid);
            resolve({ status: 1, signal: null, stdout, stderr: `${stderr}${error.message}\n`, error });
        });
        child.once('close', (code, signal) =>
        {
            clearTimeout(deadline);
            activeRehearsalProcessGroups.delete(child.pid);
            resolve({
                status: timedOut ? 124 : (code ?? 1),
                signal,
                stdout,
                stderr: timedOut ? `${stderr}rehearsal fixture exceeded ${timing.rehearsalTimeoutMs}ms\n` : stderr
            });
        });
    });
}

function fixtureRunnerSource()
{
    return String.raw`
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const action = process.argv[2]
const argv = process.argv.slice(3)
const root = path.dirname(new URL(import.meta.url).pathname)
const log = process.env.FSUSBLOG_FIXTURE_LOG
const stages = ${JSON.stringify(ROLLOUT_STAGES)}
const faultCases = ${JSON.stringify(FAULT_CASES)}
const fixtureStageDelayMs = Math.max(1, Number.parseInt(process.env.FSUSBLOG_FIXTURE_STAGE_DELAY_MS ?? '', 10) || 80)
const fixtureActiveFenceDelayMs = Math.max(1, Number.parseInt(process.env.FSUSBLOG_FIXTURE_ACTIVE_FENCE_DELAY_MS ?? '', 10) || 1500)
const fixturePollTimeoutMs = Math.max(1, Number.parseInt(process.env.FSUSBLOG_FIXTURE_POLL_TIMEOUT_MS ?? '', 10) || 10_000)

record(action, argv)
if (action === 'topology') await topology(argv)
else if (action === 'release') await release(argv)
else if (action === 'rollout-state') rolloutState(argv)
else if (action === 'worker-drill') await workerDrill(argv)
else if (action === 'observer-service') {
  process.stdout.write(JSON.stringify({
    schema: 'fsusblog.release-worker-observer-service-response.v1',
    status: 'listening',
    address: { host: '127.0.0.1', port: 19031 }
  }) + '\n')
  await new Promise(resolve => {
    const keepAlive = setInterval(() => {}, 60_000)
    const stop = () => {
      clearInterval(keepAlive)
      resolve()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
}
else if (action === 'worker-reconciliation') workerReconciliation(argv)
else if (action === 'migration-qualification') migrationQualification(argv)
else if (action === 'fault-matrix') faultMatrix(argv)
else if (action === 'normal-worker-ledger') await normalWorkerLedger(argv)
else if (action.startsWith('probe-')) probe(action, argv)

function record(kind, args) {
  fs.appendFileSync(log, JSON.stringify({ kind: normalizeKind(kind, args), args, at: Date.now() }) + '\n')
}

function normalizeKind(kind, args) {
  if (kind === 'topology') return 'topology:' + args[0]
  if (kind === 'release') {
    const state = value(args, '--rollout-state-file')
    if (state.includes('/qualification/')) return 'release:qualification'
    if (args.includes('--resume')) return 'release:resume'
    if (args.includes('--rollback')) return 'release:rollback'
    return 'release:deploy'
  }
  if (kind === 'worker-reconciliation') return 'worker-reconciliation:' + value(args, '--mode')
  if (kind.startsWith('probe-')) return 'probe:' + kind.slice('probe-'.length)
  return kind
}

async function topology(args) {
  const command = args[0]
  const workDir = value(args, '--work-dir')
  const stateFile = value(args, '--state-file')
  if (command === 'down') {
    fs.rmSync(workDir, { recursive: true, force: true })
    return
  }
  if (command === 'status') return
  const slot = value(args, '--source-slot')
  const manifest = read(value(args, '--source-manifest'))
  fs.mkdirSync(path.join(workDir, 'gateway-evidence'), { recursive: true })
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  write(stateFile, slotState(slot, manifest))
}

async function release(args) {
  const stateFile = value(args, '--rollout-state-file')
  const slotFile = value(args, '--slot-state-file')
  const manifest = read(value(args, '--release-manifest'))
  const slotStateValue = read(slotFile)
  const sourceSlot = slotStateValue.activeSlot
  const targetSlot = sourceSlot === 'blue' ? 'green' : 'blue'
  const sourceRecord = slotStateValue.slots[sourceSlot]
  const kind = args.includes('--rollback') ? 'rollback' : 'deploy'
  const rolloutId = value(args, '--rollout-id', false) ?? (kind + '-' + manifest.releaseId)
  const qualification = stateFile.includes('/qualification/')
  const migrationQualificationRun = stateFile.includes('/migration-qualification/')
  const interruptStage = stateFile.match(/\/interruptions\/(source-drain|source-stop|release-evidence)\//)?.[1] ?? null
  const sigkill = interruptStage !== null
  const resume = args.includes('--resume')
  let state = fs.existsSync(stateFile) ? read(stateFile) : rolloutStateValue({
    rolloutId, kind, manifest: value(args, '--release-manifest'), sourceSlot, sourceRecord,
    targetSlot, targetManifest: manifest
  })
  if (migrationQualificationRun) {
    state.currentStage = 'candidate-readiness'
    state.status = 'running'
    write(stateFile, state)
    const holdReady = process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE
    if (!holdReady || process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE !== 'candidate-readiness') {
      throw new Error('fixture migration qualification stage hold is missing')
    }
    write(holdReady, {
      schema: 'fsusblog.release-rollout-rehearsal-stage-hold.v1', status: 'ready',
      rolloutId, stage: 'candidate-readiness', readyAtUtc: new Date().toISOString(), errors: []
    })
    await delay(60_000)
    return
  }
  if (qualification) {
    for (const stage of ['asset-materialize', 'candidate-start', 'candidate-readiness', 'candidate-smoke', 'compatibility-smoke', 'gateway-switch', 'source-drain', 'active-fence']) {
      state.currentStage = stage
      state.status = 'running'
      write(stateFile, state)
      if (stage === 'active-fence' && process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE === stage) {
        const holdReady = process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE
        if (!holdReady || !process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE) {
          throw new Error('fixture worker qualification stage hold is missing')
        }
        write(holdReady, {
          schema: 'fsusblog.release-rollout-rehearsal-stage-hold.v1', status: 'ready',
          rolloutId, stage, readyAtUtc: new Date().toISOString(), errors: []
        })
        await delay(60_000)
        return
      }
      await delay(stage === 'active-fence' ? fixtureActiveFenceDelayMs : fixtureStageDelayMs)
    }
    await delay(60_000)
    return
  }
  if (sigkill && !resume) {
    if (!interruptStage) throw new Error('fixture SIGKILL stage is missing')
    state.currentStage = 'candidate-start'
    state.status = 'running'
    write(stateFile, state)
    if (interruptStage !== 'source-drain') {
      await finalizeSourceDrain(args, state, rolloutId, sourceRecord, manifest)
    }
    const interruptIndex = stages.indexOf(interruptStage)
    state.completedStages = stages.slice(0, interruptIndex)
    state.currentStage = interruptStage
    state.status = 'running'
    write(stateFile, state)
    const holdReady = process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE
    if (!holdReady || process.env.FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE !== interruptStage) {
      throw new Error('fixture deterministic stage hold is missing')
    }
    write(holdReady, {
      schema: 'fsusblog.release-rollout-rehearsal-stage-hold.v1', status: 'ready',
      rolloutId, stage: interruptStage, readyAtUtc: new Date().toISOString(), errors: []
    })
    await delay(60_000)
    return
  }
  state.currentStage = 'candidate-start'
  state.status = 'running'
  write(stateFile, state)
  if (process.env.FSUSBLOG_FIXTURE_FAIL_NORMAL === '1' && stateFile.includes('/modes/normal/')) {
    process.exitCode = 17
    return
  }
  if (resume) {
    state = read(stateFile)
    const recovery = state.recovery
    state.recoveries ??= []
    if (recovery) state.recoveries.push({ action: recovery.action, failedStage: recovery.failedStage, status: 'ok' })
    state.recovery = null
  }
  if (!state.completedStages?.includes('source-drain')) {
    await finalizeSourceDrain(args, state, rolloutId, sourceRecord, manifest)
  }
  const evidenceDirectory = path.dirname(value(args, '--notification-evidence'))
  const workerFile = value(args, '--worker-reconciliation-evidence')
  const faultFile = value(args, '--fault-injection-evidence')
  const artifactFiles = {
    publicTraffic: path.join(evidenceDirectory, 'public-traffic.json'),
    notificationStream: value(args, '--notification-evidence'),
    assetCompatibility: value(args, '--asset-compatibility-evidence'),
    workerReconciliation: workerFile,
    resourceBudget: value(args, '--resource-budget-evidence'),
    faultInjection: faultFile
  }
  const evidenceRoot = value(args, '--evidence-root')
  const finalEvidence = path.join(evidenceRoot, rolloutId, 'evidence', 'release-rollout.json')
  const artifacts = Object.fromEntries(Object.entries(artifactFiles).map(([name, file]) => [name, metadata(file)]))
  write(finalEvidence, {
    schema: 'fsusblog.release-rollout-evidence.v1', status: 'pass', rolloutId, kind,
    stages: stages.map(stage => ({ stage })), artifacts, errors: []
  })
  state.status = 'completed'
  state.outcome = 'succeeded'
  state.currentStage = null
  state.completedStages = [...stages]
  state.switchCommitted = true
  state.gatewayGeneration = 1
  state.finalEvidencePath = finalEvidence
  state.recoveries ??= []
  write(stateFile, state)
  slotStateValue.previousSlot = sourceSlot
  slotStateValue.previousReleaseId = sourceRecord.releaseId
  slotStateValue.previousImageDigest = sourceRecord.imageDigest
  slotStateValue.activeSlot = targetSlot
  slotStateValue.activeReleaseId = manifest.releaseId
  slotStateValue.activeImageDigest = manifest.imageDigest
  slotStateValue.slots[targetSlot] = {
    releaseId: manifest.releaseId, imageDigest: manifest.imageDigest,
    deploymentGeneration: state.target.runtimeGeneration, status: 'running'
  }
  slotStateValue.status = 'stable'
  write(slotFile, slotStateValue)
}

async function finalizeSourceDrain(args, state, rolloutId, sourceRecord, manifest) {
  await invokeProbe('asset')
  await invokeProbe('notification')
  await invokeProbe('resource')
  const evidenceDirectory = path.dirname(value(args, '--notification-evidence'))
  write(path.join(evidenceDirectory, 'source-drain-gate.json'), {
    schema: 'fsusblog.release-rollout-gate.v1', gate: 'source-drain', status: 'pass',
    observations: { blockers: [] }, errors: [], observedAtUtc: new Date().toISOString()
  })
  const normalLedger = value(args, '--worker-ledger')
  const ledgerDeadline = Date.now() + fixturePollTimeoutMs
  while (!fs.existsSync(normalLedger) && Date.now() < ledgerDeadline) await delay(10)
  if (!fs.existsSync(normalLedger)) throw new Error('fixture normal worker ledger missing')
  write(process.env.FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH, {
    schema: 'fsusblog.release-rollout-gate.v1', gate: 'target-health', status: 'pass',
    observations: { rolloutId: state.rolloutId, releaseId: state.target.releaseId }, errors: []
  })
  await invokeNormalWorker(value(args, '--worker-reconciliation-evidence'), state)
  for (const [name, flag, schema] of [
    ['publicTraffic', '--traffic-scenario', 'fsusblog.release-traffic-evidence.v1'],
    ['notificationStream', '--notification-evidence', 'fsusblog.release-notification-stream-evidence.v1'],
    ['assetCompatibility', '--asset-compatibility-evidence', 'fsusblog.release-asset-compatibility-evidence.v1'],
    ['resourceBudget', '--resource-budget-evidence', 'fsusblog.release-resource-budget-evidence.v1']
  ]) {
    const file = name === 'publicTraffic'
      ? path.join(path.dirname(value(args, '--notification-evidence')), 'public-traffic.json')
      : value(args, flag)
    write(file, {
      schema,
      ...(name === 'notificationStream' ? { contractVersion: 2 } : {}),
      status: 'pass', rolloutId,
      sourceReleaseId: sourceRecord.releaseId, targetReleaseId: manifest.releaseId, errors: []
    })
  }
}

function rolloutState(args) {
  if (args[0] !== 'fail-stage') return
  const file = value(args, '--state')
  const state = read(file)
  const stage = value(args, '--stage')
  state.currentStage = null
  state.status = 'recovery_required'
  state.recovery = { action: 'preserve-source-stop-candidate', failedStage: stage, automatic: true }
  state.stages.push({ stage, status: 'failed' })
  write(file, state)
}

async function workerDrill(args) {
  const plan = read(value(args, '--plan'))
  const state = read(value(args, '--rollout-state'))
  const workDir = value(args, '--work-dir')
  const runId = value(args, '--run-id')
  const ledgerFile = path.join(workDir, value(args, '--out'))
  const armed = path.join(workDir, plan.coordination.armedFile)
  const authorize = path.join(workDir, plan.coordination.authorizeFile)
  const terminated = path.join(workDir, plan.coordination.terminatedFile)
  write(armed, signal(state.rolloutId, runId, 'armed'))
  const deadline = Date.now() + fixturePollTimeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(authorize)) {
      const auth = read(authorize)
      if (auth.rolloutId === state.rolloutId && auth.runId === runId && auth.stage === 'terminate-source') break
    }
    await delay(10)
  }
  if (!fs.existsSync(authorize)) throw new Error('fixture authorization missing')
  const completedAtUtc = new Date().toISOString()
  const kinds = ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control','forced-source-recovery']
  const events = kinds.map((kind, index) => ({
    logicalEventId: 'fixture-event-' + String(index).padStart(2, '0'), kind, attemptCount: 2,
    finalEffectCount: 1, finalEffectKey: 'fixture-effect-' + String(index).padStart(2, '0'),
    finalReleaseId: state.target.releaseId, finalGeneration: state.target.runtimeGeneration,
    staleGenerationCommitCount: 0, pendingCountAtDrain: 1, durableReplaySource: 'postgres-outbox',
    expectedAuditCount: kind === 'audit-writer' ? 1 : 0, actualAuditCount: kind === 'audit-writer' ? 1 : 0,
    expectedProjectionCount: kind === 'visit-view-projection' ? 1 : 0, actualProjectionCount: kind === 'visit-view-projection' ? 1 : 0,
    observationBindings: { finalGeneration: { observedAtUtc: completedAtUtc } }, errors: []
  }))
  const coordination = { status: 'pass', mode: 'file-handshake' }
  const sourceTermination = { status: 'pass', forced: true, completedAtUtc, observation: { signal: 'SIGKILL' } }
  write(ledgerFile, {
    schema: 'fsusblog.release-worker-event-ledger.v1', status: 'pass', rolloutId: state.rolloutId,
    source: { releaseId: state.source.releaseId, slot: state.source.slot, generation: state.source.runtimeGeneration },
    target: { releaseId: state.target.releaseId, slot: state.target.slot, generation: state.target.runtimeGeneration },
    drill: {
      runId, coordination, sourceTermination, terminationBoundary: { status: 'pass' },
      targetReadiness: { status: 'pass' }, targetTakeover: { status: 'pass', completedAtUtc }
    },
    events, errors: []
  })
  write(terminated, { ...signal(state.rolloutId, runId, 'source-terminated'), forced: true })
}

function workerReconciliation(args) {
  const mode = value(args, '--mode')
  const state = read(value(args, '--rollout-state'))
  const normalStateFile = value(args, '--normal-rollout-state', false)
  const normalState = normalStateFile ? read(normalStateFile) : null
  write(value(args, '--out'), {
    schema: 'fsusblog.release-worker-reconciliation-evidence.v2', mode, status: 'pass',
    rolloutId: state.rolloutId, source: state.source, target: state.target,
    checks: { normalRolloutSeparationVerified: mode === 'qualification' },
    qualification: mode === 'qualification' ? {
      freshNormalRolloutRequired: true, normalRolloutReuseForbidden: true,
      expectedNormalRolloutId: normalState?.rolloutId ?? null
    } : null,
    inputs: {
      normalRolloutState: normalStateFile ? metadata(normalStateFile) : null
    },
    errors: []
  })
}

function migrationQualification(args) {
  const state = read(value(args, '--rollout-state'))
  const caseIds = [
    'expand-with-old-active','blue-green-concurrent-read-write','backfill-checkpoint-resume',
    'missing-expand-candidate-not-ready','contract-rollback-window-rejected',
    'contract-applied-non-rollback-compatible','advisory-lock-timeout','database-disconnect',
    'partial-failure-recovery','history-integrity-rejected'
  ]
  write(value(args, '--out'), {
    schema: 'fsusblog.release-migration-qualification-evidence.v1', contractVersion: 1,
    status: 'pass', runId: value(args, '--run-id'), rolloutId: state.rolloutId,
    source: state.source, target: state.target,
    cases: caseIds.map(id => ({ id, status: 'pass', actions: [], errors: [] })),
    errors: [], evidenceSha256: 'sha256:' + 'a'.repeat(64)
  })
}

async function normalWorkerLedger(args) {
  const stateFile = value(args, '--rollout-state')
  const drainFile = value(args, '--source-drain')
  const out = value(args, '--out')
  const deadline = Date.now() + fixturePollTimeoutMs
  while ((!fs.existsSync(stateFile) || !fs.existsSync(drainFile)) && Date.now() < deadline) await delay(10)
  if (!fs.existsSync(stateFile) || !fs.existsSync(drainFile)) throw new Error('fixture rollout/drain evidence missing')
  const state = read(stateFile)
  const kinds = ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control']
  const observedAtUtc = new Date().toISOString()
  write(out, {
    schema: 'fsusblog.release-worker-event-ledger.v1', mode: 'normal', status: 'pass', rolloutId: state.rolloutId,
    source: { releaseId: state.source.releaseId, slot: state.source.slot, generation: state.source.runtimeGeneration },
    target: { releaseId: state.target.releaseId, slot: state.target.slot, generation: state.target.runtimeGeneration },
    drill: { schema: 'fsusblog.release-worker-normal-observation.v1', runId: value(args, '--run-id'), destructive: false },
    events: kinds.map((kind, index) => ({
      logicalEventId: 'normal-event-' + String(index).padStart(2, '0'), kind, attemptCount: 1,
      finalEffectCount: 1, finalEffectKey: 'normal-effect-' + String(index).padStart(2, '0'),
      finalReleaseId: state.target.releaseId, finalGeneration: state.target.runtimeGeneration,
      staleGenerationCommitCount: 0, pendingCountAtDrain: 0, durableReplaySource: 'postgres-outbox',
      expectedAuditCount: kind === 'audit-writer' ? 1 : 0, actualAuditCount: kind === 'audit-writer' ? 1 : 0,
      expectedProjectionCount: kind === 'visit-view-projection' ? 1 : 0, actualProjectionCount: kind === 'visit-view-projection' ? 1 : 0,
      observationSource: 'postgres',
      observationBindings: Object.fromEntries(['finalEffectCount','finalEffectKey','finalReleaseId','finalGeneration','staleGenerationCommitCount'].map(field => [field, { observedAtUtc }]))
    })),
    errors: []
  })
}

function faultMatrix(args) {
  const plan = read(value(args, '--plan'))
  const cases = faultCases.map(name => ({
    case: name, status: 'pass', automated: true, actionStatus: 'executed', errors: [],
    after: ['active-fence-failure', 'public-probe-failure'].includes(name)
      ? { rolloutState: { status: 'rolled_back', recoveries: [{ action: 'rollback-gateway-to-source', status: 'ok' }] } }
      : { rolloutState: { status: 'recovery_required', recoveries: [] } }
  }))
  write(value(args, '--out'), {
    schema: 'fsusblog.zero-downtime-fault-matrix.v1', status: 'pass', rolloutId: plan.rolloutId,
    target: plan.target, caseCount: cases.length, cases, errors: []
  })
}

function probe(action, args) {
  const out = value(args, '--out', false)
  if (out) write(out, { schema: 'fixture-probe.v1', status: 'pass', errors: [] })
}

async function invokeProbe(name) {
  spawnSync(process.execPath, [path.join(root, 'tools/deployment/release-' + name + (name === 'asset' ? '-compatibility' : '') + '-probe.mjs')], {
    env: process.env, stdio: 'ignore'
  })
}

async function invokeNormalWorker(out, state) {
  record('probe-worker-reconciliation-normal', [])
  write(out, {
    schema: 'fsusblog.release-worker-reconciliation-evidence.v2', mode: 'normal', status: 'pass',
    rolloutId: state.rolloutId, source: state.source, target: state.target,
    kinds: ['scheduled-publish','article-mutation-outbox','audit-writer','visit-view-projection','public-hot-aot','upload-cleanup','active-singleton-control','multi-consumer-safe-control'],
    forcedSourceRecoveryRequired: false,
    checks: {
      rolloutSourceTargetBound: true, targetHealthBound: true, gracefulDrainVerified: true,
      requiredWorkerKindsCovered: true, durableBufferDrainOrReplayVerified: true,
      exactlyOnceVerified: true, staleGenerationRejected: true, auditReconciled: true, visitProjectionReconciled: true
    },
    errors: []
  })
}

function rolloutStateValue(input) {
  const targetGeneration = Number(input.sourceRecord.deploymentGeneration ?? 1) + 1
  return {
    schema: 'fsusblog.release-rollout-state.v1', rolloutId: input.rolloutId, kind: input.kind,
    status: 'planned', outcome: null, manifestPath: input.manifest,
    source: { slot: input.sourceSlot, releaseId: input.sourceRecord.releaseId, imageDigest: input.sourceRecord.imageDigest, runtimeGeneration: input.sourceRecord.deploymentGeneration ?? 1 },
    target: { slot: input.targetSlot, releaseId: input.targetManifest.releaseId, imageDigest: input.targetManifest.imageDigest, runtimeGeneration: targetGeneration },
    currentStage: null, completedStages: [], stages: [], switchCommitted: false, gatewayGeneration: null,
    contractMigrationApplied: false, rollbackAllowed: true, candidateOnly: false, recovery: null, recoveries: [], finalEvidencePath: null
  }
}

function slotState(slot, manifest) {
  return {
    schema: 'fsusblog.deployment-slots.v1', status: 'stable', activeSlot: slot,
    activeReleaseId: manifest.releaseId, activeImageDigest: manifest.imageDigest,
    previousSlot: null, previousReleaseId: null, previousImageDigest: null,
    runtimeGeneration: 1,
    slots: {
      blue: slot === 'blue' ? { releaseId: manifest.releaseId, imageDigest: manifest.imageDigest, deploymentGeneration: 1, status: 'running' } : null,
      green: slot === 'green' ? { releaseId: manifest.releaseId, imageDigest: manifest.imageDigest, deploymentGeneration: 1, status: 'running' } : null
    }
  }
}

function metadata(file) {
  const buffer = fs.readFileSync(file)
  const parsed = JSON.parse(buffer.toString('utf8'))
  return { path: file, bytes: buffer.length, sha256: 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex'), schema: parsed.schema, status: parsed.status }
}

function signal(rolloutId, runId, stage) {
  return { schema: 'fsusblog.release-worker-drill-signal.v1', rolloutId, runId, stage, observedAtUtc: new Date().toISOString() }
}

function value(args, name, required = true) {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1]
  if (required) throw new Error('missing fixture argument ' + name)
  return null
}

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n') }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
`;
}

function writeRunner(deployment, name, action)
{
    const runner = path.resolve(deployment, '../../fixture-runner.mjs');
    if (name.endsWith('.sh'))
    {
        fs.writeFileSync(path.join(deployment, name), `#!/usr/bin/env bash\nexec node "${runner}" ${action} "$@"\n`, { mode: 0o755 });
    }
    else
    {
        fs.writeFileSync(path.join(deployment, name), [
            '#!/usr/bin/env node',
            "import process from 'node:process'",
            "import { spawnSync } from 'node:child_process'",
            `const result = spawnSync(process.execPath, [${JSON.stringify(runner)}, ${JSON.stringify(action)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })`,
            'process.exitCode = result.status ?? 1',
            ''
        ].join('\n'), { mode: 0o755 });
    }
}

function releaseManifest(releaseId, digit)
{
    return { schema: 'fsusblog.release-manifest.v1', releaseId, imageDigest: `sha256:${digit.repeat(64)}` };
}

function assetScenario(oldReleaseId, newReleaseId)
{
    return {
        schema: 'fsusblog.release-asset-compatibility-scenario.v1',
        oldReleaseId,
        newReleaseId,
        browser: { required: true }
    };
}

function writeJson(file, value, mode = 0o600)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readRecords(file)
{
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function assertOrdered(records, kinds)
{
    let offset = -1;
    for (const kind of kinds)
    {
        const next = records.findIndex((item, index) => index > offset && item.kind === kind);
        assert.ok(next > offset, `${kind} was not observed after index ${offset}`);
        offset = next;
    }
}

function onlyRunRoot(fixture)
{
    const base = path.join(fixture.root, '.tmp/rehearsal/fixture-zdt');
    const entries = fs.readdirSync(base);
    assert.equal(entries.length, 1);
    return path.join(base, entries[0]);
}

function readSummary(fixture, mode)
{
    const summary = readJson(path.join(onlyRunRoot(fixture), 'evidence/rehearsal-summary.json'));
    assert.equal(summary.modes[0].mode, mode);
    return summary;
}
