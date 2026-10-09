#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const checkerPath = path.join(repoRoot, 'tests/frontend/checks/static/check-fsusui-boundary.mjs');
const fixtureRoot = path.join(repoRoot, 'tests/frontend/fixtures/fsusui-boundary-violation');

const result = spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
        ...process.env,
        FSUSBLOG_FSUSUI_BOUNDARY_ROOT: fixtureRoot
    }
});

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

function fail(message)
{
    console.error(`[fsusui-boundary-fixture] ${message}`);
    console.error(output.trim());
    process.exit(1);
}

if (result.status === 0)
{
    fail('expected fixture violation to fail the boundary checker');
}

for (const token of [
    'src/frontend/src/components/BoundaryViolation.ts',
    'programmatic-api',
    'deep-import',
    'internal-selector',
    'misleading-local-fsusui-component',
    'runtime-import-outside-boundary'
])
{
    if (!output.includes(token))
    {
        fail(`expected checker output to include ${token}`);
    }
}

console.log('[fsusui-boundary-fixture] ok');

const mutations = spawnSync(process.execPath, ['--test', path.join(repoRoot, 'tests/tools/control-legality.test.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env
});
console.log(mutations.stdout ?? '');
if (mutations.status !== 0)
{
    console.error(mutations.stderr ?? '');
    process.exit(mutations.status ?? 1);
}
