#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStrykerAuthority } from './check-stryker-report.mjs';
import {
    releaseArtifactDigest,
    resolveReleaseMutationSubset
} from './mutation-release-parity.mjs';
import {
    assertMutationRootLocation,
    createMutationAttemptRoot,
    prepareMutationWriteBoundary,
    publishMutationAttemptReference,
    writeMutationRootTerminal
} from './release-mutation-attempt-root.mjs';

let writeBoundary = null;
let reachedPhase = 'write-boundary-precondition';
let producerSpawned = false;
let producerOutcome = null;
async function spawnProducer(command, args, options)
{
    if (!writeBoundary)
    {
        throw new Error('mutation producer requires a verified current-attempt write boundary');
    }
    const executable = command === 'dotnet'
        ? writeBoundary.dotnetExecutable
        : command;
    const result = await writeBoundary.run(executable, args, options);
    producerSpawned = true;
    producerOutcome = { exitCode: result.status, signal: result.signal ?? null,
        executable, args, error: result.error?.message ?? null };
    return result;
}

const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const option = (name) =>
{
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
};
function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function traceFile(output)
{
    const files = fs.readdirSync(path.join(output, 'logs')).filter((name) => /^log-.*\.txt$/u.test(name)).sort();
    if (files.length !== 1)
    {
        throw new Error(`Release parity requires one trace log, found ${files.length}`);
    }
    return path.join(output, 'logs', files[0]);
}
async function readCompilerProperties(project, configuration, environment)
{
    const names = [
        'MSBuildProjectFullPath',
        'AssemblyName',
        'Configuration',
        'Optimize',
        'DefineConstants',
        'TargetFramework',
        'LangVersion',
        'TieredPGO',
        'UseSharedCompilation'
    ];
    reachedPhase = `${configuration}-compiler-identity`;
    const result = await spawnProducer(
        'dotnet',
        [
            'msbuild',
            project,
            `-property:Configuration=${configuration}`,
            ...names.map((name) => `-getProperty:${name}`)
        ],
        { encoding: 'utf8', env: environment }
    );
    if (result.status !== 0)
    {
        throw new Error(`Release compiler identity probe failed: ${result.stderr.trim()}`);
    }
    const properties = JSON.parse(result.stdout).Properties;
    return properties;
}
async function run(command, args, options, label)
{
    reachedPhase = label;
    const result = await spawnProducer(command, args, options);
    if (result.status !== 0)
    {
        throw new Error(`${label} failed with exit ${result.status}: ${result.stderr?.trim() ?? ''}`);
    }
    return result;
}

const authorityFile = option('--authority');
const policyFile = option('--policy');
const outputRoot = option('--output-root') ?? path.join(os.tmpdir(), `fsusblog-mutation-${crypto.randomUUID()}`);
const runId = option('--run-id');
if (!authorityFile || !policyFile || !outputRoot || !runId)
{
    throw new Error('usage: --authority --policy --output-root --run-id');
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// Refuse unsafe roots before reading producer inputs or deleting any previous output.
assertMutationRootLocation({ repositoryRoot: root, outputRoot });
const invocationId = option('--invocation-id');
const attemptId = option('--attempt-id');
let runBinding = null;
let runIdentity = null;
let buildReceiptPath = option('--build-receipt');
let buildReceiptDigest = option('--build-receipt-digest');
const identityPath = option('--identity');
if (identityPath)
{
    const { readReleaseReliabilityEvidenceBinding } = await import('./release-reliability-evidence-binding.mjs');
    const binding = readReleaseReliabilityEvidenceBinding({ repositoryRoot: root, environment: {
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityPath,
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: option('--identity-digest'),
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
        FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
        FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: 'release-mutation-critical-slice'
    } });
    runBinding = binding;
    const identity = JSON.parse(fs.readFileSync(path.resolve(root, identityPath), 'utf8'));
    runIdentity = identity;
    if (!binding || identity.build.status !== 'complete' || attemptId !== `${invocationId}.attempt-1`)
    {
        throw new Error('mutation attempt is not bound to the canonical current invocation');
    }
    buildReceiptPath = path.resolve(root, identity.build.path);
    buildReceiptDigest = identity.build.contentDigest;
}
if (!invocationId || !attemptId || !buildReceiptPath || !buildReceiptDigest)
{
    throw new Error('Release mutation requires --invocation-id --attempt-id --build-receipt --build-receipt-digest');
}
const produceSource = process.argv.includes('--produce-source');
if (produceSource && !runBinding)
{
    throw new Error('fresh Debug/Release mutation requires the canonical sealed run identity');
}
let authority = produceSource ? null : JSON.parse(fs.readFileSync(path.resolve(authorityFile), 'utf8'));
const policyBytes = fs.readFileSync(path.resolve(policyFile));
const policy = JSON.parse(policyBytes);
if (produceSource && (path.resolve(policyFile) !== path.resolve(root, runIdentity.policy.mutationSubset.path)
    || sha256(policyBytes) !== runIdentity.policy.mutationSubset.fileDigest))
{
    throw new Error('mutation subset policy differs from the sealed invocation policy');
}
if (!produceSource && (authority.evidenceClass !== 'source-level' || authority.producer?.runId !== runId))
{
    throw new Error('Release parity requires a source-level authority');
}
const sourceConfig = path.resolve(root, produceSource ? 'config/testing/mutation/critical.json' : authority.config?.path ?? '');
if (!sourceConfig.startsWith(`${root}${path.sep}`) || !fs.existsSync(sourceConfig))
{
    throw new Error('Release parity source authority config is missing or escapes the repository');
}
if (fs.realpathSync(sourceConfig) !== sourceConfig)
{
    throw new Error('mutation source config filesystem alias is forbidden');
}
const rawSourceConfig = fs.readFileSync(sourceConfig);
if (!produceSource && sha256(rawSourceConfig).replace(/^sha256:/u, '') !== authority.config.sha256.replace(/^sha256:/u, ''))
{
    throw new Error('Release mutation source config digest mismatch');
}
const sourceConfiguration = JSON.parse(rawSourceConfig);
const config = structuredClone(sourceConfiguration);
if (config['stryker-config']?.configuration !== 'Debug')
{
    throw new Error('Release parity source authority must originate from the Debug critical config');
}
if ('project' in config['stryker-config'])
{
    throw new Error('Release parity refuses a synthetic pinned mutation project');
}
config['stryker-config'].configuration = 'Release';
config['stryker-config'].concurrency = 1;
config['stryker-config']['additional-timeout'] = 120000;
const sourceState = produceSource
    ? { commit: runBinding.sourceState.commit, worktreeFingerprint: runBinding.sourceState.worktreeFingerprint.replace(/^sha256:/u, '') }
    : authority.producer.sourceState;
if (runBinding && (sourceState.commit !== runBinding.sourceState.commit
    || sourceState.worktreeFingerprint.replace(/^sha256:/u, '') !== runBinding.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')))
{
    throw new Error('mutation source authority does not match the canonical run identity');
}
if (produceSource && (process.env.FSUSBLOG_TEST_RUN_ID !== runId
    || process.env.FSUSBLOG_TEST_SOURCE_COMMIT !== sourceState.commit
    || process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT !== sourceState.worktreeFingerprint))
{
    throw new Error('mutation source producer transport differs from the sealed run identity');
}
const rootReceipt = await createMutationAttemptRoot({
    repositoryRoot: root, outputRoot, runId, invocationId, attemptId, sourceState,
    buildReceiptPath, buildReceiptDigest
});
const expectedRoot = { runId, invocationId, attemptId, sourceState, buildReceiptDigest };
const runRoot = rootReceipt.root;
let terminalWritten = false;
try
{
    if (runBinding)
    {
        publishMutationAttemptReference(rootReceipt, expectedRoot);
    }
    const configFile = path.join(runRoot, 'config.release.json');
    const output = rootReceipt.paths.physical;
    const buildRoot = rootReceipt.paths.build;
    writeJson(configFile, config);
    const mutationProjectRoot = path.join(root, 'src/core');
    const sourceProject = path.join(mutationProjectRoot, 'FsusBlog.Core.csproj');
    const sourceProjectIdentity = path.relative(root, sourceProject).replaceAll(path.sep, '/');
    const environment = {
        ...process.env,
        FSUSBLOG_MUTATION_BUILD: '1',
        FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot,
        HOME: rootReceipt.paths.home,
        DOTNET_CLI_HOME: rootReceipt.paths.home,
        TMPDIR: rootReceipt.paths.scratch,
        TEMP: rootReceipt.paths.scratch,
        TMP: rootReceipt.paths.scratch,
        FSUSBLOG_TOOL_CACHE: rootReceipt.paths['tool-cache'],
        DOTNET_CLI_USE_MSBUILD_SERVER: '0',
        MSBUILDDISABLENODEREUSE: '1',
        CustomAfterMicrosoftCommonTargets: rootReceipt.sdkBoundary.path,
        NUGET_PACKAGES: path.join(rootReceipt.paths['tool-cache'], 'nuget')
    };
    writeBoundary = prepareMutationWriteBoundary(rootReceipt, expectedRoot, environment);
    const { observeExecutableIdentity } = await import('./execution-envelope-environment.mjs');
    writeBoundary.dotnetExecutable = observeExecutableIdentity('dotnet', { pathValue: environment.PATH }).realPath;
    if (produceSource)
    {
        const debugOutput = path.join(output, 'debug');
        fs.mkdirSync(debugOutput, { mode: 0o700 });
        const debugBinding = path.join(debugOutput, 'tool-binding.json');
        reachedPhase = 'sealed-critical-Debug-Stryker';
        await run(process.execPath, [path.join(root, 'tools/mutation/stryker-tool.mjs'), 'run',
            '--working-directory', mutationProjectRoot, '--attestation-output', debugBinding,
            '--root-receipt', path.join(runRoot, 'root-receipt.json'), '--stage', 'Debug', '--',
            '--config-file', sourceConfig, '--output', debugOutput, '--log-to-file', '--verbosity', 'trace'],
        { cwd: root, stdio: 'inherit', env: environment }, 'sealed critical Debug mutation');
        const debugReportFile = path.join(debugOutput, 'reports', sourceConfiguration['stryker-config']['report-file-name'] + '.json');
        const ownedAuthorityFile = path.join(debugOutput, 'authority.json');
        await run(process.execPath, [path.join(root, 'tools/test/check-stryker-report.mjs'), debugReportFile,
            '--config', sourceConfig, '--tier', 'release-mutation-critical-slice', '--out', ownedAuthorityFile,
            '--tool-binding', debugBinding, '--trace-log', traceFile(debugOutput), '--source-root', 'src/core'],
        { cwd: root, encoding: 'utf8', env: environment }, 'canonical Debug source authority');
        authority = JSON.parse(fs.readFileSync(ownedAuthorityFile, 'utf8'));
        const { checkMutationInventory } = await import('./check-mutation-inventory.mjs');
        const inventory = checkMutationInventory({
            authority, policy: JSON.parse(fs.readFileSync(path.join(root, 'config/testing/mutation/inventory-retention.json'), 'utf8')),
            repositoryRoot: root, environment,
            authorityInputs: {
                toolBinding: JSON.parse(fs.readFileSync(debugBinding)),
                report: JSON.parse(fs.readFileSync(debugReportFile)), rawReport: fs.readFileSync(debugReportFile),
                reportPath: authority.rawReport.path, reportAbsolutePath: debugReportFile,
                rawTrace: fs.readFileSync(traceFile(debugOutput)), tracePath: authority.rawTrace.path,
                config: sourceConfiguration, rawConfig: rawSourceConfig, configPath: authority.config.path,
                tierId: authority.tierId, runId, sourceState, generatedAt: authority.producer.generatedAt,
                repositoryRoot: root, sourceRoot: 'src/core', releaseReliability: runBinding
            }
        });
        writeJson(path.join(debugOutput, 'inventory-retention.json'), inventory);
    }
    const resolvedSubset = resolveReleaseMutationSubset(authority, policy);
    const debugCompilerProperties = await readCompilerProperties(sourceProject, 'Debug', environment);
    const releaseCompilerProperties = await readCompilerProperties(sourceProject, 'Release', environment);
    if (path.resolve(releaseCompilerProperties.MSBuildProjectFullPath) !== sourceProject
    || releaseCompilerProperties.AssemblyName !== 'FsusBlog.Core'
    || releaseCompilerProperties.Configuration !== 'Release'
    || releaseCompilerProperties.Optimize !== 'true'
    || releaseCompilerProperties.UseSharedCompilation !== 'false'
    || debugCompilerProperties.UseSharedCompilation !== 'false')
    {
        throw new Error('Release compiler identity is not the production FsusBlog.Core project');
    }
    await run('dotnet', ['build', sourceProject, '--configuration', 'Debug'], {
        cwd: root, encoding: 'utf8', env: environment
    }, 'run-bound Debug production Core build');
    const debugAssembly = path.join(buildRoot, 'dotnet/FsusBlog.Core/bin/Debug/net10.0/FsusBlog.Core.dll');
    if (!fs.existsSync(debugAssembly))
    {
        throw new Error('run-bound Debug production Core artifact is missing');
    }
    const debugAssemblyDigest = sha256(fs.readFileSync(debugAssembly));
    const toolBindingPath = path.join(output, 'tool-binding.json');
    reachedPhase = 'sealed-critical-Release-Stryker';
    const result = await spawnProducer(process.execPath, [path.join(root, 'tools/mutation/stryker-tool.mjs'), 'run', '--working-directory', mutationProjectRoot, '--attestation-output', toolBindingPath, '--root-receipt', path.join(runRoot, 'root-receipt.json'), '--', '--config-file', configFile, '--output', output, '--log-to-file', '--verbosity', 'trace'], {
        cwd: root, stdio: 'inherit', env: environment
    });
    if (result.status !== 0)
    {
        throw new Error('Release Stryker failed for the sealed critical authority scope');
    }
    const reportFile = path.join(output, 'reports', config['stryker-config']['report-file-name'] + '.json');
    const rawReport = fs.readFileSync(reportFile);
    const rawTrace = fs.readFileSync(traceFile(output));
    const releaseAuthority = createStrykerAuthority({
        toolBinding: JSON.parse(fs.readFileSync(toolBindingPath)),
        report: JSON.parse(rawReport), rawReport, reportPath: path.relative(root, reportFile).replaceAll(path.sep, '/'),
        reportAbsolutePath: reportFile, rawTrace, tracePath: path.relative(root, traceFile(output)).replaceAll(path.sep, '/'),
        config, rawConfig: fs.readFileSync(configFile), configPath: path.relative(root, configFile).replaceAll(path.sep, '/'),
        tierId: 'release-mutation-critical-slice', runId: `${runId}:release`, sourceState: authority.producer.sourceState,
        generatedAt: new Date().toISOString(), repositoryRoot: root, sourceRoot: 'src/core'
    });
    if (releaseAuthority.semanticMutantIdentityDigest !== authority.semanticMutantIdentityDigest)
    {
        throw new Error('Release Stryker produced a different semantic mutant identity inventory');
    }
    const assembly = path.join(
        buildRoot,
        'dotnet/FsusBlog.Server.Tests/bin/Release/net10.0/FsusBlog.Core.dll'
    );
    if (!fs.existsSync(assembly))
    {
        throw new Error('production FsusBlog.Core Release artifact is missing from the run-bound build root');
    }
    const assemblyDigest = sha256(fs.readFileSync(assembly));
    const compilerIdentity = {
        configuration: 'Release',
        project: sourceProjectIdentity,
        sourceConfigDigest: sha256(rawSourceConfig),
        releaseConfigDigest: sha256(fs.readFileSync(configFile)),
        buildRoot: buildRoot,
        properties: releaseCompilerProperties
    };
    const compiler = { ...compilerIdentity, optionsDigest: sha256(JSON.stringify(compilerIdentity)) };
    const smokeRoot = path.join(runRoot, 'smoke');
    fs.mkdirSync(smokeRoot, { recursive: true });
    const smokeResult = await run('dotnet', [
        'test',
        path.join(root, 'tests/backend/FsusBlog.Server.Tests.csproj'),
        '--configuration', 'Release',
        '--no-build',
        '--filter', config['stryker-config']['test-case-filter'],
        '--logger', 'trx;LogFileName=release-artifact-smoke.trx',
        '--results-directory', smokeRoot
    ], { cwd: root, encoding: 'utf8', env: environment }, 'Release artifact AEDS smoke');
    const smokeTrxFile = path.join(smokeRoot, 'release-artifact-smoke.trx');
    if (!fs.existsSync(smokeTrxFile))
    {
        throw new Error('Release artifact smoke did not produce TRX execution evidence');
    }
    const selectedKilledMutantIds = resolvedSubset.subset.map(({ mutantId }) => mutantId).sort();
    const releaseById = new Map(releaseAuthority.inventory.map((mutant) => [mutant.mutantId, mutant]));
    if (!selectedKilledMutantIds.every((mutantId) => releaseById.get(mutantId)?.status === 'Killed'))
    {
        throw new Error('Release mutation producer did not kill every selected semantic mutant');
    }
    const smokeEvidenceFile = path.join(smokeRoot, 'execution.json');
    writeJson(smokeEvidenceFile, {
        schema: 'fsusblog.release-mutation-artifact-smoke.v1',
        command: 'dotnet test tests/backend/FsusBlog.Server.Tests.csproj --configuration Release --no-build --filter FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests',
        exitCode: smokeResult.status,
        stdoutDigest: sha256(smokeResult.stdout),
        stderrDigest: sha256(smokeResult.stderr),
        loadedAssemblyPath: assembly,
        loadedAssemblyDigest: assemblyDigest,
        trxPath: smokeTrxFile,
        trxDigest: sha256(fs.readFileSync(smokeTrxFile)),
        canonicalAffectedTestsPassed: true,
        aedsEncodeDecodeContractPassed: true,
        killedMutantIds: selectedKilledMutantIds
    });
    const sourceText = fs.readFileSync(path.join(root, 'src/core/Algorithms/AedsEncoder.cs'), 'utf8');
    const debugCompilerIdentity = {
        configuration: 'Debug',
        project: sourceProjectIdentity,
        sourceConfigDigest: sha256(rawSourceConfig),
        releaseConfigDigest: sha256(fs.readFileSync(configFile)),
        buildRoot: buildRoot,
        properties: debugCompilerProperties
    };
    const debugCompiler = {
        ...debugCompilerIdentity,
        optionsDigest: sha256(JSON.stringify(debugCompilerIdentity))
    };
    const terminal = writeMutationRootTerminal(rootReceipt, expectedRoot, {
        phase: 'producer-complete', producerSpawned, producerOutcome, enforcement: writeBoundary.binding,
        authoritativeEvidence: { path: reportFile, fileDigest: sha256(rawReport) }
    });
    terminalWritten = true;
    const receipt = {
        schema: 'fsusblog.release-mutation-parity-receipt.v1', evidenceClass: 'release-artifact', runId,
        invocationId, attemptId, sourceState,
        attemptRoot: rootReceipt,
        terminal: { path: terminal.path, fileDigest: terminal.fileDigest },
        sourceAuthority: { path: path.relative(root, path.resolve(authorityFile)).replaceAll(path.sep, '/'), inventoryDigest: authority.inventoryDigest, configDigest: authority.config.sha256 },
        semanticMutantIdentityDigest: releaseAuthority.semanticMutantIdentityDigest,
        resultInventoryDigest: releaseAuthority.inventoryDigest,
        inventory: releaseAuthority.inventory,
        debugCompiler,
        compiler,
        configurationComparison: {
            debugArtifactDigest: debugAssemblyDigest,
            releaseArtifactDigest: assemblyDigest,
            debugCompilerOptionsDigest: debugCompiler.optionsDigest,
            releaseCompilerOptionsDigest: compiler.optionsDigest,
            ilClassification: debugAssemblyDigest === assemblyDigest
                ? 'same-assembly-bytes'
                : 'configuration-different-assembly-bytes',
            sourceBranchClassification: /^\s*#\s*(if|elif|else|endif)\b/mu.test(sourceText)
                ? 'conditional-source-branch-different'
                : 'same-source-branch'
        },
        resolvedSubset: resolvedSubset.subset, resolvedSubsetDigest: resolvedSubset.resolvedSubsetDigest,
        artifact: {
            root: runRoot,
            buildRoot: buildRoot,
            digest: releaseArtifactDigest(runRoot),
            assembly: {
                name: 'FsusBlog.Core.dll',
                path: assembly,
                digest: assemblyDigest
            },
            smoke: {
                evidencePath: smokeEvidenceFile,
                evidenceDigest: sha256(fs.readFileSync(smokeEvidenceFile)),
                trxPath: smokeTrxFile,
                trxDigest: sha256(fs.readFileSync(smokeTrxFile)),
                killedMutantIds: selectedKilledMutantIds
            }
        }
    };
    writeJson(path.join(runRoot, 'release-parity-receipt.json'), receipt);
    const { validateMutationReleaseParity, verifyReleaseArtifactBinding } = await import('./mutation-release-parity.mjs');
    validateMutationReleaseParity({ sourceMutationResult: authority, releaseParityResult: receipt, selectionPolicy: policy });
    await verifyReleaseArtifactBinding(receipt, root);
    const receiptOutput = option('--receipt-output');
    if (receiptOutput)
    {
        const expected = path.join(root, '.tmp/mutation/backend-critical/release-parity', runId, 'release-parity-receipt.json');
        if (path.resolve(receiptOutput) !== expected)
        {
            throw new Error('mutation control receipt must use the canonical current-run path');
        }
        let cursor = expected;
        while (cursor !== root)
        {
            if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
            {
                throw new Error('mutation control receipt path contains a filesystem alias');
            }
            cursor = path.dirname(cursor);
        }
        writeJson(expected, receipt);
        if (produceSource)
        {
            const expectedAuthority = path.join(root, '.tmp/mutation/backend-critical/authority.json');
            if (path.resolve(authorityFile) !== expectedAuthority)
            {
                throw new Error('source mutation control authority path is not canonical');
            }
            writeJson(expectedAuthority, authority);
        }
    }
}
catch (error)
{
    if (!terminalWritten)
    {
        writeMutationRootTerminal(rootReceipt, expectedRoot, {
            phase: reachedPhase, producerSpawned, producerOutcome, firstBlockingReason: error.message,
            enforcement: writeBoundary?.binding ?? null
        });
    }
    throw error;
}
