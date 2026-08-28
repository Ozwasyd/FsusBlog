#!/usr/bin/env node

import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { canonicalDigest, canonicalJson } from './execution-replay-contract.mjs'
import { loadRandomStreamInventory } from './random-streams.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const producerInventoryFile = path.join(root, 'config/testing/replay-qualification-producers.json')

function fail(pointer, message) { throw new Error(`${pointer}: ${message}`) }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')) }

function owned(file, pointer)
{
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(pointer, 'path escapes repository')
    return absolute
}

function parseArgs(argv)
{
    const values = new Map()
    for (let index = 0; index < argv.length; index += 2)
    {
        if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined || values.has(argv[index]))
            fail('$.arguments', 'arguments must be unique --key value pairs')
        values.set(argv[index], argv[index + 1])
    }
    const required = (name) => values.get(name) ?? fail(`$.arguments.${name.slice(2)}`, 'missing')
    return {
        framework: owned(required('--framework'), '$.arguments.framework'),
        randomized: owned(required('--randomized'), '$.arguments.randomized'),
        output: values.has('--out') ? owned(values.get('--out'), '$.arguments.out') : null
    }
}

function validateFamily(file, expectedFamily)
{
    const receipt = readJson(file)
    if (receipt.schema !== 'fsusblog.replay-family-qualification.v1'
        || receipt.family !== expectedFamily || receipt.status !== 'verified'
        || receipt.qualificationEligible !== true
        || receipt.contentDigest !== canonicalDigest({ ...receipt, contentDigest: null }))
        fail(`$.inputs.${expectedFamily}`, 'family receipt schema, status or digest mismatch')
    return receipt
}

function requiredAuthority()
{
    const inventory = readJson(producerInventoryFile)
    if (inventory.contentDigest !== canonicalDigest({ ...inventory, contentDigest: null })) fail('$.inventory', 'digest mismatch')
    const random = loadRandomStreamInventory()
    return {
        inventory,
        framework: inventory.families.framework.map((producer) => producer.id).sort(),
        randomized: [...new Set(random.consumers.map((consumer) => consumer.producerId))].sort(),
        topologies: inventory.topologies,
        perturbations: inventory.perturbations,
        randomInventoryDigest: canonicalDigest(random)
    }
}

function validateResults(family, requiredProducers, authority)
{
    if (canonicalJson(family.requiredProducers) !== canonicalJson(requiredProducers)
        || canonicalJson(family.requiredTopologies) !== canonicalJson(authority.topologies)
        || canonicalJson(family.requiredPerturbations) !== canonicalJson(authority.perturbations))
        fail(`$.families.${family.family}.closure`, 'required producer, topology or perturbation drift')
    const expected = new Set(requiredProducers.flatMap((producer) => authority.topologies.map((topology) => `${producer}\0${topology}`)))
    const found = new Set()
    const source = []
    const results = family.results.map((reference, index) =>
    {
        const key = `${reference.producerId}\0${reference.topology}`
        if (!expected.has(key) || found.has(key)) fail(`$.families.${family.family}.results/${index}`, 'extra or duplicate producer topology')
        found.add(key)
        const file = owned(reference.ref, `$.families.${family.family}.results/${index}.ref`)
        const result = readJson(file)
        if (result.schema !== 'fsusblog.replay-producer-qualification.v1'
            || result.family !== family.family || result.producerId !== reference.producerId
            || result.topology !== reference.topology || result.status !== 'verified'
            || result.qualificationEligible !== true || result.contentDigest !== reference.digest
            || result.contentDigest !== canonicalDigest({ ...result, contentDigest: null }))
            fail(`$.families.${family.family}.results/${index}`, 'result binding or digest mismatch')
        if (canonicalJson(result.perturbations.map((item) => item.id)) !== canonicalJson(authority.perturbations)
            || result.perturbations.some((item) => item.status !== 'observed'))
            fail(`$.families.${family.family}.results/${index}.perturbations`, 'coverage incomplete')
        if (result.firstFailure?.overwritten !== false) fail(`$.families.${family.family}.results/${index}.firstFailure`, 'first failure was overwritten')
        source.push(result.source)
        return { producerId: reference.producerId, topology: reference.topology, ref: reference.ref, digest: reference.digest }
    })
    if (found.size !== expected.size) fail(`$.families.${family.family}.results`, 'required producer topology missing')
    return { results, source }
}

function atomicJson(file, value)
{
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.next-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temporary, file)
}

export function aggregateReplayQualification({ frameworkFile, randomizedFile, outputFile = null })
{
    const authority = requiredAuthority()
    const framework = validateFamily(frameworkFile, 'framework')
    const randomized = validateFamily(randomizedFile, 'randomized')
    if (framework.runId !== randomized.runId) fail('$.runId', 'family run identity mismatch')
    if (framework.inventoryDigest !== authority.inventory.contentDigest
        || randomized.inventoryDigest !== authority.inventory.contentDigest
        || randomized.randomInventoryDigest !== authority.randomInventoryDigest)
        fail('$.inventoryDigest', 'family inventory binding mismatch')
    const frameworkResults = validateResults(framework, authority.framework, authority)
    const randomizedResults = validateResults(randomized, authority.randomized, authority)
    const sources = [...frameworkResults.source, ...randomizedResults.source]
    if (sources.length === 0 || sources.some((source) => canonicalJson(source) !== canonicalJson(sources[0])))
        fail('$.sourceState', 'producer source identity mismatch')
    const base = {
        schema: 'fsusblog.replay-qualification.v1', status: 'qualified', runId: framework.runId,
        sourceState: sources[0],
        policy: {
            producerInventoryDigest: authority.inventory.contentDigest,
            randomInventoryDigest: authority.randomInventoryDigest,
            topologies: authority.topologies,
            perturbations: authority.perturbations
        },
        families: {
            framework: {
                ref: path.relative(root, frameworkFile).replaceAll(path.sep, '/'),
                digest: framework.contentDigest,
                results: frameworkResults.results
            },
            randomized: {
                ref: path.relative(root, randomizedFile).replaceAll(path.sep, '/'),
                digest: randomized.contentDigest,
                results: randomizedResults.results
            }
        },
        producerIds: [...authority.framework, ...authority.randomized].sort(),
        producerCount: authority.framework.length + authority.randomized.length,
        topologyResultCount: frameworkResults.results.length + randomizedResults.results.length,
        perturbationCoverage: authority.perturbations,
        unqualifiedCount: 0,
        diagnosticCount: 0,
        recoveredCount: 0,
        producerSpawnCount: 0,
        contentDigest: null
    }
    const receipt = { ...base, contentDigest: canonicalDigest(base) }
    const destination = outputFile ?? path.join(root, `.tmp/test-runs/${framework.runId}/replay-qualification.json`)
    atomicJson(destination, receipt)
    return { receipt, destination }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href)
{
    try
    {
        const options = parseArgs(process.argv.slice(2))
        const result = aggregateReplayQualification({
            frameworkFile: options.framework,
            randomizedFile: options.randomized,
            outputFile: options.output
        })
        process.stdout.write(`${JSON.stringify({ ...result.receipt, output: path.relative(root, result.destination).replaceAll(path.sep, '/') }, null, 2)}\n`)
    }
    catch (error)
    {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    }
}
