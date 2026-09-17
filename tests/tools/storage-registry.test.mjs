import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('storage registry static gate accepts the registered production inventory', async () =>
{
    const { stdout } = await execFileAsync(process.execPath, [
        'tests/frontend/checks/static/check-storage-registry.mjs'
    ], { cwd: repoRoot });
    assert.match(stdout, /storage registry owns \d+ persisted keys/u);
    assert.match(stdout, /dynamic\/cache\/runtime boundaries/u);
});
