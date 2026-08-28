import path from 'node:path'

import {
    canonicalDigest,
    canonicalJson,
    validateReplayBundle,
    validateReplayPlan,
    validateReplayReceipt
} from './execution-replay-contract.mjs'

export class ExecutionReplayMismatch extends Error
{
    constructor(pointer, expected, actual)
    {
        super(`execution replay mismatch at ${pointer}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`)
        this.name = 'ExecutionReplayMismatch'
        this.pointer = pointer
        this.expected = expected
        this.actual = actual
    }
}

function assert(condition, pointer, expected, actual)
{
    if (!condition)
    {
        throw new ExecutionReplayMismatch(pointer, expected, actual)
    }
}

function exact(expected, actual, pointer)
{
    if (canonicalJson(expected) !== canonicalJson(actual))
    {
        throw new ExecutionReplayMismatch(pointer, expected, actual)
    }
}

function shellQuote(value)
{
    return `'${String(value).replaceAll("'", `'\"'\"'`)}'`
}

function powershellQuote(value)
{
    return `'${String(value).replaceAll("'", "''")}'`
}

function secretLike(value)
{
    return /(?:password|passwd|secret|token|private[-_]?key|connection[-_]?string)=/iu.test(String(value))
}

export function buildExecutionReplayCommand({
    root,
    planPath,
    plan,
    schedulerShuffleSeed,
    executionEnvelopeRef
})
{
    validateReplayPlan(plan)
    const absolutePlan = path.resolve(planPath)
    const relative = path.relative(path.resolve(root), absolutePlan)
    assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        '$.replayCommand.planPath', 'repository-owned path', absolutePlan)
    assert(typeof schedulerShuffleSeed === 'string' && schedulerShuffleSeed.length > 0,
        '$.replayCommand.schedulerShuffleSeed', 'non-empty sealed seed', schedulerShuffleSeed)
    assert(schedulerShuffleSeed === plan.schedulerShuffleSeed,
        '$.replayCommand.schedulerShuffleSeed', plan.schedulerShuffleSeed, schedulerShuffleSeed)
    assert(typeof executionEnvelopeRef === 'string' && /^sha256:[0-9a-f]{64}$/u.test(executionEnvelopeRef),
        '$.replayCommand.executionEnvelopeRef', 'sha256 digest', executionEnvelopeRef)
    assert(!plan.command.args.some(secretLike), '$.plan.command.args', 'secret refs only', '<plaintext-secret>')

    const argv = [
        process.execPath,
        path.join(path.resolve(root), 'tools/test/replay-execution.mjs'),
        '--plan', absolutePlan,
        '--plan-digest', plan.planDigest,
        '--producer', plan.producer.id,
        '--root-seed', plan.rootSeed,
        '--shard-digest', plan.shardDigest,
        '--workers', plan.workers.ids.join(','),
        '--scheduler-policy', plan.schedulerReadyPolicy.kind,
        '--scheduler-seed', schedulerShuffleSeed,
        '--execution-envelope', executionEnvelopeRef
    ]
    return Object.freeze({
        argv: Object.freeze(argv),
        posix: argv.map(shellQuote).join(' '),
        powershell: argv.map(powershellQuote).join(' ')
    })
}

function verifyReceiptTopology(plan, receipt)
{
    exact(plan.testEnumerationOrder, receipt.testIds, '$.testIds')
    exact(plan.shards, receipt.shards, '$.shards')
    exact(plan.workers.ids, receipt.workers.map((worker) => worker.id), '$.workers.ids')
    const actualAdmission = receipt.admissionSequence.map((entry) => entry.testId)
    exact(plan.testEnumerationOrder, actualAdmission, '$.admissionSequence')
    const assignments = receipt.workers.flatMap((worker) => worker.testIds)
    assert(assignments.length === plan.testEnumerationOrder.length,
        '$.workers.assignments.length', plan.testEnumerationOrder.length, assignments.length)
}

function verifyFrameworkActuals(plan, frameworkActuals)
{
    assert(Array.isArray(frameworkActuals), '$.frameworkActuals', 'array', frameworkActuals)
    for (const [index, actual] of frameworkActuals.entries())
    {
        exact(plan.planDigest, actual.planDigest, `$.frameworkActuals/${index}/planDigest`)
        exact(plan.producer.id, actual.producerId, `$.frameworkActuals/${index}/producerId`)
        exact(plan.source.commit, actual.sourceCommit, `$.frameworkActuals/${index}/sourceCommit`)
        exact(plan.source.worktreeFingerprint, actual.worktreeFingerprint,
            `$.frameworkActuals/${index}/worktreeFingerprint`)
        exact(plan.testEnumerationOrder, actual.actualTestIds,
            `$.frameworkActuals/${index}/actualTestIds`)
        assert(actual.evidenceClass === 'correctness' && actual.qualificationEligible === true,
            `$.frameworkActuals/${index}/qualificationEligible`, true, actual.qualificationEligible)
        exact(actual.contentDigest, canonicalDigest({ ...actual, contentDigest: null }),
            `$.frameworkActuals/${index}/contentDigest`)
    }
}

function verifyRandomReceipts(plan, randomReceipts)
{
    assert(Array.isArray(randomReceipts), '$.randomReceipts', 'array', randomReceipts)
    const planned = new Map(plan.randomStreams.map((stream) => [stream.streamId, stream]))
    assert(randomReceipts.length === planned.size, '$.randomReceipts.length', planned.size, randomReceipts.length)
    for (const [index, receipt] of randomReceipts.entries())
    {
        const stream = planned.get(receipt.streamId)
        assert(stream !== undefined, `$.randomReceipts/${index}/streamId`, [...planned.keys()], receipt.streamId)
        exact(stream.seed, receipt.derivedSeed, `$.randomReceipts/${index}/derivedSeed`)
        assert(receipt.evidenceClass === 'correctness' && receipt.qualificationEligible === true,
            `$.randomReceipts/${index}/qualificationEligible`, true, receipt.qualificationEligible)
        exact(receipt.contentDigest, canonicalDigest({ ...receipt, contentDigest: null }),
            `$.randomReceipts/${index}/contentDigest`)
    }
}

export function verifyExecutionReplay({
    plan,
    receipt,
    frameworkActuals = [],
    schedulerActual = null,
    randomReceipts = []
})
{
    validateReplayPlan(plan)
    validateReplayReceipt(receipt)
    validateReplayBundle({ plan, receipt })
    assert(plan.run.mode === 'qualification' && receipt.run.mode === 'qualification',
        '$.run.mode', 'qualification', `${plan.run.mode}/${receipt.run.mode}`)
    verifyReceiptTopology(plan, receipt)
    verifyFrameworkActuals(plan, frameworkActuals)
    verifyRandomReceipts(plan, randomReceipts)
    if (schedulerActual)
    {
        exact(plan.planDigest, schedulerActual.planDigest, '$.schedulerActual.planDigest')
        assert(schedulerActual.outcome === 'success', '$.schedulerActual.outcome', 'success', schedulerActual.outcome)
        exact(schedulerActual.contentDigest, canonicalDigest({ ...schedulerActual, contentDigest: null }),
            '$.schedulerActual.contentDigest')
    }
    return Object.freeze({
        status: 'verified',
        planDigest: plan.planDigest,
        receiptDigest: receipt.receiptDigest,
        frameworkActualCount: frameworkActuals.length,
        randomReceiptCount: randomReceipts.length,
        schedulerActual: schedulerActual !== null,
        warnings: 0
    })
}
