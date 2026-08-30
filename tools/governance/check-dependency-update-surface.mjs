#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const valueAfter = flag => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
}
const root = path.resolve(valueAfter('--root') ?? path.join(import.meta.dirname, '../..'))
const fixturePath = valueAfter('--fixtures')
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const clone = value => JSON.parse(JSON.stringify(value))

const catalog = readJson('config/dependencies/update-surface.json')
const config = readJson('renovate.json5')
const fixtures = fixturePath ? JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8')) : null

const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
const trackedFiles = tracked()

function configPattern(value) {
    const lastSlash = value.lastIndexOf('/')
    return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1))
}

function discoverCustomManagerFields(manager) {
    const result = []
    const patterns = manager.managerFilePatterns.map(configPattern)
    for (const file of trackedFiles.filter(item => patterns.some(pattern => pattern.test(item)))) {
        const source = fs.readFileSync(path.join(root, file), 'utf8')
        for (const matchString of manager.matchStrings) {
            const pattern = new RegExp(matchString.replaceAll('\\"', '"'), 'dgu')
            for (const match of source.matchAll(pattern)) {
                const packageName = manager.packageNameTemplate ?? manager.depNameTemplate ?? match.groups?.depName
                for (const field of ['currentValue', 'currentDigest']) {
                    const indices = match.indices?.groups?.[field]
                    if (!indices) continue
                    result.push({
                        manager: 'custom.regex',
                        customManager: manager.description,
                        packageName,
                        file,
                        start: indices[0],
                        end: indices[1]
                    })
                }
            }
        }
    }
    return result
}

function discoverCustomFields(candidateConfig) {
    return (candidateConfig.customManagers ?? []).flatMap(discoverCustomManagerFields)
}

function discoverDockerfileFileFields(file) {
    const result = []
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const args = new Map()
    for (const match of source.matchAll(/^ARG\s+([A-Z][A-Z0-9_]*)=([^\s]+)$/dgmu)) {
        args.set(match[1], { value: match[2], start: match.indices[2][0], end: match.indices[2][1] })
    }
    for (const match of source.matchAll(/^#\s*syntax=([^:@\s]+(?:\/[^:@\s]+)*):([^\s]+)$/dgmu)) {
        result.push({ manager: 'dockerfile', packageName: match[1], file, start: match.indices[2][0], end: match.indices[2][1] })
    }
    const seen = new Set()
    for (const match of source.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+[^\s]+)?$/dgmu)) {
        const reference = match[1]
        const depName = reference.split(':', 1)[0]
        if (!reference.includes(':') && !reference.includes('@')) continue
        for (const argument of reference.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/gu)) {
            if (!/(?:VERSION|DIGEST)$/u.test(argument[1])) continue
            const authority = args.get(argument[1])
            if (!authority) continue
            const key = `${depName}:${authority.start}:${authority.end}`
            if (seen.has(key)) continue
            seen.add(key)
            result.push({ manager: 'dockerfile', packageName: depName, file, start: authority.start, end: authority.end })
        }
        if (reference.includes('${')) continue
        const literal = /^(?<depName>[^:@\s]+(?:\/[^:@\s]+)*):(?<currentValue>[^@\s]+)(?:@(?<currentDigest>sha256:[0-9a-f]{64}))?$/du.exec(reference)
        if (!literal) continue
        const referenceStart = match.indices[1][0]
        for (const field of ['currentValue', 'currentDigest']) {
            const indices = literal.indices.groups[field]
            if (!indices) continue
            result.push({ manager: 'dockerfile', packageName: literal.groups.depName, file, start: referenceStart + indices[0], end: referenceStart + indices[1] })
        }
    }
    return result
}

function discoverDockerfileFields() {
    return trackedFiles
        .filter(item => /(?:^|\/)Dockerfile$/u.test(item) || /\.Dockerfile$/u.test(item))
        .flatMap(discoverDockerfileFileFields)
}

function discoverDockerComposeFields(candidateConfig) {
    const result = []
    const patterns = candidateConfig['docker-compose']?.managerFilePatterns?.map(configPattern) ?? [/(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/u]
    for (const file of trackedFiles.filter(item => patterns.some(pattern => pattern.test(item)))) {
        const source = fs.readFileSync(path.join(root, file), 'utf8')
        for (const match of source.matchAll(/^\s*image:\s*["']?(?<depName>[^\s:@"']+(?:\/[^\s:@"']+)*):(?<currentValue>[^\s@"']+)(?:@(?<currentDigest>sha256:[0-9a-f]{64}))?["']?\s*$/dgmu)) {
            for (const field of ['currentValue', 'currentDigest']) {
                const indices = match.indices.groups[field]
                if (!indices) continue
                result.push({ manager: 'docker-compose', packageName: match.groups.depName, file, start: indices[0], end: indices[1] })
            }
        }
    }
    return result
}

function discoverExternalFields(candidateConfig) {
    return [
        ...discoverDockerfileFields(),
        ...discoverDockerComposeFields(candidateConfig),
        ...discoverCustomFields(candidateConfig)
    ]
}

const pointerToken = value => value.replaceAll('~', '~0').replaceAll('/', '~1')

function overridePackageName(key) {
    if (key.startsWith('@')) {
        const selector = key.indexOf('@', key.indexOf('/') + 1)
        return selector < 0 ? key : key.slice(0, selector)
    }
    const selector = key.indexOf('@')
    return selector < 0 ? key : key.slice(0, selector)
}

function discoverNpmOverrides(overrides, file, pathTokens = ['overrides'], inheritedPackage) {
    const result = []
    for (const [key, value] of Object.entries(overrides ?? {})) {
        const packageName = key === '.' ? inheritedPackage : overridePackageName(key)
        const fieldPath = `/${[...pathTokens, pointerToken(key)].join('/')}`
        if (typeof value === 'string') {
            if (packageName && !value.startsWith('$')) result.push({ manager: 'npm', packageName, file, fieldPath })
            continue
        }
        if (value && typeof value === 'object') {
            result.push(...discoverNpmOverrides(value, file, [...pathTokens, pointerToken(key)], packageName))
        }
    }
    return result
}

function discoverPackages() {
    const result = []
    const excluded = new Set(catalog.exclusions.map(item => item.path))
    for (const file of trackedFiles.filter(item => item.endsWith('package.json'))) {
        if (excluded.has(file)) continue
        const manifest = readJson(file)
        if (/^npm@/u.test(manifest.packageManager ?? '')) {
            result.push({ manager: 'npm', packageName: 'npm', file, fieldPath: '/packageManager' })
        }
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
            for (const packageName of Object.keys(manifest[section] ?? {})) {
                result.push({ manager: 'npm', packageName, file, fieldPath: `/${section}/${pointerToken(packageName)}` })
            }
        }
        result.push(...discoverNpmOverrides(manifest.overrides, file))
    }

    const central = fs.readFileSync(path.join(root, 'Directory.Packages.props'), 'utf8')
    for (const match of central.matchAll(/<PackageVersion Include="([^"]+)" Version="[^"]+"\s*\/>/gu)) {
        result.push({ manager: 'nuget', packageName: match[1], file: 'Directory.Packages.props' })
    }
    const dotnetTools = readJson('.config/dotnet-tools.json')
    for (const packageName of Object.keys(dotnetTools.tools ?? {})) {
        result.push({ manager: 'nuget', packageName, file: '.config/dotnet-tools.json' })
    }

    const actionPattern = /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)?@[^\s#]+/gu
    for (const file of trackedFiles.filter(item => /^\.github\/(?:actions|workflows)\/.+\.ya?ml$/u.test(item))) {
        const source = fs.readFileSync(path.join(root, file), 'utf8')
        for (const match of source.matchAll(actionPattern)) {
            result.push({ manager: 'github-actions', packageName: match[1], file })
        }
    }
    return result
}

function validate(candidateCatalog, candidateConfig) {
    const errors = []
    const report = (code, detail) => errors.push({ code, detail })
    if (candidateCatalog.schema !== 'fsusblog.dependency-update-surface.v1') report('catalog-schema', 'unexpected schema')
    if (!Array.isArray(candidateCatalog.items) || candidateCatalog.items.length === 0) report('catalog-empty', 'items must not be empty')
    const ids = new Set()
    const required = ['id', 'datasource', 'packageName', 'manager', 'files', 'versioning', 'group', 'stabilityPolicy']
    for (const item of candidateCatalog.items ?? []) {
        if (ids.has(item.id)) report('catalog-duplicate-id', item.id)
        ids.add(item.id)
        for (const field of required) if (item[field] === undefined || item[field] === '' || (field === 'files' && !item.files.length)) report('catalog-field', `${item.id}:${field}`)
        if ('currentValue' in item || 'version' in item) report('catalog-current-version', item.id)
        if (item.manager === 'custom.regex' && !item.customManager) report('catalog-custom-manager', item.id)
        if (item.manager === 'npm' && !item.fieldPaths?.length) report('catalog-npm-field-path', item.id)
        for (const file of item.files ?? []) if (!fs.existsSync(path.join(root, file))) report('catalog-file-missing', `${item.id}:${file}`)
    }
    const exclusionPaths = new Set()
    for (const exclusion of candidateCatalog.exclusions ?? []) {
        if (!exclusion.path || !exclusion.reason) report('catalog-exclusion-field', JSON.stringify(exclusion))
        if (exclusionPaths.has(exclusion.path)) report('catalog-exclusion-duplicate', exclusion.path)
        exclusionPaths.add(exclusion.path)
    }
    for (const dependency of discoverPackages()) {
        const owners = (candidateCatalog.items ?? []).filter(item => item.manager === dependency.manager
            && item.packageName === dependency.packageName
            && item.files.includes(dependency.file)
            && (item.manager !== 'npm' || item.fieldPaths?.includes(dependency.fieldPath)))
        const detail = `${dependency.manager}:${dependency.packageName}:${dependency.file}:${dependency.fieldPath}`
        if (owners.length === 0) report('catalog-missing-package', detail)
        if (owners.length > 1) report('catalog-duplicate-owner', detail)
    }
    const packages = discoverPackages()
    for (const item of (candidateCatalog.items ?? []).filter(candidate => candidate.fieldPaths)) {
        for (const fieldPath of item.fieldPaths) {
            const matched = packages.some(dependency => dependency.manager === item.manager
                && dependency.packageName === item.packageName
                && item.files.includes(dependency.file)
                && dependency.fieldPath === fieldPath)
            if (!matched) report('catalog-unmatched-field-path', `${item.id}:${fieldPath}`)
        }
    }
    for (const lock of trackedFiles.filter(item => /(?:package-lock\.json|packages\.lock\.json)$/u.test(item))) {
        if (exclusionPaths.has(lock)) continue
        if (!(candidateCatalog.items ?? []).some(item => item.files.includes(lock))) report('catalog-missing-lock', lock)
    }

    const fields = discoverExternalFields(candidateConfig)
    const fieldManagers = new Map()
    for (const field of fields) {
        const identity = `${field.file}:${field.start}:${field.end}`
        const managers = fieldManagers.get(identity) ?? new Set()
        managers.add(`${field.manager}:${field.customManager ?? ''}`)
        fieldManagers.set(identity, managers)
        const owners = (candidateCatalog.items ?? []).filter(item => item.manager === field.manager
            && item.packageName === field.packageName
            && item.files.includes(field.file)
            && (field.manager !== 'custom.regex' || item.customManager === field.customManager))
        const detail = `${field.manager}:${field.customManager ?? '-'}:${field.packageName}:${identity}`
        if (owners.length === 0) report('catalog-missing-field', detail)
        if (owners.length > 1) report('catalog-duplicate-owner', detail)
    }
    for (const [identity, managers] of fieldManagers) {
        if (managers.size > 1) report('manager-overlap', `${identity}:${[...managers].join(',')}`)
    }
    for (const item of (candidateCatalog.items ?? []).filter(candidate => ['custom.regex', 'dockerfile', 'docker-compose'].includes(candidate.manager))) {
        for (const file of item.files) {
            const matched = fields.some(field => field.manager === item.manager
                && field.packageName === item.packageName
                && field.file === file
                && (field.manager !== 'custom.regex' || field.customManager === item.customManager))
            if (!matched) report('catalog-unmatched-file', `${item.id}:${file}`)
        }
    }
    for (const item of (candidateCatalog.items ?? []).filter(candidate => candidate.manager === 'custom.regex')) {
        const manager = candidateConfig.customManagers?.find(candidate => candidate.description === item.customManager)
        if (!manager) continue
        if (manager.datasourceTemplate !== item.datasource) report('config-custom-datasource', `${item.id}:${manager.datasourceTemplate ?? '-'}:${item.datasource}`)
        if (manager.versioningTemplate !== item.versioning) report('config-custom-versioning', `${item.id}:${manager.versioningTemplate ?? '-'}:${item.versioning}`)
    }

    if (candidateConfig.automerge !== false
        || candidateConfig.lockFileMaintenance?.automerge === true
        || candidateConfig.vulnerabilityAlerts?.automerge === true
        || candidateConfig.packageRules?.some(rule => rule.automerge === true)) report('config-automerge', 'automerge must remain false')
    const serialized = JSON.stringify(candidateConfig)
    if (serialized.includes('"enabled":false')) report('config-disabled-update', 'enabled:false is forbidden')
    if ('ignoreDeps' in candidateConfig) report('config-ignore-deps', 'ignoreDeps is forbidden')
    if (candidateConfig.ignoreUnstable !== true) report('config-prerelease', 'stable releases must be the default')
    if (candidateConfig.minimumReleaseAge !== '0 days') report('config-minimum-age', 'minimumReleaseAge must be zero')
    if (JSON.stringify(candidateConfig.schedule) !== JSON.stringify(['* 0,6,12,18 * * *'])) report('config-schedule', 'schedule must run every six hours')
    if (!candidateConfig.lockFileMaintenance?.enabled || JSON.stringify(candidateConfig.lockFileMaintenance.schedule) !== JSON.stringify(['* 5 * * *'])) report('config-lockfile-maintenance', 'daily lockfile maintenance is required')
    if (JSON.stringify(candidateConfig.vulnerabilityAlerts?.schedule) !== JSON.stringify(['at any time'])) report('config-vulnerability-schedule', 'vulnerability updates must be unscheduled')
    const forbiddenPresets = new Set(['config:recommended', 'config:best-practices', ':ignoreModulesAndTests', 'group:monorepos', 'group:recommended', 'workarounds:all'])
    for (const preset of candidateConfig.extends ?? []) if (forbiddenPresets.has(preset)) report('config-hidden-ignore-preset', preset)
    const exclusionFiles = new Set((candidateCatalog.exclusions ?? []).map(item => item.path).filter(item => !item.includes('#')))
    for (const ignorePath of candidateConfig.ignorePaths ?? []) {
        if (/[*?]|\*\*|\/(?:tests|test|fixtures|examples)(?:\/|$)/u.test(ignorePath) && !exclusionFiles.has(ignorePath)) report('config-broad-ignore-path', ignorePath)
        if (!exclusionFiles.has(ignorePath)) report('config-ignore-path-unregistered', ignorePath)
    }
    for (const exclusion of exclusionFiles) if (!(candidateConfig.ignorePaths ?? []).includes(exclusion)) report('config-exclusion-not-ignored', exclusion)
    const updateRule = candidateConfig.packageRules?.find(rule => Array.isArray(rule.matchUpdateTypes))
    for (const updateType of ['major', 'minor', 'patch', 'pin', 'digest', 'lockFileMaintenance']) if (!updateRule?.matchUpdateTypes.includes(updateType)) report('config-update-type', updateType)
    const groups = new Set(candidateConfig.packageRules?.map(rule => rule.groupName).filter(Boolean))
    for (const group of groups) if (['misc', 'other', 'ungrouped'].includes(group)) report('config-group-anonymous', group)
    for (const item of candidateCatalog.items ?? []) if (!groups.has(item.group)) report('config-group-missing', `${item.id}:${item.group}`)
    if (trackedFiles.some(file => /^\.github\/workflows\/.*renovate/iu.test(file))) report('config-self-hosted-workflow', 'self-hosted Renovate workflows are forbidden')
    return errors
}

function validateRegexFixtures() {
    const errors = []
    const managers = new Map(config.customManagers.map(manager => [manager.description, manager]))
    for (const fixture of fixtures?.regexCases ?? []) {
        const manager = managers.get(fixture.manager)
        if (!manager) {
            errors.push({ code: 'fixture-manager-missing', detail: fixture.manager })
            continue
        }
        const matches = sample => manager.matchStrings.reduce((count, pattern) => count + [...sample.matchAll(new RegExp(pattern, 'g'))].length, 0)
        if (matches(fixture.positive) !== 1) errors.push({ code: 'fixture-positive', detail: fixture.manager })
        if (matches(fixture.negative) !== 0) errors.push({ code: 'fixture-negative', detail: fixture.manager })
    }
    return errors
}

function applicableUpdateTypes(item) {
    if (item.manager === 'npm') return ['major', 'minor', 'patch', 'pin']
    if (item.manager === 'nuget') return ['major', 'minor', 'patch']
    if (item.manager === 'github-actions') return ['digest']
    if (item.datasource === 'git-refs') return ['digest']
    if (item.datasource === 'docker') return ['major', 'minor', 'patch', 'digest']
    if (['npm', 'node-version', 'dotnet-version', 'github-releases'].includes(item.datasource)) return ['major', 'minor', 'patch']
    return []
}

function validateSimulationRepresentatives(candidateCatalog, candidateConfig, candidateFixtures) {
    const errors = []
    const report = (code, detail) => errors.push({ code, detail })
    const catalogById = new Map((candidateCatalog.items ?? []).map(item => [item.id, item]))
    const representatives = []
    const representativeIds = new Set()
    const enabledUpdateTypes = new Set((candidateConfig.packageRules ?? []).flatMap(rule => rule.matchUpdateTypes ?? []))
    for (const id of candidateFixtures?.simulationRepresentatives ?? []) {
        const item = catalogById.get(id)
        if (!item) {
            report('fixture-simulation-catalog', id)
            continue
        }
        if (representativeIds.has(item.id)) report('fixture-simulation-duplicate-id', item.id)
        representativeIds.add(item.id)
        representatives.push(item)
        const updateTypes = applicableUpdateTypes(item)
        if (!updateTypes.length) report('fixture-simulation-manager', `${item.id}:${item.manager}:${item.datasource}`)
        for (const updateType of updateTypes) if (!enabledUpdateTypes.has(updateType)) report('fixture-simulation-disabled-type', `${item.id}:${updateType}`)
        if (item.manager === 'npm' && !item.fieldPaths?.length) report('fixture-simulation-field-path', item.id)
    }
    const requiredPairs = new Set((candidateCatalog.items ?? []).flatMap(item => applicableUpdateTypes(item).map(updateType => `${item.group}:${updateType}`)))
    const coveredPairs = new Set(representatives.flatMap(item => applicableUpdateTypes(item).map(updateType => `${item.group}:${updateType}`)))
    for (const pair of requiredPairs) if (!coveredPairs.has(pair)) report('fixture-simulation-pair-coverage', pair)
    return errors
}

function validateDashboardCases(candidateCatalog, candidateFixtures) {
    const errors = []
    const report = (code, detail) => errors.push({ code, detail })
    const dashboard = candidateFixtures?.dashboardSimulation
    if (dashboard?.evidenceClass !== 'local-controlled-simulation') report('fixture-dashboard-evidence-class', dashboard?.evidenceClass ?? '-')
    const catalogGroups = new Set((candidateCatalog.items ?? []).map(item => item.group))
    const dashboardGroups = new Set()
    const catalogById = new Map((candidateCatalog.items ?? []).map(item => [item.id, item]))
    const statesByTarget = new Map()
    const controlledTargets = new Set(dashboard?.tokenControlledTargets ?? [])
    for (const sample of dashboard?.cases ?? []) {
        if (sample.evidenceClass !== 'local-controlled-simulation') report('fixture-dashboard-evidence-class', sample.id)
        const item = catalogById.get(sample.catalogItemId)
        if (!item) {
            report('fixture-dashboard-catalog', sample.id)
            continue
        }
        dashboardGroups.add(item.group)
        if (!controlledTargets.has(sample.target) && sample.target !== item.group) report('fixture-dashboard-target', sample.id)
        const availableVersions = [...new Set(sample.availableVersions ?? [])]
        const controlledValuesValid = availableVersions.includes(sample.currentValue) && availableVersions.length >= 1
        if (!controlledValuesValid) report('fixture-dashboard-controlled-values', sample.id)
        const state = availableVersions.length > 1 ? 'available-update' : 'zero-update'
        const states = statesByTarget.get(sample.target) ?? []
        states.push(state)
        statesByTarget.set(sample.target, states)
    }
    for (const group of catalogGroups) if (!dashboardGroups.has(group)) report('fixture-dashboard-group', group)
    for (const target of dashboard?.tokenControlledTargets ?? []) {
        const states = statesByTarget.get(target)
        if (states?.filter(state => state === 'available-update').length !== 1
            || states.filter(state => state === 'zero-update').length !== 1) report('fixture-dashboard-token-states', target)
    }
    return errors
}

function validateEvidence(candidateCatalog, candidateConfig, candidateFixtures) {
    return [
        ...validateSimulationRepresentatives(candidateCatalog, candidateConfig, candidateFixtures),
        ...validateDashboardCases(candidateCatalog, candidateFixtures)
    ]
}

let errors = validate(catalog, config)
errors.push(...validateRegexFixtures())
errors.push(...validateEvidence(catalog, config, fixtures))
for (const fixture of fixtures?.policyCases ?? []) {
    const fixtureCatalog = clone(catalog)
    const fixtureConfig = clone(config)
    const fixtureEvidence = clone(fixtures)
    if (fixture.mutation === 'missing-catalog-item') fixtureCatalog.items.shift()
    if (fixture.mutation === 'duplicate-id') fixtureCatalog.items[1].id = fixtureCatalog.items[0].id
    if (fixture.mutation === 'missing-field-owner') fixtureCatalog.items = fixtureCatalog.items.filter(item => item.id !== 'container-node-images')
    if (fixture.mutation === 'duplicate-field-owner') {
        const duplicate = clone(fixtureCatalog.items.find(item => item.id === 'container-node-images'))
        duplicate.id = 'container-node-images-duplicate-fixture'
        fixtureCatalog.items.push(duplicate)
    }
    if (fixture.mutation === 'duplicate-custom-manager') {
        const duplicate = clone(fixtureConfig.customManagers.find(item => item.description === 'setup-node workflow inputs'))
        duplicate.description = 'setup-node workflow inputs duplicate fixture'
        fixtureConfig.customManagers.push(duplicate)
    }
    if (fixture.mutation === 'disabled-update') fixtureConfig.packageRules[0].enabled = false
    if (fixture.mutation === 'automerge') fixtureConfig.automerge = true
    if (fixture.mutation === 'prerelease') fixtureConfig.ignoreUnstable = false
    if (fixture.mutation === 'slow-schedule') fixtureConfig.schedule = ['* 0 * * 1']
    if (fixture.mutation === 'missing-override-owner') fixtureCatalog.items = fixtureCatalog.items.filter(item => item.id !== 'npm-glob-override-frontend')
    if (fixture.mutation === 'duplicate-override-owner') {
        const duplicate = clone(fixtureCatalog.items.find(item => item.id === 'npm-glob-override-frontend'))
        duplicate.id = 'npm-glob-override-frontend-duplicate-fixture'
        fixtureCatalog.items.push(duplicate)
    }
    if (fixture.mutation === 'missing-npm-field-path') delete fixtureCatalog.items.find(item => item.id === 'npm-vue-frontend').fieldPaths
    if (fixture.mutation === 'missing-simulation-representative') fixtureEvidence.simulationRepresentatives.shift()
    if (fixture.mutation === 'duplicate-simulation-id') fixtureEvidence.simulationRepresentatives[1] = fixtureEvidence.simulationRepresentatives[0]
    if (fixture.mutation === 'missing-dashboard-group') fixtureEvidence.dashboardSimulation.cases = fixtureEvidence.dashboardSimulation.cases.filter(item => item.target !== 'frontend-runtime')
    if (fixture.mutation === 'missing-dashboard-token-state') fixtureEvidence.dashboardSimulation.cases = fixtureEvidence.dashboardSimulation.cases.filter(item => item.id !== 'actions-zero')
    if (fixture.mutation === 'invalid-dashboard-controlled-values') fixtureEvidence.dashboardSimulation.cases.find(item => item.id === 'actions-zero').availableVersions = []
    if (fixture.mutation === 'custom-versioning-drift') fixtureConfig.customManagers.find(item => item.description === 'Binaryen release projections').versioningTemplate = 'semver-coerced'
    if (fixture.mutation === 'recommended-preset') fixtureConfig.extends = ['config:recommended']
    if (fixture.mutation === 'broad-ignore-path') fixtureConfig.ignorePaths = ['**/tests/**']
    if (fixture.mutation === 'automerge-lockfile') fixtureConfig.lockFileMaintenance.automerge = true
    const codes = [
        ...validate(fixtureCatalog, fixtureConfig),
        ...validateEvidence(fixtureCatalog, fixtureConfig, fixtureEvidence)
    ].map(error => error.code)
    if (!codes.includes(fixture.expectedCode)) errors.push({ code: 'fixture-policy', detail: `${fixture.id}:${fixture.expectedCode}` })
}

if (errors.length > 0) {
    for (const error of errors) console.error(`[${error.code}] ${error.detail}`)
    process.exitCode = 1
} else {
    console.log(`dependency update surface accepted (${catalog.items.length} items, ${catalog.exclusions.length} exclusions)`)
}
