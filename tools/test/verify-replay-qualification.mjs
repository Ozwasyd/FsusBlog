#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { canonicalDigest, canonicalJson, validateReplayPlan, validateReplayReceipt } from './execution-replay-contract.mjs'
import { deriveRandomConsumerStream, loadRandomStreamInventory, validateRandomStreamReceipt, readRandomExecutionObservation } from './random-streams.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fail(pointer, message) { throw new Error(`${pointer}: ${message}`) }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')) }
function owned(file, pointer)
{
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(pointer, 'path escapes repository')
    return absolute
}

function authority()
{
    const inventory = readJson(path.join(root, 'config/testing/replay-qualification-producers.json'))
    if (inventory.contentDigest !== canonicalDigest({ ...inventory, contentDigest: null })) fail('$.policy.producerInventoryDigest', 'inventory tamper')
    const random = loadRandomStreamInventory()
    return {
        inventory,
        random,
        framework: inventory.families.framework.map((producer) => producer.id).sort(),
        randomized: [...new Set(random.consumers.map((consumer) => consumer.producerId))].sort()
    }
}

function verifyFrameworkResult(result, pointer)
{
    const plan = readJson(owned(result.plan.ref, `${pointer}.plan.ref`))
    const actual = readJson(owned(result.actual.ref, `${pointer}.actual.ref`))
    const receipt = readJson(owned(result.receipt.ref, `${pointer}.receipt.ref`))
    const repeated = readJson(owned(result.repeatedActual.ref, `${pointer}.repeatedActual.ref`))
    validateReplayPlan(plan)
    validateReplayReceipt(receipt)
    if (plan.planDigest !== result.plan.digest || actual.contentDigest !== result.actual.digest
        || receipt.receiptDigest !== result.receipt.digest || repeated.contentDigest !== result.repeatedActual.digest)
        fail(pointer, 'referenced plan or actual digest mismatch')
    if (actual.contentDigest !== canonicalDigest({ ...actual, contentDigest: null })
        || repeated.contentDigest !== canonicalDigest({ ...repeated, contentDigest: null })) fail(pointer, 'actual content tamper')
    if (actual.semanticDigest !== repeated.semanticDigest || actual.semanticDigest !== result.semanticDigest)
        fail(`${pointer}.semanticDigest`, 'same-plan replay drift')
    if (canonicalJson(actual.actualTestIds) !== canonicalJson(plan.testEnumerationOrder)
        || canonicalJson(receipt.testIds) !== canonicalJson(plan.testEnumerationOrder)) fail(`${pointer}.actualTestIds`, 'membership drift')
}

function verifyRandomizedResult(result, pointer, randomInventory)
{
    const plan = result.plan.inline
    const receipt = result.receipt.inline
    validateReplayPlan(plan)
    validateReplayReceipt(receipt)
    if (plan.planDigest !== result.plan.digest || receipt.receiptDigest !== result.receipt.digest) fail(pointer, 'inline plan or receipt digest mismatch')
    const consumers = new Map(randomInventory.consumers.map((consumer) => [`${consumer.producerId}\0${consumer.streamId}`, consumer]))
    const expectedConsumers = randomInventory.consumers.filter((consumer) => consumer.producerId === result.producerId)
    for (const [attemptId, receipts] of [['initial', result.actual.inline], ['replay', result.repeatedActual.inline]])
    {
        const attempt = result.processEvidence?.[attemptId]
        if (attempt?.attemptId !== attemptId || !Array.isArray(attempt.processes)
            || attempt.processes.length === 0 || attempt.processes.some((entry) => entry.code !== 0 || entry.signal !== null))
            fail(pointer, 'child process attempt is missing or failed')
        const bindings = attempt.processes.flatMap((entry) => entry.evidence?.observations ?? [])
        const expectedIds = expectedConsumers.map((consumer) => consumer.streamId).sort()
        if (canonicalJson(bindings.map((entry) => entry.streamId).sort()) !== canonicalJson(expectedIds)
            || canonicalJson(receipts.map((entry) => entry.streamId).sort()) !== canonicalJson(expectedIds))
            fail(pointer, 'child execution observations do not exact-cover current consumers')
        for (const consumer of expectedConsumers)
        {
            const observation = readRandomExecutionObservation({
                binding: bindings.find((entry) => entry.streamId === consumer.streamId),
                directory: attempt.evidenceDirectory, consumer,
                stream: deriveRandomConsumerStream({ rootSeed: plan.rootSeed, consumer }),
                runId: plan.run.id, attemptId, planDigest: plan.planDigest
            })
            const randomReceipt = receipts.find((entry) => entry.streamId === consumer.streamId)
            if (randomReceipt.executedIterations !== observation.caseIdentities.length
                || canonicalJson(randomReceipt.caseIdentities) !== canonicalJson(observation.caseIdentities)
                || canonicalJson(randomReceipt.transitionIdentities) !== canonicalJson(observation.transitionIdentities))
                fail(pointer, 'random receipt differs from child executed cases')
        }
    }
    for (const [index, randomReceipt] of result.actual.inline.entries())
    {
        const consumer = consumers.get(`${randomReceipt.producerId}\0${randomReceipt.streamId}`)
            ?? fail(`${pointer}.actual.inline/${index}`, 'unknown random consumer')
        const stream = plan.randomStreams.find((candidate) => candidate.streamId === randomReceipt.streamId)
            ?? fail(`${pointer}.actual.inline/${index}.streamId`, 'stream absent from plan')
        const derived = deriveRandomConsumerStream({ rootSeed: plan.rootSeed, consumer })
        if (stream.seed !== derived.seed || randomReceipt.derivedSeed !== derived.derivedSeed
            || randomReceipt.rootSeedDigest !== derived.rootSeedDigest
            || randomReceipt.streamDigest !== derived.streamDigest)
            fail(`${pointer}.actual.inline/${index}`, 'root seed derivation drift')
        validateRandomStreamReceipt(randomReceipt, {
            consumer,
            stream: derived
        })
    }
    if (canonicalDigest(result.actual.inline) !== result.actual.digest
        || canonicalDigest(result.repeatedActual.inline) !== result.repeatedActual.digest
        || result.actual.digest !== result.repeatedActual.digest) fail(`${pointer}.actual`, 'random replay drift')
}

export function verifyReplayQualification(file)
{
    const receiptFile = owned(file, '$.receipt')
    const receipt = readJson(receiptFile)
    if (receipt.schema !== 'fsusblog.replay-qualification.v1' || receipt.status !== 'qualified'
        || receipt.contentDigest !== canonicalDigest({ ...receipt, contentDigest: null })) fail('$', 'aggregate schema, status or digest mismatch')
    if (receipt.producerSpawnCount !== 0) fail('$.producerSpawnCount', 'verify-only input reports producer spawn')
    const canonical = authority()
    if (receipt.policy.producerInventoryDigest !== canonical.inventory.contentDigest
        || receipt.policy.randomInventoryDigest !== canonicalDigest(canonical.random)
        || canonicalJson(receipt.policy.topologies) !== canonicalJson(canonical.inventory.topologies)
        || canonicalJson(receipt.policy.perturbations) !== canonicalJson(canonical.inventory.perturbations)) fail('$.policy', 'canonical policy drift')
    const expected = new Set([
        ...canonical.framework.flatMap((producer) => canonical.inventory.topologies.map((topology) => `framework\0${producer}\0${topology}`)),
        ...canonical.randomized.flatMap((producer) => canonical.inventory.topologies.map((topology) => `randomized\0${producer}\0${topology}`))
    ])
    const seen = new Set()
    for (const family of ['framework', 'randomized'])
    {
        const familyBinding = receipt.families[family]
        const familyFile = owned(familyBinding.ref, `$.families.${family}.ref`)
        const familyReceipt = readJson(familyFile)
        if (familyReceipt.contentDigest !== familyBinding.digest
            || familyReceipt.contentDigest !== canonicalDigest({ ...familyReceipt, contentDigest: null })) fail(`$.families.${family}`, 'family digest mismatch')
        for (const [index, binding] of familyBinding.results.entries())
        {
            const key = `${family}\0${binding.producerId}\0${binding.topology}`
            if (!expected.has(key) || seen.has(key)) fail(`$.families.${family}.results/${index}`, 'extra or duplicate result')
            seen.add(key)
            const result = readJson(owned(binding.ref, `$.families.${family}.results/${index}.ref`))
            if (result.contentDigest !== binding.digest || result.contentDigest !== canonicalDigest({ ...result, contentDigest: null })
                || result.status !== 'verified' || result.qualificationEligible !== true) fail(`$.families.${family}.results/${index}`, 'result digest or eligibility mismatch')
            if (canonicalJson(result.perturbations.map((item) => item.id)) !== canonicalJson(canonical.inventory.perturbations)
                || result.perturbations.some((item) => item.status !== 'observed')) fail(`$.families.${family}.results/${index}.perturbations`, 'evidence missing')
            if (family === 'framework') verifyFrameworkResult(result, `$.families.${family}.results/${index}`)
            else verifyRandomizedResult(result, `$.families.${family}.results/${index}`, canonical.random)
        }
    }
    if (seen.size !== expected.size) fail('$.families', 'required producer topology closure incomplete')
    if (receipt.unqualifiedCount !== 0 || receipt.diagnosticCount !== 0 || receipt.recoveredCount !== 0)
        fail('$.qualificationCounts', 'unqualified, diagnostic or recovered evidence present')
    return {
        schema: 'fsusblog.replay-qualification-verification.v1', status: 'verified',
        receipt: path.relative(root, receiptFile).replaceAll(path.sep, '/'),
        receiptDigest: receipt.contentDigest, producerCount: receipt.producerCount,
        topologyResultCount: seen.size, perturbationCoverage: canonical.inventory.perturbations,
        producerSpawnCount: 0, warnings: 0
    }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href)
{
    try
    {
        if (process.argv.length !== 3) fail('$.arguments', 'usage: verify-replay-qualification.mjs <receipt>')
        process.stdout.write(`${JSON.stringify(verifyReplayQualification(process.argv[2]), null, 2)}\n`)
    }
    catch (error)
    {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    }
}
