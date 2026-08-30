#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { validate as validateCatalogAndConfig } from './dependency-update-surface-policy.mjs'

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

function discoverDelegatedFields() {
    const file = 'config/testing/fsusui-baseline.json'
    if (!trackedFiles.includes(file)) return []
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const match = /"commit"\s*:\s*"(?<currentDigest>[0-9a-f]{40})"/du.exec(source)
    if (!match?.indices?.groups?.currentDigest) return []
    return [{
        manager: 'delegated',
        customManager: 'fsusui-release-train',
        packageName: 'https://github.com/Ozwasyd/FsusUI.git',
        file,
        start: match.indices.groups.currentDigest[0],
        end: match.indices.groups.currentDigest[1]
    }]
}

function discoverExternalFields(candidateConfig) {
    return [
        ...discoverDockerfileFields(),
        ...discoverDockerComposeFields(candidateConfig),
        ...discoverCustomFields(candidateConfig),
        ...discoverDelegatedFields()
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

const validate = (candidateCatalog, candidateConfig) => validateCatalogAndConfig(candidateCatalog, candidateConfig, {
    root,
    trackedFiles,
    discoverPackages,
    discoverExternalFields
})

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
    if (item.manager === 'delegated') return []
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

function duplicateCatalogItem(candidateCatalog, id, duplicateId) {
    const duplicate = clone(candidateCatalog.items.find(item => item.id === id))
    duplicate.id = duplicateId
    candidateCatalog.items.push(duplicate)
}

const policyMutations = {
    'missing-catalog-item': catalog => catalog.items.shift(),
    'duplicate-id': catalog => { catalog.items[1].id = catalog.items[0].id },
    'missing-field-owner': catalog => { catalog.items = catalog.items.filter(item => item.id !== 'container-node-images') },
    'duplicate-field-owner': catalog => duplicateCatalogItem(catalog, 'container-node-images', 'container-node-images-duplicate-fixture'),
    'duplicate-custom-manager': (_catalog, config) => {
        const duplicate = clone(config.customManagers.find(item => item.description === 'setup-node workflow inputs'))
        duplicate.description = 'setup-node workflow inputs duplicate fixture'
        config.customManagers.push(duplicate)
    },
    'disabled-update': (_catalog, config) => { config.packageRules[0].enabled = false },
    'automerge': (_catalog, config) => { config.automerge = true },
    'prerelease': (_catalog, config) => { config.ignoreUnstable = false },
    'slow-schedule': (_catalog, config) => { config.schedule = ['* 0 * * 1'] },
    'missing-override-owner': catalog => { catalog.items = catalog.items.filter(item => item.id !== 'npm-glob-override-frontend') },
    'duplicate-override-owner': catalog => duplicateCatalogItem(catalog, 'npm-glob-override-frontend', 'npm-glob-override-frontend-duplicate-fixture'),
    'missing-npm-field-path': catalog => { delete catalog.items.find(item => item.id === 'npm-vue-frontend').fieldPaths },
    'missing-simulation-representative': (_catalog, _config, evidence) => evidence.simulationRepresentatives.shift(),
    'duplicate-simulation-id': (_catalog, _config, evidence) => { evidence.simulationRepresentatives[1] = evidence.simulationRepresentatives[0] },
    'missing-dashboard-group': (_catalog, _config, evidence) => {
        evidence.dashboardSimulation.cases = evidence.dashboardSimulation.cases.filter(item => item.target !== 'frontend-runtime')
    },
    'missing-dashboard-token-state': (_catalog, _config, evidence) => {
        evidence.dashboardSimulation.cases = evidence.dashboardSimulation.cases.filter(item => item.id !== 'actions-zero')
    },
    'invalid-dashboard-controlled-values': (_catalog, _config, evidence) => {
        evidence.dashboardSimulation.cases.find(item => item.id === 'actions-zero').availableVersions = []
    },
    'custom-versioning-drift': (_catalog, config) => {
        config.customManagers.find(item => item.description === 'Binaryen release projections').versioningTemplate = 'semver-coerced'
    },
    'recommended-preset': (_catalog, config) => { config.extends = ['config:recommended'] },
    'broad-ignore-path': (_catalog, config) => { config.ignorePaths = ['**/tests/**'] },
    'branch-automerge': (_catalog, config) => { config.packageRules[0].automergeType = 'branch' },
    'non-platform-automerge': (_catalog, config) => { config.packageRules[0].platformAutomerge = false },
    'missing-delegated-owner': catalog => { catalog.items = catalog.items.filter(item => item.id !== 'fsusui-baseline') }
}

let errors = validate(catalog, config)
errors.push(...validateRegexFixtures())
errors.push(...validateEvidence(catalog, config, fixtures))

for (const fixture of fixtures?.policyCases ?? []) {
    const fixtureCatalog = clone(catalog)
    const fixtureConfig = clone(config)
    const fixtureEvidence = clone(fixtures)
    policyMutations[fixture.mutation]?.(fixtureCatalog, fixtureConfig, fixtureEvidence)
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
