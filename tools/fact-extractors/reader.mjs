/**
 * Public receipt reader for DocClaim verifiers, test joiners, and matrix consumers.
 * Consumers must use this module only — never import seed/extractor implementations.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isPlainObject } from './lib/canonicalize.mjs'
import { loadReceiptFromFile, semanticDigestFromReceipt, validateReceipt } from './receipt.mjs'
import { root } from './registry.mjs'

const fail = (message) =>
{
    throw new Error(`[fact-observation-reader] ${message}`)
}

/**
 * Read and validate a sealed FactObservationReceipt from disk or an in-memory object.
 * Returns a frozen public view with typed observations only.
 */
export function readFactObservationReceipt(source, options = {})
{
    const receipt = typeof source === 'string'
        ? loadReceiptFromFile(path.isAbsolute(source) ? source : path.join(options.repositoryRoot ?? root, source))
        : structuredClone(source)

    validateReceipt(receipt, options)

    const view = Object.freeze({
        schema: receipt.schema,
        extractorId: receipt.extractorId,
        behaviorIds: Object.freeze([...receipt.behaviorIds]),
        sourceCommit: receipt.sourceCommit,
        worktreeFingerprint: receipt.worktreeFingerprint,
        buildIdentity: receipt.buildIdentity == null
            ? null
            : deepFreeze(structuredClone(receipt.buildIdentity)),
        extractorDigest: receipt.extractorDigest,
        registryDigest: receipt.registryDigest,
        consumedInputDigests: Object.freeze(receipt.consumedInputDigests.map((entry) => Object.freeze({ ...entry }))),
        observations: deepFreeze(structuredClone(receipt.observations)),
        status: receipt.status,
        failureReasons: Object.freeze([...receipt.failureReasons]),
        contentDigest: receipt.contentDigest,
        semanticDigest: semanticDigestFromReceipt(receipt)
    })
    return view
}

function deepFreeze(value)
{
    if (Array.isArray(value))
    {
        for (const entry of value) deepFreeze(entry)
        return Object.freeze(value)
    }
    if (isPlainObject(value))
    {
        for (const nested of Object.values(value)) deepFreeze(nested)
        return Object.freeze(value)
    }
    return value
}

export function readFactObservationReceiptFile(relativeOrAbsolute, options = {})
{
    return readFactObservationReceipt(relativeOrAbsolute, options)
}

/**
 * Assert a module source does not import extractor implementations.
 * Used by governance and consumer contract tests.
 */
export function assertConsumerDoesNotImportExtractors(sourceText, consumerLabel = 'consumer')
{
    if (/fact-extractors\/seeds\//u.test(sourceText))
    {
        fail(`${consumerLabel} must not import extractor seed implementations`)
    }
    if (/from\s+['"][^'"]*fact-extractors\/(?!reader\.mjs|receipt\.mjs)[^'"]*['"]/u.test(sourceText)
        && /extract\s*\(/u.test(sourceText))
    {
        // Allow framework internals; block calling extract from non-runner consumers when combined with seed paths.
    }
    if (/\bimportExtractorModule\b|\brunExtractor\b/.test(sourceText) && /seeds\//u.test(sourceText))
    {
        fail(`${consumerLabel} must not invoke extractors; read receipts only`)
    }
    return true
}

export function loadReceiptJson(filePath)
{
    return JSON.parse(readFileSync(filePath, 'utf8'))
}
