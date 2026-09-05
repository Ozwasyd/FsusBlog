#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const valueAfter = flag => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
}
const root = path.resolve(valueAfter('--root') ?? path.join(import.meta.dirname, '../..'))
const fixturePath = path.resolve(valueAfter('--fixtures') ?? path.join(root, 'tests/fixtures/governance/dependency-update-surface.json'))
const renovateRoot = path.resolve(valueAfter('--renovate-root') ?? '')
if (!renovateRoot || !fs.existsSync(path.join(renovateRoot, 'dist'))) {
    throw new Error('usage: check-renovate-controlled-simulation.mjs --renovate-root <renovate package root>')
}

const importRenovate = relative => import(pathToFileURL(path.join(renovateRoot, 'dist', relative)).href)
const [{ GlobalConfig }, renovateLogger, managerApi, npmExtract, regexExtract, { applyPackageRules }, { generateBranchName }, { doAutoReplace }] = await Promise.all([
    importRenovate('config/global.js'),
    importRenovate('logger/index.js'),
    importRenovate('modules/manager/index.js'),
    importRenovate('modules/manager/npm/extract/index.js'),
    importRenovate('modules/manager/custom/regex/index.js'),
    importRenovate('util/package-rules/index.js'),
    importRenovate('workers/repository/updates/branch-name.js'),
    importRenovate('workers/repository/update/branch/auto-replace.js')
])
await renovateLogger.init()

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const catalog = readJson(path.join(root, 'config/dependencies/update-surface.json'))
const config = readJson(path.join(root, 'renovate.json5'))
const fixtures = readJson(fixturePath)
const catalogById = new Map(catalog.items.map(item => [item.id, item]))
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-renovate-simulation-'))
GlobalConfig.set({ localDir: temporaryRoot, cacheDir: path.join(temporaryRoot, '.cache'), platform: 'local' })

function updateTypes(item) {
    if (item.manager === 'delegated') return []
    if (item.manager === 'npm') return ['major', 'minor', 'patch', 'pin']
    if (item.manager === 'nuget') return ['major', 'minor', 'patch']
    if (item.manager === 'github-actions') return ['digest']
    if (item.datasource === 'git-refs') return ['digest']
    if (item.datasource === 'docker') return ['major', 'minor', 'patch', 'digest']
    if (['npm', 'node-version', 'dotnet-version', 'github-releases'].includes(item.datasource)) return ['major', 'minor', 'patch']
    return []
}

function npmDocument(item, currentValue) {
    const fieldPath = item.fieldPaths[0]
    if (fieldPath === '/packageManager') return { name: 'controlled-renovate-simulation', version: '1.0.0', packageManager: `npm@${currentValue}` }
    if (fieldPath.startsWith('/overrides/')) {
        const tokens = fieldPath.split('/').slice(2).map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
        const overrides = {}
        let owner = overrides
        for (const token of tokens.slice(0, -1)) owner = owner[token] = {}
        owner[tokens.at(-1)] = currentValue
        return { name: 'controlled-renovate-simulation', version: '1.0.0', overrides }
    }
    const [section] = fieldPath.split('/').slice(1)
    return { name: 'controlled-renovate-simulation', version: '1.0.0', [section]: { [item.packageName]: currentValue } }
}

function sourceFor(item, updateType) {
    const currentValue = updateType === 'pin' ? '^1.2.3' : '1.2.3'
    if (item.manager === 'npm') return `${JSON.stringify(npmDocument(item, currentValue), null, 2)}\n`
    if (item.manager === 'nuget') return `<Project>\n  <ItemGroup>\n    <PackageVersion Include="${item.packageName}" Version="${currentValue}" />\n  </ItemGroup>\n</Project>\n`
    if (item.manager === 'dockerfile') return `FROM ${item.packageName}:${currentValue}@sha256:${'1'.repeat(64)}\n`
    if (item.manager === 'github-actions') return `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${item.packageName}@${'1'.repeat(40)} # v1\n`
    if (item.manager === 'custom.regex' && item.datasource === 'git-refs') return `vcpkgCommit: '${'1'.repeat(40)}'\n`
    throw new Error(`unsupported controlled source: ${item.id}`)
}

function extractionConfig(item) {
    if (item.manager !== 'custom.regex') return { registryAliases: {} }
    const manager = config.customManagers.find(candidate => candidate.description === item.customManager)
    if (!manager) throw new Error(`missing custom manager: ${item.id}:${item.customManager}`)
    return manager
}

function newVersion(updateType) {
    if (updateType === 'major') return '2.0.0'
    if (updateType === 'minor') return '1.3.0'
    if (updateType === 'patch') return '1.2.4'
    if (updateType === 'pin') return '1.2.3'
    return undefined
}

function derivedPaths(extraction) {
    const result = new Set(extraction.lockFiles ?? [])
    for (const value of Object.values(extraction.managerData ?? {})) {
        if (typeof value === 'string' && /(?:^|\/)(?:package-lock\.json|packages\.lock\.json)$/u.test(value)) result.add(value)
    }
    return [...result]
}

async function simulate(item, updateType) {
    const packageFile = item.files.find(file => !/(?:package-lock\.json|packages\.lock\.json)$/u.test(file))
    const source = sourceFor(item, updateType)
    const absoluteFile = path.join(temporaryRoot, packageFile)
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true })
    fs.writeFileSync(absoluteFile, source)
    if (item.manager === 'npm') {
        const lockFile = path.join(path.dirname(absoluteFile), 'package-lock.json')
        fs.writeFileSync(lockFile, `${JSON.stringify({ name: 'controlled-renovate-simulation', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'controlled-renovate-simulation', version: '1.0.0' } } }, null, 2)}\n`)
    }
    const extraction = item.manager === 'npm'
        ? await npmExtract.extractPackageFile(source, packageFile, { skipInstalls: true })
        : item.manager === 'custom.regex'
            ? await regexExtract.extractPackageFile(source, packageFile, extractionConfig(item))
            : await managerApi.extractPackageFile(item.manager, source, packageFile, extractionConfig(item))
    const depIndex = extraction?.deps?.findIndex(dep => (dep.packageName ?? dep.depName) === item.packageName || dep.depName === item.packageName) ?? -1
    if (depIndex < 0) throw new Error(`official extraction missed ${item.id}:${updateType}:${JSON.stringify(extraction?.deps?.map(dep => ({ depName: dep.depName, packageName: dep.packageName, depType: dep.depType })))}`)
    const dependency = extraction.deps[depIndex]
    const version = newVersion(updateType)
    let upgrade = {
        ...extraction,
        ...dependency,
        packageRules: config.packageRules,
        manager: item.manager,
        packageFile,
        packageName: dependency.packageName ?? dependency.depName,
        depIndex,
        updateType,
        newValue: version ?? dependency.currentValue,
        newVersion: version ?? dependency.currentVersion,
        newMajor: updateType === 'major' ? 2 : 1,
        newMinor: updateType === 'minor' ? 3 : 2,
        newDigest: updateType === 'digest' ? `sha256:${'2'.repeat(64)}` : undefined
    }
    if (item.manager === 'github-actions') upgrade.newDigest = '2'.repeat(40)
    if (item.datasource === 'git-refs') upgrade.newDigest = '2'.repeat(40)
    upgrade = await applyPackageRules(upgrade, 'controlled-simulation')
    if (upgrade.groupName !== item.group) throw new Error(`official packageRules grouped ${item.id}:${updateType} as ${upgrade.groupName ?? '-'}`)
    upgrade = {
        ...upgrade,
        branchPrefix: 'renovate/',
        branchName: '{{{branchPrefix}}}{{{branchTopic}}}',
        branchTopic: '{{{depNameSanitized}}}-{{{newValue}}}',
        depNameSanitized: item.id,
        separateMajorMinor: true,
        separateMultipleMajor: false,
        group: { branchTopic: '{{{groupSlug}}}' }
    }
    generateBranchName(upgrade)
    const expectedBranch = `renovate/${updateType === 'major' ? 'major-' : ''}${item.group}`
    if (upgrade.branchName !== expectedBranch) throw new Error(`official branch name drift ${item.id}:${updateType}:${upgrade.branchName}`)
    const updater = managerApi.get(item.manager, 'updateDependency')
    let updated
    try {
        updated = updater
            ? await updater({ fileContent: source, packageFile, upgrade })
            : await doAutoReplace({ ...upgrade, manager: item.manager === 'custom.regex' ? 'regex' : item.manager, baseDeps: extraction.deps }, source, false)
    } catch (error) {
        throw new Error(`official update failed ${item.id}:${updateType}:${JSON.stringify({ depName: upgrade.depName, packageName: upgrade.packageName, replaceString: upgrade.replaceString, currentValue: upgrade.currentValue, currentDigest: upgrade.currentDigest, newValue: upgrade.newValue, newDigest: upgrade.newDigest, matchStrings: upgrade.matchStrings, packageNameTemplate: upgrade.packageNameTemplate })}`, { cause: error })
    }
    if (!updated || updated === source) throw new Error(`official update produced no source change ${item.id}:${updateType}`)
    const paths = [packageFile, ...derivedPaths(extraction)]
    for (const changedPath of paths) if (!item.files.includes(changedPath)) throw new Error(`official update escaped catalog owner ${item.id}:${changedPath}`)
    return { group: item.group, updateType, branch: upgrade.branchName, changedPaths: paths }
}

function simulateDashboard() {
    return fixtures.dashboardSimulation.cases.map(sample => {
        const item = catalogById.get(sample.catalogItemId)
        if (!item) throw new Error(`unknown Dashboard catalog item: ${sample.catalogItemId}`)
        const versions = [...new Set(sample.availableVersions)]
        if (!versions.includes(sample.currentValue) || versions.length === 0) throw new Error(`invalid Dashboard controlled values: ${sample.id}`)
        return {
            group: item.group,
            target: sample.target,
            disposition: versions.length > 1 ? 'update-available' : 'up-to-date',
            evidenceClass: 'local-controlled-simulation'
        }
    })
}

try {
    const results = []
    const representatives = fixtures.simulationRepresentatives.map(id => {
        const item = catalogById.get(id)
        if (!item) throw new Error(`unknown simulation representative: ${id}`)
        return item
    })
    const requiredPairs = new Set(catalog.items.flatMap(item => updateTypes(item).map(updateType => `${item.group}:${updateType}`)))
    for (const pair of requiredPairs) {
        const [group, updateType] = pair.split(':')
        const item = representatives.find(candidate => candidate.group === group && updateTypes(candidate).includes(updateType))
        if (!item) throw new Error(`missing controlled simulation representative: ${pair}`)
        results.push(await simulate(item, updateType))
    }
    const groups = new Set(results.map(result => result.group))
    const catalogGroups = new Set(catalog.items.filter(item => updateTypes(item).length > 0).map(item => item.group))
    if (groups.size !== catalogGroups.size || [...catalogGroups].some(group => !groups.has(group))) throw new Error('controlled simulation does not cover every catalog group')
    const dashboardResults = simulateDashboard()
    const dashboardGroups = new Set(dashboardResults.map(result => result.group))
    if ([...catalogGroups].some(group => !dashboardGroups.has(group))) throw new Error('controlled Dashboard simulation does not cover every catalog group')
    console.log(`official Renovate controlled simulation accepted (${results.length} group/update-type cases, ${dashboardResults.length} Dashboard cases)`)
    for (const result of results) console.log(JSON.stringify(result))
    for (const result of dashboardResults) console.log(JSON.stringify(result))
} finally {
    GlobalConfig.reset()
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
