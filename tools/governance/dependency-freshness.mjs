#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

export const exceptionsSchema = 'fsusblog.dependency-exceptions.v1'
export const resultSchema = 'fsusblog.dependency-freshness-result.v1'
export const generalMaxMs = 14 * 24 * 60 * 60 * 1000
export const vulnerabilityMaxMs = 72 * 60 * 60 * 1000
export const behindSlaMs = 24 * 60 * 60 * 1000
const forbiddenReasons = [
    '可能不兼容',
    '测试很慢',
    '暂时不想升级',
    'maybe incompatible',
    'tests are slow',
    "don't want to upgrade",
    'do not want to upgrade'
]
const requiredExceptionFields = [
    'id',
    'dependencyId',
    'datasource',
    'packageName',
    'currentVersion',
    'targetVersion',
    'reason',
    'owner',
    'createdAt',
    'expiresAt',
    'kind'
]
const wildcardPattern = /[*?]|^\.\*$/u

export function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

export function parseInstant(value, label, errors) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
        errors.push({ code: 'exception-timestamp', detail: label })
        return Number.NaN
    }
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) errors.push({ code: 'exception-timestamp', detail: label })
    return parsed
}

function compareVersion(left, right) {
    return String(left ?? '').replace(/^[~^]/u, '') === String(right ?? '').replace(/^[~^]/u, '')
}

function decodePointer(pointer) {
    return pointer.split('/').slice(1).map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function readPointer(document, pointer) {
    let current = document
    for (const token of decodePointer(pointer)) {
        if (current == null || typeof current !== 'object') return undefined
        current = current[token]
    }
    return current
}

function sourceFiles(item) {
    return (item.files ?? []).filter(file => !/(?:package-lock\.json|packages\.lock\.json)$/u.test(file))
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function configPattern(value) {
    const lastSlash = value.lastIndexOf('/')
    return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1))
}

function extractNpm(root, item) {
    const files = sourceFiles(item).filter(candidate => candidate.endsWith('package.json'))
    if (files.length === 0 || !item.fieldPaths?.length) return undefined
    const versions = new Set()
    for (const file of files) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
        if (item.fieldPaths.length === 1 && item.fieldPaths[0] === '/packageManager') {
            if (!/^npm@\d+\.\d+\.\d+$/u.test(manifest.packageManager ?? '')) {
                throw new Error(`npm-package-manager-invalid:${file}`)
            }
            versions.add(manifest.packageManager.slice(4))
            continue
        }
        const lockPath = path.posix.join(path.posix.dirname(file), 'package-lock.json')
        if (!item.files.includes(lockPath)) throw new Error(`npm-lockfile-not-owned:${file}`)
        const lock = JSON.parse(fs.readFileSync(path.join(root, lockPath), 'utf8'))
        if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) {
            throw new Error(`npm-lockfile-invalid:${lockPath}`)
        }
        for (const pointer of item.fieldPaths) {
            const raw = readPointer(manifest, pointer)
            const tokens = decodePointer(pointer)
            if (tokens[0] === 'overrides') {
                if (typeof raw !== 'string' || tokens.at(-1) !== item.packageName || ![2, 3].includes(tokens.length)) {
                    throw new Error(`npm-override-shape-unsupported:${pointer}`)
                }
                const packageSuffix = `node_modules/${item.packageName}`
                let entries
                if (tokens.length === 2) {
                    entries = Object.entries(lock.packages).filter(([key]) => key === packageSuffix || key.endsWith(`/${packageSuffix}`)).map(([, entry]) => entry)
                } else {
                    const parentSuffix = `node_modules/${tokens[1]}`
                    const parents = Object.keys(lock.packages).filter(key => key === parentSuffix || key.endsWith(`/${parentSuffix}`))
                    entries = parents.map(parent => {
                        let context = parent
                        while (context) {
                            const found = lock.packages[`${context}/${packageSuffix}`]
                            if (found) return found
                            const separator = context.lastIndexOf('/node_modules/')
                            context = separator < 0 ? '' : context.slice(0, separator)
                        }
                        return lock.packages[packageSuffix]
                    })
                }
                if (entries.length === 0) throw new Error(`npm-override-resolution-missing:${pointer}`)
                for (const entry of entries) {
                    if (entry?.link || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(entry?.version ?? '')) {
                        throw new Error(`npm-override-resolution-invalid:${pointer}`)
                    }
                    versions.add(entry.version)
                }
                continue
            }
            if (typeof raw !== 'string' || readPointer(lock.packages[''], pointer) !== raw) {
                throw new Error(`npm-lockfile-manifest-drift:${file}:${pointer}`)
            }
        }
        if (item.fieldPaths.every(pointer => decodePointer(pointer)[0] === 'overrides')) continue
        const entry = lock.packages[`node_modules/${item.packageName}`]
        if (entry?.link || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(entry?.version ?? '')) {
            throw new Error(`npm-lockfile-version-missing:${lockPath}:${item.packageName}`)
        }
        versions.add(entry.version)
    }
    if (versions.size !== 1) throw new Error(`npm-current-versions-disagree:${item.id}`)
    return [...versions][0]
}

function extractNuget(root, item) {
    const file = sourceFiles(item)[0]
    if (file === 'Directory.Packages.props') {
        const source = fs.readFileSync(path.join(root, file), 'utf8')
        const match = source.match(new RegExp(`<PackageVersion Include="${escapeRegExp(item.packageName)}" Version="([^"]+)"`, 'u'))
        return match?.[1]
    }
    if (file === '.config/dotnet-tools.json') {
        const tools = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
        return tools.tools?.[item.packageName]?.version
    }
    return undefined
}

function extractAction(root, item) {
    const references = new Set()
    for (const file of sourceFiles(item)) {
        const source = fs.readFileSync(path.join(root, file), 'utf8')
        const pattern = new RegExp(`^\\s*(?:-\\s*)?uses:\\s*["']?${escapeRegExp(item.packageName)}(?:/[A-Za-z0-9_./-]+)?@([^\\s#"']+)`, 'gmu')
        for (const match of source.matchAll(pattern)) references.add(match[1])
    }
    if (references.size > 1) throw new Error(`action-current-references-disagree:${item.id}`)
    return [...references][0]
}

function extractDocker(root, item) {
    const file = sourceFiles(item)[0]
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    if (item.manager === 'docker-compose') {
        const match = source.match(new RegExp(`image:\\s*["']?${escapeRegExp(item.packageName)}:([^\\s"']+)`, 'mu'))
        return match?.[1]
    }
    if (item.packageName === 'docker/dockerfile') {
        const match = source.match(/^#\s*syntax=docker\/dockerfile:(\S+)/mu)
        return match?.[1]
    }
    const globals = new Map()
    const references = new Set()
    let beforeFirstFrom = true
    for (const line of source.split(/\r?\n/u)) {
        if (beforeFirstFrom) {
            const argument = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$/iu.exec(line)
            if (argument) globals.set(argument[1], argument[2].replace(/^(["'])(.*)\1$/u, '$2'))
        }
        const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/iu.exec(line)
        if (!from) continue
        beforeFirstFrom = false
        if (!from[1].startsWith(`${item.packageName}:`) && !from[1].startsWith(`${item.packageName}@`)) continue
        const expanded = from[1].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (token, braced, bare) => {
            const value = globals.get(braced ?? bare)
            if (value === undefined || value.includes('$')) throw new Error(`docker-from-argument-unresolved:${file}:${token}`)
            return value
        })
        const reference = expanded.slice(item.packageName.length + 1)
        if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*(?:@sha256:[0-9a-f]{64})?|sha256:[0-9a-f]{64})$/u.test(reference)) {
            throw new Error(`docker-from-reference-invalid:${file}`)
        }
        references.add(reference)
    }
    const sorted = [...references].sort()
    return sorted.length > 1 ? JSON.stringify(sorted) : sorted[0]
}

function extractCustom(root, item, config) {
    const manager = (config.customManagers ?? []).find(candidate => candidate.description === item.customManager)
    if (!manager) return undefined
    const dockerReferences = new Set()
    for (const file of sourceFiles(item)) {
        if (!manager.managerFilePatterns?.some(pattern => configPattern(pattern).test(file))) continue
        const source = fs.readFileSync(path.join(root, file), 'utf8')
        for (const matchString of manager.matchStrings ?? []) {
            const pattern = new RegExp(matchString.replaceAll('\\"', '"'), 'dgu')
            for (const match of source.matchAll(pattern)) {
                const packageName = manager.packageNameTemplate ?? manager.depNameTemplate ?? match.groups?.depName
                if (packageName !== item.packageName && match.groups?.depName !== item.packageName) continue
                const value = match.groups?.currentValue ?? match.groups?.currentDigest
                if (item.datasource === 'docker' && value) {
                    dockerReferences.add(match.groups?.currentValue && match.groups?.currentDigest
                        ? `${match.groups.currentValue}@${match.groups.currentDigest}` : value)
                    continue
                }
                if (value) return value
            }
        }
    }
    if (item.datasource === 'docker') {
        const pinnedTags = new Set([...dockerReferences].filter(value => value.includes('@')).map(value => value.split('@')[0]))
        const references = [...dockerReferences].filter(value => !pinnedTags.has(value))
        if (references.length > 1) throw new Error(`docker-current-references-disagree:${item.id}`)
        return references[0]
    }
    return undefined
}

function extractDelegated(root, item) {
    const file = sourceFiles(item)[0]
    const baseline = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    if (item.packageName === 'https://github.com/Ozwasyd/FsusUI.git') return baseline.commit
    return undefined
}

export function extractCurrentVersion(root, item, config) {
    if (item.manager === 'npm') return extractNpm(root, item)
    if (item.manager === 'nuget') return extractNuget(root, item)
    if (item.manager === 'github-actions') return extractAction(root, item)
    if (item.manager === 'dockerfile' || item.manager === 'docker-compose') return extractDocker(root, item)
    if (item.manager === 'custom.regex') return extractCustom(root, item, config)
    if (item.manager === 'delegated') return extractDelegated(root, item)
    return undefined
}

export function extractCurrentVersions(root, catalog, config, errors = []) {
    const versions = {}
    for (const item of catalog.items ?? []) {
        try {
            const currentVersion = extractCurrentVersion(root, item, config)
            if (!currentVersion) {
                errors.push({ code: 'extract-current-version', detail: item.id })
                continue
            }
            versions[item.id] = {
                currentVersion,
                datasource: item.datasource,
                packageName: item.packageName
            }
        } catch (error) {
            errors.push({ code: 'extract-current-version', detail: `${item.id}:${error instanceof Error ? error.message : String(error)}` })
        }
    }
    return versions
}

export function currentSimulation(currentVersions, now) {
    const instant = now instanceof Date ? now.getTime() : now
    const registries = { byId: {} }
    for (const [id, snapshot] of Object.entries(currentVersions)) {
        const latest = {
            latestStable: snapshot.currentVersion.replace(/^[~^]/u, ''),
            releasedAt: new Date(instant - 60 * 60 * 1000).toISOString()
        }
        registries.byId[id] = latest
        const datasource = snapshot.datasource
        registries[datasource] ??= {}
        registries[datasource][snapshot.packageName] ??= latest
    }
    return { registries, pullRequests: [] }
}

export function validateExceptions(document, catalog, now, root) {
    const errors = []
    if (document?.schema !== exceptionsSchema) errors.push({ code: 'exception-schema', detail: document?.schema ?? '-' })
    if (!Array.isArray(document?.exceptions)) {
        errors.push({ code: 'exception-schema', detail: 'exceptions' })
        return errors
    }
    const catalogById = new Map((catalog.items ?? []).map(item => [item.id, item]))
    const ids = new Set()
    for (const record of document.exceptions) {
        const label = record?.id ?? JSON.stringify(record)
        if (ids.has(record?.id)) errors.push({ code: 'exception-duplicate-id', detail: label })
        ids.add(record?.id)
        for (const field of requiredExceptionFields) {
            if (record?.[field] === undefined || record?.[field] === '') errors.push({ code: 'exception-field', detail: `${label}:${field}` })
        }
        if (record?.group !== undefined || record?.manager !== undefined) errors.push({ code: 'exception-wildcard', detail: `${label}:group-or-manager` })
        if (wildcardPattern.test(record?.dependencyId ?? '') || wildcardPattern.test(record?.packageName ?? '') || record?.dependencyId === 'all') {
            errors.push({ code: 'exception-wildcard', detail: label })
        }
        if (!['general', 'vulnerability'].includes(record?.kind)) errors.push({ code: 'exception-kind', detail: label })
        const item = catalogById.get(record?.dependencyId)
        if (!item) errors.push({ code: 'exception-unknown-dependency', detail: label })
        else if (item.packageName !== record.packageName || item.datasource !== record.datasource) {
            errors.push({ code: 'exception-identity', detail: label })
        }
        const reason = String(record?.reason ?? '')
        if (forbiddenReasons.some(sample => reason.includes(sample))) errors.push({ code: 'exception-reason', detail: label })
        if (!record?.evidenceUrl && !record?.evidencePath) errors.push({ code: 'exception-evidence', detail: label })
        if (record?.evidenceUrl && !/^https:\/\/\S+$/u.test(record.evidenceUrl)) errors.push({ code: 'exception-evidence', detail: `${label}:url` })
        if (record?.evidencePath) {
            if (record.evidencePath.startsWith('/') || record.evidencePath.includes('..')) errors.push({ code: 'exception-evidence', detail: `${label}:path` })
            else if (root && !fs.existsSync(path.join(root, record.evidencePath))) errors.push({ code: 'exception-evidence', detail: `${label}:missing-path` })
        }
        const createdAt = parseInstant(record?.createdAt, `${label}:createdAt`, errors)
        const expiresAt = parseInstant(record?.expiresAt, `${label}:expiresAt`, errors)
        if (!Number.isNaN(createdAt) && !Number.isNaN(expiresAt)) {
            if (expiresAt <= createdAt) errors.push({ code: 'exception-ttl', detail: `${label}:order` })
            const maxMs = record?.kind === 'vulnerability' ? vulnerabilityMaxMs : generalMaxMs
            if (expiresAt - createdAt > maxMs) errors.push({ code: 'exception-ttl', detail: `${label}:${record.kind}` })
        }
        if (record?.targetVersion === undefined || record?.targetVersion === '') errors.push({ code: 'exception-target-missing', detail: label })
    }
    return errors
}

function coveringExceptions(records, item, latest, now) {
    return records.filter(record => {
        if (record.dependencyId !== item.id || record.datasource !== item.datasource || record.packageName !== item.packageName) return false
        if (record.group !== undefined || record.manager !== undefined) return false
        if (wildcardPattern.test(record.dependencyId ?? '') || wildcardPattern.test(record.packageName ?? '')) return false
        if (record.targetVersion !== latest) return false
        const createdAt = Date.parse(record.createdAt)
        const expiresAt = Date.parse(record.expiresAt)
        if (Number.isNaN(createdAt) || Number.isNaN(expiresAt) || createdAt > now || expiresAt <= now) return false
        const maxMs = record.kind === 'vulnerability' ? vulnerabilityMaxMs : generalMaxMs
        return expiresAt - createdAt <= maxMs && expiresAt > createdAt
    })
}

function coveringPullRequests(pullRequests, item, latest) {
    return pullRequests.filter(pullRequest => pullRequest.state === 'open'
        && pullRequest.targetVersion === latest
        && (pullRequest.dependencyId === item.id
            || (pullRequest.group === item.group && pullRequest.packageName === item.packageName)))
}

function closedPullRequests(pullRequests, item) {
    return pullRequests.filter(pullRequest => pullRequest.state !== 'open'
        && (pullRequest.dependencyId === item.id
            || (pullRequest.group === item.group && pullRequest.packageName === item.packageName)))
}

function updateTypesEnabled(config) {
    const updateRule = (config.packageRules ?? []).find(rule => Array.isArray(rule.matchUpdateTypes))
    const required = ['major', 'minor', 'patch', 'digest']
    return required.filter(updateType => !updateRule?.matchUpdateTypes?.includes(updateType))
}

function managerOwners(catalog) {
    const owners = new Map()
    for (const item of catalog.items ?? []) {
        for (const file of item.files ?? []) {
            const key = `${item.manager}:${item.packageName}:${file}:${item.fieldPaths?.[0] ?? item.customManager ?? ''}`
            const list = owners.get(key) ?? []
            list.push(item.id)
            owners.set(key, list)
        }
    }
    return owners
}

export function evaluateFreshness({ catalog, config, exceptions, currentVersions, registries, pullRequests, now, root }) {
    const errors = []
    const results = []
    const instant = typeof now === 'number' ? now : Date.parse(now)
    if (Number.isNaN(instant)) errors.push({ code: 'freshness-now', detail: String(now) })
    errors.push(...validateExceptions(exceptions, catalog, instant, root))
    if (registries == null) errors.push({ code: 'registry-network-error', detail: 'registry snapshot missing' })
    const missingUpdateTypes = updateTypesEnabled(config ?? {})
    for (const updateType of missingUpdateTypes) errors.push({ code: 'config-update-type', detail: updateType })
    if (config?.automerge === true) errors.push({ code: 'config-automerge', detail: 'automerge' })
    const enabledManagers = new Set(config?.enabledManagers ?? ['npm', 'nuget', 'dockerfile', 'docker-compose', 'github-actions', 'custom.regex'])
    const owners = managerOwners(catalog)
    for (const [key, ids] of owners) if (ids.length > 1) errors.push({ code: 'manager-duplicate-owner', detail: `${key}:${ids.join(',')}` })
    const seen = new Set()
    for (const item of catalog.items ?? []) {
        seen.add(item.id)
        const snapshot = currentVersions?.[item.id]
        const currentVersion = snapshot?.currentVersion
        if (!item.manager) errors.push({ code: 'manager-missing', detail: item.id })
        else if (item.manager !== 'delegated' && enabledManagers.size > 0 && !enabledManagers.has(item.manager)) {
            errors.push({ code: 'manager-missing', detail: item.id })
        }
        else if (item.manager === 'custom.regex' && !(config?.customManagers ?? []).some(manager => manager.description === item.customManager)) {
            errors.push({ code: 'manager-missing', detail: item.id })
        }
        else if (item.manager === 'delegated' && item.customManager !== 'fsusui-release-train') {
            errors.push({ code: 'manager-missing', detail: item.id })
        }
        if (!currentVersion) {
            errors.push({ code: 'extract-current-version', detail: item.id })
            results.push({ dependencyId: item.id, state: 'uncovered', currentVersion: null, latestStable: null, reason: 'extract-current-version' })
            continue
        }
        const registry = registries?.byId?.[item.id] ?? registries?.[item.datasource]?.[item.packageName]
        if (!registry) {
            errors.push({ code: 'registry-network-error', detail: `${item.id}:${item.datasource}:${item.packageName}` })
            results.push({ dependencyId: item.id, state: 'uncovered', currentVersion, latestStable: null, reason: 'registry-network-error' })
            continue
        }
        const latestStable = registry.latestStable
        const releasedAt = Date.parse(registry.releasedAt)
        if (!latestStable) {
            errors.push({ code: 'registry-latest-missing', detail: item.id })
            results.push({ dependencyId: item.id, state: 'uncovered', currentVersion, latestStable: null, reason: 'registry-latest-missing' })
            continue
        }
        const matches = []
        if (compareVersion(currentVersion, latestStable)) matches.push({ state: 'current' })
        const open = coveringPullRequests(pullRequests ?? [], item, latestStable)
        if (open.length > 0) matches.push({ state: 'latest-target-pr', prNumber: open[0].number })
        const active = coveringExceptions(exceptions?.exceptions ?? [], item, latestStable, instant)
        if (active.length > 0) matches.push({ state: 'exception', exceptionId: active[0].id })
        const staleExceptions = (exceptions?.exceptions ?? []).filter(record => record.dependencyId === item.id && record.targetVersion && record.targetVersion !== latestStable)
        if (matches.length === 1) {
            results.push({
                dependencyId: item.id,
                state: matches[0].state,
                currentVersion,
                latestStable,
                reason: matches[0].state,
                prNumber: matches[0].prNumber,
                exceptionId: matches[0].exceptionId
            })
            continue
        }
        if (matches.length > 1) {
            errors.push({ code: 'state-not-exact-one', detail: `${item.id}:${matches.map(match => match.state).join(',')}` })
            results.push({ dependencyId: item.id, state: 'uncovered', currentVersion, latestStable, reason: 'state-not-exact-one' })
            continue
        }
        const closed = closedPullRequests(pullRequests ?? [], item)
        if (closed.length > 0) errors.push({ code: 'pr-closed-without-successor', detail: item.id })
        if (staleExceptions.length > 0) errors.push({ code: 'exception-target-stale', detail: item.id })
        if (Number.isNaN(releasedAt)) errors.push({ code: 'registry-released-at-missing', detail: item.id })
        else if (instant - releasedAt > behindSlaMs) errors.push({ code: 'behind-over-24h', detail: item.id })
        else errors.push({ code: 'uncovered-behind', detail: item.id })
        results.push({ dependencyId: item.id, state: 'uncovered', currentVersion, latestStable, reason: 'uncovered-behind' })
    }
    return {
        schema: resultSchema,
        status: errors.length === 0 ? 'pass' : 'fail',
        now: new Date(instant).toISOString(),
        results,
        errors
    }
}
