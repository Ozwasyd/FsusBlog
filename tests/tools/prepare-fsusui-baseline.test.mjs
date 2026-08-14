import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fsusUiPreparationCommands
} from '../../tools/test/prepare-fsusui-baseline.mjs';

test('FsusUI preparation keeps install scripts disabled and explicitly builds producer stubs before theme output', () =>
{
    const root = '/tmp/fsusui-pinned-baseline';
    assert.deepEqual(fsusUiPreparationCommands(root), [
        [
            'corepack',
            'pnpm',
            '--dir',
            root,
            'install',
            '--frozen-lockfile',
            '--ignore-scripts'
        ],
        ['corepack', 'pnpm', '--dir', root, 'run', 'stub'],
        ['corepack', 'pnpm', '--dir', root, 'run', 'build:theme']
    ]);
});
