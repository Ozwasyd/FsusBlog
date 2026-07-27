import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
    releaseArtifactDigest,
    validateMutationReleaseParity
} from '../../tools/test/mutation-release-parity.mjs'

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const taggedHash = (value) => `sha256:${hash(value)}`
const canonicalJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(
            (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(',')}}`
    }
    return JSON.stringify(value)
}
const subset = [{ operator: 'Arithmetic', sourceRegion: 'AedsEncoder.Write' }]
const selectionPolicy = {
    subset,
    subsetDigest: taggedHash(JSON.stringify(subset)),
    requiredOperators: ['Arithmetic'],
    requiredSourceRegions: ['AedsEncoder.Write']
}
const identity = {
    sourceFile: 'AedsEncoder.Write',
    sourceFileDigest: 'source-digest',
    operator: 'Arithmetic',
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 2,
    originalDigest: 'original-digest',
    replacementDigest: 'replacement-digest'
}
const mutantId = hash(canonicalJson(identity))
const semanticMutantIdentityDigest = hash(canonicalJson([identity]))
const source = {
    evidenceClass: 'source-level',
    config: { sha256: 'debug-config-digest' },
    semanticMutantIdentityDigest,
    mutants: [{ mutantId, status: 'Killed', ...identity }]
}
source.inventoryDigest = hash(canonicalJson(source.mutants))
const resolvedSubsetDigest = taggedHash(JSON.stringify([{ ...subset[0], mutantId }]))
const compilerIdentity = {
    configuration: 'Release',
    project: 'src/core/FsusBlog.Core.csproj',
    sourceConfigDigest: 'sha256:debug-config',
    releaseConfigDigest: 'sha256:release-config',
    buildRoot: '.tmp/mutation/run/build',
    properties: {
        AssemblyName: 'FsusBlog.Core',
        Configuration: 'Release',
        Optimize: 'true',
        DefineConstants: 'TRACE;RELEASE',
        TargetFramework: 'net10.0',
        LangVersion: '14.0',
        TieredPGO: 'true'
    }
}
const compiler = {
    ...compilerIdentity,
    optionsDigest: taggedHash(JSON.stringify(compilerIdentity))
}
const debugCompilerIdentity = {
    ...compilerIdentity,
    configuration: 'Debug',
    properties: {
        ...compilerIdentity.properties,
        Configuration: 'Debug',
        Optimize: 'false',
        DefineConstants: 'TRACE;DEBUG'
    }
}
const debugCompiler = {
    ...debugCompilerIdentity,
    optionsDigest: taggedHash(JSON.stringify(debugCompilerIdentity))
}
const release = {
    evidenceClass: 'release-artifact',
    semanticMutantIdentityDigest,
    sourceAuthority: {
        inventoryDigest: source.inventoryDigest,
        configDigest: source.config.sha256
    },
    resolvedSubsetDigest,
    artifact: {
        root: '.tmp/mutation/run',
        buildRoot: '.tmp/mutation/run/build',
        digest: 'sha256:artifact',
        assembly: {
            name: 'FsusBlog.Core.dll',
            path: '.tmp/mutation/run/build/FsusBlog.Core.dll',
            digest: 'sha256:assembly'
        },
        smoke: {
            evidenceDigest: 'sha256:smoke',
            trxPath: '.tmp/mutation/run/smoke.trx',
            trxDigest: 'sha256:trx',
            killedMutantIds: [mutantId]
        }
    },
    debugCompiler,
    compiler,
    configurationComparison: {
        debugArtifactDigest: 'sha256:debug',
        releaseArtifactDigest: 'sha256:assembly',
        debugCompilerOptionsDigest: debugCompiler.optionsDigest,
        releaseCompilerOptionsDigest: compiler.optionsDigest,
        ilClassification: 'configuration-different-assembly-bytes',
        sourceBranchClassification: 'same-source-branch'
    },
    mutants: [{ mutantId, status: 'Killed', ...identity }]
}
release.resultInventoryDigest = hash(canonicalJson(release.mutants))

test('release parity accepts the same killed semantic mutant from production Core', () => {
    assert.equal(validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: release,
        selectionPolicy
    }), true)
})

test('release parity rejects survived and compile-different mutants', () => {
    const survivedInventory = [{ ...release.mutants[0], status: 'Survived' }]
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            mutants: survivedInventory,
            resultInventoryDigest: hash(canonicalJson(survivedInventory))
        },
        selectionPolicy
    }), /status differs/)
    const compileErrorInventory = [{ ...source.mutants[0], status: 'CompileError' }]
    const compileErrorSource = {
        ...source,
        mutants: compileErrorInventory,
        inventoryDigest: hash(canonicalJson(compileErrorInventory))
    }
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: compileErrorSource,
        releaseParityResult: {
            ...release,
            sourceAuthority: {
                ...release.sourceAuthority,
                inventoryDigest: compileErrorSource.inventoryDigest
            }
        },
        selectionPolicy
    }), /no executable same-authority mutant|status differs/)
})

test('release parity rejects drifted compiler, artifact and subset identities', () => {
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: release,
        selectionPolicy: { ...selectionPolicy, subsetDigest: 'sha256:random' }
    }), /subset digest/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: { ...release, artifact: { root: 'bin/Debug', digest: '' } },
        selectionPolicy
    }), /isolated artifact/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: release,
        selectionPolicy: { ...selectionPolicy, requiredOperators: ['Arithmetic', 'Equality'] }
    }), /cover every required/)
    for (const properties of [
        { ...compilerIdentity.properties, DefineConstants: 'TRACE;DEBUG' },
        { ...compilerIdentity.properties, Optimize: 'false' }
    ]) {
        const changed = { ...compilerIdentity, properties }
        assert.throws(() => validateMutationReleaseParity({
            sourceMutationResult: source,
            releaseParityResult: {
                ...release,
                compiler: { ...changed, optionsDigest: taggedHash(JSON.stringify(changed)) }
            },
            selectionPolicy
        }), /symbols\/options/)
    }
    const invalidDebugIdentity = {
        ...debugCompilerIdentity,
        properties: { ...debugCompiler.properties, Optimize: 'true' }
    }
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            debugCompiler: {
                ...invalidDebugIdentity,
                optionsDigest: taggedHash(JSON.stringify(invalidDebugIdentity))
            }
        },
        selectionPolicy
    }), /Debug compiler symbols\/options/)
})

test('release parity requires exact source and Release result inventory bindings', () => {
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            sourceAuthority: { configDigest: source.config.sha256 }
        },
        selectionPolicy
    }), /source authority config or inventory digest/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            sourceAuthority: { inventoryDigest: source.inventoryDigest }
        },
        selectionPolicy
    }), /source authority config or inventory digest/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: { ...release, resultInventoryDigest: undefined },
        selectionPolicy
    }), /result inventory digest/)
})

test('conditional-compilation and optimization-difference fixtures require explicit classification', () => {
    assert.equal(validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            configurationComparison: {
                ...release.configurationComparison,
                sourceBranchClassification: 'conditional-source-branch-different'
            }
        },
        selectionPolicy
    }), true)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            configurationComparison: {
                ...release.configurationComparison,
                ilClassification: 'assumed-equivalent',
                sourceBranchClassification: 'not-inspected'
            }
        },
        selectionPolicy
    }), /source-branch and assembly-bytecode comparison/)
})

test('negative contracts kill renamed receipts, ordinary Release smoke, synthetic projects, random sampling, and ID-only identities', () => {
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: { ...release, evidenceClass: 'source-level' },
        selectionPolicy
    }), /release-artifact/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            artifact: {
                ...release.artifact,
                smoke: { evidenceDigest: taggedHash('receipt-string'), killedMutantIds: [] }
            }
        },
        selectionPolicy
    }), /isolated artifact|selected killed mutant/)
    const syntheticIdentity = { ...compilerIdentity, project: 'tests/mutation/Synthetic.csproj' }
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            compiler: {
                ...syntheticIdentity,
                optionsDigest: taggedHash(JSON.stringify(syntheticIdentity))
            }
        },
        selectionPolicy
    }), /production Release/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: {
            ...release,
            mutants: [{ ...release.mutants[0], operator: 'Equality' }]
        },
        selectionPolicy
    }), /mutant ID is not bound/)
    assert.throws(() => validateMutationReleaseParity({
        sourceMutationResult: source,
        releaseParityResult: release,
        selectionPolicy: {
            ...selectionPolicy,
            subsetDigest: taggedHash(crypto.randomBytes(32))
        }
    }), /subset digest/)
})

test('fixed release subset policy is machine-readable and digest-bound', () => {
    const policy = JSON.parse(fs.readFileSync('config/testing/mutation/release-parity-subset.json', 'utf8'))
    assert.equal(policy.schema, 'fsusblog.release-mutation-parity-subset.v1')
    assert.equal(policy.subsetDigest, taggedHash(JSON.stringify(policy.subset)))
    assert.deepEqual(
        [...new Set(policy.subset.map(({ operator }) => operator))].sort(),
        [...policy.requiredOperators].sort())
    assert.deepEqual(
        [...new Set(policy.subset.map(({ sourceRegion }) => sourceRegion))].sort(),
        [...policy.requiredSourceRegions].sort())
})

test('release-final CLI verifies executed smoke evidence and matrix requires it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-release-parity-'))
    try {
        const artifactRoot = path.join(directory, '.tmp/mutation/run')
        const buildRoot = path.join(artifactRoot, 'build')
        const assembly = path.join(buildRoot, 'FsusBlog.Core.dll')
        const smokeEvidence = path.join(artifactRoot, 'smoke.json')
        const smokeTrx = path.join(artifactRoot, 'smoke.trx')
        fs.mkdirSync(buildRoot, { recursive: true })
        fs.writeFileSync(assembly, 'release-artifact')
        const assemblyDigest = taggedHash(fs.readFileSync(assembly))
        fs.writeFileSync(smokeTrx, '<TestRun><ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1" failed="0"/></ResultSummary><UnitTest name="AedsEncoderTests"/></TestRun>')
        const smokeTrxDigest = taggedHash(fs.readFileSync(smokeTrx))
        fs.writeFileSync(smokeEvidence, JSON.stringify({
            exitCode: 0,
            loadedAssemblyPath: assembly,
            loadedAssemblyDigest: assemblyDigest,
            trxPath: smokeTrx,
            trxDigest: smokeTrxDigest,
            canonicalAffectedTestsPassed: true,
            aedsEncodeDecodeContractPassed: true,
            killedMutantIds: [mutantId]
        }))
        const fixtureRelease = {
            ...release,
            artifact: {
                root: artifactRoot,
                buildRoot,
                assembly: { name: 'FsusBlog.Core.dll', path: assembly, digest: assemblyDigest },
                smoke: {
                    evidencePath: smokeEvidence,
                    evidenceDigest: taggedHash(fs.readFileSync(smokeEvidence)),
                    trxPath: smokeTrx,
                    trxDigest: smokeTrxDigest,
                    killedMutantIds: [mutantId]
                }
            },
            configurationComparison: {
                ...release.configurationComparison,
                releaseArtifactDigest: assemblyDigest
            }
        }
        fixtureRelease.artifact.digest = releaseArtifactDigest(artifactRoot)
        const files = { authority: source, release: fixtureRelease, policy: selectionPolicy }
        for (const [name, value] of Object.entries(files)) {
            fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value))
        }
        const result = spawnSync(process.execPath, [
            'tools/test/run-release-mutation-parity.mjs',
            '--authority', path.join(directory, 'authority.json'),
            '--release', path.join(directory, 'release.json'),
            '--policy', path.join(directory, 'policy.json')
        ], { encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        assert.match(
            fs.readFileSync('tests/matrix.yml', 'utf8'),
            /release-parity\/\*\/release-parity-receipt\.json/u)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('release-final parity consumes real Core critical authority, not changed-critical selection', () => {
    const lane = fs.readFileSync('tools/test/lanes/backend-mutation-critical.sh', 'utf8')
    const support = fs.readFileSync('tools/test/lanes/_suite-support.sh', 'utf8')
    const config = JSON.parse(fs.readFileSync('config/testing/mutation/critical.json', 'utf8'))
    const scenarios = JSON.parse(fs.readFileSync('config/testing/release-reliability-scenario-catalog.json', 'utf8'))
    const scenario = scenarios.scenarios.find((entry) => entry.id === 'release-mutation-critical-slice')
    assert.match(lane, /--authority "\$ROOT_DIR\/\.tmp\/mutation\/backend-critical\/authority\.json"/u)
    assert.doesNotMatch(lane, /--selection "\$FSUSBLOG_MUTATION_SELECTION"/u)
    assert.match(support, /"\$ROOT_DIR\/src\/core"/u)
    assert.deepEqual(config['stryker-config']['test-projects'], ['../../tests/backend/FsusBlog.Server.Tests.csproj'])
    assert.equal('project' in config['stryker-config'], false)
    assert.equal(scenario.command.env.FSUSBLOG_RELEASE_MUTATION_PARITY, '1')
})
