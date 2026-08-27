import { canonicalDigest } from './execution-replay-contract.mjs'
import {
    createRandomStreamReceipt,
    deterministicCaseIdentity,
    deterministicSequenceIdentity
} from './random-streams.mjs'

export function createFuzzCaseReceipt({
    consumer,
    stream,
    cases,
    executedIterations,
    failure = null,
    evidenceClass = 'correctness'
})
{
    if (consumer.kind !== 'fuzz')
    {
        throw new Error('fuzz receipt requires a fuzz consumer')
    }
    if (!Array.isArray(cases) || cases.length !== executedIterations)
    {
        throw new Error('fuzz cases must exact match executedIterations')
    }
    const caseIdentities = cases.map((value, caseIndex) => deterministicCaseIdentity({
        derivedSeed: stream.derivedSeed,
        caseIndex,
        value
    }))
    const shrinkSequenceIdentity = failure
        ? deterministicSequenceIdentity(failure.shrinkSequence)
        : null
    const minimalSample = failure
        ? {
            ref: failure.minimalSampleRef,
            digest: canonicalDigest(failure.minimalSample)
        }
        : null
    return createRandomStreamReceipt({
        consumer,
        stream,
        evidenceClass,
        qualificationEligible: evidenceClass === 'correctness',
        caseIdentities,
        executedIterations,
        shrinkSequenceIdentity,
        minimalSample,
        outcome: failure ? 'failed' : 'passed',
        firstFailure: failure
            ? {
                attempt: 1,
                iteration: failure.iteration,
                caseIdentity: caseIdentities[failure.iteration],
                errorDigest: canonicalDigest(failure.error)
            }
            : null
    })
}

export function assertFuzzReplayBinding(original, replay)
{
    for (const field of [
        'producerId', 'canonicalTestId', 'streamId', 'rootSeedDigest', 'derivedSeed',
        'streamDigest', 'caseIdentities', 'shrinkSequenceIdentity', 'minimalSample',
        'firstFailure'
    ])
    {
        if (JSON.stringify(original?.[field]) !== JSON.stringify(replay?.[field]))
        {
            throw new Error(`fuzz replay mismatch at $.${field}`)
        }
    }
    return replay
}
