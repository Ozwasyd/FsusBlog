#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    lstatSync,
    readFileSync,
    realpathSync,
    statSync
} from 'node:fs'
import {
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    isWithinOrEqual,
    StateRootValidationError,
    validateStateRoot
} from './validate-state-root.mjs'

class DagGateError extends Error {
    constructor(code, message, details = {}) {
        super(message)
        this.name = 'DagGateError'
        this.code = code
        this.details = details
    }
}

function fail(code, message, details = {}) {
    throw new DagGateError(code, message, details)
}

function tryLstat(target) {
    try {
        return lstatSync(target)
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
        throw error
    }
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function normalizeJson(value) {
    if (Array.isArray(value)) return value.map(normalizeJson)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, normalizeJson(value[key])])
    )
}

function fingerprint(value) {
    return sha256(JSON.stringify(normalizeJson(value)))
}

function readJson(path, label) {
    let source
    try {
        source = readFileSync(path, 'utf8')
    } catch (error) {
        fail(`${label}-unreadable`, `${label} cannot be read: ${path}.`, {
            path,
            error: error.message
        })
    }

    try {
        return JSON.parse(source)
    } catch (error) {
        fail(`${label}-invalid-json`, `${label} is not valid JSON: ${path}.`, {
            path,
            error: error.message
        })
    }
}

function runGit(repository, args) {
    try {
        return execFileSync(
            'git',
            ['-C', repository, ...args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim()
    } catch (error) {
        fail('repository-probe-failed', `Git probe failed for ${repository}.`, {
            repository,
            args,
            stderr: error.stderr?.toString().trim() ?? ''
        })
    }
}

function ensureStateFile(path, stateRoot, label) {
    const absolute = resolve(path)
    let canonical
    try {
        canonical = realpathSync.native(absolute)
    } catch (error) {
        fail(`${label}-unreadable`, `${label} does not resolve to an existing state file: ${absolute}.`, {
            error: error.message
        })
    }

    if (!isWithinOrEqual(canonical, stateRoot) || canonical === stateRoot) {
        fail(`${label}-outside-state-root`, `${label} is outside the validated state root.`, {
            path: canonical,
            stateRoot
        })
    }

    const offset = relative(stateRoot, absolute)
    let cursor = stateRoot
    for (const component of offset.split(sep).filter(Boolean)) {
        cursor = resolve(cursor, component)
        if (lstatSync(cursor).isSymbolicLink()) {
            fail(`${label}-symlink`, `${label} traverses a symbolic link: ${cursor}.`, {
                path: absolute,
                symlink: cursor
            })
        }
    }

    if (!statSync(canonical).isFile()) {
        fail(`${label}-not-file`, `${label} is not a regular file: ${canonical}.`)
    }
    return canonical
}

function parseTimestamp(value, label) {
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) fail('invalid-timestamp', `${label} is not a valid timestamp.`, { value })
    return timestamp
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail('invalid-schema', `${label} must be a non-empty string.`)
    }
}

function requireStringArray(value, label) {
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
        fail('invalid-schema', `${label} must be a non-empty string array.`)
    }
}

function issueKey(issue) {
    return `${issue.repository}#${issue.number}`
}

function validateIssueSnapshot(snapshot, startupTime, repositoryNames) {
    if (snapshot?.schema !== 'issue-orchestration.issue-snapshot.v1') {
        fail('issue-snapshot-schema', 'Issue snapshot schema is missing or unsupported.')
    }
    if (!Array.isArray(snapshot.issues) || snapshot.issues.length === 0) {
        fail('issue-snapshot-scope', 'Issue snapshot must contain the complete selected scope.')
    }

    const refreshedAt = parseTimestamp(snapshot.refreshedAt, 'issue snapshot refreshedAt')
    if (refreshedAt < startupTime) {
        fail('issue-snapshot-stale', 'Issue snapshot predates the current startup gate.', {
            refreshedAt: snapshot.refreshedAt,
            startupTime: new Date(startupTime).toISOString()
        })
    }

    const keys = new Set()
    for (const issue of snapshot.issues) {
        requireString(issue.repository, 'issue.repository')
        if (!repositoryNames.has(issue.repository)) {
            fail('issue-snapshot-repository', `Issue snapshot references an unknown repository: ${issue.repository}.`)
        }
        if (!Number.isInteger(issue.number) || issue.number <= 0) {
            fail('issue-snapshot-number', 'Issue number must be a positive integer.')
        }
        if (issue.state !== 'OPEN') {
            fail('issue-snapshot-state', `Issue ${issueKey(issue)} is not currently open.`, {
                state: issue.state
            })
        }
        parseTimestamp(issue.updatedAt, `${issueKey(issue)} updatedAt`)
        if (!/^[a-f0-9]{64}$/u.test(issue.commentsFingerprint ?? '')) {
            fail('issue-snapshot-comments', `Issue ${issueKey(issue)} lacks a valid comments fingerprint.`)
        }
        const key = issueKey(issue)
        if (keys.has(key)) fail('issue-snapshot-duplicate', `Issue snapshot repeats ${key}.`)
        keys.add(key)
    }

    return {
        refreshedAt,
        fingerprint: fingerprint(
            [...snapshot.issues].sort((left, right) => issueKey(left).localeCompare(issueKey(right)))
        ),
        keys
    }
}

function repositoryFacts(repositories, defaultBranches) {
    return repositories
        .map(({ name, path }) => {
            requireString(defaultBranches.get(name), `default branch for ${name}`)
            const canonical = realpathSync.native(resolve(path))
            const currentBranch = runGit(canonical, ['branch', '--show-current'])
            if (currentBranch !== defaultBranches.get(name)) {
                fail('default-branch-mismatch', `${name} is not on its declared default branch.`, {
                    declared: defaultBranches.get(name),
                    current: currentBranch
                })
            }
            const dirty = runGit(canonical, ['status', '--porcelain=v1', '--untracked-files=all'])
            return {
                name,
                path: canonical,
                remote: runGit(canonical, ['remote', 'get-url', 'origin']),
                defaultBranch: defaultBranches.get(name),
                headSha: runGit(canonical, ['rev-parse', 'HEAD']),
                dirtyFingerprint: sha256(dirty)
            }
        })
        .sort((left, right) => left.name.localeCompare(right.name))
}

function validateRepositories(dag, liveFacts) {
    if (!Array.isArray(dag.repositories) || dag.repositories.length !== liveFacts.length) {
        fail('repository-scope-mismatch', 'DAG repository scope does not match the current repositories.')
    }

    const dagByName = new Map(dag.repositories.map((repository) => [repository.name, repository]))
    for (const live of liveFacts) {
        const recorded = dagByName.get(live.name)
        if (!recorded) fail('repository-missing', `DAG is missing repository ${live.name}.`)
        for (const field of ['path', 'remote', 'defaultBranch', 'headSha', 'dirtyFingerprint']) {
            if (recorded[field] !== live[field]) {
                fail('repository-identity-mismatch', `DAG ${live.name}.${field} does not match current repository facts.`, {
                    field,
                    recorded: recorded[field],
                    current: live[field]
                })
            }
        }
        if (recorded.baseSha !== live.headSha) {
            fail('base-sha-mismatch', `DAG ${live.name}.baseSha does not match the startup HEAD.`, {
                recorded: recorded.baseSha,
                current: live.headSha
            })
        }
    }
}

function validateAcyclic(nodesById) {
    const visiting = new Set()
    const visited = new Set()

    function visit(id) {
        if (visiting.has(id)) fail('dependency-cycle', `DAG dependency cycle includes ${id}.`)
        if (visited.has(id)) return
        visiting.add(id)
        for (const dependency of nodesById.get(id).dependencies) visit(dependency)
        visiting.delete(id)
        visited.add(id)
    }

    for (const id of nodesById.keys()) visit(id)
}

function validateNodesAndGroups(dag, snapshot, repositoryNames) {
    if (!Array.isArray(dag.nodes) || dag.nodes.length !== snapshot.issues.length) {
        fail('node-scope-mismatch', 'DAG nodes do not exactly cover the current issue scope.')
    }

    const snapshotById = new Map(snapshot.issues.map((issue) => [issueKey(issue), issue]))
    const nodesById = new Map()
    const allowedStatuses = new Set([
        'discovered',
        'investigated',
        'ready',
        'implementing',
        'review',
        'verifying',
        'deliverable',
        'delivered',
        'closed',
        'terminal'
    ])
    const effortByBand = new Map([
        ['simple-to-lower-middle', 'low'],
        ['lower-middle-to-medium', 'medium'],
        ['medium-to-upper-middle', 'high'],
        ['upper-middle-to-hard', 'xhigh'],
        ['hard-to-extreme', 'max']
    ])
    const effortOrder = ['low', 'medium', 'high', 'xhigh', 'max']

    for (const node of dag.nodes) {
        requireString(node.id, 'node.id')
        if (nodesById.has(node.id)) fail('node-duplicate', `DAG repeats node ${node.id}.`)
        const issue = snapshotById.get(node.id)
        if (!issue) fail('node-out-of-scope', `DAG node ${node.id} is absent from the current issue snapshot.`)
        if (node.repository !== issue.repository || node.issueNumber !== issue.number) {
            fail('node-identity-mismatch', `DAG node ${node.id} does not match its issue identity.`)
        }
        if (node.issueUpdatedAt !== issue.updatedAt || node.commentsFingerprint !== issue.commentsFingerprint) {
            fail('node-remote-mismatch', `DAG node ${node.id} is stale relative to current issue facts.`)
        }
        if (!allowedStatuses.has(node.status)) fail('node-status', `DAG node ${node.id} has invalid status ${node.status}.`)
        requireString(node.ownerRepository, `${node.id}.ownerRepository`)
        if (!repositoryNames.has(node.ownerRepository)) {
            fail('node-owner', `DAG node ${node.id} has unknown owner repository ${node.ownerRepository}.`)
        }
        const baseEffort = effortByBand.get(node.difficultyBand)
        if (!baseEffort) {
            fail('node-difficulty', `DAG node ${node.id} has invalid difficulty band ${node.difficultyBand}.`)
        }
        if (node.model !== 'gpt-5.6-sol') {
            fail('node-model', `DAG node ${node.id} must use gpt-5.6-sol.`)
        }
        if (!Number.isInteger(node.reworkCount) || node.reworkCount < 0) {
            fail('node-rework-count', `DAG node ${node.id} has invalid reworkCount.`)
        }
        const baseIndex = effortOrder.indexOf(baseEffort)
        const requiredIndex = node.reworkCount >= 2
            ? Math.min(baseIndex + 1, effortOrder.length - 1)
            : baseIndex
        const requiredEffort = effortOrder[requiredIndex]
        const actualIndex = effortOrder.indexOf(node.effort)
        if (
            actualIndex < requiredIndex
            || (node.reworkCount < 2 && actualIndex !== baseIndex)
        ) {
            fail('node-effort', `DAG node ${node.id} effort does not match its difficulty/rework requirement.`, {
                difficultyBand: node.difficultyBand,
                reworkCount: node.reworkCount,
                requiredEffort,
                actualEffort: node.effort
            })
        }
        if (node.reworkCount >= 2) {
            requireString(node.effortPromotionEvidence, `${node.id}.effortPromotionEvidence`)
        }
        requireString(node.acceptanceGroup, `${node.id}.acceptanceGroup`)
        if (!Array.isArray(node.dependencies)) fail('node-dependencies', `${node.id}.dependencies must be an array.`)
        requireStringArray(node.investigation?.codePaths, `${node.id}.investigation.codePaths`)
        requireStringArray(node.investigation?.testPaths, `${node.id}.investigation.testPaths`)
        requireStringArray(node.investigation?.currentDocs, `${node.id}.investigation.currentDocs`)
        requireStringArray(node.investigation?.constraints, `${node.id}.investigation.constraints`)
        parseTimestamp(node.investigation?.checkedAt, `${node.id}.investigation.checkedAt`)

        if (node.status === 'terminal') {
            if (!['impossible', 'externally_blocked', 'not_applicable'].includes(node.terminalCategory)) {
                fail('terminal-category', `Terminal node ${node.id} lacks a valid category.`)
            }
            requireStringArray(node.terminalEvidence, `${node.id}.terminalEvidence`)
            requireString(node.recoveryFingerprint, `${node.id}.recoveryFingerprint`)
        }

        nodesById.set(node.id, node)
    }

    for (const node of nodesById.values()) {
        for (const dependency of node.dependencies) {
            if (!nodesById.has(dependency)) {
                fail('dependency-missing', `Node ${node.id} depends on absent node ${dependency}.`)
            }
            if (dependency === node.id) fail('dependency-cycle', `Node ${node.id} depends on itself.`)
        }
        if (node.status === 'ready') {
            const incomplete = node.dependencies.filter((dependency) => !['delivered', 'closed'].includes(nodesById.get(dependency).status))
            if (incomplete.length > 0) {
                fail('ready-dependency', `Ready node ${node.id} has incomplete dependencies.`, { incomplete })
            }
        }
    }
    validateAcyclic(nodesById)

    if (!Array.isArray(dag.acceptanceGroups) || dag.acceptanceGroups.length === 0) {
        fail('acceptance-groups-missing', 'DAG acceptance groups are missing.')
    }
    const groupMembership = new Map()
    for (const group of dag.acceptanceGroups) {
        requireString(group.id, 'acceptanceGroup.id')
        if (groupMembership.has(group.id)) fail('acceptance-group-duplicate', `DAG repeats group ${group.id}.`)
        if (!Array.isArray(group.nodes) || group.nodes.length === 0) {
            fail('acceptance-group-empty', `Acceptance group ${group.id} is empty.`)
        }
        groupMembership.set(group.id, new Set(group.nodes))
    }
    for (const node of nodesById.values()) {
        const group = groupMembership.get(node.acceptanceGroup)
        if (!group || !group.has(node.id)) {
            fail('acceptance-group-mismatch', `Node ${node.id} is not present in its declared acceptance group.`)
        }
    }
    for (const [groupId, members] of groupMembership) {
        for (const member of members) {
            const node = nodesById.get(member)
            if (!node || node.acceptanceGroup !== groupId) {
                fail('acceptance-group-mismatch', `Acceptance group ${groupId} contains inconsistent node ${member}.`)
            }
        }
    }
}

function validateRuntimePaths(dag, stateRoot) {
    const runtime = dag.runtimeFiles
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
        fail('runtime-files-missing', 'DAG runtimeFiles must declare the ledger, slots, locks, issue state, recovery fingerprints, and evidence paths.')
    }

    for (const field of ['ledger', 'slots', 'locks', 'issueState', 'recoveryFingerprints', 'evidence']) {
        requireString(runtime[field], `runtimeFiles.${field}`)
        if (isAbsolute(runtime[field])) {
            fail('runtime-path-absolute', `runtimeFiles.${field} must be relative to the validated state root.`)
        }
        const components = runtime[field].split(/[\\/]/u).filter((component) => component && component !== '.')
        if (components.includes('..')) {
            fail('runtime-path-escape', `runtimeFiles.${field} must not contain parent traversal.`, {
                value: runtime[field]
            })
        }
        const projected = resolve(stateRoot, runtime[field])
        if (!isWithinOrEqual(projected, stateRoot) || projected === stateRoot) {
            fail('runtime-path-escape', `runtimeFiles.${field} escapes the validated state root.`, {
                value: runtime[field],
                projected
            })
        }

        let cursor = stateRoot
        for (const component of components) {
            cursor = resolve(cursor, component)
            const stat = tryLstat(cursor)
            if (!stat) break
            if (stat.isSymbolicLink()) {
                fail('runtime-path-symlink', `runtimeFiles.${field} traverses a symbolic link.`, {
                    value: runtime[field],
                    symlink: cursor
                })
            }
        }
    }
}

export function checkDagGate({
    stateRoot,
    dagPath,
    issuesSnapshotPath,
    repositories,
    defaultBranches,
    workspaces,
    startupTime,
    factsOnly = false
}) {
    const rootValidation = validateStateRoot({
        candidate: stateRoot,
        repositories: repositories.map(({ path }) => path),
        workspaces
    })
    if (!rootValidation.candidate.exists) {
        fail('state-root-missing', 'Validated state root must exist before checking a DAG.')
    }

    const canonicalRoot = rootValidation.candidate.canonical
    const canonicalSnapshot = ensureStateFile(issuesSnapshotPath, canonicalRoot, 'issue-snapshot')
    const snapshot = readJson(canonicalSnapshot, 'issue-snapshot')

    const startup = parseTimestamp(startupTime, 'startup time')
    const repositoryNames = new Set(repositories.map(({ name }) => name))
    const snapshotValidation = validateIssueSnapshot(snapshot, startup, repositoryNames)
    const liveRepositories = repositoryFacts(repositories, defaultBranches)
    const repositoriesFingerprint = fingerprint(liveRepositories)

    if (factsOnly) {
        return {
            schema: 'issue-orchestration.dag-gate-result.v1',
            valid: true,
            dispatchEnabled: false,
            factsOnly: true,
            stateRoot: canonicalRoot,
            issuesSnapshot: canonicalSnapshot,
            issueSnapshotFingerprint: snapshotValidation.fingerprint,
            repositories: liveRepositories,
            repositoryFingerprint: repositoriesFingerprint
        }
    }

    const canonicalDag = ensureStateFile(dagPath, canonicalRoot, 'dag')
    const dag = readJson(canonicalDag, 'dag')
    if (dag?.schema !== 'issue-orchestration.dag.v1') {
        fail('dag-schema', 'DAG schema is missing or unsupported.')
    }
    requireString(dag.runId, 'dag.runId')
    if (dag.subagentSlotsConfigured !== 15) {
        fail('subagent-slots-configured', 'DAG must configure exactly 15 subagent slots.')
    }
    if (
        !Number.isInteger(dag.subagentSlotsEffective)
        || dag.subagentSlotsEffective < 1
        || dag.subagentSlotsEffective > 15
    ) {
        fail('subagent-slots-effective', 'DAG effective subagent slots must be an integer from 1 through 15.')
    }
    requireString(dag.subagentCapacityEvidence, 'dag.subagentCapacityEvidence')
    if (dag.stateRootCanonical !== canonicalRoot) {
        fail('state-root-mismatch', 'DAG state root does not match the validated canonical state root.', {
            recorded: dag.stateRootCanonical,
            current: canonicalRoot
        })
    }

    validateRepositories(dag, liveRepositories)
    validateNodesAndGroups(dag, snapshot, repositoryNames)
    validateRuntimePaths(dag, canonicalRoot)

    const dagRefreshedAt = parseTimestamp(dag.refreshedAt, 'DAG refreshedAt')
    if (dagRefreshedAt < snapshotValidation.refreshedAt) {
        fail('dag-stale', 'DAG predates the current issue snapshot.')
    }
    if (dag.issueSnapshotFingerprint !== snapshotValidation.fingerprint) {
        fail('issue-scope-fingerprint', 'DAG issue scope fingerprint does not match current remote facts.')
    }
    if (dag.repositoryFingerprint !== repositoriesFingerprint) {
        fail('repository-fingerprint', 'DAG repository fingerprint does not match current repository facts.')
    }
    if (
        dag.consistency?.status !== 'passed'
        || dag.consistency.issueSnapshotFingerprint !== snapshotValidation.fingerprint
        || dag.consistency.repositoryFingerprint !== repositoriesFingerprint
    ) {
        fail('consistency-incomplete', 'DAG consistency evidence is absent or does not match current facts.')
    }
    parseTimestamp(dag.consistency.validatedAt, 'DAG consistency.validatedAt')

    return {
        schema: 'issue-orchestration.dag-gate-result.v1',
        valid: true,
        dispatchEnabled: true,
        stateRoot: canonicalRoot,
        dag: canonicalDag,
        issueSnapshotFingerprint: snapshotValidation.fingerprint,
        repositoryFingerprint: repositoriesFingerprint,
        nodeCount: dag.nodes.length,
        acceptanceGroupCount: dag.acceptanceGroups.length
    }
}

function valuesFor(argv, name) {
    const values = []
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== name) continue
        if (!argv[index + 1]) fail('missing-option-value', `Missing value for ${name}.`)
        values.push(argv[index + 1])
        index += 1
    }
    return values
}

function valueFor(argv, name) {
    return valuesFor(argv, name)[0] ?? null
}

function namedValues(argv, name) {
    return valuesFor(argv, name).map((value) => {
        const separatorIndex = value.indexOf('=')
        if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
            fail('invalid-option-value', `${name} values must use name=value.`)
        }
        return {
            name: value.slice(0, separatorIndex),
            value: value.slice(separatorIndex + 1)
        }
    })
}

function runCli() {
    try {
        const argv = process.argv.slice(2)
        const repositories = namedValues(argv, '--repository').map(({ name, value }) => ({
            name,
            path: value
        }))
        const defaultBranches = new Map(
            namedValues(argv, '--default-branch').map(({ name, value }) => [name, value])
        )
        const result = checkDagGate({
            stateRoot: valueFor(argv, '--state-root'),
            dagPath: valueFor(argv, '--dag'),
            issuesSnapshotPath: valueFor(argv, '--issues-snapshot'),
            repositories,
            defaultBranches,
            workspaces: valuesFor(argv, '--workspace'),
            startupTime: valueFor(argv, '--startup-time'),
            factsOnly: argv.includes('--facts-only')
        })
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
        const known = error instanceof DagGateError || error instanceof StateRootValidationError
        const payload = {
            schema: 'issue-orchestration.dag-gate-result.v1',
            valid: false,
            dispatchEnabled: false,
            code: known ? error.code : 'unexpected-error',
            reason: error.message,
            details: known ? error.details : {}
        }
        process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
        process.exitCode = 2
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
