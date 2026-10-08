#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveLocalFsusUiRepositoryRoot } = await import(
    new URL('../../../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontend = path.join(root, 'src/frontend');
const ui = resolveLocalFsusUiRepositoryRoot({ override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT, repositoryRoot: root });
if (!ui)
{
    throw new Error('An actual local FsusUI source checkout is required.');
}

function git(repository, ...args)
{
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

const outputRoot = path.join(root, '.tmp/block-anchor-public-boundary');
mkdirSync(outputRoot, { recursive: true });
const run = mkdtempSync(path.join(outputRoot, 'run-'));
const configPath = path.join(run, 'vitest.config.mjs');
const basePath = path.join(frontend, 'vitest.config.ts');
const testPath = path.join(root, 'tests/frontend/checks/runtime/article-block-anchor-public-boundary.test.ts');
writeFileSync(configPath, `import base from ${JSON.stringify(basePath)};\nexport default { ...base, test: { ...base.test, setupFiles: [], include: [${JSON.stringify(testPath)}] } };\n`);
const resultsPath = path.join(run, 'vitest.json');
const args = ['run', '--config', configPath, '--reporter=verbose', '--reporter=json', `--outputFile.json=${resultsPath}`];
const result = spawnSync(path.join(frontend, 'node_modules/.bin/vitest'), args, {
    cwd: frontend,
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_USE_LOCAL_FSUSUI: '1', FSUSBLOG_LOCAL_FSUSUI_ROOT: ui }
});
writeFileSync(path.join(run, 'runtime.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const baseline = JSON.parse(readFileSync(path.join(root, 'config/testing/fsusui-baseline.json'), 'utf8'));
const uiCommit = git(ui, 'rev-parse', 'HEAD');
writeFileSync(path.join(run, 'probe.json'), `${JSON.stringify({
    schema: 'fsusblog.block-anchor-public-boundary-probe.v1',
    candidateCommit: git(root, 'rev-parse', 'HEAD'),
    candidateStatus: git(root, 'status', '--porcelain'),
    fsusUiCommit: uiCommit,
    fsusUiStatus: git(ui, 'status', '--porcelain'),
    baselineCommit: baseline.commit,
    baselineMatches: baseline.commit === uiCommit,
    command: args,
    exitCode: result.status,
    spawnError: result.error?.message ?? null,
    issueAcceptance: false,
    sourceDigests: { test: digest(testPath), runner: digest(fileURLToPath(import.meta.url)), config: digest(configPath), aliases: digest(path.join(frontend, 'scripts/fsusui-local.ts')) },
    logDigest: digest(path.join(run, 'runtime.log'))
}, null, 4)}\n`);
console.log(`Block-anchor public boundary: exit=${result.status}; baselineMatches=${baseline.commit === uiCommit}; evidence=${run}`);
process.exitCode = result.status ?? 1;
