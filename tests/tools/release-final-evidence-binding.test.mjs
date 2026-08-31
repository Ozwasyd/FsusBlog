import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildReleaseFinalizerSpawnDecision } from '../../tools/test-matrix/release-final-static-boundary.mjs';

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

test('nonaccepted seals and nonexistent evidence fail before any checker child spawn', async (context) =>
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
        const checkerNode = path.join(bin, 'checker-node');
        writeFileSync(
            checkerNode,
            '#!/usr/bin/env bash\nprintf \'%s\\n\' "checker-node:$*" >> "$FSUSBLOG_SPAWN_LOG"\nexit 97\n'
        );
        chmodSync(checkerNode, 0o755);
        const baseEnvironment = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FSUSBLOG_SPAWN_LOG: log,
            FSUSBLOG_NODE: checkerNode
        };
        const finalizerRoot = path.join(fixture, 'finalizer-root');
        mkdirSync(path.join(finalizerRoot, 'tools/test/lanes'), { recursive: true });
        copyFileSync(
            path.join(root, 'tools/test/lanes/release-final.sh'),
            path.join(finalizerRoot, 'tools/test/lanes/release-final.sh')
        );
        const contextFile = path.join(fixture, 'context.json');
        const manifestFile = path.join(fixture, 'manifest.json');
        const domainFile = path.join(fixture, 'domain.json');
        for (const file of [contextFile, manifestFile, domainFile])
        {
            writeFileSync(file, '{}\n');
        }
        const execute = (environment) => spawnSync('tools/test/lanes/release-final.sh', [], {
            cwd: finalizerRoot,
            detached: process.platform !== 'win32',
            encoding: 'utf8',
            env: { ...baseEnvironment, ...environment }
        });
        for (const sealState of ['missing', 'failed', 'stale'])
        {
            await context.test(sealState, () =>
            {
                const decision = buildReleaseFinalizerSpawnDecision({ sealState });
                const result = execute({
                    FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION: decision.shellToken,
                    FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextFile,
                    FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: manifestFile,
                    FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: domainFile
                });
                assert.notEqual(result.status, 0);
                assert.match(`${result.stdout}\n${result.stderr}`, /release-final seal rejected/u);
                assert.equal(readFileSync(log, 'utf8'), '', `${sealState} must keep child spawn count at zero`);
            });
        }
        const accepted = buildReleaseFinalizerSpawnDecision({ sealState: 'accepted' });
        for (const [name, missingPath] of [
            ['context', contextFile],
            ['manifest', manifestFile],
            ['domain', domainFile]
        ])
        {
            await context.test(`nonexistent ${name}`, () =>
            {
                const paths = {
                    FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextFile,
                    FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: manifestFile,
                    FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: domainFile
                };
                paths[
                    name === 'context'
                        ? 'FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT'
                        : name === 'manifest'
                            ? 'FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH'
                            : 'FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH'
                ] = `${missingPath}.missing`;
                const result = execute({
                    FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION: accepted.shellToken,
                    ...paths
                });
                assert.notEqual(result.status, 0);
                assert.match(`${result.stdout}\n${result.stderr}`, /requires existing non-empty context and evidence files/u);
                assert.equal(readFileSync(log, 'utf8'), '', `${name} absence must keep child spawn count at zero`);
            });
        }
    }
    finally
    {
        rmSync(fixture, { recursive: true, force: true });
    }
});
