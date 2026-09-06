import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    AttemptContractError,
    digestCanonical,
    validateAggregateAttemptReceipt
} from '../test/attempt-provenance.mjs';

export const cleanFirstAttemptVerdictSchema = 'fsusblog.clean-first-attempt-verdict.v1';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function safeRelativeReference(relative)
{
    return typeof relative === 'string'
        && relative.length > 0
        && !relative.includes('\\')
        && !/^[a-z]:/iu.test(relative)
        && !path.posix.isAbsolute(relative)
        && path.posix.normalize(relative) === relative
        && !relative.split('/').some((segment) => segment === '.' || segment === '..');
}

function transportEntryMap(entries)
{
    if (entries === undefined || entries === null)
    {
        return null;
    }
    if (!Array.isArray(entries) || entries.length === 0)
    {
        throw new AttemptContractError(
            'attempt.transport-manifest-invalid',
            'transport-backed attempt evidence requires a non-empty archive entry list'
        );
    }
    const mapped = new Map();
    for (const entry of entries)
    {
        if (!entry || typeof entry !== 'object'
            || !safeRelativeReference(entry.path)
            || !safeRelativeReference(entry.extractedPath)
            || !digestPattern.test(String(entry.digest ?? '')))
        {
            throw new AttemptContractError(
                'attempt.transport-manifest-invalid',
                'transport archive entries require safe paths and SHA-256 digests'
            );
        }
        for (const key of [entry.path, entry.extractedPath])
        {
            const existing = mapped.get(key);
            if (existing && (existing.extractedPath !== entry.extractedPath
                || existing.digest !== entry.digest))
            {
                throw new AttemptContractError(
                    'attempt.transport-manifest-invalid',
                    `transport archive path maps to conflicting entries: ${key}`,
                    { ref: key }
                );
            }
            mapped.set(key, entry);
        }
    }
    return mapped;
}

export function fileBackedCleanAttemptEvidence({
    evidenceRoot,
    aggregateReference,
    transportEntries = null
})
{
    let aggregateReceipt = null;
    let producerRoot = null;
    const transported = transportEntryMap(transportEntries);
    function readFile(relative, { json = false } = {})
    {
        if (typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)
            || fs.realpathSync(evidenceRoot) !== evidenceRoot
            || !safeRelativeReference(relative))
        {
            throw new AttemptContractError('attempt.artifact-reference-invalid',
                'attempt evidence requires a canonical root and relative reference', { ref: relative });
        }
        const transport = transported?.get(relative) ?? null;
        if (transported && !transport)
        {
            throw new AttemptContractError(
                'attempt.transport-unbound',
                'attempt evidence file is not present in the exact transport manifest',
                { ref: relative }
            );
        }
        const resolvedRelative = transport?.extractedPath ?? relative;
        const file = path.resolve(evidenceRoot, resolvedRelative);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file)
        {
            throw new AttemptContractError('attempt.artifact-reference-invalid',
                'attempt evidence must be a regular non-symlink file', { ref: relative });
        }
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try
        {
            const opened = fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino
                || (json && opened.size > 16 * 1024 * 1024))
            {
                throw new AttemptContractError('attempt.artifact-reference-invalid',
                    'attempt evidence changed identity or exceeds the receipt size limit', { ref: relative });
            }
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(64 * 1024);
            const chunks = [];
            let count;
            let total = 0;
            while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
            {
                total += count;
                if (json && total > 16 * 1024 * 1024)
                {
                    throw new AttemptContractError('attempt.artifact-reference-invalid',
                        'attempt receipt exceeds the size limit', { ref: relative });
                }
                hash.update(buffer.subarray(0, count));
                if (json) chunks.push(Buffer.from(buffer.subarray(0, count)));
            }
            const finished = fs.fstatSync(descriptor);
            const current = fs.lstatSync(file);
            if (finished.size !== opened.size || total !== opened.size
                || finished.mtimeMs !== opened.mtimeMs || finished.ctimeMs !== opened.ctimeMs
                || current.dev !== opened.dev || current.ino !== opened.ino
                || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs
                || current.ctimeMs !== opened.ctimeMs
                || current.isSymbolicLink() || fs.realpathSync(file) !== file)
            {
                throw new AttemptContractError('attempt.content-tamper',
                    'attempt evidence changed while being read', { ref: relative });
            }
            const actualDigest = `sha256:${hash.digest('hex')}`;
            if (transport && actualDigest !== transport.digest)
            {
                throw new AttemptContractError(
                    'attempt.transport-content-tamper',
                    'transport archive entry content digest does not match the extracted file',
                    { ref: relative, expected: transport.digest, actual: actualDigest }
                );
            }
            return {
                fileDigest: actualDigest,
                document: json ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
                resolvedRelative
            };
        }
        finally
        {
            fs.closeSync(descriptor);
        }
    }
    return {
        get aggregateReceipt() { return aggregateReceipt; },
        loadAggregate()
        {
            const loaded = readFile(aggregateReference?.path, { json: true });
            aggregateReceipt = loaded.document;
            if (loaded.fileDigest !== aggregateReference.fileDigest
                || aggregateReceipt?.contentDigest !== aggregateReference.digest)
            {
                throw new AttemptContractError('attempt.content-tamper',
                    'aggregate reference does not bind its file and content digests',
                    { ref: aggregateReference.path, field: 'aggregateReceipt',
                        expected: aggregateReference, actual: {
                            fileDigest: loaded.fileDigest, digest: aggregateReceipt?.contentDigest
                        } });
            }
            const directory = path.posix.dirname(loaded.resolvedRelative);
            producerRoot = directory === '.' ? '' : `${directory}/`;
            return aggregateReceipt;
        },
        loadAttempt(reference)
        {
            const loaded = readFile(`${producerRoot}${reference.path}`, { json: true });
            const unsigned = { ...loaded.document };
            delete unsigned.contentDigest;
            if (digestCanonical(unsigned) !== reference.digest)
            {
                throw new AttemptContractError('attempt.content-tamper',
                    'attempt reference does not bind its file content', { ref: reference.path });
            }
            return loaded.document;
        },
        verifyArtifact(relative, digest, receipt)
        {
            return readFile(`${producerRoot}attempt-${receipt.attemptNumber}/${relative}`).fileDigest === digest;
        }
    };
}

function context(receipt)
{
    return {
        producerId: receipt?.producerId ?? null,
        schedulerRunId: receipt?.schedulerRunId ?? null,
        sourceCommit: receipt?.sourceCommit ?? null
    };
}

function reason(code, message, receipt, details = {})
{
    return Object.freeze({
        code,
        message,
        ...context(receipt),
        ...details
    });
}

function mismatch(receipt, field, expected, actual)
{
    return reason(
        'attempt.consumer-identity-mismatch',
        `${receipt?.producerId ?? 'unknown producer'}/${receipt?.schedulerRunId ?? 'unknown run'} ${field} expected ${expected}, got ${actual}`,
        receipt,
        { field, expected, actual }
    );
}

export class CleanFirstAttemptAdmissionError extends Error
{
    constructor(verdict)
    {
        super(verdict.reasons.map((item) => `${item.code}: ${item.message}`).join('; '));
        this.name = 'CleanFirstAttemptAdmissionError';
        this.verdict = verdict;
        this.reasons = verdict.reasons;
    }
}

export function cleanFirstAttemptVerdict({
    aggregateReceipt,
    loadAggregate,
    loadAttempt,
    verifyAuthority,
    verifyArtifact,
    expectedIdentity = {}
})
{
    let aggregate;
    try
    {
        if (loadAggregate !== undefined)
        {
            if (typeof loadAggregate !== 'function')
                throw new AttemptContractError('attempt.aggregate-invalid', 'aggregate loader must be a function');
            aggregateReceipt = loadAggregate();
        }
        if (typeof verifyArtifact !== 'function')
        {
            throw new AttemptContractError(
                'attempt.artifact-verifier-missing',
                'clean-first-attempt admission requires an artifact verifier'
            );
        }
        aggregate = validateAggregateAttemptReceipt(aggregateReceipt, {
            loadAttempt,
            verifyAuthority,
            verifyArtifact
        });
    }
    catch (error)
    {
        const item = error instanceof AttemptContractError
            ? reason(error.reasonCode, error.message, aggregateReceipt, error.details)
            : reason('attempt.aggregate-invalid', error.message, aggregateReceipt);
        return Object.freeze({
            schema: cleanFirstAttemptVerdictSchema,
            eligible: false,
            reasons: Object.freeze([item]),
            aggregate: null,
            attempt: null
        });
    }

    for (const [field, expected] of Object.entries(expectedIdentity))
    {
        if (expected !== undefined && aggregate[field] !== expected)
        {
            return Object.freeze({
                schema: cleanFirstAttemptVerdictSchema,
                eligible: false,
                reasons: Object.freeze([mismatch(aggregate, field, expected, aggregate[field])]),
                aggregate,
                attempt: aggregate.attempts[0] ?? null
            });
        }
    }

    const attempt = aggregate.attempts[0];
    const isClean = aggregate.attempts.length === 1
        && attempt?.attemptNumber === 1
        && attempt.firstFailure === false
        && attempt.status === 'clean-success'
        && aggregate.firstAttemptStatus === 'clean-success'
        && aggregate.finalAttemptStatus === 'clean-success'
        && aggregate.finalClassification === 'clean-success'
        && aggregate.cleanFirstAttempt === true
        && aggregate.qualificationEligible === true
        && aggregate.policy.classification === 'correctness';
    if (!isClean)
    {
        return Object.freeze({
            schema: cleanFirstAttemptVerdictSchema,
            eligible: false,
            reasons: Object.freeze([reason(
                'attempt.not-clean-first',
                `${aggregate.producerId}/${aggregate.schedulerRunId} attempt ${attempt?.attemptNumber ?? 'missing'} is ${attempt?.status ?? 'missing'}; classification=${aggregate.finalClassification}, cleanFirstAttempt=${aggregate.cleanFirstAttempt}, qualificationEligible=${aggregate.qualificationEligible}`,
                aggregate,
                {
                    attemptNumber: attempt?.attemptNumber ?? null,
                    attemptStatus: attempt?.status ?? null,
                    finalClassification: aggregate.finalClassification,
                    cleanFirstAttempt: aggregate.cleanFirstAttempt,
                    qualificationEligible: aggregate.qualificationEligible
                }
            )]),
            aggregate,
            attempt
        });
    }

    return Object.freeze({
        schema: cleanFirstAttemptVerdictSchema,
        eligible: true,
        reasons: Object.freeze([]),
        aggregate,
        attempt
    });
}

export function requireCleanFirstAttempt(options)
{
    const verdict = cleanFirstAttemptVerdict(options);
    if (!verdict.eligible)
    {
        throw new CleanFirstAttemptAdmissionError(verdict);
    }
    return verdict;
}
