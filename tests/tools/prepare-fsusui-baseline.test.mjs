import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(root, 'tools/test/prepare-fsusui-baseline.mjs');

test('FsusUI preparation keeps install scripts disabled and explicitly builds every consumed output', () =>
{
    const fsusUiRoot = '/tmp/fsusui-pinned-baseline';
    const result = spawnSync(process.execPath, [
        script,
        '--print-commands',
        '--root',
        fsusUiRoot
    ], {
        cwd: root,
        encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
        [
            'corepack',
            'pnpm',
            '--dir',
            fsusUiRoot,
            'install',
            '--frozen-lockfile',
            '--ignore-scripts'
        ],
        ['corepack', 'pnpm', '--dir', fsusUiRoot, 'run', 'stub'],
        ['corepack', 'pnpm', '--dir', fsusUiRoot, 'run', 'ensure:wasm'],
        ['corepack', 'pnpm', '--dir', fsusUiRoot, 'run', 'build:theme']
    ]);
});
