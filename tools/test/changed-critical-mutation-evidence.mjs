#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStrykerAuthority } from './check-stryker-report.mjs'
import { canonicalJson, sha256 } from './changed-critical-mutation-identity.mjs'

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label} mismatch`)
    }
}

function scopeMutationReport(report, mutateFiles, sourceProject) {
    const normalizedMutateFiles = mutateFiles.map((path) => path.replaceAll('\\', '/'))
    const selectedFiles = []
    const unexpected = []
    for (const [file, value] of Object.entries(report.files ?? {})) {
        const normalizedFile = file.replaceAll('\\', '/')
        const selected = normalizedMutateFiles.some(
            (path) => normalizedFile === path || normalizedFile.endsWith(`/${path}`)
        )
        if (selected) {
            selectedFiles.push(normalizedFile)
            continue
        }
        for (const mutant of value?.mutants ?? []) {
            unexpected.push(`${file}#${mutant.id}:${mutant.status}`)
        }
    }
    for (const mutateFile of normalizedMutateFiles) {
        if (!selectedFiles.some((file) => file.endsWith(`/${mutateFile}`) || file === mutateFile)) {
            throw new Error(
                `raw report is missing selected mutate file ${sourceProject}/${mutateFile}`
            )
        }
    }
    if (unexpected.length > 0) {
        throw new Error(
            `raw report planned mutants outside selected closure: ${unexpected.join(', ')}`
        )
    }
    return report
}

function executionMatrix(inventory) {
    return inventory.map((mutant) => ({
        mutantId: mutant.mutantId,
        rawMutantId: mutant.rawMutantId,
        status: mutant.status,
        coveredByTestIds: mutant.coveredByTestIds,
        killedByTestIds: mutant.killedByTestIds,
        coveredByTestBindings: mutant.coveredByTestBindings,
        killedByTestBindings: mutant.killedByTestBindings,
        durationMs: mutant.durationMs,
        durationState: mutant.durationState,
        traceBatchId: mutant.traceBatchId
    }))
}

function combinedTestIdentities(runAuthorities) {
    const identities = new Map()
    for (const run of runAuthorities) {
        for (const identity of run.testIdentities) {
            const existing = identities.get(identity.rawTestId)
            if (existing && existing !== identity.fullyQualifiedName) {
                throw new Error(
                    `raw test ID ${identity.rawTestId} resolves differently across physical runs`
                )
            }
            identities.set(identity.rawTestId, identity.fullyQualifiedName)
        }
    }
    return [...identities]
        .map(([rawTestId, fullyQualifiedName]) => ({ rawTestId, fullyQualifiedName }))
        .sort((left, right) => left.rawTestId.localeCompare(right.rawTestId))
}

function absoluteArtifactPath(repositoryRoot, path) {
    return isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path)
}

export function createChangedCriticalMutationAuthority({
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs,
    selectionPath,
    runId,
    generatedAt,
    repositoryRoot = process.cwd()
}) {
    if (selection?.status !== 'selected') {
        throw new Error('authority requires a non-empty critical selection')
    }
    assertEqual(
        sha256(rawSelection),
        sha256(Buffer.from(`${JSON.stringify(selection, null, 2)}\n`)),
        'selection bytes'
    )
    assertEqual(selection.catalog.sha256, sha256(rawCatalog), 'catalog digest')
    if (!Array.isArray(runs) || runs.length !== selection.projectClosures.length) {
        throw new Error('authority requires one physical mutation run per source-project closure')
    }

    const runAuthorities = runs.map((run) => {
        const closure = selection.projectClosures.find(
            ({ sourceProject }) => sourceProject === run.sourceProject
        )
        if (!closure) {
            throw new Error(`unexpected mutation source project ${run.sourceProject}`)
        }
        assertEqual(
            canonicalJson(run.config['stryker-config'].mutate),
            canonicalJson(closure.mutateFiles),
            `${run.sourceProject} mutate scope`
        )
        assertEqual(
            run.config['stryker-config']['test-case-filter'],
            closure.testFilter,
            `${run.sourceProject} test filter`
        )
        const scopedReport = scopeMutationReport(
            run.report,
            closure.mutateFiles,
            run.sourceProject
        )
        const authority = createStrykerAuthority({
            report: scopedReport,
            rawReport: run.rawReport,
            reportPath: run.paths.report,
            reportAbsolutePath: run.reportAbsolutePath
                ?? absoluteArtifactPath(repositoryRoot, run.paths.report),
            rawTrace: run.rawTrace,
            tracePath: run.paths.trace,
            config: run.config,
            rawConfig: run.rawConfig,
            configPath: run.paths.config,
            tierId: 'backend-mutation-changed-critical',
            runId: `${runId}:${run.sourceProject}`,
            sourceState: selection.sourceState,
            generatedAt,
            repositoryRoot,
            sourceRoot: run.sourceProject
        })
        if (authority.executedMutants === 0) {
            throw new Error(
                `non-empty critical closure executed zero mutants for ${run.sourceProject}`
            )
        }
        return {
            sourceProject: run.sourceProject,
            config: {
                path: run.paths.config,
                sha256: sha256(run.rawConfig)
            },
            rawReport: {
                path: run.paths.report,
                sha256: sha256(run.rawReport)
            },
            rawTrace: {
                path: run.paths.trace,
                sha256: sha256(run.rawTrace)
            },
            traceExecution: authority.traceExecution,
            mutateFiles: closure.mutateFiles,
            testFilter: closure.testFilter,
            executed: authority.executedMutants,
            statuses: authority.statuses,
            score: authority.score,
            inventory: authority.inventory,
            testIdentities: authority.testIdentities,
            plannedMutantIds: authority.plannedMutantIds,
            executedMutantIds: authority.executedMutantIds,
            compileErrorMutantIds: authority.compileErrorMutantIds,
            ignoredMutantIds: authority.ignoredMutantIds,
            noCoverageMutantIds: authority.noCoverageMutantIds,
            killedMutantIds: authority.killedMutantIds,
            survivedMutantIds: authority.survivedMutantIds,
            timeoutMutantIds: authority.timeoutMutantIds,
            executedTestIds: authority.executedTestIds,
            inventoryDigest: authority.inventoryDigest,
            executionMatrixDigest: authority.executionMatrixDigest
        }
    }).sort((left, right) => left.sourceProject.localeCompare(right.sourceProject))

    const statuses = Object.fromEntries(knownStatuses().map((status) => [
        status,
        runAuthorities.reduce((total, run) => total + run.statuses[status], 0)
    ]))
    const executed = runAuthorities.reduce((total, run) => total + run.executed, 0)
    const combinedInventory = runAuthorities
        .flatMap((run) => run.inventory)
        .sort((left, right) => left.mutantId.localeCompare(right.mutantId))
    if (new Set(combinedInventory.map(({ mutantId }) => mutantId)).size !== combinedInventory.length) {
        throw new Error('changed-critical authority contains duplicate canonical mutant ID')
    }
    const collection = (name) => runAuthorities
        .flatMap((run) => run[name])
        .sort((left, right) => left.localeCompare(right))

    return {
        schema: 'fsusblog.changed-critical-mutation-authority.v1',
        evidenceClass: 'source-level',
        status: 'success',
        runId,
        generatedAt,
        sourceState: selection.sourceState,
        closureDigest: selection.closureDigest,
        selection: {
            path: selectionPath,
            sha256: sha256(rawSelection)
        },
        catalog: {
            path: selection.catalog.path,
            sha256: sha256(rawCatalog),
            version: catalog.version
        },
        generatedConfigDigest: sha256(canonicalJson(
            runAuthorities.map(({ sourceProject, config }) => ({ sourceProject, ...config }))
        )),
        mutateFiles: selection.mutateFiles,
        testFilter: selection.testFilter,
        domains: selection.domains.map(({ id, risk }) => ({ id, risk })),
        mutants: {
            executed,
            killed: statuses.Killed,
            survived: statuses.Survived,
            timeout: statuses.Timeout,
            noCoverage: statuses.NoCoverage,
            compileError: statuses.CompileError,
            ignored: statuses.Ignored
        },
        inventory: combinedInventory,
        testIdentities: combinedTestIdentities(runAuthorities),
        plannedMutantIds: collection('plannedMutantIds'),
        executedMutantIds: collection('executedMutantIds'),
        compileErrorMutantIds: collection('compileErrorMutantIds'),
        ignoredMutantIds: collection('ignoredMutantIds'),
        noCoverageMutantIds: collection('noCoverageMutantIds'),
        killedMutantIds: collection('killedMutantIds'),
        survivedMutantIds: collection('survivedMutantIds'),
        timeoutMutantIds: collection('timeoutMutantIds'),
        executedTestIds: [...new Set(runAuthorities
            .flatMap((run) => run.executedTestIds))]
            .sort((left, right) => left.localeCompare(right)),
        inventoryDigest: sha256(canonicalJson(combinedInventory)),
        executionMatrixDigest: sha256(canonicalJson(executionMatrix(combinedInventory))),
        physicalRuns: runAuthorities,
        rawReportDigest: sha256(canonicalJson(
            runAuthorities.map(({ sourceProject, rawReport }) => ({
                sourceProject,
                ...rawReport
            }))
        )),
        rawTraceDigest: sha256(canonicalJson(
            runAuthorities.map(({ sourceProject, rawTrace }) => ({
                sourceProject,
                ...rawTrace
            }))
        )),
        traceBatchDigest: sha256(canonicalJson(
            runAuthorities.map(({ sourceProject, traceExecution }) => ({
                sourceProject,
                batchDigest: traceExecution.batchDigest
            }))
        ))
    }
}

function knownStatuses() {
    return ['CompileError', 'Ignored', 'Killed', 'NoCoverage', 'Survived', 'Timeout']
}

export function validateChangedCriticalMutationAuthority({
    authority,
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs,
    expectedSourceState,
    repositoryRoot = process.cwd()
}) {
    if (
        authority?.schema !== 'fsusblog.changed-critical-mutation-authority.v1'
        || authority.status !== 'success'
    ) {
        throw new Error('changed-critical authority schema/status is invalid')
    }
    assertEqual(authority.sourceState.commit, expectedSourceState.commit, 'source commit')
    assertEqual(
        authority.sourceState.worktreeFingerprint,
        expectedSourceState.worktreeFingerprint,
        'worktree fingerprint'
    )
    assertEqual(authority.closureDigest, selection.closureDigest, 'closure digest')
    assertEqual(authority.selection.sha256, sha256(rawSelection), 'selection digest')
    assertEqual(authority.catalog.sha256, sha256(rawCatalog), 'catalog digest')
    assertEqual(
        canonicalJson(authority.mutateFiles),
        canonicalJson(selection.mutateFiles),
        'mutate file list'
    )
    assertEqual(authority.testFilter, selection.testFilter, 'test filter')

    const recreated = createChangedCriticalMutationAuthority({
        selection,
        rawSelection,
        catalog,
        rawCatalog,
        runs,
        selectionPath: authority.selection.path,
        runId: authority.runId,
        generatedAt: authority.generatedAt,
        repositoryRoot
    })
    assertEqual(canonicalJson(authority), canonicalJson(recreated), 'authority content')
    return authority
}

function parseArguments(args) {
    const names = new Map([
        ['--authority', 'authority'],
        ['--selection', 'selection'],
        ['--catalog', 'catalog'],
        ['--run-manifest', 'runManifest'],
        ['--source-commit', 'sourceCommit'],
        ['--worktree-fingerprint', 'worktreeFingerprint']
    ])
    const options = {}
    for (let index = 0; index < args.length; index += 2) {
        const key = names.get(args[index])
        const value = args[index + 1]
        if (!key || !value || value.startsWith('--')) {
            throw new Error(`unknown or incomplete option ${args[index]}`)
        }
        options[key] = value
    }
    for (const key of names.values()) {
        if (!options[key]) {
            throw new Error(`missing required option ${key}`)
        }
    }
    return options
}

function readJsonWithBytes(path) {
    const raw = readFileSync(resolve(path))
    return { raw, value: JSON.parse(raw) }
}

function main() {
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
    const options = parseArguments(process.argv.slice(2))
    const authority = readJsonWithBytes(options.authority)
    const selection = readJsonWithBytes(options.selection)
    const catalog = readJsonWithBytes(options.catalog)
    const runManifest = JSON.parse(readFileSync(resolve(options.runManifest)))
    const runs = runManifest.runs.map((entry) => {
        const config = readJsonWithBytes(entry.config)
        const report = readJsonWithBytes(entry.report)
        const trace = readFileSync(resolve(entry.trace))
        return {
            sourceProject: entry.sourceProject,
            config: config.value,
            rawConfig: config.raw,
            report: report.value,
            rawReport: report.raw,
            reportAbsolutePath: resolve(entry.report),
            rawTrace: trace,
            paths: {
                config: entry.config,
                report: entry.report,
                trace: entry.trace
            }
        }
    })
    validateChangedCriticalMutationAuthority({
        authority: authority.value,
        selection: selection.value,
        rawSelection: selection.raw,
        catalog: catalog.value,
        rawCatalog: catalog.raw,
        runs,
        expectedSourceState: {
            commit: options.sourceCommit,
            worktreeFingerprint: options.worktreeFingerprint
        },
        repositoryRoot: root
    })
    process.stdout.write(
        `[changed-critical-mutation-evidence] ok run=${authority.value.runId} `
        + `closure=${authority.value.closureDigest} `
        + `executed=${authority.value.mutants.executed}\n`
    )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main()
    } catch (error) {
        process.stderr.write(
            `[changed-critical-mutation-evidence] `
            + `${error instanceof Error ? error.message : String(error)}\n`
        )
        process.exitCode = 1
    }
}
