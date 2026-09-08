import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { canonicalDigest } from '../../tools/test/execution-replay-contract.mjs'
import { reopenRandomizedProducerEvidence } from '../../tools/test/run-replay-qualification.mjs'
import { deriveRandomConsumerStream, loadRandomStreamInventory, validateRandomExecutionObservation,
    readRandomExecutionObservation } from '../../tools/test/random-streams.mjs'

const rootSeed = `seed256:${'2'.repeat(64)}`
const root = path.resolve(import.meta.dirname, '../..')

test('child records executed case identities and refuses incomplete stale or altered evidence', () =>
{
    const consumer = loadRandomStreamInventory().consumers.find((entry) => entry.streamId === 'frontend-moderation-unicode-samples')
    const stream = deriveRandomConsumerStream({ rootSeed, consumer })
    const context = { consumer, stream, runId: 'focused-run', attemptId: 'initial', planDigest: `sha256:${'3'.repeat(64)}` }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
    const directory = fs.mkdtempSync(path.join(root, '.tmp/random-child-focused-'))
    try
    {
        const program = `import { createRandomExecutionRecorder } from './tools/test/random-streams.mjs';
const recorder = createRandomExecutionRecorder(JSON.parse(process.env.CHILD_CONSUMER));
for (let index = 0; index < 129; index++) recorder.record({ input: index, actual: index * 2 });
recorder.complete();`
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
            cwd: root, encoding: 'utf8', env: { ...process.env,
                CHILD_CONSUMER: JSON.stringify(consumer),
                FSUSBLOG_RANDOM_STREAMS_JSON: JSON.stringify({ [`${consumer.canonicalTestId}\0${consumer.streamId}`]: stream.derivedSeed }),
                FSUSBLOG_RANDOM_EXECUTION_DIR: directory, FSUSBLOG_RANDOM_EXECUTION_RUN: context.runId,
                FSUSBLOG_RANDOM_EXECUTION_ATTEMPT: context.attemptId, FSUSBLOG_REPLAY_PLAN_DIGEST: context.planDigest }
        })
        assert.equal(result.status, 0, result.stderr)
        const file = path.join(directory, `${consumer.streamId}.json`)
        const bytes = fs.readFileSync(file)
        const binding = { streamId: consumer.streamId, ref: path.relative(root, file),
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
        const document = readRandomExecutionObservation({ ...context, directory, binding })
        assert.equal(document.caseIdentities.length, 129)
        const title = decodeURIComponent(consumer.canonicalTestId.split('#')[1])
        const resultFile = path.join(directory, 'vitest.json')
        fs.writeFileSync(resultFile, JSON.stringify({ testResults: [{ assertionResults: [
            { fullName: title, title, status: 'passed' }
        ] }] }))
        const processEvidence = { attemptId: context.attemptId, evidenceDirectory: directory,
            processes: [{ code: 0, signal: null, evidence: { kind: 'vitest-json', role: 'property',
                ref: path.relative(root, resultFile),
                digest: `sha256:${createHash('sha256').update(fs.readFileSync(resultFile)).digest('hex')}`,
                observations: [binding] } }],
            observationDigest: canonicalDigest({ schema: 'fsusblog.randomized-producer-attempt-observation.v1',
                producerId: consumer.producerId, semantics: [{ kind: 'vitest-json', role: 'property',
                    results: [{ name: title, title, outcome: 'passed' }] }] }) }
        const reopen = () => reopenRandomizedProducerEvidence({ producerId: consumer.producerId,
            consumers: [consumer], processEvidence,
            plan: { rootSeed, run: { id: context.runId }, planDigest: context.planDigest } })
        assert.deepEqual(reopen().bindings[0].caseIdentities, document.caseIdentities)
        assert.equal(reopen().bindings[0].caseIdentities.length, 129, 'actual execution count must not become inventory budget 128')
        for (const [field, value] of [['runId', 'stale'], ['attemptId', 'replay'],
            ['derivedSeed', `seed256:${'4'.repeat(64)}`], ['replayPlanDigest', `sha256:${'5'.repeat(64)}`],
            ['caseIdentities', document.caseIdentities.slice(2)],
            ['caseIdentities', Array(128).fill(document.caseIdentities[0])], ['outcome', 'failed']])
        {
            assert.throws(() => validateRandomExecutionObservation({ ...document, [field]: value }, context))
        }
        assert.throws(() => validateRandomExecutionObservation({ ...document, executedIterations: 128 }, context), /fields are not exact/u)
        assert.throws(() => readRandomExecutionObservation({ ...context, directory,
            binding: { ...binding, digest: `sha256:${'0'.repeat(64)}` } }), /bytes drifted/u)
        fs.unlinkSync(file)
        assert.throws(() => readRandomExecutionObservation({ ...context, directory, binding }))
        assert.throws(reopen, /ENOENT/u, 'passing Vitest results alone must not qualify')
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('randomized qualification derives every canonical consumer from one explicit root seed', () =>
{
    const inventory = loadRandomStreamInventory()
    assert.ok(inventory.consumers.length > 0)
    const first = inventory.consumers.map((consumer) => deriveRandomConsumerStream({ rootSeed, consumer }))
    const repeated = [...inventory.consumers].reverse()
        .map((consumer) => deriveRandomConsumerStream({ rootSeed, consumer }))
        .sort((left, right) => left.streamId.localeCompare(right.streamId))
    assert.equal(canonicalDigest(first.sort((left, right) => left.streamId.localeCompare(right.streamId))), canonicalDigest(repeated))
    assert.equal(new Set(first.map((stream) => stream.streamId)).size, inventory.consumers.length)
})
