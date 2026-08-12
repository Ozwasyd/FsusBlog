#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runWeightedCommandManifest } from './run-command-manifest.mjs';
import {
    buildStaticGovernanceExecutionPlan,
    buildStaticGovernanceHostEvidence,
    buildStaticGovernanceTestCatalog,
    collectExecutedStaticGovernanceTestIds,
    loadStaticGovernanceRegistry
} from './static-governance-host.mjs';
import { sourceIdentity } from './test-asset-audit/preflight.mjs';

const { loadCanonicalInventory } = await import(new URL('../test-inventory/api.mjs', import.meta.url));

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const node = process.env.FSUSBLOG_NODE || process.execPath;
const registryFile = path.join(root, 'tests/governance/test-lifecycle-registry.json');
const reporterFile = path.join(root, 'tools/test/static-governance-reporter.mjs');
const registry = loadStaticGovernanceRegistry(registryFile, root);
const plan = buildStaticGovernanceExecutionPlan(registry);
const testCatalog = buildStaticGovernanceTestCatalog(
    root,
    registry,
    loadCanonicalInventory(root, { requireArtifact: true, runAdapters: false })
);
const governanceRoot = path.resolve(process.env.FSUSBLOG_TEST_GOVERNANCE_DIR || path.join(root, '.tmp/test-governance'));

const historicalDurationMs = new Map([
    ['gateway-switch.test.mjs', 36_000],
    ['deployment-slots.test.mjs', 32_000],
    ['security-source-analyzer.test.mjs', 12_000],
    ['release-traffic-probe-session.test.mjs', 8_000],
    ['release-rollout-probes.test.mjs', 4_000],
    ['release-rollout-evidence.test.mjs', 3_000]
]);

function hostCommand(host)
{
    const shared = ['pure-file-validation', 'isolated-temporary-repository-fixture'].includes(host.category);
    const options = shared ? ['--test-isolation=none', '--test-concurrency=1'] : [];
    return [node, '--test', `--test-reporter=${reporterFile}`, ...options, ...host.checks.map((check) => path.join(root, check.file))];
}

const planFile = path.join(governanceRoot, 'suite-plan.json');
fs.mkdirSync(path.dirname(planFile), { recursive: true });
fs.writeFileSync(planFile, `${JSON.stringify({
    ...plan,
    source: sourceIdentity(root),
    registry: path.relative(root, registryFile).split(path.sep).join('/')
}, null, 2)}\n`);

const hostResultDirectory = path.join(governanceRoot, 'host-results');
fs.rmSync(hostResultDirectory, { recursive: true, force: true });
fs.mkdirSync(hostResultDirectory, { recursive: true });
const hostResultFiles = plan.hosts.map((_, index) => path.join(hostResultDirectory, `${index}.json`));
const hostCommands = plan.hosts.map((host, index) => ({
    id: host.id,
    access: 'read',
    command: hostCommand(host),
    environment: {
        ...(host.checks[0]?.environment ?? {}),
        FSUSBLOG_STATIC_GOVERNANCE_HOST_RESULT: hostResultFiles[index]
    },
    ...(host.exclusive ? { concurrencyWeight: Number.MAX_SAFE_INTEGER } : {}),
    estimatedDurationMs: host.checks.reduce(
        (sum, check) => sum + (historicalDurationMs.get(path.basename(check.file)) ?? 1_000),
        0
    )
}));
const environment = { ...process.env };
delete environment.FSUSBLOG_COMMAND_MANIFEST_WORKERS;
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
{
    process.once(signal, () => controller.abort(new Error(`static governance host cancelled by ${signal}`)));
}
const startedAt = process.hrtime.bigint();
const cpuStarted = process.cpuUsage();
await runWeightedCommandManifest({
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'static-governance-node-contracts',
    commands: hostCommands
}, {
    cwd: root,
    env: environment,
    orchestrationWorkersPerCpu: 1,
    orchestrationMemoryGiBPerWorker: process.memoryUsage().rss / 1024 ** 3,
    signal: controller.signal,
    evidenceFile: path.join(governanceRoot, 'live-grant.json')
});
const elapsed = process.hrtime.bigint() - startedAt;
const cpu = process.cpuUsage(cpuStarted);
const executedTestIds = collectExecutedStaticGovernanceTestIds(
    root,
    testCatalog,
    hostResultFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
);
const evidence = buildStaticGovernanceHostEvidence({
    registry,
    plan,
    executedCheckIds: registry.checks.map((check) => check.id),
    testCatalog,
    executedTestIds,
    source: sourceIdentity(root),
    runId: process.env.FSUSBLOG_TEST_RUN_ID ?? 'direct',
    metrics: {
        wallTimeMs: Number(elapsed / 1_000_000n),
        cpuSeconds: (cpu.user + cpu.system) / 1_000_000,
        fileReadBytes: registry.checks.reduce(
            (sum, check) => sum + fs.statSync(path.join(root, check.file)).size,
            fs.statSync(registryFile).size
        )
    }
});
const evidenceFile = path.join(governanceRoot, 'host-evidence.json');
fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
