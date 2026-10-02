#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { behaviorDocNugetClosure, inventoryPreparedNuget, validatePreparedNugetPackages } from '../test/behavior-doc-nuget-preparation.mjs';
import { observeExecutableIdentity, verifyExecutableIdentity } from '../test/execution-envelope-environment.mjs';
import { fingerprintPaths, runBoundExecution, validateRunBoundProjection } from '../test/run-once.mjs';
import { sealSourceIdentity } from '../fact-extractors/identity.mjs';

/** Independent dependency transfer only; this does not generate admission or correctness facts. */
export async function prepareBehaviorDocNuget({ repositoryRoot, runId, outputFile })
{
    if (!String(runId ?? '').trim()) throw new Error('NuGet preparation requires an explicit scheduler run');
    const source = sealSourceIdentity(repositoryRoot);
    const closure = behaviorDocNugetClosure(repositoryRoot);
    const preparationParent = path.join(repositoryRoot, '.tmp/behavior-doc-nuget-preparation');
    const output = path.resolve(outputFile);
    if (!output.startsWith(path.resolve(preparationParent) + path.sep))
    {
        throw new Error('NuGet preparation descriptor must stay inside its preparation owner');
    }
    fs.mkdirSync(preparationParent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(preparationParent) !== path.resolve(preparationParent))
    {
        throw new Error('NuGet preparation parent must be canonical');
    }
    const attemptRoot = fs.mkdtempSync(path.join(preparationParent, 'transfer-'));
    const packagesRoot = path.join(attemptRoot, 'packages');
    const artifactsRoot = path.join(attemptRoot, 'artifacts');
    const home = path.join(attemptRoot, 'home');
    const temp = path.join(attemptRoot, 'tmp');
    for (const directory of [packagesRoot, artifactsRoot, home, temp])
    {
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    const toolchain = observeExecutableIdentity('dotnet', { pathValue: process.env.PATH });
    const command = ['dotnet', 'restore', 'tools/contracts/BehaviorDocRestore.slnx',
        '--locked-mode', '--packages', packagesRoot, '--artifacts-path', artifactsRoot,
        '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel'];
    const physicalRoot = path.join(repositoryRoot, '.tmp/physical-executions');
    const key = 'behavior-doc-nuget-transfer-' + randomUUID();
    const inputDigest = await fingerprintPaths(
        [...closure.sourceClosureDigests.map((value) => value.path),
            'tools/contracts/BehaviorDocRestore.slnx', 'tools/docs/prepare-behavior-doc-nuget.mjs',
            'tools/test/behavior-doc-nuget-preparation.mjs'],
        { root: repositoryRoot, values: [JSON.stringify(source), JSON.stringify(command), JSON.stringify(toolchain)] }
    );
    const environment = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp,
        TEMP: temp, DOTNET_CLI_HOME: home, NUGET_PACKAGES: packagesRoot,
        DOTNET_NOLOGO: 'true', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: 'true', MSBUILDDISABLENODEREUSE: '1' };
    const outputContract = [artifactsRoot, packagesRoot].sort();
    const result = await runBoundExecution({
        root: physicalRoot, runId, key, command, cwd: repositoryRoot, inputDigest,
        environmentDigest: createHash('sha256').update(JSON.stringify(environment)).digest('hex'),
        outputContract, requiredOutputs: outputContract,
        commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint,
        consumerId: 'behavior-doc-nuget-transfer'
    }, async () =>
    {
        const startedAt = new Date().toISOString();
        const restored = spawnSync(toolchain.absolutePath, command.slice(1), {
            cwd: repositoryRoot, env: environment, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024
        });
        const physicalExecution = { phase: 'independent-dependency-transfer', qualificationEligible: false,
            command, toolchain, startedAt, completedAt: new Date().toISOString(),
            stdout: String(restored.stdout ?? ''), stderr: String(restored.stderr ?? ''),
            exitCode: restored.status, signal: restored.signal };
        if (restored.error || restored.status !== 0 || restored.signal)
        {
            const error = restored.error ?? new Error('Independent NuGet transfer failed');
            error.exitCode = restored.status;
            error.signal = restored.signal;
            error.physicalExecution = physicalExecution;
            throw error;
        }
        verifyExecutableIdentity(toolchain, observeExecutableIdentity('dotnet', { pathValue: process.env.PATH }));
        if (JSON.stringify(sealSourceIdentity(repositoryRoot)) !== JSON.stringify(source))
        {
            throw new Error('Source drifted during independent NuGet transfer');
        }
        const sealTree = (directory) =>
        {
            for (const name of fs.readdirSync(directory))
            {
                const file = path.join(directory, name);
                const stat = fs.lstatSync(file);
                if (stat.isDirectory() && !stat.isSymbolicLink()) sealTree(file);
                else if (stat.isFile() && stat.nlink === 1) fs.chmodSync(file, stat.mode & 0o555);
                else throw new Error('NuGet transfer produced linked or nonregular payload');
            }
            fs.chmodSync(directory, 0o555);
        };
        sealTree(packagesRoot);
        validatePreparedNugetPackages(inventoryPreparedNuget(packagesRoot), closure);
        return physicalExecution;
    });
    const transfer = { root: physicalRoot, runId, key, consumerId: 'behavior-doc-nuget-transfer',
        projectionFile: result.projectionFile, receiptFile: result.receiptFile };
    const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
    const seed = inventoryPreparedNuget(packagesRoot);
    const preparation = { source, closure, root: packagesRoot, artifactsRoot,
        treeDigest: seed.treeDigest, transfer: { ...transfer, receiptDigest: verified.receipt.receiptDigest } };
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    if (fs.realpathSync(path.dirname(output)) !== path.dirname(output))
    {
        throw new Error('NuGet preparation descriptor parent is not canonical');
    }
    fs.writeFileSync(output, JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
    return preparation;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--run-id' || args[2] !== '--out')
    {
        throw new Error('Usage: prepare-behavior-doc-nuget.mjs --run-id id --out .tmp/behavior-doc-nuget-preparation/input.json');
    }
    await prepareBehaviorDocNuget({ repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
        runId: args[1], outputFile: args[3] });
}
