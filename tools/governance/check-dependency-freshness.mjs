#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
    clone,
    currentSimulation,
    evaluateFreshness,
    extractCurrentVersions,
    resultSchema
} from './dependency-freshness.mjs'

const args = process.argv.slice(2)
const valueAfter = flag => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
}
const root = path.resolve(valueAfter('--root') ?? path.join(import.meta.dirname, '../..'))
const fixturePath = valueAfter('--fixtures') ?? process.env.FSUSBLOG_DEPS_FRESHNESS_FIXTURES
const nowValue = valueAfter('--now')
const outputPath = valueAfter('--output')
const readJson = file => JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(root, file), 'utf8'))

async function fetchJson(url, headers = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'fsusblog-deps-freshness', Accept: 'application/json', ...headers },
            signal: controller.signal
        })
        if (!response.ok) throw new Error(`${response.status} ${url}`)
        return await response.json()
    } finally {
        clearTimeout(timer)
    }
}

function githubHeaders() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    return token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' }
}

async function liveLatest(item) {
    if (item.datasource === 'npm') {
        const body = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(item.packageName)}`)
        const latest = body['dist-tags']?.latest
        if (!latest) throw new Error(`npm latest missing for ${item.packageName}`)
        return { latestStable: latest, releasedAt: body.time?.[latest] ?? new Date().toISOString() }
    }
    if (item.datasource === 'nuget') {
        const body = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${item.packageName.toLowerCase()}/index.json`)
        const versions = (body.versions ?? []).filter(version => !/[-]/u.test(version))
        const latest = versions.at(-1)
        if (!latest) throw new Error(`nuget latest missing for ${item.packageName}`)
        return { latestStable: latest, releasedAt: new Date().toISOString() }
    }
    if (item.datasource === 'node-version') {
        const body = await fetchJson('https://nodejs.org/dist/index.json')
        const latest = body.find(entry => entry.lts)?.version?.replace(/^v/u, '')
        if (!latest) throw new Error('node-version latest missing')
        return { latestStable: latest, releasedAt: new Date().toISOString() }
    }
    if (item.datasource === 'git-refs') {
        const repo = String(item.packageName).replace(/^https:\/\/github.com\//u, '').replace(/\.git$/u, '')
        const body = await fetchJson(`https://api.github.com/repos/${repo}/commits/master`, githubHeaders())
        if (!body.sha) throw new Error(`git-refs latest missing for ${item.packageName}`)
        return { latestStable: body.sha, releasedAt: body.commit?.committer?.date ?? new Date().toISOString() }
    }
    if (item.datasource === 'github-tags' || item.datasource === 'github-releases') {
        const body = await fetchJson(`https://api.github.com/repos/${item.packageName}/releases/latest`, githubHeaders())
        const latest = body.tag_name
        if (!latest) throw new Error(`github latest missing for ${item.packageName}`)
        return { latestStable: latest, releasedAt: body.published_at ?? new Date().toISOString() }
    }
    throw new Error(`unsupported live datasource ${item.datasource}`)
}

function parseRenovatePullRequests(pulls, catalog) {
    const items = catalog.items ?? []
    return pulls.flatMap(pull => {
        if (pull.user?.login !== 'renovate[bot]' && pull.user?.type !== 'Bot') return []
        return items.flatMap(item => {
            const mentionsPackage = `${pull.title ?? ''} ${pull.body ?? ''}`.includes(item.packageName)
            const versionMatch = /to (?:v)?(\S+)/u.exec(pull.title ?? '')
            if (!mentionsPackage || !versionMatch) return []
            return [{
                number: pull.number,
                state: pull.state,
                dependencyId: item.id,
                packageName: item.packageName,
                group: item.group,
                targetVersion: versionMatch[1]
            }]
        })
    })
}

async function loadLiveSnapshot(catalog, currentVersions) {
    const registries = { byId: {} }
    const settled = await Promise.allSettled((catalog.items ?? []).map(async item => {
        const latest = await liveLatest(item)
        registries.byId[item.id] = latest
        registries[item.datasource] ??= {}
        registries[item.datasource][item.packageName] ??= latest
    }))
    const failed = settled.filter(result => result.status === 'rejected')
    if (failed.length > 0) {
        throw new Error(failed.map(result => result.reason?.message ?? String(result.reason)).slice(0, 8).join('; '))
    }
    const repository = process.env.GITHUB_REPOSITORY || 'Ozwasyd/FsusBlog'
    const pulls = await fetchJson(`https://api.github.com/repos/${repository}/pulls?state=open&per_page=100`, githubHeaders())
    if (!Array.isArray(pulls)) throw new Error('github pull request payload is not an array')
    void currentVersions
    return { registries, pullRequests: parseRenovatePullRequests(pulls, catalog) }
}

function writeResult(result) {
    const payload = `${JSON.stringify(result, null, 4)}\n`
    if (outputPath) fs.writeFileSync(path.resolve(outputPath), payload)
    process.stdout.write(payload)
}

function enabledUpdateConfig(config) {
    const next = clone(config)
    if (!next.packageRules?.some(rule => Array.isArray(rule.matchUpdateTypes))) {
        next.packageRules = [
            ...(next.packageRules ?? []),
            { matchUpdateTypes: ['major', 'minor', 'patch', 'pin', 'digest', 'lockFileMaintenance'], enabled: true, automerge: false }
        ]
    }
    return next
}

function runCase(fixtureCase, repository) {
    const catalog = fixtureCase.useRepositoryCatalog ? repository.catalog : fixtureCase.catalog
    const config = enabledUpdateConfig(fixtureCase.config ?? repository.config)
    const exceptions = fixtureCase.exceptions ?? { schema: 'fsusblog.dependency-exceptions.v1', exceptions: [] }
    const now = Date.parse(fixtureCase.now ?? repository.now)
    const currentErrors = []
    const currentVersions = fixtureCase.currentVersions
        ?? extractCurrentVersions(root, catalog, config, currentErrors)
    const simulation = fixtureCase.useRepositoryCatalog && !fixtureCase.registries
        ? currentSimulation(currentVersions, now)
        : null
    const registries = fixtureCase.networkError ? null : (fixtureCase.registries ?? simulation?.registries ?? {})
    const pullRequests = fixtureCase.pullRequests ?? simulation?.pullRequests ?? []
    const evaluated = evaluateFreshness({
        catalog,
        config,
        exceptions,
        currentVersions,
        registries,
        pullRequests,
        now,
        root
    })
    evaluated.errors.push(...currentErrors)
    if (currentErrors.length > 0) evaluated.status = 'fail'
    evaluated.evidenceClass = 'local-controlled-simulation'
    evaluated.caseId = fixtureCase.id
    if (fixtureCase.mustEnumerate) {
        for (const id of fixtureCase.mustEnumerate) {
            if (!evaluated.results.some(result => result.dependencyId === id)) {
                evaluated.errors.push({ code: 'delegated-not-enumerated', detail: id })
                evaluated.status = 'fail'
            }
        }
    }
    const expectedStatus = fixtureCase.expectedStatus ?? (fixtureCase.expectedCode ? 'fail' : 'pass')
    if (evaluated.status !== expectedStatus) {
        evaluated.errors.push({ code: 'fixture-status', detail: `${fixtureCase.id}:${expectedStatus}:${evaluated.status}` })
        evaluated.status = 'fail'
    }
    if (fixtureCase.expectedCode && !evaluated.errors.some(error => error.code === fixtureCase.expectedCode)) {
        evaluated.errors.push({
            code: 'fixture-policy',
            detail: `${fixtureCase.id}:${fixtureCase.expectedCode}:${evaluated.errors.map(error => error.code).join(',') || '-'}`
        })
        evaluated.status = 'fail'
    }
    for (const [id, expected] of Object.entries(fixtureCase.expected ?? {})) {
        const actual = evaluated.results.find(result => result.dependencyId === id)
        if (actual?.state !== expected.state) {
            evaluated.errors.push({ code: 'fixture-state', detail: `${fixtureCase.id}:${id}:${expected.state}:${actual?.state ?? '-'}` })
            evaluated.status = 'fail'
        }
    }
    return evaluated
}

if (fixturePath) {
    const fixtures = JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'))
    if (fixtures.schema !== 'fsusblog.dependency-freshness-fixtures.v1') {
        writeResult({ schema: resultSchema, status: 'fail', errors: [{ code: 'fixture-schema', detail: fixtures.schema ?? '-' }] })
        process.exitCode = 1
    } else {
        const catalog = readJson('config/dependencies/update-surface.json')
        const config = readJson('renovate.json5')
        const now = fixtures.now ?? new Date().toISOString()
        const reports = []
        let failed = false
        for (const fixtureCase of fixtures.cases ?? []) {
            const evaluated = runCase(fixtureCase, { catalog, config, now })
            reports.push(evaluated)
            if (evaluated.status !== 'pass' && (fixtureCase.expectedStatus ?? 'pass') === 'pass') failed = true
            if (evaluated.errors.some(error => ['fixture-status', 'fixture-policy', 'fixture-state', 'fixture-schema'].includes(error.code))) failed = true
            if ((fixtureCase.expectedStatus ?? (fixtureCase.expectedCode ? 'fail' : 'pass')) === 'fail') {
                const policyOk = !evaluated.errors.some(error => ['fixture-status', 'fixture-policy', 'fixture-state'].includes(error.code))
                if (!policyOk) failed = true
            }
        }
        const result = {
            schema: resultSchema,
            status: failed ? 'fail' : 'pass',
            evidenceClass: 'local-controlled-simulation',
            now,
            cases: reports.map(report => ({
                id: report.caseId,
                status: report.errors.some(error => ['fixture-status', 'fixture-policy', 'fixture-state'].includes(error.code)) ? 'fail' : 'pass',
                dependencyCount: report.results.length,
                errors: report.errors.filter(error => ['fixture-status', 'fixture-policy', 'fixture-state'].includes(error.code))
            })),
            errors: reports.flatMap(report => report.errors.filter(error => ['fixture-status', 'fixture-policy', 'fixture-state', 'fixture-schema'].includes(error.code)))
        }
        if (result.status === 'fail') {
            for (const report of reports) {
                if (report.errors.some(error => ['fixture-status', 'fixture-policy', 'fixture-state'].includes(error.code))) {
                    for (const error of report.errors) console.error(`[${report.caseId}] [${error.code}] ${error.detail}`)
                }
            }
            process.exitCode = 1
        } else {
            console.error(`dependency freshness fixtures accepted (${reports.length} cases)`)
        }
        writeResult(result)
    }
} else {
    const catalog = readJson('config/dependencies/update-surface.json')
    const config = readJson('renovate.json5')
    const exceptions = readJson('config/dependencies/exceptions.json')
    const now = nowValue ? Date.parse(nowValue) : Date.now()
    const extractErrors = []
    const currentVersions = extractCurrentVersions(root, catalog, config, extractErrors)
    try {
        const liveSnapshot = await loadLiveSnapshot(catalog, currentVersions)
        const result = evaluateFreshness({
            catalog,
            config,
            exceptions,
            currentVersions,
            registries: liveSnapshot.registries,
            pullRequests: liveSnapshot.pullRequests,
            now,
            root
        })
        result.errors.push(...extractErrors)
        if (extractErrors.length > 0) result.status = 'fail'
        result.evidenceClass = 'live-registry'
        writeResult(result)
        if (result.status !== 'pass') process.exitCode = 1
    } catch (error) {
        const result = evaluateFreshness({
            catalog,
            config,
            exceptions,
            currentVersions,
            registries: null,
            pullRequests: [],
            now,
            root
        })
        result.errors.push(...extractErrors)
        result.errors.unshift({
            code: 'registry-network-error',
            detail: error instanceof Error ? error.message : String(error)
        })
        result.status = 'fail'
        result.evidenceClass = 'live-registry'
        writeResult(result)
        process.exitCode = 1
    }
}
