#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateReplayPlan } from './execution-replay-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function args(argv)
{
    const output = {}
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index]
        const value = argv[index + 1]
        if (!key?.startsWith('--') || value === undefined || Object.hasOwn(output, key))
        {
            throw new Error('replay command arguments must be unique --key value pairs')
        }
        output[key] = value
    }
    return output
}

function exact(actual, expected, label)
{
    if (actual !== expected)
    {
        throw new Error(`replay ${label} drift: expected ${expected}, got ${actual}`)
    }
}

try
{
    const options = args(process.argv.slice(2))
    const planPath = path.resolve(options['--plan'] ?? '')
    const relative = path.relative(root, planPath)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        throw new Error('replay plan path escapes repository')
    }
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    validateReplayPlan(plan)
    exact(options['--plan-digest'], plan.planDigest, 'plan digest')
    exact(options['--producer'], plan.producer.id, 'producer')
    exact(options['--root-seed'], plan.rootSeed, 'root seed')
    exact(options['--shard-digest'], plan.shardDigest, 'shard membership')
    exact(options['--workers'], plan.workers.ids.join(','), 'worker topology')
    exact(options['--scheduler-policy'], plan.schedulerReadyPolicy.kind, 'scheduler policy')
    exact(options['--scheduler-seed'], plan.schedulerShuffleSeed, 'scheduler seed')
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(options['--execution-envelope'] ?? '')))
    {
        throw new Error('replay execution envelope ref is invalid')
    }
    const child = spawn(plan.command.executable, plan.command.args, {
        cwd: root,
        env: {
            PATH: process.env.PATH,
            FSUSBLOG_REPLAY_PLAN: planPath,
            FSUSBLOG_REPLAY_PLAN_DIGEST: plan.planDigest,
            FSUSBLOG_REPLAY_ROOT_SEED: plan.rootSeed,
            FSUSBLOG_REPLAY_SHARD_DIGEST: plan.shardDigest,
            FSUSBLOG_REPLAY_WORKERS: plan.workers.ids.join(','),
            FSUSBLOG_REPLAY_SCHEDULER_POLICY: plan.schedulerReadyPolicy.kind,
            FSUSBLOG_REPLAY_SCHEDULER_SEED: options['--scheduler-seed'],
            FSUSBLOG_TEST_EXECUTION_ENVELOPE_REF: options['--execution-envelope']
        },
        stdio: 'inherit',
        shell: false
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
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
}
