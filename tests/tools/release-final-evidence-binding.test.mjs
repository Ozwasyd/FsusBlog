import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('release-final script files do not contain recursive test or build producer invocations', () =>
{
    const files = [
        path.join(root, 'tools/test/lanes/release-final.sh'),
        path.join(root, 'tools/release/check-release-final.mjs')
    ];
    const forbiddenPattern = /dotnet test|vitest|playwright|bootstrap-acceptance|load-|soak|mutation|npm.*build/u;

    for (const file of files)
    {
        const content = readFileSync(file, 'utf8');
        assert.equal(
            forbiddenPattern.test(content),
            false,
            `${file} must not contain recursive test or build producer execution`
        );
    }
});

test('missing explicit bindings fail before finalizer or fallback spawn', () =>
{
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-final-evidence-'));
    const bin = path.join(fixture, 'bin');
    const log = path.join(fixture, 'spawn.log');
    const forbidden = [
        'dotnet', 'npm', 'pnpm', 'yarn', 'vitest', 'playwright', 'bootstrap-acceptance',
        'docker', 'postgres', 'postgresql', 'redis-server', 'backend', 'frontend',
        'load', 'soak', 'scale', 'benchmark', 'mutation', 'fuzz'
    ];
    try
    {
        mkdirSync(bin);
        writeFileSync(log, '');
        for (const name of forbidden)
        {
            const command = path.join(bin, name);
            writeFileSync(command, `#!/usr/bin/env bash\nprintf '%s\\n' "${name}:$*" >> "$FSUSBLOG_SPAWN_LOG"\nexit 97\n`);
            chmodSync(command, 0o755);
        }
        const environment = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FSUSBLOG_SPAWN_LOG: log,
            FSUSBLOG_NODE: process.execPath
        };
        const finalizerRoot = path.join(fixture, 'finalizer-root');
        mkdirSync(path.join(finalizerRoot, 'tools/test/lanes'), { recursive: true });
        copyFileSync(
            path.join(root, 'tools/test/lanes/release-final.sh'),
            path.join(finalizerRoot, 'tools/test/lanes/release-final.sh')
        );

        const result = spawnSync('tools/test/lanes/release-final.sh', [], {
            cwd: finalizerRoot,
            detached: process.platform !== 'win32',
            encoding: 'utf8',
            env: environment
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.notEqual(result.status, 0, 'missing evidence must fail closed rather than report success');
        assert.match(output, /requires explicit current-run context, manifest binding, and domain binding/u);
        assert.equal(readFileSync(log, 'utf8'), '', 'missing evidence must not execute a blocked producer command');
    }
    finally
    {
        rmSync(fixture, { recursive: true, force: true });
    }
});
