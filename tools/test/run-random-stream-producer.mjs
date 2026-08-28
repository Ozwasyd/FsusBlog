#!/usr/bin/env node

import { spawn } from 'node:child_process'

import { resolveRootSeed } from './execution-replay-contract.mjs'
import {
    deriveRandomConsumerStream,
    loadRandomStreamInventory
} from './random-streams.mjs'

function parseArguments(argv)
{
    const separator = argv.indexOf('--')
    if (separator < 0 || separator === argv.length - 1)
    {
        throw new Error('usage: run-random-stream-producer.mjs --producer <id> -- <command> [args...]')
    }
    const options = argv.slice(0, separator)
    if (options.length !== 2 || options[0] !== '--producer' || !options[1])
    {
        throw new Error('random stream producer requires exact-one --producer <id>')
    }
    return { producerId: options[1], command: argv.slice(separator + 1) }
}

function streamKey(consumer)
{
    return `${consumer.canonicalTestId}\u0000${consumer.streamId}`
}

async function main()
{
    const { producerId, command } = parseArguments(process.argv.slice(2))
    const inventory = loadRandomStreamInventory()
    const consumers = inventory.consumers.filter((consumer) => consumer.producerId === producerId)
    if (consumers.length === 0)
    {
        throw new Error(`random stream producer is not inventoried: ${producerId}`)
    }
    const explicitSeed = String(process.env.FSUSBLOG_REPLAY_ROOT_SEED ?? '').trim()
    const qualification = process.env.FSUSBLOG_REPLAY_MODE === 'qualification'
    const replayPlanDigest = String(process.env.FSUSBLOG_REPLAY_PLAN_DIGEST ?? '').trim()
    if (qualification && !/^sha256:[0-9a-f]{64}$/u.test(replayPlanDigest))
    {
        throw new Error('random stream qualification requires an explicit replay plan digest')
    }
    let generatedSeed = null
    const resolution = resolveRootSeed({
        cliSeed: explicitSeed || null,
        mode: qualification ? 'qualification' : 'diagnostic',
        emitGenerated(seed)
        {
            generatedSeed = seed
        }
    })
    if (generatedSeed)
    {
        process.stderr.write(`[random-stream] diagnostic root seed ${generatedSeed}\n`)
    }
    const streams = Object.fromEntries(consumers.map((consumer) =>
    {
        const stream = deriveRandomConsumerStream({ rootSeed: resolution.rootSeed, consumer })
        return [streamKey(consumer), stream.derivedSeed]
    }))
    const child = spawn(command[0], command.slice(1), {
        stdio: 'inherit',
        shell: false,
        env: {
            ...process.env,
            FSUSBLOG_RANDOM_STREAMS_JSON: JSON.stringify(streams),
            FSUSBLOG_REPLAY_ROOT_SEED: resolution.rootSeed,
            FSUSBLOG_REPLAY_EVIDENCE_CLASS: qualification ? 'correctness' : 'diagnostic'
        }
    })
    child.once('error', (error) =>
    {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
    })
    child.once('close', (code, signal) =>
    {
        process.exitCode = code ?? (signal ? 1 : 0)
    })
}

main().catch((error) =>
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
})
