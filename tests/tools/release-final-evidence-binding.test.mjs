import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);

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

test('missing evidence reports producer commands without spawning a fallback', () =>
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
        const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
        const finalizerRoot = path.join(fixture, 'finalizer-root');
        for (const directory of [
            'tools/test/lanes',
            'tools/ci',
            'tools/release',
            '.tmp/release-evidence'
        ])
        {
            mkdirSync(path.join(finalizerRoot, directory), { recursive: true });
        }
        copyFileSync(
            path.join(root, 'tools/test/lanes/release-final.sh'),
            path.join(finalizerRoot, 'tools/test/lanes/release-final.sh')
        );
        copyFileSync(
            path.join(root, 'tools/ci/check-job-summaries.mjs'),
            path.join(finalizerRoot, 'tools/ci/check-job-summaries.mjs')
        );
        const governanceStub = path.join(finalizerRoot, 'tools/test/run-matrix-governance-once.sh');
        writeFileSync(governanceStub, '#!/usr/bin/env bash\nexit 0\n');
        chmodSync(governanceStub, 0o755);
        writeFileSync(
            path.join(finalizerRoot, 'tools/release/test-evidence-receipts-cli.mjs'),
            'process.exit(0);\n'
        );
        writeFileSync(
            path.join(finalizerRoot, '.tmp/release-evidence/test-plan.json'),
            `${JSON.stringify({
                schema: 'fsusblog.release-evidence.test-plan.v1',
                tiers: matrix.tiers
            }, null, 2)}\n`
        );

        const result = spawnSync('tools/test/lanes/release-final.sh', [], {
            cwd: finalizerRoot,
            detached: process.platform !== 'win32',
            encoding: 'utf8',
            env: environment
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.notEqual(result.status, 0, 'missing evidence must fail closed rather than report success');
        assert.match(output, /missing job summary for required evidence tier: coverage-gate-strict/u);
        assert.match(
            output,
            /\.\/tools\/test\.sh ci-tier coverage-gate-strict/u,
            'missing evidence diagnostics must name the producer command'
        );
        assert.equal(readFileSync(log, 'utf8'), '', 'missing evidence must not execute a blocked producer command');
    }
    finally
    {
        rmSync(fixture, { recursive: true, force: true });
    }
});
