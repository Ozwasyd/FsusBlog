import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const executable = path.join(root, 'tools/test/run-with-dotnet-release-build-lock.sh');

function waitForOutput(child, marker)
{
    return new Promise((resolve, reject) =>
    {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${marker}: ${output}`)), 5_000);
        child.stdout.on('data', (chunk) =>
        {
            output += chunk;
            if (!output.includes(marker))
            {
                return;
            }
            clearTimeout(timeout);
            resolve(output);
        });
        child.once('error', reject);
    });
}

test('Release writer lock serializes competing writers', async (t) =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-release-lock-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(directory, 'build') };
    const first = spawn(executable, ['bash', '-c', 'printf acquired; sleep 1'], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForOutput(first, 'acquired');

    const startedAt = Date.now();
    const second = spawnSync(executable, ['true'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.ok(Date.now() - startedAt >= 700, 'competing writer bypassed the Release build lock');
});

test('Release writer lock is not inherited by a detached descendant', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-release-lock-'));
    const env = { ...process.env, FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(directory, 'build') };
    try
    {
        const first = spawnSync(executable, ['bash', '-c', 'sleep 2 >/dev/null 2>&1 &'], {
            cwd: root,
            env,
            encoding: 'utf8'
        });
        assert.equal(first.status, 0, first.stderr || first.stdout);

        const startedAt = Date.now();
        const second = spawnSync(executable, ['true'], { cwd: root, env, encoding: 'utf8' });
        assert.equal(second.status, 0, second.stderr || second.stdout);
        assert.ok(Date.now() - startedAt < 1_000, 'detached child retained the Release build lock');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
