#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    writeFileSync
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { createMinimalCorrectnessEnvironment, observeExecutableIdentity } =
    await import(new URL('../test/execution-envelope-environment.mjs', import.meta.url));

const { verifyMutationAttemptRoot } = await import(new URL('../test/release-mutation-attempt-root.mjs', import.meta.url));

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), '../..');
const policyPath = resolve(rootDir, 'config/testing/mutation/stryker-tool.v1.json');
let childEnvironment = null;
let boundHostExecutable = null;

function fail(message)
{
    throw new Error(`Stryker tool bootstrap failed: ${message}`);
}

function run(command, args, options = {})
{
    const resolvedCommand = command === 'dotnet' ? boundHostExecutable?.realPath : command;
    if (!resolvedCommand)
    {
        fail('dotnet host was not observed before bootstrap');
    }
    if (command === 'dotnet' && sha256(readFileSync(resolvedCommand)) !== boundHostExecutable.sha256.replace(/^sha256:/u, ''))
    {
        fail('dotnet host drifted before bootstrap step');
    }
    const result = spawnSync(resolvedCommand, args, {
        cwd: options.cwd ?? rootDir,
        env: options.env ?? childEnvironment,
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit'
    });
    if (command === 'dotnet' && sha256(readFileSync(resolvedCommand)) !== boundHostExecutable.sha256.replace(/^sha256:/u, ''))
    {
        fail('dotnet host drifted during bootstrap step');
    }
    if (result.error)
    {
        throw result.error;
    }
    if (result.status !== 0)
    {
        if (options.capture)
        {
            process.stderr.write(result.stderr ?? '');
        }
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
    {
        fail('unsupported policy schema');
    }
    if (!/^[0-9a-f]{40}$/u.test(policy.upstreamCommit ?? ''))
    {
        fail('upstream commit must be a full lowercase SHA');
    }
    const expectedArchive = `https://github.com/stryker-mutator/stryker-net/archive/${policy.upstreamCommit}.tar.gz`;
    if (policy.upstreamArchive !== expectedArchive)
    {
        fail('upstream archive is not the reviewed official source');
    }
    if (!/^[0-9a-f]{64}$/u.test(policy.upstreamArchiveSha256 ?? ''))
    {
        fail('upstream archive digest is invalid');
    }
    if (policy.upstreamVersion !== '4.14.2')
    {
        fail('upstream version is not the reviewed release');
    }
    if (policy.packageVersion !== '4.14.2-fsusblog.3')
    {
        fail('package version is not the reviewed repository producer');
    }
    const manifestTool = manifest?.tools?.['dotnet-stryker'];
    if (!manifest?.isRoot || manifestTool?.version !== policy.upstreamVersion
        || manifestTool?.rollForward !== false)
    {
        fail('tool manifest does not pin the reviewed upstream release');
    }
    if (sha256(patch) !== policy.patchSha256)
    {
        fail('candidate-validity patch digest does not match policy');
    }
    const resolvedExpressionTreePatch = expressionTreePatch ?? readFileSync(
        resolve(rootDir, policy.expressionTreePatchPath)
    );
    if (sha256(resolvedExpressionTreePatch) !== policy.expressionTreePatchSha256)
    {
        fail('expression-tree patch digest does not match policy');
    }
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
    if (!existsSync(archivePath))
    {
        fail('reviewed official archive must be provisioned before admitted execution; bootstrap never downloads');
    }
    if (sha256(readFileSync(archivePath)) !== policy.upstreamArchiveSha256)
    {
        fail('downloaded upstream archive digest does not match policy');
    }
    return archivePath;
}

export function requireStrykerExecutionIdentity(environment)
{
    const runId = environment.FSUSBLOG_TEST_RUN_ID;
    const commit = environment.FSUSBLOG_TEST_SOURCE_COMMIT;
    const worktreeFingerprint = environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT;
    if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(runId)
        || !/^[0-9a-f]{40}$/u.test(commit ?? '')
        || !/^[0-9a-f]{64}$/u.test(worktreeFingerprint ?? '')
        || !environment.TMPDIR)
    {
        fail('current scheduler identity and private execution scratch are required');
    }
    return { runId, sourceState: { commit, worktreeFingerprint } };
}

function artifactPath(root, path, { directory = false } = {})
{
    if (typeof path !== 'string' || isAbsolute(path))
    {
        fail('tool custody requires a repository-relative artifact');
    }
    const absolute = resolve(root, path);
    const local = relative(root, absolute);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
    {
        fail('tool custody artifact escapes its repository owner');
    }
    let current = root;
    for (const part of local.split(sep))
    {
        current = resolve(current, part);
        if (lstatSync(current).isSymbolicLink())
        {
            fail('tool custody artifact ancestor is a symlink');
        }
    }
    const stat = lstatSync(absolute);
    if (directory ? !stat.isDirectory() : !stat.isFile())
    {
        fail('tool custody artifact type differs from its owner');
    }
    return absolute;
}

function installedFileInventory(directory, repositoryRoot)
{
    const records = [];
    for (const name of readdirSync(directory).sort())
    {
        const file = resolve(directory, name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink())
        {
            fail('installed tool closure contains a symlink');
        }
        if (stat.isDirectory())
        {
            records.push(...installedFileInventory(file, repositoryRoot));
        }
        else if (stat.isFile())
        {
            records.push({ path: relative(repositoryRoot, file).split(sep).join('/'), sha256: sha256(readFileSync(file)) });
        }
        else
        {
            fail('installed tool closure contains a nonregular file');
        }
    }
    return records;
}

export function validateStrykerToolBinding(binding, { repositoryRoot = rootDir, sourceState, runId } = {})
{
    const { policy } = readPolicy();
    if (binding?.schema !== 'fsusblog.stryker-tool-binding.v1'
        || binding.packageVersion !== policy.packageVersion
        || binding.upstreamCommit !== policy.upstreamCommit
        || binding.policySha256 !== sha256(readFileSync(resolve(repositoryRoot, 'config/testing/mutation/stryker-tool.v1.json')))
        || binding.patchSha256 !== policy.patchSha256
        || binding.expressionTreePatchSha256 !== policy.expressionTreePatchSha256
        || JSON.stringify(binding.sourceState) !== JSON.stringify(sourceState)
        || (binding.runId !== runId && !String(runId).startsWith(`${binding.runId}:`)))
    {
        fail('current source/run/policy producer binding mismatch');
    }
    const custodyRoot = binding.mutationAttempt ? binding.mutationAttempt.root : repositoryRoot;
    if (binding.mutationAttempt)
    {
        verifyMutationAttemptRoot(binding.mutationAttempt, {
            runId: binding.runId, invocationId: binding.mutationAttempt.invocationId,
            attemptId: binding.mutationAttempt.attemptId, sourceState,
            buildReceiptDigest: binding.mutationAttempt.immutableBuild.contentDigest
        });
    }
    for (const field of ['package', 'executable'])
    {
        const artifact = binding[field];
        if (!/^[0-9a-f]{64}$/u.test(artifact?.sha256 ?? '')
            || sha256(readFileSync(artifactPath(custodyRoot, artifact.path))) !== artifact.sha256)
        {
            fail(`${field} custody digest mismatch`);
        }
    }
    if (!binding.installedRoot || !Array.isArray(binding.installedFiles)
        || JSON.stringify(installedFileInventory(artifactPath(custodyRoot, binding.installedRoot, { directory: true }), custodyRoot))
            !== JSON.stringify(binding.installedFiles))
    {
        fail('installed tool dependency closure differs from custody');
    }
    if (!binding.hostExecutable?.absolutePath || !binding.hostExecutable?.sha256
        || sha256(readFileSync(binding.hostExecutable.realPath ?? binding.hostExecutable.absolutePath))
            !== binding.hostExecutable.sha256.replace(/^sha256:/u, ''))
    {
        fail('actual dotnet host executable digest mismatch');
    }
    return binding;
}

function buildTool(outputPath, mutationAttempt = null)
{
    const identity = requireStrykerExecutionIdentity(process.env);
    const { policy, patchPath, expressionTreePatchPath } = readPolicy();
    const applicability = JSON.parse(readFileSync(resolve(rootDir, 'config/testing/test-execution-envelope-applicability.json')));
    const envelopePolicy = JSON.parse(readFileSync(resolve(rootDir, 'config/testing/test-execution-envelope-policy.json')));
    const mutationProducer = applicability.producers.find(entry => entry.producerId === 'backend-mutation');
    if (!mutationProducer)
    {
        fail('canonical mutation environment owner is missing');
    }
    const injectedEnvironment = { FSUSBLOG_MUTATION_BUILD: '1', DOTNET_ROLL_FORWARD: 'Major',
        ...(mutationAttempt ? { FSUSBLOG_PRODUCTION_BUILD_ROOT: mutationAttempt.paths.build,
            CustomAfterMicrosoftCommonTargets: mutationAttempt.sdkBoundary.path,
            DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' } : {}) };
    const custodyRoot = mutationAttempt?.root ?? rootDir;
    for (const name of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'NUGET_PACKAGES', 'DOTNET_CLI_HOME',
        'FSUSBLOG_TOOL_CACHE', 'FSUSBLOG_TEST_RUN_ID', 'FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT'])
    {
        if (process.env[name] !== undefined)
        {
            injectedEnvironment[name] = process.env[name];
        }
    }
    const minimal = createMinimalCorrectnessEnvironment({
        parentEnvironment: process.env,
        producerAllowlist: mutationProducer.allowedEnvironment,
        injectedEnvironment,
        policy: envelopePolicy
    });
    childEnvironment = minimal.childEnvironment;
    const archivePath = ensureArchive(policy);
    const privateScratch = resolve(process.env.TMPDIR);
    const scratchStat = lstatSync(privateScratch);
    if (scratchStat.isSymbolicLink() || !scratchStat.isDirectory()
        || (scratchStat.mode & 0o077) !== 0
        || (process.getuid && scratchStat.uid !== process.getuid()))
    {
        fail('execution scratch is not a current-user private directory');
    }
    // No ready.json or cross-run cache can substitute current execution/custody.
    // The admitted process tree owns resource enforcement and scratch cleanup.
    const artifactDirectory = resolve(dirname(outputPath), 'tool-custody');
    mkdirSync(artifactDirectory, { recursive: true });
    const stagingDir = mkdtempSync(resolve(artifactDirectory, 'stryker-'));
    const hostExecutable = observeExecutableIdentity('dotnet', { pathValue: childEnvironment.PATH });
    boundHostExecutable = hostExecutable;
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
        env: childEnvironment
    });
    process.stdout.write(`${focusedTestOutput}\n`);
    if (!/Passed!\s+-\s+Failed:\s+0,\s+Passed:\s+12,/u.test(focusedTestOutput))
    {
        fail('fork focused test run did not execute the expected twelve tests');
    }
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
    const executable = resolve(
        binDir,
        `.store/dotnet-stryker/${policy.packageVersion}/dotnet-stryker/`,
        `${policy.packageVersion}/tools/net8.0/any/Stryker.CLI.dll`
    );
    const binding = {
        schema: 'fsusblog.stryker-tool-binding.v1',
        ...identity,
        packageSha256: sha256(readFileSync(packagePath)),
        packageVersion: policy.packageVersion,
        patchSha256: policy.patchSha256,
        expressionTreePatchSha256: policy.expressionTreePatchSha256,
        upstreamCommit: policy.upstreamCommit,
        policySha256: sha256(readFileSync(policyPath)),
        hostExecutable,
        environment: minimal.observation,
        ...(mutationAttempt ? { mutationAttempt } : {}),
        installedRoot: relative(custodyRoot, binDir).split(sep).join('/'),
        installedFiles: installedFileInventory(binDir, custodyRoot),
        package: { path: relative(custodyRoot, packagePath).split(sep).join('/'), sha256: sha256(readFileSync(packagePath)) },
        executable: { path: relative(custodyRoot, executable).split(sep).join('/'), sha256: sha256(readFileSync(executable)) }
    };
    validateStrykerToolBinding(binding, { sourceState: identity.sourceState, runId: identity.runId });
    writeFileSync(outputPath, `${JSON.stringify(binding, null, 2)}\n`);
    return { executable, binding, hostExecutable };
}

function printUsage()
{
    process.stderr.write(
        'Usage: node tools/mutation/stryker-tool.mjs run --working-directory <path> '
        + '--attestation-output <run-owned-path> -- <args>\n'
    );
}

function main(args)
{
    const command = args.shift();
    // Builds only as part of an admitted physical run; no standalone ensure/cache promotion.
    if (command !== 'run')
    {
        printUsage();
        process.exitCode = 2;
        return;
    }
    const workingDirectoryFlag = args.shift();
    const workingDirectory = args.shift();
    const attestationFlag = args.shift();
    const attestationOutput = args.shift();
    let mutationAttempt = null;
    let mutationStage = 'Release';
    if (args[0] === '--root-receipt')
    {
        args.shift();
        const receiptPath = args.shift();
        mutationAttempt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        const identity = requireStrykerExecutionIdentity(process.env);
        verifyMutationAttemptRoot(mutationAttempt, {
            ...identity, invocationId: mutationAttempt.invocationId, attemptId: mutationAttempt.attemptId,
            buildReceiptDigest: mutationAttempt.immutableBuild.contentDigest
        });
        if (resolve(receiptPath) !== resolve(mutationAttempt.root, 'root-receipt.json')
            || resolve(workingDirectory) !== resolve(rootDir, 'src/core')
            || process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT !== mutationAttempt.paths.build
            || process.env.TMPDIR !== mutationAttempt.paths.scratch)
        {
            fail('Release mutation custody is not bound to the exact attempt and production source');
        }
    }
    if (mutationAttempt && args[0] === '--stage')
    {
        args.shift();
        mutationStage = args.shift();
        if (!['Debug', 'Release'].includes(mutationStage))
        {
            fail('mutation stage is not canonical');
        }
    }
    const separator = args.shift();
    if (workingDirectoryFlag !== '--working-directory' || !workingDirectory
        || attestationFlag !== '--attestation-output' || !attestationOutput || separator !== '--')
    {
        printUsage();
        process.exitCode = 2;
        return;
    }
    const outputPath = resolve(rootDir, attestationOutput);
    if (mutationAttempt ? outputPath !== resolve(mutationAttempt.paths.physical,
        ...(mutationStage === 'Debug' ? ['debug'] : []), 'tool-binding.json')
        : !relative(rootDir, outputPath).split(sep).join('/').startsWith('.tmp/mutation/'))
    {
        fail('tool binding output must belong to the current mutation output owner');
    }
    const { executable, binding, hostExecutable } = buildTool(outputPath, mutationAttempt);
    const result = spawnSync(hostExecutable.realPath, [executable, ...args], {
        cwd: resolve(rootDir, workingDirectory),
        env: childEnvironment,
        stdio: 'inherit'
    });
    if (result.error)
    {
        throw result.error;
    }
    validateStrykerToolBinding(binding, { sourceState: binding.sourceState, runId: binding.runId });
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
