#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

export function validate(candidateCatalog, candidateConfig, { root, trackedFiles, discoverPackages, discoverExternalFields }) {
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
        if ((item.manager === 'custom.regex' || item.manager === 'delegated') && !item.customManager) report('catalog-custom-manager', item.id)
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
            && (!['custom.regex', 'delegated'].includes(field.manager) || item.customManager === field.customManager))
        const detail = `${field.manager}:${field.customManager ?? '-'}:${field.packageName}:${identity}`
        if (owners.length === 0) report('catalog-missing-field', detail)
        if (owners.length > 1) report('catalog-duplicate-owner', detail)
    }
    for (const [identity, managers] of fieldManagers) {
        if (managers.size > 1) report('manager-overlap', `${identity}:${[...managers].join(',')}`)
    }
    for (const item of (candidateCatalog.items ?? []).filter(candidate => ['custom.regex', 'dockerfile', 'docker-compose', 'delegated'].includes(candidate.manager))) {
        for (const file of item.files) {
            const matched = fields.some(field => field.manager === item.manager
                && field.packageName === item.packageName
                && field.file === file
                && (!['custom.regex', 'delegated'].includes(field.manager) || field.customManager === item.customManager))
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
    for (const item of candidateCatalog.items ?? []) {
        if (item.manager === 'delegated') continue
        if (!groups.has(item.group)) report('config-group-missing', `${item.id}:${item.group}`)
    }
    if (trackedFiles.some(file => /^\.github\/workflows\/.*renovate/iu.test(file))) report('config-self-hosted-workflow', 'self-hosted Renovate workflows are forbidden')
    return errors
}
