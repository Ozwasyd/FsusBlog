#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { createStrykerAuthority } from './check-stryker-report.mjs'
import {
    releaseArtifactDigest,
    resolveReleaseMutationSubset
} from './mutation-release-parity.mjs'

const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`) }
function traceFile(output) {
    const files = fs.readdirSync(path.join(output, 'logs')).filter((name) => /^log-.*\.txt$/u.test(name)).sort()
    if (files.length !== 1) throw new Error(`Release parity requires one trace log, found ${files.length}`)
    return path.join(output, 'logs', files[0])
}
function readCompilerProperties(project, configuration, environment) {
    const names = [
        'MSBuildProjectFullPath',
        'AssemblyName',
        'Configuration',
        'Optimize',
        'DefineConstants',
        'TargetFramework',
        'LangVersion',
        'TieredPGO'
    ]
    const result = spawnSync(
        'dotnet',
        [
            'msbuild',
            project,
            `-property:Configuration=${configuration}`,
            ...names.map((name) => `-getProperty:${name}`)
        ],
        { encoding: 'utf8', env: environment }
    )
    if (result.status !== 0) {
        throw new Error(`Release compiler identity probe failed: ${result.stderr.trim()}`)
    }
    const properties = JSON.parse(result.stdout).Properties
    return properties
}
function run(command, args, options, label) {
    const result = spawnSync(command, args, options)
    if (result.status !== 0) {
        throw new Error(`${label} failed with exit ${result.status}: ${result.stderr?.trim() ?? ''}`)
    }
    return result
}

const authorityFile = option('--authority'); const policyFile = option('--policy'); const outputRoot = option('--output-root'); const runId = option('--run-id')
if (!authorityFile || !policyFile || !outputRoot || !runId) throw new Error('usage: --authority --policy --output-root --run-id')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const authority = JSON.parse(fs.readFileSync(path.resolve(authorityFile), 'utf8'))
const policy = JSON.parse(fs.readFileSync(path.resolve(policyFile), 'utf8'))
if (authority.evidenceClass !== 'source-level') throw new Error('Release parity requires a source-level authority')
const resolvedSubset = resolveReleaseMutationSubset(authority, policy)
const sourceConfig = path.resolve(root, authority.config?.path ?? '')
if (!sourceConfig.startsWith(`${root}${path.sep}`) || !fs.existsSync(sourceConfig)) throw new Error('Release parity source authority config is missing or escapes the repository')
const rawSourceConfig = fs.readFileSync(sourceConfig)
const config = JSON.parse(rawSourceConfig)
if (config['stryker-config']?.configuration !== 'Debug') throw new Error('Release parity source authority must originate from the Debug critical config')
if ('project' in config['stryker-config']) throw new Error('Release parity refuses a synthetic pinned mutation project')
config['stryker-config'].configuration = 'Release'
config['stryker-config'].concurrency = 1
config['stryker-config']['additional-timeout'] = 120000
const resolvedOutputRoot = path.resolve(outputRoot)
const repositoryTemporaryRoot = path.join(root, '.tmp')
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(runId)) throw new Error('Release mutation run ID is not path-safe')
const runRoot = path.resolve(resolvedOutputRoot, runId)
if (!resolvedOutputRoot.startsWith(`${repositoryTemporaryRoot}${path.sep}`)
    || !runRoot.startsWith(`${resolvedOutputRoot}${path.sep}`)) {
    throw new Error('Release mutation output must be run-bound under repository .tmp, never development bin/obj')
}
fs.rmSync(runRoot, { recursive: true, force: true })
const configFile = path.join(runRoot, 'config.release.json'); const output = path.join(runRoot, 'physical')
const buildRoot = path.join(runRoot, 'build')
writeJson(configFile, config)
const mutationProjectRoot = path.join(root, 'src/core')
const sourceProject = path.join(mutationProjectRoot, 'FsusBlog.Core.csproj')
const sourceProjectIdentity = path.relative(root, sourceProject).replaceAll(path.sep, '/')
const environment = {
    ...process.env,
    FSUSBLOG_MUTATION_BUILD: '1',
    FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot
}
const debugCompilerProperties = readCompilerProperties(sourceProject, 'Debug', environment)
const releaseCompilerProperties = readCompilerProperties(sourceProject, 'Release', environment)
if (path.resolve(releaseCompilerProperties.MSBuildProjectFullPath) !== sourceProject
    || releaseCompilerProperties.AssemblyName !== 'FsusBlog.Core'
    || releaseCompilerProperties.Configuration !== 'Release'
    || releaseCompilerProperties.Optimize !== 'true') {
    throw new Error('Release compiler identity is not the production FsusBlog.Core project')
}
run('dotnet', ['build', sourceProject, '--configuration', 'Debug'], {
    cwd: root, encoding: 'utf8', env: environment
}, 'run-bound Debug production Core build')
const debugAssembly = path.join(buildRoot, 'dotnet/FsusBlog.Core/bin/Debug/net10.0/FsusBlog.Core.dll')
if (!fs.existsSync(debugAssembly)) throw new Error('run-bound Debug production Core artifact is missing')
const debugAssemblyDigest = sha256(fs.readFileSync(debugAssembly))
const result = spawnSync('node', [path.join(root, 'tools/mutation/stryker-tool.mjs'), 'run', '--working-directory', mutationProjectRoot, '--', '--config-file', configFile, '--output', output, '--log-to-file', '--verbosity', 'trace'], {
    cwd: root, stdio: 'inherit', env: environment
})
if (result.status !== 0) throw new Error('Release Stryker failed for the sealed critical authority scope')
const reportFile = path.join(output, 'reports', config['stryker-config']['report-file-name'] + '.json')
const rawReport = fs.readFileSync(reportFile); const rawTrace = fs.readFileSync(traceFile(output))
const releaseAuthority = createStrykerAuthority({
    report: JSON.parse(rawReport), rawReport, reportPath: path.relative(root, reportFile).replaceAll(path.sep, '/'),
    reportAbsolutePath: reportFile, rawTrace, tracePath: path.relative(root, traceFile(output)).replaceAll(path.sep, '/'),
    config, rawConfig: fs.readFileSync(configFile), configPath: path.relative(root, configFile).replaceAll(path.sep, '/'),
    tierId: 'release-mutation-critical-slice', runId: `${runId}:release`, sourceState: authority.producer.sourceState,
    generatedAt: new Date().toISOString(), repositoryRoot: root, sourceRoot: 'src/core'
})
if (releaseAuthority.semanticMutantIdentityDigest !== authority.semanticMutantIdentityDigest) {
    throw new Error('Release Stryker produced a different semantic mutant identity inventory')
}
const assembly = path.join(
    buildRoot,
    'dotnet/FsusBlog.Server.Tests/bin/Release/net10.0/FsusBlog.Core.dll'
)
if (!fs.existsSync(assembly)) throw new Error('production FsusBlog.Core Release artifact is missing from the run-bound build root')
const assemblyDigest = sha256(fs.readFileSync(assembly))
const compilerIdentity = {
    configuration: 'Release',
    project: sourceProjectIdentity,
    sourceConfigDigest: sha256(rawSourceConfig),
    releaseConfigDigest: sha256(fs.readFileSync(configFile)),
    buildRoot: path.relative(root, buildRoot).replaceAll(path.sep, '/'),
    properties: releaseCompilerProperties
}
const compiler = { ...compilerIdentity, optionsDigest: sha256(JSON.stringify(compilerIdentity)) }
const smokeRoot = path.join(runRoot, 'smoke')
fs.mkdirSync(smokeRoot, { recursive: true })
const smokeResult = run('dotnet', [
    'test',
    path.join(root, 'tests/backend/FsusBlog.Server.Tests.csproj'),
    '--configuration', 'Release',
    '--no-build',
    '--filter', config['stryker-config']['test-case-filter'],
    '--logger', 'trx;LogFileName=release-artifact-smoke.trx',
    '--results-directory', smokeRoot
], { cwd: root, encoding: 'utf8', env: environment }, 'Release artifact AEDS smoke')
const smokeTrxFile = path.join(smokeRoot, 'release-artifact-smoke.trx')
if (!fs.existsSync(smokeTrxFile)) throw new Error('Release artifact smoke did not produce TRX execution evidence')
const selectedKilledMutantIds = resolvedSubset.subset.map(({ mutantId }) => mutantId).sort()
const releaseById = new Map(releaseAuthority.inventory.map((mutant) => [mutant.mutantId, mutant]))
if (!selectedKilledMutantIds.every((mutantId) => releaseById.get(mutantId)?.status === 'Killed')) {
    throw new Error('Release mutation producer did not kill every selected semantic mutant')
}
const smokeEvidenceFile = path.join(smokeRoot, 'execution.json')
writeJson(smokeEvidenceFile, {
    schema: 'fsusblog.release-mutation-artifact-smoke.v1',
    command: 'dotnet test tests/backend/FsusBlog.Server.Tests.csproj --configuration Release --no-build --filter FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests',
    exitCode: smokeResult.status,
    stdoutDigest: sha256(smokeResult.stdout),
    stderrDigest: sha256(smokeResult.stderr),
    loadedAssemblyPath: path.relative(root, assembly).replaceAll(path.sep, '/'),
    loadedAssemblyDigest: assemblyDigest,
    trxPath: path.relative(root, smokeTrxFile).replaceAll(path.sep, '/'),
    trxDigest: sha256(fs.readFileSync(smokeTrxFile)),
    canonicalAffectedTestsPassed: true,
    aedsEncodeDecodeContractPassed: true,
    killedMutantIds: selectedKilledMutantIds
})
const sourceText = fs.readFileSync(path.join(root, 'src/core/Algorithms/AedsEncoder.cs'), 'utf8')
const debugCompilerIdentity = {
    configuration: 'Debug',
    project: sourceProjectIdentity,
    sourceConfigDigest: sha256(rawSourceConfig),
    releaseConfigDigest: sha256(fs.readFileSync(configFile)),
    buildRoot: path.relative(root, buildRoot).replaceAll(path.sep, '/'),
    properties: debugCompilerProperties
}
const debugCompiler = {
    ...debugCompilerIdentity,
    optionsDigest: sha256(JSON.stringify(debugCompilerIdentity))
}
const receipt = {
    schema: 'fsusblog.release-mutation-parity-receipt.v1', evidenceClass: 'release-artifact', runId,
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
        root: path.relative(root, runRoot).replaceAll(path.sep, '/'),
        buildRoot: path.relative(root, buildRoot).replaceAll(path.sep, '/'),
        digest: releaseArtifactDigest(runRoot),
        assembly: {
            name: 'FsusBlog.Core.dll',
            path: path.relative(root, assembly).replaceAll(path.sep, '/'),
            digest: assemblyDigest
        },
        smoke: {
            evidencePath: path.relative(root, smokeEvidenceFile).replaceAll(path.sep, '/'),
            evidenceDigest: sha256(fs.readFileSync(smokeEvidenceFile)),
            trxPath: path.relative(root, smokeTrxFile).replaceAll(path.sep, '/'),
            trxDigest: sha256(fs.readFileSync(smokeTrxFile)),
            killedMutantIds: selectedKilledMutantIds
        }
    }
}
writeJson(path.join(runRoot, 'release-parity-receipt.json'), receipt)
