#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveLocalFsusUiRepositoryRoot } = await import(
    new URL('../../../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
);
const { readFsusUiBaseline } = await import(
    new URL('../../../../tools/test/fsusui-baseline.mjs', import.meta.url)
);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontendRoot = path.join(repositoryRoot, 'src/frontend');
const exploratory = process.argv.length === 3 && process.argv[2] === '--exploratory';
if (process.argv.length > 2 && !exploratory)
{
    throw new Error('usage: probe-article-anchor-boundary.mjs [--exploratory]');
}

function git(root, args)
{
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

const fsusUiRoot = resolveLocalFsusUiRepositoryRoot({
    override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
    repositoryRoot
});
if (!fsusUiRoot)
{
    throw new Error('local FsusUI checkout required; set FSUSBLOG_LOCAL_FSUSUI_ROOT');
}
const baseline = readFsusUiBaseline();
const actualFsusUiCommit = git(fsusUiRoot, ['rev-parse', 'HEAD']);
if (git(fsusUiRoot, ['status', '--porcelain']) !== '')
{
    throw new Error('FsusUI probe requires a clean source checkout');
}
if (!exploratory && actualFsusUiCommit !== baseline.commit)
{
    throw new Error(`FsusUI baseline mismatch: expected ${baseline.commit}, got ${actualFsusUiCommit}; --exploratory cannot qualify acceptance`);
}

const outputRoot = path.join(repositoryRoot, '.tmp/article-anchor-boundary');
mkdirSync(outputRoot, { recursive: true });
const runRoot = mkdtempSync(path.join(outputRoot, 'run-'));
const configRoot = path.join(frontendRoot, 'node_modules/.tmp');
mkdirSync(configRoot, { recursive: true });
const configPath = path.join(configRoot, `${path.basename(runRoot)}.article-anchor.config.mjs`);
const testPath = path.join(repositoryRoot, 'tests/frontend/checks/runtime/article-anchor-boundary.test.ts');
writeFileSync(configPath, [
    "import base from '../../vitest.config.ts';",
    `export default { ...base, test: { ...base.test, setupFiles: [], include: [${JSON.stringify(testPath)}] } };`,
    ''
].join('\n'));

const resultsPath = path.join(runRoot, 'vitest.json');
const logPath = path.join(runRoot, 'runtime.log');
const log = openSync(logPath, 'wx');
const command = [
    'run', '--config', configPath, '--reporter=verbose', '--reporter=json',
    `--outputFile.json=${resultsPath}`
];
const startedAt = new Date().toISOString();
const result = spawnSync(path.join(frontendRoot, 'node_modules/.bin/vitest'), command, {
    cwd: frontendRoot,
    env: {
        ...process.env,
        FSUSBLOG_USE_LOCAL_FSUSUI: '1',
        FSUSBLOG_LOCAL_FSUSUI_ROOT: fsusUiRoot
    },
    stdio: ['ignore', log, log]
});
closeSync(log);
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const report = {
    schema: 'fsusblog.article-anchor-boundary-probe.v1',
    runId: path.basename(runRoot),
    startedAt,
    completedAt: new Date().toISOString(),
    candidateCommit: git(repositoryRoot, ['rev-parse', 'HEAD']),
    candidateStatus: git(repositoryRoot, ['status', '--porcelain']),
    expectedFsusUiCommit: baseline.commit,
    actualFsusUiCommit,
    exploratory,
    nodeVersion: process.version,
    command,
    exitCode: result.status,
    spawnError: result.error?.message ?? null,
    // A passing public-API probe is only one prerequisite, never #2246 acceptance.
    status: result.status === 0 ? 'boundary-probe-passed' : 'boundary-probe-blocked',
    issueAcceptance: false,
    inputDigests: {
        runner: digest(fileURLToPath(import.meta.url)),
        test: digest(testPath),
        config: digest(configPath),
        baseConfig: digest(path.join(frontendRoot, 'vitest.config.ts')),
        aliases: digest(path.join(frontendRoot, 'scripts/fsusui-local.ts')),
        baseline: digest(path.join(repositoryRoot, 'config/testing/fsusui-baseline.json'))
    },
    artifacts: {
        logPath,
        logDigest: digest(logPath),
        resultsPath,
        resultsDigest: existsSync(resultsPath) ? digest(resultsPath) : null
    }
};
const reportPath = path.join(runRoot, 'probe.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 4)}\n`);
console.log(`Article anchor boundary: ${report.status}; exploratory=${exploratory}; evidence=${reportPath}`);
process.exitCode = result.status ?? 1;
