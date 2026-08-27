#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), '../..');
const policyPath = resolve(rootDir, 'config/testing/mutation/stryker-tool.v1.json');

function fail(message)
{
    throw new Error(`Stryker tool bootstrap failed: ${message}`);
}

function run(command, args, options = {})
{
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? rootDir,
        env: options.env ?? process.env,
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit'
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
    {
        if (options.capture)
            process.stderr.write(result.stderr ?? '');
        fail(`${command} exited with status ${result.status}`);
    }
    return options.capture ? (result.stdout ?? '').trim() : '';
}

function sha256(content)
{
    return createHash('sha256').update(content).digest('hex');
}

export function validateStrykerToolPolicy(policy, manifest, patch, expressionTreePatch = null)
{
    if (policy?.schema !== 'fsusblog.stryker-tool.v1')
        fail('unsupported policy schema');
    if (!/^[0-9a-f]{40}$/u.test(policy.upstreamCommit ?? ''))
        fail('upstream commit must be a full lowercase SHA');
    const expectedArchive = `https://github.com/stryker-mutator/stryker-net/archive/${policy.upstreamCommit}.tar.gz`;
    if (policy.upstreamArchive !== expectedArchive)
        fail('upstream archive is not the reviewed official source');
    if (!/^[0-9a-f]{64}$/u.test(policy.upstreamArchiveSha256 ?? ''))
        fail('upstream archive digest is invalid');
    if (policy.upstreamVersion !== '4.14.2')
        fail('upstream version is not the reviewed release');
    if (policy.packageVersion !== '4.14.2-fsusblog.2')
        fail('package version is not the reviewed repository producer');
    const manifestTool = manifest?.tools?.['dotnet-stryker'];
    if (!manifest?.isRoot || manifestTool?.version !== policy.upstreamVersion
        || manifestTool?.rollForward !== false)
    {
        fail('tool manifest does not pin the reviewed upstream release');
    }
    if (sha256(patch) !== policy.patchSha256)
        fail('candidate-validity patch digest does not match policy');
    const resolvedExpressionTreePatch = expressionTreePatch ?? readFileSync(
        resolve(rootDir, policy.expressionTreePatchPath)
    );
    if (sha256(resolvedExpressionTreePatch) !== policy.expressionTreePatchSha256)
        fail('expression-tree patch digest does not match policy');
    return policy;
}

function readPolicy()
{
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const manifestPath = resolve(rootDir, policy.toolManifestPath);
    const patchPath = resolve(rootDir, policy.patchPath);
    const expressionTreePatchPath = resolve(rootDir, policy.expressionTreePatchPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const patch = readFileSync(patchPath);
    const expressionTreePatch = readFileSync(expressionTreePatchPath);
    validateStrykerToolPolicy(policy, manifest, patch, expressionTreePatch);
    return { policy, patch, patchPath, expressionTreePatch, expressionTreePatchPath };
}

function ensureArchive(policy)
{
    const archivePath = resolve(rootDir, `.tmp/tools/downloads/stryker-net-${policy.upstreamCommit}.tar.gz`);
    mkdirSync(dirname(archivePath), { recursive: true });
    if (!existsSync(archivePath))
        run('curl', ['--fail', '--location', '--silent', '--show-error', policy.upstreamArchive, '--output', archivePath]);
    if (sha256(readFileSync(archivePath)) !== policy.upstreamArchiveSha256)
        fail('downloaded upstream archive digest does not match policy');
    return archivePath;
}

function buildTool()
{
    const { policy, patch, patchPath, expressionTreePatch, expressionTreePatchPath } = readPolicy();
    const archivePath = ensureArchive(policy);
    const cacheKey = sha256(Buffer.concat([
        Buffer.from('fsusblog-stryker-bootstrap-v4'),
        Buffer.from(policy.upstreamCommit),
        Buffer.from(policy.packageVersion),
        patch,
        expressionTreePatch
    ])).slice(0, 24);
    const cacheDir = resolve(rootDir, '.tmp/tools/stryker', cacheKey);
    const executable = resolve(
        cacheDir,
        `bin/.store/dotnet-stryker/${policy.packageVersion}/dotnet-stryker/`,
        `${policy.packageVersion}/tools/net8.0/any/Stryker.CLI.dll`
    );
    const markerPath = resolve(cacheDir, 'ready.json');
    if (existsSync(executable) && existsSync(markerPath))
        return executable;

    const stagingDir = `${cacheDir}.staging-${process.pid}`;
    rmSync(stagingDir, { force: true, recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    const stagedSource = resolve(stagingDir, 'source');
    mkdirSync(stagedSource, { recursive: true });
    run('tar', ['--extract', '--gzip', '--file', archivePath, '--directory', stagedSource, '--strip-components=1']);
    run('patch', [
        '--batch', '--dry-run', '--forward', '--strip=1',
        '--directory', stagedSource, '--input', patchPath
    ]);
    run('patch', [
        '--batch', '--forward', '--strip=1',
        '--directory', stagedSource, '--input', patchPath
    ]);
    run('patch', [
        '--batch', '--dry-run', '--forward', '--strip=1',
        '--directory', stagedSource, '--input', expressionTreePatchPath
    ]);
    run('patch', [
        '--batch', '--forward', '--strip=1',
        '--directory', stagedSource, '--input', expressionTreePatchPath
    ]);

    const focusedTestOutput = run('dotnet', [
        'test',
        policy.focusedTestProject,
        '--configuration', 'Release',
        '--filter', policy.focusedTestFilter
    ], {
        capture: true,
        cwd: stagedSource,
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' }
    });
    process.stdout.write(`${focusedTestOutput}\n`);
    if (!/Passed!\s+-\s+Failed:\s+0,\s+Passed:\s+11,/u.test(focusedTestOutput))
        fail('fork focused test run did not execute the expected eleven tests');
    const feedDir = resolve(stagingDir, 'feed');
    run('dotnet', [
        'pack',
        'src/Stryker.CLI/Stryker.CLI/Stryker.CLI.csproj',
        '--configuration', 'Release',
        `-p:Version=${policy.packageVersion}`,
        '--output', feedDir
    ], { cwd: stagedSource });
    const binDir = resolve(stagingDir, 'bin');
    run('dotnet', [
        'tool', 'install', 'dotnet-stryker',
        '--tool-path', binDir,
        '--source', feedDir,
        '--version', policy.packageVersion
    ]);
    const packagePath = resolve(feedDir, `dotnet-stryker.${policy.packageVersion}.nupkg`);
    writeFileSync(resolve(stagingDir, 'ready.json'), `${JSON.stringify({
        packageSha256: sha256(readFileSync(packagePath)),
        packageVersion: policy.packageVersion,
        patchSha256: policy.patchSha256,
        expressionTreePatchSha256: policy.expressionTreePatchSha256,
        upstreamCommit: policy.upstreamCommit
    }, null, 2)}\n`);
    mkdirSync(dirname(cacheDir), { recursive: true });
    rmSync(cacheDir, { force: true, recursive: true });
    renameSync(stagingDir, cacheDir);
    return executable;
}

function printUsage()
{
    process.stderr.write(
        'Usage: node tools/mutation/stryker-tool.mjs ensure\n'
        + '   or: node tools/mutation/stryker-tool.mjs run --working-directory <path> -- <args>\n'
    );
}

function main(args)
{
    const command = args.shift();
    if (command === 'ensure')
    {
        process.stdout.write(`${buildTool()}\n`);
        return;
    }
    if (command !== 'run')
    {
        printUsage();
        process.exitCode = 2;
        return;
    }
    const workingDirectoryFlag = args.shift();
    const workingDirectory = args.shift();
    const separator = args.shift();
    if (workingDirectoryFlag !== '--working-directory' || !workingDirectory || separator !== '--')
    {
        printUsage();
        process.exitCode = 2;
        return;
    }
    const executable = buildTool();
    const result = spawnSync('dotnet', [executable, ...args], {
        cwd: resolve(rootDir, workingDirectory),
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' },
        stdio: 'inherit'
    });
    if (result.error)
        throw result.error;
    process.exitCode = result.status ?? 1;
}

if (resolve(process.argv[1] ?? '') === scriptPath)
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
