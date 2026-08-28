#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
    REPLAY_PLAN_SCHEMA,
    REPLAY_RECEIPT_SCHEMA,
    canonicalDigest,
    canonicalTestId,
    planExactShards,
    sealReplayPlan,
    sealReplayReceipt,
    validateReplayPlan
} from './execution-replay-contract.mjs'
import { verifyExecutionReplay } from './execution-replay-verifier.mjs'
import { validatePlaywrightReplayDecision } from './playwright-replay-decision.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const playwrightPackage = path.join(root, 'src/frontend/node_modules/@playwright/test/package.json')
const playwrightCli = path.join(root, 'src/frontend/node_modules/@playwright/test/cli.js')
const decisionFile = path.join(root, 'config/testing/playwright-replay-decision.json')

function fail(message) { throw new Error(message) }

function parseArgs(argv)
{
    const values = new Map()
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index]
        if (!key?.startsWith('--') || argv[index + 1] === undefined) fail('invalid Playwright replay arguments')
        values.set(key.slice(2), [...(values.get(key.slice(2)) ?? []), argv[index + 1]])
    }
    return {
        one(name, required = true)
        {
            const found = values.get(name) ?? []
            if (found.length > 1) fail(`--${name} may appear only once`)
            if (required && found.length !== 1) fail(`missing --${name}`)
            return found[0]
        },
        many: (name) => values.get(name) ?? []
    }
}

function repoPath(file, label)
{
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${label} escapes repository`)
    return absolute
}

function sha256(file) { return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}` }

function run(executable, args, { cwd = root, env = process.env, capture = false } = {})
{
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) fail(`${executable} failed (${result.status}): ${result.stderr ?? ''}`)
    return result.stdout ?? ''
}

function atomicJson(file, value)
{
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.next-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temporary, file)
}

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')) }

function sourceIdentity(options)
{
    const commit = options.one('source-commit', false) ?? process.env.FSUSBLOG_TEST_SOURCE_COMMIT
        ?? run('git', ['rev-parse', 'HEAD'], { capture: true }).trim()
    const configured = options.one('worktree-fingerprint', false) ?? process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    if (configured) return { commit, worktreeFingerprint: configured.startsWith('sha256:') ? configured : `sha256:${configured}` }
    const diff = run('git', ['diff', '--binary', 'HEAD'], { capture: true })
    const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { capture: true })
        .split('\0').filter(Boolean).sort().map((file) => ({ file, content: readFileSync(path.join(root, file)).toString('base64') }))
    return { commit, worktreeFingerprint: canonicalDigest({ diff, untracked }) }
}

function validateDecision(config)
{
    const decision = readJson(decisionFile)
    const packageDocument = readJson(playwrightPackage)
    validatePlaywrightReplayDecision(decision, { expectedVersion: packageDocument.version, verifyFiles: true })
    const canonicalConfig = path.resolve(root, decision.configuration.configPath)
    if (config === canonicalConfig && sha256(config) !== decision.configuration.configDigest) fail('Playwright canonical config drifted from the selected decision')
    if (config === canonicalConfig)
    {
        const setup = path.resolve(root, decision.configuration.globalSetupPath)
        if (sha256(setup) !== decision.configuration.globalSetupDigest) fail('Playwright global setup drifted from the selected decision')
    }
    return decision
}

function flattenDiscovery(document, configDirectory)
{
    const entries = []
    function visitSuite(suite, parents = [])
    {
        const nextParents = suite.file ? parents : [...parents, suite.title]
        for (const spec of suite.specs ?? [])
        {
            for (const test of spec.tests ?? [])
            {
                const project = test.projectName || 'default'
                const absoluteFile = path.resolve(configDirectory, spec.file)
                const source = path.relative(root, absoluteFile).replaceAll(path.sep, '/')
                const titles = [...nextParents, spec.title].filter(Boolean)
                const canonical = canonicalTestId({ framework: 'playwright', source, name: [project, ...titles] })
                const listLine = `${test.projectName ? `[${test.projectName}] › ` : ''}${spec.file} › ${titles.join(' › ')}`
                entries.push({
                    canonicalTestId: canonical,
                    projectName: test.projectName,
                    file: absoluteFile,
                    relativeFile: spec.file,
                    titles,
                    specId: spec.id,
                    listLine
                })
            }
        }
        for (const child of suite.suites ?? []) visitSuite(child, nextParents)
    }
    for (const suite of document.suites ?? []) visitSuite(suite)
    if (document.errors?.length) fail(`Playwright discovery reported ${document.errors.length} errors`)
    if (entries.length === 0) fail('Playwright discovery returned no tests')
    return entries.sort((left, right) => Buffer.compare(Buffer.from(left.canonicalTestId), Buffer.from(right.canonicalTestId)))
}

function assignAtoms(entries, ids)
{
    const grouped = new Map()
    for (const entry of entries)
    {
        const key = `${entry.projectName}\0${entry.file}`
        grouped.set(key, [...(grouped.get(key) ?? []), entry])
    }
    if (ids.length > grouped.size) fail(`Playwright topology ${ids.length} exceeds project/file atoms ${grouped.size}`)
    const workers = ids.map((id) => ({ id, count: 0, atoms: [] }))
    const atoms = [...grouped.values()].map((tests) => ({ tests }))
        .sort((left, right) => left.tests[0].canonicalTestId.localeCompare(right.tests[0].canonicalTestId))
    for (const atom of atoms)
    {
        const worker = workers.reduce((best, candidate) => candidate.count < best.count ? candidate : best)
        worker.atoms.push(atom)
        worker.count += atom.tests.length
    }
    return workers
}

function makeManifest(plan, config, decision, assignments)
{
    const base = {
        schema: 'fsusblog.playwright-replay-queue-manifest.v1', planDigest: plan.planDigest,
        config, decisionDigest: decision.contentDigest,
        lanes: assignments.map((worker) => ({
            id: worker.id,
            tests: worker.atoms.flatMap((atom) => atom.tests.map((test) => ({
                canonicalTestId: test.canonicalTestId, projectName: test.projectName,
                file: test.file, relativeFile: test.relativeFile, titles: test.titles,
                specId: test.specId, listLine: test.listLine
            })))
        }))
    }
    return { ...base, contentDigest: canonicalDigest(base) }
}

function validateManifest(plan, manifest)
{
    const { contentDigest, ...base } = manifest
    if (manifest.schema !== 'fsusblog.playwright-replay-queue-manifest.v1'
        || manifest.planDigest !== plan.planDigest || contentDigest !== canonicalDigest(base)) fail('Playwright queue manifest is invalid')
    const ids = manifest.lanes.flatMap((lane) => lane.tests.map((test) => test.canonicalTestId)).sort()
    if (JSON.stringify(ids) !== JSON.stringify([...plan.testEnumerationOrder])) fail('Playwright queue membership drift')
    if (JSON.stringify(manifest.lanes.map((lane) => lane.id)) !== JSON.stringify(plan.workers.ids)) fail('Playwright lane topology drift')
}

function prepareSessions(laneCount)
{
    if (process.env.FSUSBLOG_TEST_SESSION_ISOLATION !== '1') return null
    const script = path.join(root, 'tests/frontend/fixtures/prepare-playwright-sessions.mjs')
    run(process.execPath, [script, '--workers', String(laneCount)], {
        env: { ...process.env, FSUSBLOG_PLAYWRIGHT_WORKERS: String(laneCount) }
    })
    return { script, workers: laneCount }
}

function spawnLane(plan, manifest, lane, outputDirectory)
{
    const listFile = path.join(outputDirectory, 'lanes', `${lane.id}.test-list.txt`)
    const reportFile = path.join(outputDirectory, 'lanes', `${lane.id}.json`)
    const artifactRoot = path.join(outputDirectory, 'artifacts', lane.id)
    mkdirSync(path.dirname(listFile), { recursive: true })
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(listFile, `${lane.tests.map((test) => test.listLine).join('\n')}\n`)
    const args = [playwrightCli, 'test', '--config', manifest.config, '--test-list', listFile,
        '--workers=1', '--retries=0', '--reporter=json']
    return new Promise((resolve, reject) =>
    {
        const child = spawn(process.execPath, args, {
            cwd: root,
            env: {
                ...process.env,
                FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
                FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP: '1',
                PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
                PLAYWRIGHT_OUTPUT_DIR: artifactRoot,
                FSUSBLOG_REPLAY_PLAN_DIGEST: plan.planDigest
            },
            stdio: ['ignore', 'inherit', 'inherit']
        })
        const pid = child.pid
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ lane, listFile, reportFile, artifactRoot, pid, code, signal }))
    })
}

function flattenActual(document, configDirectory, canonicalByIdentity)
{
    const outcomes = []
    function visitSuite(suite, parents = [])
    {
        const nextParents = suite.file ? parents : [...parents, suite.title]
        for (const spec of suite.specs ?? [])
        {
            for (const test of spec.tests ?? [])
            {
                const project = test.projectName || 'default'
                const source = path.relative(root, path.resolve(configDirectory, spec.file)).replaceAll(path.sep, '/')
                const titles = [...nextParents, spec.title].filter(Boolean)
                const identity = `${project}\0${source}\0${titles.join('\0')}`
                const canonical = canonicalByIdentity.get(identity) ?? fail(`Playwright emitted unknown test ${identity}`)
                for (const result of test.results ?? []) outcomes.push({
                    canonicalTestId: canonical, status: result.status, workerIndex: result.workerIndex,
                    parallelIndex: result.parallelIndex, retry: result.retry, duration: result.duration,
                    startTime: result.startTime, errors: result.errors, attachments: result.attachments
                })
            }
        }
        for (const child of suite.suites ?? []) visitSuite(child, nextParents)
    }
    for (const suite of document.suites ?? []) visitSuite(suite)
    return outcomes
}

async function execute(plan, manifest, outputDirectory)
{
    validateReplayPlan(plan)
    validateManifest(plan, manifest)
    const sessionPreparation = prepareSessions(manifest.lanes.length)
    const preDispatch = manifest.lanes.map((lane, ordinal) => ({
        ordinal, laneId: lane.id, testIds: lane.tests.map((test) => test.canonicalTestId),
        testListDigest: canonicalDigest(lane.tests.map((test) => test.listLine))
    }))
    const results = await Promise.all(manifest.lanes.map((lane) => spawnLane(plan, manifest, lane, outputDirectory)))
    const configDirectory = path.dirname(manifest.config)
    const canonicalByIdentity = new Map(manifest.lanes.flatMap((lane) => lane.tests.map((test) => [
        `${test.projectName || 'default'}\0${path.relative(root, test.file).replaceAll(path.sep, '/')}\0${test.titles.join('\0')}`,
        test.canonicalTestId
    ])))
    const lanes = results.map((result) =>
    {
        if (!Number.isInteger(result.pid)) fail(`Playwright lane ${result.lane.id} has no real process ID`)
        const report = readJson(result.reportFile)
        const outcomes = flattenActual(report, configDirectory, canonicalByIdentity)
        if (outcomes.some((outcome) => outcome.retry !== 0)) fail(`Playwright lane ${result.lane.id} observed an unplanned retry`)
        return { ...result, report, outcomes }
    })
    const actualIds = lanes.flatMap((lane) => lane.outcomes.map((outcome) => outcome.canonicalTestId)).sort()
    if (JSON.stringify(actualIds) !== JSON.stringify([...plan.testEnumerationOrder])) fail('Playwright actual set drift')
    const workers = lanes.map((lane) => ({ id: lane.lane.id, testIds: lane.outcomes.map((outcome) => outcome.canonicalTestId).sort() }))
    const workerByTest = new Map(workers.flatMap((worker) => worker.testIds.map((test) => [test, worker.id])))
    const shardByTest = new Map(plan.shards.flatMap((shard) => shard.testIds.map((test) => [test, shard.id])))
    const passed = lanes.every((lane) => lane.code === 0 && lane.signal === null && lane.report.stats?.unexpected === 0)
    const receipt = sealReplayReceipt({
        schema: REPLAY_RECEIPT_SCHEMA, source: plan.source, producer: plan.producer, run: plan.run,
        planDigest: plan.planDigest, rootSeed: plan.rootSeed, entropySources: plan.entropySources,
        randomStreams: plan.randomStreams, testIds: plan.testEnumerationOrder, shards: plan.shards, workers,
        admissionSequence: plan.testEnumerationOrder.map((testId, ordinal) => ({
            ordinal, testId, shardId: shardByTest.get(testId), workerId: workerByTest.get(testId)
        })),
        processOutcome: { status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, signal: null }
    })
    const actualBase = {
        schema: 'fsusblog.playwright-replay-actual.v1', planDigest: plan.planDigest, producerId: plan.producer.id,
        sourceCommit: plan.source.commit, worktreeFingerprint: plan.source.worktreeFingerprint,
        actualTestIds: plan.testEnumerationOrder, evidenceClass: 'correctness', qualificationEligible: passed,
        decisionDigest: manifest.decisionDigest, sessionPreparation, preDispatch,
        lanes: lanes.map((lane) => ({
            laneId: lane.lane.id, controllerProcessId: lane.pid, exitCode: lane.code, signal: lane.signal,
            workerRestarts: [...new Set(lane.outcomes.map((outcome) => outcome.workerIndex))],
            parallelSlots: [...new Set(lane.outcomes.map((outcome) => outcome.parallelIndex))],
            outcomes: lane.outcomes, artifactRoot: path.relative(root, lane.artifactRoot).replaceAll(path.sep, '/')
        })),
        semanticDigest: canonicalDigest(lanes.map((lane) => ({
            laneId: lane.lane.id,
            tests: lane.outcomes.map((outcome) => ({ canonicalTestId: outcome.canonicalTestId, status: outcome.status })).sort()
        }))),
        cleanup: { childrenExited: lanes.every((lane) => lane.code !== null || lane.signal !== null), residualProcessCount: 0 },
        contentDigest: null
    }
    const actual = { ...actualBase, contentDigest: canonicalDigest(actualBase) }
    atomicJson(path.join(outputDirectory, 'receipt.json'), receipt)
    atomicJson(path.join(outputDirectory, 'framework-actual.json'), actual)
    if (passed) atomicJson(path.join(outputDirectory, 'verification.json'), verifyExecutionReplay({ plan, receipt, frameworkActuals: [actual] }))
    return { passed }
}

async function create(options)
{
    const outputDirectory = repoPath(options.one('output-dir'), 'output directory')
    const config = repoPath(options.one('config'), 'Playwright config')
    const decision = validateDecision(config)
    const discoveryFile = path.join(outputDirectory, 'discovery.json')
    mkdirSync(outputDirectory, { recursive: true })
    const filters = options.many('file').map((file) => repoPath(file, 'Playwright file'))
    const discovery = run(process.execPath, [playwrightCli, 'test', '--config', config, ...filters, '--list', '--reporter=json'], { capture: true })
    writeFileSync(discoveryFile, discovery)
    const entries = flattenDiscovery(JSON.parse(discovery), path.dirname(config))
    const workerCount = Number(options.one('workers'))
    if (!Number.isInteger(workerCount) || workerCount < 1) fail('invalid Playwright workers')
    const ids = Array.from({ length: workerCount }, (_, index) => `playwright-lane-${index + 1}`)
    const assignment = planExactShards({ testIds: entries.map((entry) => entry.canonicalTestId), shardCount: workerCount })
    const planFile = path.join(outputDirectory, 'plan.json')
    const manifestFile = path.join(outputDirectory, 'queue-manifest.json')
    const plan = sealReplayPlan({
        schema: REPLAY_PLAN_SCHEMA, source: sourceIdentity(options),
        producer: { id: options.one('producer', false) ?? 'browser-playwright', framework: 'playwright' },
        run: { id: options.one('run-id'), mode: 'qualification' }, rootSeed: options.one('root-seed'),
        entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [], ...assignment,
        workers: { ids, assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [
            { name: 'adapter', value: 'repo-owned-n-lane' },
            { name: 'child-workers', value: '1' },
            { name: 'decision-digest', value: decision.contentDigest },
            { name: 'fully-parallel', value: 'true' },
            { name: 'runner-version', value: `playwright-${decision.playwright.version}` }
        ],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: options.one('scheduler-seed', false) ?? 'playwright-lane-order-v1',
        command: {
            executable: process.execPath,
            args: [path.join(root, 'tools/test/playwright-replay-adapter.mjs'), '--replay-plan', planFile,
                '--queue-manifest', manifestFile, '--output-dir', path.join(outputDirectory, 'replay')],
            environmentDigest: canonicalDigest({ inherited: ['PATH'], replayInputs: 'sealed-plan-environment' })
        }
    })
    const manifest = makeManifest(plan, config, decision, assignAtoms(entries, ids))
    atomicJson(planFile, plan)
    atomicJson(manifestFile, manifest)
    return execute(plan, manifest, path.join(outputDirectory, 'actual'))
}

async function replay(options)
{
    const plan = readJson(repoPath(options.one('replay-plan'), 'plan'))
    const manifest = readJson(repoPath(options.one('queue-manifest'), 'manifest'))
    validateDecision(manifest.config)
    for (const [actual, expected, label] of [
        [process.env.FSUSBLOG_REPLAY_PLAN_DIGEST, plan.planDigest, 'plan'],
        [process.env.FSUSBLOG_REPLAY_ROOT_SEED, plan.rootSeed, 'root seed'],
        [process.env.FSUSBLOG_REPLAY_WORKERS, plan.workers.ids.join(','), 'workers']
    ]) if (actual !== undefined && actual !== expected) fail(`Playwright replay ${label} drift`)
    return execute(plan, manifest, repoPath(options.one('output-dir'), 'output directory'))
}

try
{
    const options = parseArgs(process.argv.slice(2))
    const result = options.one('replay-plan', false) ? await replay(options) : await create(options)
    if (!result.passed) process.exitCode = 1
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
}
