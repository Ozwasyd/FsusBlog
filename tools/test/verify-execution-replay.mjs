#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    buildExecutionReplayCommand,
    verifyExecutionReplay
} from './execution-replay-verifier.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(argv)
{
    const options = {}
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index]
        const value = argv[index + 1]
        if (!key?.startsWith('--') || value === undefined)
        {
            throw new Error('usage: verify-execution-replay.mjs --plan <path> --receipt <path> [--scheduler <path>] [--framework <path>] [--random <path>] --scheduler-seed <seed> --execution-envelope <digest>')
        }
        options[key.slice(2)] ??= []
        options[key.slice(2)].push(value)
    }
    return options
}

function readJson(file, label)
{
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        throw new Error(`${label} path escapes repository`)
    }
    return { absolute, document: JSON.parse(readFileSync(absolute, 'utf8')) }
}

try
{
    const args = parseArgs(process.argv.slice(2))
    const planInput = readJson(args.plan?.[0], 'plan')
    const receiptInput = readJson(args.receipt?.[0], 'receipt')
    const frameworkActuals = (args.framework ?? []).map((file) => readJson(file, 'framework actual').document)
    const randomReceipts = (args.random ?? []).map((file) => readJson(file, 'random receipt').document)
    const schedulerActual = args.scheduler ? readJson(args.scheduler[0], 'scheduler actual').document : null
    const verification = verifyExecutionReplay({
        plan: planInput.document,
        receipt: receiptInput.document,
        frameworkActuals,
        schedulerActual,
        randomReceipts
    })
    const replayCommand = buildExecutionReplayCommand({
        root,
        planPath: planInput.absolute,
        plan: planInput.document,
        schedulerShuffleSeed: args['scheduler-seed']?.[0],
        executionEnvelopeRef: args['execution-envelope']?.[0]
    })
    process.stdout.write(`${JSON.stringify({ ...verification, replayCommand: replayCommand.posix }, null, 2)}\n`)
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
}
