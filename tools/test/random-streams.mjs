/**
 * @typedef {{ producerId: string; canonicalTestId: string; streamId: string; }} RandomConsumerIdentity
 * @typedef {RandomConsumerIdentity & { kind: 'property' | 'model' | 'fuzz' | 'fixture'; entrypoint: string; runner: string; runnerConfig: string; version: string; budget: { iterations: number; transitions: number; shrinks: number; }; receiptOwner: string; evidenceClass: 'correctness'; qualificationEligible: true; usesRandomness: true; randomStreams: string[]; }} RandomConsumer
 * @typedef {{ schema: string; consumers: RandomConsumer[]; nonRandomDeclarations: { producerId: string; canonicalTestId: string; entrypoint: string; randomStreams: string[]; }[]; nonSemanticEntropy: unknown[]; }} RandomStreamInventory
 * @typedef {Readonly<{ version: string; producerId: string; streamId: string; consumerTestId: string; seed: string; rootSeedDigest: string; derivedSeed: string; streamDigest: string; }>} RandomConsumerStream
 * @typedef {{ canonicalTestId: string; streamId: string; derivedSeed: string; runId: string; attemptId: string; replayPlanDigest: string; caseIdentities: string[]; transitionIdentities: string[]; outcome: 'passed'; }} RandomExecutionObservation
 * @typedef {{ consumer: RandomConsumer; stream: RandomConsumerStream; runId: string; attemptId: string; planDigest: string; }} RandomExecutionContext
 * @typedef {{ schema: string; producerId: string; canonicalTestId: string; kind: RandomConsumer['kind']; streamId: string; version: string; rootSeedDigest: string; derivedSeed: string; streamDigest: string; evidenceClass: 'correctness' | 'diagnostic'; qualificationEligible: boolean; budget: RandomConsumer['budget']; executedIterations: number; caseIdentities: string[]; transitionIdentities: string[]; shrinkSequenceIdentity: string | null; minimalSample: { digest: string; ref?: string; } | null; artifact: { digest: string; generationCount: number; ref?: string; } | null; outcome: 'passed' | 'failed'; firstFailure: { attempt: number; } | null; contentDigest: string; }} RandomStreamReceipt
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    canonicalDigest,
    canonicalJson,
    deriveReplayStream,
    resolveRootSeed,
    validateCanonicalTestId
} from './execution-replay-contract.mjs';

export const randomStreamInventorySchema = 'fsusblog.random-stream-consumers.v1';
export const randomStreamReceiptSchema = 'fsusblog.random-stream-receipt.v1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultInventoryFile = path.join(root, 'config/testing/random-stream-consumers.json');
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const consumerKinds = new Set(['property', 'model', 'fuzz', 'fixture']);

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function nonEmpty(value, label)
{
    assert(typeof value === 'string' && value.trim() === value && value.length > 0, `${label} must be a non-empty canonical string`);
    return value;
}

function exactKeys(value, allowed, label)
{
    assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
    for (const key of Object.keys(value))
    {
        assert(allowed.has(key), `${label} contains unsupported field ${key}`);
    }
}

function consumerKey(consumer)
{
    return `${consumer.producerId}\u0000${consumer.canonicalTestId}\u0000${consumer.streamId}`;
}

/**
 * @param {string} [file]
 * @returns {RandomStreamInventory}
 */
export function loadRandomStreamInventory(file = defaultInventoryFile)
{
    const document = JSON.parse(readFileSync(file, 'utf8'));
    validateRandomStreamInventory(document);
    return document;
}

/**
 * @param {unknown} document
 * @returns {RandomStreamInventory}
 */
export function validateRandomStreamInventory(document)
{
    exactKeys(document, new Set(['schema', 'consumers', 'nonRandomDeclarations', 'nonSemanticEntropy']), 'random stream inventory');
    assert(document.schema === randomStreamInventorySchema, `random stream inventory schema must be ${randomStreamInventorySchema}`);
    assert(Array.isArray(document.consumers) && document.consumers.length > 0, 'random stream inventory consumers must be non-empty');
    assert(Array.isArray(document.nonRandomDeclarations), 'random stream inventory nonRandomDeclarations must be an array');
    assert(Array.isArray(document.nonSemanticEntropy), 'random stream inventory nonSemanticEntropy must be an array');

    const keys = new Set();
    const streamOwners = new Set();
    for (const [index, consumer] of document.consumers.entries())
    {
        const label = `random stream inventory consumers[${index}]`;
        exactKeys(consumer, new Set([
            'producerId', 'canonicalTestId', 'kind', 'entrypoint', 'runner', 'runnerConfig',
            'streamId', 'version', 'budget', 'receiptOwner', 'evidenceClass',
            'qualificationEligible', 'usesRandomness', 'randomStreams'
        ]), label);
        nonEmpty(consumer.producerId, `${label}.producerId`);
        validateCanonicalTestId(nonEmpty(consumer.canonicalTestId, `${label}.canonicalTestId`));
        assert(consumerKinds.has(consumer.kind), `${label}.kind is unsupported`);
        nonEmpty(consumer.entrypoint, `${label}.entrypoint`);
        nonEmpty(consumer.runner, `${label}.runner`);
        nonEmpty(consumer.runnerConfig, `${label}.runnerConfig`);
        nonEmpty(consumer.streamId, `${label}.streamId`);
        nonEmpty(consumer.version, `${label}.version`);
        nonEmpty(consumer.receiptOwner, `${label}.receiptOwner`);
        assert(consumer.evidenceClass === 'correctness', `${label}.evidenceClass must be correctness`);
        assert(consumer.qualificationEligible === true, `${label}.qualificationEligible must be true`);
        assert(consumer.usesRandomness === true, `${label}.usesRandomness must be true`);
        assert(Array.isArray(consumer.randomStreams)
            && consumer.randomStreams.length === 1
            && consumer.randomStreams[0] === consumer.streamId,
        `${label}.randomStreams must exact-one declare its streamId`);
        exactKeys(consumer.budget, new Set(['iterations', 'transitions', 'shrinks']), `${label}.budget`);
        for (const field of ['iterations', 'transitions', 'shrinks'])
        {
            assert(Number.isInteger(consumer.budget[field]) && consumer.budget[field] >= 0, `${label}.budget.${field} must be a non-negative integer`);
        }
        assert(consumer.budget.iterations + consumer.budget.transitions > 0, `${label}.budget must preserve non-zero coverage`);

        const key = consumerKey(consumer);
        assert(!keys.has(key), `${label} duplicates producer/test/stream identity`);
        keys.add(key);
        const owner = `${consumer.producerId}\u0000${consumer.streamId}`;
        assert(!streamOwners.has(owner), `${label} duplicates streamId within producer ${consumer.producerId}`);
        streamOwners.add(owner);
    }

    for (const [index, declaration] of document.nonRandomDeclarations.entries())
    {
        const label = `random stream inventory nonRandomDeclarations[${index}]`;
        exactKeys(declaration, new Set(['producerId', 'canonicalTestId', 'entrypoint', 'randomStreams']), label);
        nonEmpty(declaration.producerId, `${label}.producerId`);
        validateCanonicalTestId(nonEmpty(declaration.canonicalTestId, `${label}.canonicalTestId`));
        nonEmpty(declaration.entrypoint, `${label}.entrypoint`);
        assert(Array.isArray(declaration.randomStreams) && declaration.randomStreams.length === 0,
            `${label}.randomStreams must be an explicit empty array`);
    }

    return document;
}

/**
 * @param {RandomStreamInventory} inventory
 * @param {RandomConsumerIdentity} identity
 * @returns {RandomConsumer}
 */
export function resolveRandomConsumer(inventory, { producerId, canonicalTestId, streamId })
{
    validateRandomStreamInventory(inventory);
    const matches = inventory.consumers.filter((consumer) => consumer.producerId === producerId
        && consumer.canonicalTestId === canonicalTestId
        && consumer.streamId === streamId);
    assert(matches.length === 1, `random consumer must resolve exact-one entry, got ${matches.length}`);
    return matches[0];
}

/**
 * @param {{ rootSeed: string; consumer: RandomConsumer; }} options
 * @returns {RandomConsumerStream}
 */
export function deriveRandomConsumerStream({ rootSeed, consumer })
{
    validateRandomStreamInventory({
        schema: randomStreamInventorySchema,
        consumers: [consumer],
        nonRandomDeclarations: [],
        nonSemanticEntropy: []
    });
    const stream = deriveReplayStream({
        rootSeed,
        producerId: consumer.producerId,
        canonicalTestId: consumer.canonicalTestId,
        streamId: consumer.streamId
    });
    return Object.freeze({
        ...stream,
        rootSeedDigest: canonicalDigest(rootSeed),
        derivedSeed: stream.seed,
        streamDigest: canonicalDigest(stream)
    });
}

/**
 * @param {string} seed
 * @returns {() => number}
 */
export function createDeterministicRandom(seed)
{
    nonEmpty(seed, 'derived seed');
    let state = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
    return () =>
    {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/**
 * @param {{ derivedSeed: string; caseIndex: number; value: unknown; }} options
 * @returns {string}
 */
export function deterministicCaseIdentity({ derivedSeed, caseIndex, value })
{
    assert(Number.isInteger(caseIndex) && caseIndex >= 0, 'caseIndex must be a non-negative integer');
    return canonicalDigest({ derivedSeed, caseIndex, value });
}

/**
 * @param {readonly unknown[]} items
 * @returns {string}
 */
export function deterministicSequenceIdentity(items)
{
    assert(Array.isArray(items), 'sequence identity input must be an array');
    return canonicalDigest(items);
}

// The child calls record only after the corresponding oracle has succeeded.
// A failed/incomplete child never publishes a completed execution document.
/**
 * @param {{ canonicalTestId: string; streamId: string; environment?: Record<string, string | undefined>; }} options
 * @returns {{ record(value: unknown): void; complete(): void; } | null}
 */
export function createRandomExecutionRecorder({ canonicalTestId, streamId, environment = process.env })
{
    if (!environment.FSUSBLOG_RANDOM_EXECUTION_DIR)
    {
        return null;
    }
    const seeds = JSON.parse(environment.FSUSBLOG_RANDOM_STREAMS_JSON ?? '{}');
    const derivedSeed = seeds[`${canonicalTestId}\u0000${streamId}`];
    assert(/^seed256:[a-f0-9]{64}$/u.test(derivedSeed ?? ''), 'child execution stream is missing');
    const caseIdentities = [];
    return {
        record(value)
        {
            caseIdentities.push(deterministicCaseIdentity({ derivedSeed, caseIndex: caseIdentities.length, value }));
        },
        complete()
        {
            assert(/^[a-z0-9-]+$/u.test(streamId), 'child execution stream filename is invalid');
            const document = {
                canonicalTestId, streamId, derivedSeed,
                runId: nonEmpty(environment.FSUSBLOG_RANDOM_EXECUTION_RUN, 'child run'),
                attemptId: nonEmpty(environment.FSUSBLOG_RANDOM_EXECUTION_ATTEMPT, 'child attempt'),
                replayPlanDigest: environment.FSUSBLOG_REPLAY_PLAN_DIGEST,
                caseIdentities, transitionIdentities: [], outcome: 'passed'
            };
            assert(sha256Pattern.test(document.replayPlanDigest ?? ''), 'child replay plan is missing');
            writeFileSync(path.join(environment.FSUSBLOG_RANDOM_EXECUTION_DIR, `${streamId}.json`),
                `${JSON.stringify(document)}\n`, { flag: 'wx' });
        }
    };
}

/**
 * Direct validation preserves the input type; digest tests can coerce element values.
 * @template T
 * @param {T} document
 * @param {RandomExecutionContext} context
 * @returns {T}
 */
export function validateRandomExecutionObservation(document, { consumer, stream, runId, attemptId, planDigest })
{
    const fields = ['canonicalTestId', 'streamId', 'derivedSeed', 'runId', 'attemptId',
        'replayPlanDigest', 'caseIdentities', 'transitionIdentities', 'outcome'];
    assert(document && Object.keys(document).sort().join('\0') === fields.sort().join('\0'),
        'child execution observation fields are not exact');
    for (const [field, expected] of Object.entries({ canonicalTestId: consumer.canonicalTestId,
        streamId: consumer.streamId, derivedSeed: stream.derivedSeed, runId, attemptId,
        replayPlanDigest: planDigest, outcome: 'passed' }))
    {
        assert(typeof expected === 'string' && expected.length > 0 && document[field] === expected,
            `child execution observation ${field} mismatch`);
    }
    for (const field of ['caseIdentities', 'transitionIdentities'])
    {
        const values = document[field];
        assert(Array.isArray(values) && values.every((value) => sha256Pattern.test(value))
            && new Set(values).size === values.length, `child execution observation ${field} is invalid`);
    }
    assert(document.caseIdentities.length >= consumer.budget.iterations,
        'child execution observation reduced iteration budget');
    assert(document.transitionIdentities.length >= consumer.budget.transitions,
        'child execution observation reduced transition budget');
    return document;
}

/**
 * @param {RandomExecutionContext & { binding: { streamId: string; ref: string; digest: string; }; directory: string; }} options
 * @returns {Omit<RandomExecutionObservation, 'caseIdentities' | 'transitionIdentities'> & { caseIdentities: unknown[]; transitionIdentities: unknown[]; }}
 */
export function readRandomExecutionObservation({ binding, directory, consumer, stream, runId, attemptId, planDigest })
{
    const expected = path.resolve(root, directory, `${consumer.streamId}.json`);
    const relative = path.relative(root, expected);
    assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        'child execution observation escapes repository');
    assert(binding?.streamId === consumer.streamId && path.resolve(root, binding.ref) === expected
        && realpathSync(expected) === expected, 'child execution observation path mismatch');
    const bytes = readFileSync(expected);
    assert(binding.digest === `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        'child execution observation bytes drifted');
    return validateRandomExecutionObservation(JSON.parse(bytes.toString('utf8')),
        { consumer, stream, runId, attemptId, planDigest });
}

/**
 * @param {{ consumer: RandomConsumer; stream: RandomConsumerStream; evidenceClass?: RandomStreamReceipt['evidenceClass']; qualificationEligible?: boolean; caseIdentities: string[]; transitionIdentities?: string[]; executedIterations: number; shrinkSequenceIdentity?: RandomStreamReceipt['shrinkSequenceIdentity']; minimalSample?: RandomStreamReceipt['minimalSample']; artifact?: RandomStreamReceipt['artifact']; outcome?: RandomStreamReceipt['outcome']; firstFailure?: RandomStreamReceipt['firstFailure']; }} options
 * @returns {RandomStreamReceipt}
 */
export function createRandomStreamReceipt({
    consumer,
    stream,
    evidenceClass = 'correctness',
    qualificationEligible = evidenceClass === 'correctness',
    caseIdentities,
    transitionIdentities = [],
    executedIterations,
    shrinkSequenceIdentity = null,
    minimalSample = null,
    artifact = null,
    outcome = 'passed',
    firstFailure = null
})
{
    const receipt = {
        schema: randomStreamReceiptSchema,
        producerId: consumer.producerId,
        canonicalTestId: consumer.canonicalTestId,
        kind: consumer.kind,
        streamId: consumer.streamId,
        version: consumer.version,
        rootSeedDigest: stream.rootSeedDigest,
        derivedSeed: stream.derivedSeed,
        streamDigest: stream.streamDigest,
        evidenceClass,
        qualificationEligible,
        budget: consumer.budget,
        executedIterations,
        caseIdentities,
        transitionIdentities,
        shrinkSequenceIdentity,
        minimalSample,
        artifact,
        outcome,
        firstFailure,
        contentDigest: null
    };
    receipt.contentDigest = canonicalDigest({ ...receipt, contentDigest: null });
    validateRandomStreamReceipt(receipt, { consumer, stream });
    return receipt;
}

/**
 * Validation preserves the caller's type without proving every nested receipt field.
 * @template T
 * @param {T} receipt
 * @param {{ consumer: RandomConsumer; stream: RandomConsumerStream; }} context
 * @returns {T}
 */
export function validateRandomStreamReceipt(receipt, { consumer, stream })
{
    exactKeys(receipt, new Set([
        'schema', 'producerId', 'canonicalTestId', 'kind', 'streamId', 'version',
        'rootSeedDigest', 'derivedSeed', 'streamDigest', 'evidenceClass',
        'qualificationEligible', 'budget', 'executedIterations', 'caseIdentities',
        'transitionIdentities', 'shrinkSequenceIdentity', 'minimalSample', 'artifact',
        'outcome', 'firstFailure', 'contentDigest'
    ]), 'random stream receipt');
    assert(receipt.schema === randomStreamReceiptSchema, `random stream receipt schema must be ${randomStreamReceiptSchema}`);
    for (const field of ['producerId', 'canonicalTestId', 'kind', 'streamId', 'version'])
    {
        assert(receipt[field] === consumer[field], `random stream receipt ${field} does not match inventory`);
    }
    for (const field of ['rootSeedDigest', 'derivedSeed', 'streamDigest'])
    {
        assert(receipt[field] === stream[field], `random stream receipt ${field} does not match sealed stream`);
    }
    assert(sha256Pattern.test(receipt.rootSeedDigest), 'random stream receipt rootSeedDigest is invalid');
    assert(sha256Pattern.test(receipt.streamDigest), 'random stream receipt streamDigest is invalid');
    assert(Array.isArray(receipt.caseIdentities), 'random stream receipt caseIdentities must be an array');
    assert(Array.isArray(receipt.transitionIdentities), 'random stream receipt transitionIdentities must be an array');
    assert(new Set(receipt.caseIdentities).size === receipt.caseIdentities.length, 'random stream receipt has duplicate case identities');
    assert(new Set(receipt.transitionIdentities).size === receipt.transitionIdentities.length, 'random stream receipt has duplicate transition identities');
    assert(Number.isInteger(receipt.executedIterations) && receipt.executedIterations >= 0,
        'random stream receipt executedIterations must be a non-negative integer');
    assert(['passed', 'failed'].includes(receipt.outcome), 'random stream receipt outcome is invalid');
    if (receipt.evidenceClass === 'correctness')
    {
        assert(receipt.qualificationEligible === true, 'correctness random stream receipt must be qualification eligible');
        assert(receipt.executedIterations >= consumer.budget.iterations, 'random stream receipt reduced the iteration budget');
        assert(receipt.transitionIdentities.length >= consumer.budget.transitions, 'random stream receipt reduced the transition budget');
    }
    else
    {
        assert(receipt.evidenceClass === 'diagnostic' && receipt.qualificationEligible === false,
            'non-correctness random stream receipt must be ineligible diagnostic evidence');
    }
    if (receipt.kind === 'fuzz' && receipt.outcome === 'failed')
    {
        assert(sha256Pattern.test(String(receipt.shrinkSequenceIdentity ?? '')), 'failed fuzz receipt shrink identity is missing');
        assert(receipt.minimalSample && sha256Pattern.test(String(receipt.minimalSample.digest ?? '')),
            'failed fuzz receipt minimal sample binding is missing');
        assert(receipt.firstFailure && receipt.firstFailure.attempt === 1,
            'failed fuzz receipt must preserve the first attempt');
    }
    if (receipt.artifact)
    {
        assert(sha256Pattern.test(String(receipt.artifact.digest ?? '')), 'random fixture artifact digest is invalid');
        assert(Number.isInteger(receipt.artifact.generationCount) && receipt.artifact.generationCount > 0,
            'random fixture generation count is invalid');
    }
    assert(receipt.contentDigest === canonicalDigest({ ...receipt, contentDigest: null }),
        'random stream receipt content digest mismatch');
    return receipt;
}

/**
 * @returns {{ rootSeed: string; rootSeedDigest: string; evidenceClass: 'diagnostic'; qualificationEligible: false; }}
 */
export function generateDiagnosticRootSeed()
{
    let emitted = null;
    const resolution = resolveRootSeed({
        mode: 'diagnostic',
        emitGenerated(rootSeed)
        {
            emitted = rootSeed;
        }
    });
    const rootSeed = resolution.rootSeed;
    assert(emitted === rootSeed, 'diagnostic root seed was not immediately emitted and sealed');
    return {
        rootSeed,
        rootSeedDigest: canonicalDigest(rootSeed),
        evidenceClass: 'diagnostic',
        qualificationEligible: false
    };
}

/**
 * @param {{ consumer: RandomConsumer; stream: RandomConsumerStream; payload: unknown; generationCount?: number; }} options
 * @returns {{ bytes: Buffer<ArrayBuffer>; digest: string; generationCount: number; }}
 */
export function deterministicFixtureArtifact({ consumer, stream, payload, generationCount = 1 })
{
    assert(consumer.kind === 'fixture', 'fixture artifact requires a fixture consumer');
    assert(Number.isInteger(generationCount) && generationCount > 0, 'fixture generationCount must be positive');
    const bytes = Buffer.from(canonicalJson({
        streamId: consumer.streamId,
        derivedSeed: stream.derivedSeed,
        generatorVersion: consumer.version,
        payload
    }));
    return {
        bytes,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        generationCount
    };
}
