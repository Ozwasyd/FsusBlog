// #1677 — Production Fresh explicit run-bound output locator.
//
// Every report/summary/coverage/TRX/evidence consumer must open output files
// exclusively through this API. A locator is immutable and binds run, attempt,
// producer, receipt, inventory, file content, schema and candidate identity.
// There is no directory scanning, no latest/mtime/first-match selection, and no
// fallback to global directories: any mismatch fails closed before a read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    captureProductionFreshOutputInventory,
    outputPath,
    resolveProductionFreshOutputAttempt,
    verifyTerminalProductionFreshOutputs
} from './production-fresh-run-bound-outputs.mjs';

export const productionFreshOutputLocatorSchema =
    'fsusblog.production-fresh.output-locator.v1';
export const productionFreshConsumerInputReceiptSchema =
    'fsusblog.production-fresh.consumer-input-receipt.v1';
export const productionFreshProducerReceiptSchema =
    'fsusblog.production-fresh.producer-receipt.v1';

const terminalAttemptsSchema = 'fsusblog.production-fresh.terminal-attempts.v2';
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;

export function isProductionFreshSha256Digest(value)
{
    return sha256Pattern.test(String(value ?? ''));
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digestFile(file)
{
    return sha256(fs.readFileSync(file));
}

function safeRelative(relative)
{
    const value = String(relative ?? '').trim();
    if (!value)
    {
        throw new Error('locator relativePath is required');
    }
    if (value.includes('\0') || value.includes('\\') || path.isAbsolute(value))
    {
        throw new Error(`locator relativePath must be a normalized relative key: ${value}`);
    }
    const normalized = value.replaceAll('/', path.sep);
    const segments = normalized.split(path.sep);
    if (segments.includes('..') || segments.includes('.'))
    {
        throw new Error(`locator relativePath must not contain traversal segments: ${value}`);
    }
    return value;
}

function assertContained(root, candidate)
{
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
    {
        throw new Error(`path escapes its bound root: ${resolved}`);
    }
    return resolved;
}

function requireDigest(value, field)
{
    if (!isProductionFreshSha256Digest(value))
    {
        throw new Error(`${field} must be a sha256 digest, got ${String(value ?? '')}`);
    }
    return value;
}

function requireString(value, field)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${field} is required`);
    }
    return value;
}

// Immutable locator contract (fixed by issue #1677).
export function createProductionFreshOutputLocator({
    runId,
    attemptId,
    producerId,
    producerReceiptRef,
    producerReceiptDigest,
    outputInventoryDigest,
    relativePath,
    contentDigest,
    schema,
    candidateIdentityDigest
})
{
    const relative = safeRelative(relativePath);
    return Object.freeze({
        schema: requireString(schema, 'locator schema'),
        runId: requireString(runId, 'locator runId'),
        attemptId: requireString(attemptId, 'locator attemptId'),
        producerId: requireString(producerId, 'locator producerId'),
        producerReceiptRef: safeRelative(producerReceiptRef),
        producerReceiptDigest: requireDigest(producerReceiptDigest, 'locator producerReceiptDigest'),
        outputInventoryDigest: requireDigest(
            outputInventoryDigest,
            'locator outputInventoryDigest'
        ),
        relativePath: relative,
        contentDigest: requireDigest(contentDigest, 'locator contentDigest'),
        candidateIdentityDigest: requireDigest(
            candidateIdentityDigest,
            'locator candidateIdentityDigest'
        )
    });
}

// Resolve the run-bound attempt layout exclusively from runId/attemptId.
// Consumers must never discover an attempt themselves.
export function resolveProductionFreshLocatorLayout({ root, locator })
{
    return resolveProductionFreshOutputAttempt({
        root,
        runId: locator.runId,
        attemptId: locator.attemptId
    });
}

function readJsonFile(file)
{
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    {
        throw new Error(`locator referenced file is missing or invalid: ${file}`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifyAttemptProtectionBinding({ layout, locator, protection })
{
    const attempt = protection.attempts.find(
        (entry) => entry.attemptId === locator.attemptId
    );
    if (!attempt)
    {
        throw new Error(
            `producer is not terminal for ${locator.runId}/${locator.attemptId}:`
      + ` attempt missing from terminal protection`
        );
    }
    if (attempt.outputInventoryDigest !== locator.outputInventoryDigest)
    {
        throw new Error(
            `attempt inventory digest mismatch: expected ${locator.outputInventoryDigest},`
      + ` sealed ${attempt.outputInventoryDigest}`
        );
    }
    if (protection.runId !== locator.runId)
    {
        throw new Error(
            `terminal protection run mismatch: expected ${locator.runId},`
      + ` got ${protection.runId}`
        );
    }
    return attempt;
}

function verifyProducerReceipt({ layout, locator, receiptFile })
{
    const digest = digestFile(receiptFile);
    if (digest !== locator.producerReceiptDigest)
    {
        throw new Error(
            `producer receipt digest mismatch for ${locator.producerId}:`
      + ` expected ${locator.producerReceiptDigest}, got ${digest}`
        );
    }
    const receipt = readJsonFile(receiptFile);
    if (receipt.schema === productionFreshProducerReceiptSchema)
    {
        if (receipt.runId !== locator.runId
      || receipt.attemptId !== locator.attemptId
      || receipt.producerId !== locator.producerId)
        {
            throw new Error(
                `producer receipt identity mismatch:`
      + ` ${receipt.runId}/${receipt.attemptId}/${receipt.producerId}`
      + ` != ${locator.runId}/${locator.attemptId}/${locator.producerId}`
            );
        }
        if (!['complete', 'terminal'].includes(String(receipt.status ?? '')))
        {
            throw new Error(
                `producer receipt is not terminal: ${locator.producerId}`
      + ` (${receipt.status ?? 'missing'})`
            );
        }
        if (!receipt.perOutputDigest
      || !Object.hasOwn(receipt.perOutputDigest, locator.relativePath)
      || receipt.perOutputDigest[locator.relativePath] !== locator.contentDigest)
        {
            throw new Error(
                `producer receipt does not bind the requested output:`
      + ` ${locator.producerId} ${locator.relativePath}`
            );
        }
        const inventoryDigest = sha256(JSON.stringify(receipt.perOutputDigest));
        if (!receipt.outputInventoryDigest
      || receipt.outputInventoryDigest !== inventoryDigest)
        {
            throw new Error(
                `producer receipt inventory digest is inconsistent: ${locator.producerId}`
            );
        }
        return { kind: 'producer-receipt', receipt };
    }
    if (receipt.schema === terminalAttemptsSchema)
    {
        if (receipt.runId !== locator.runId)
        {
            throw new Error(
                `terminal protection run mismatch in receipt: expected ${locator.runId},`
      + ` got ${receipt.runId}`
            );
        }
        const attempt = receipt.attempts?.find((entry) => entry.attemptId === locator.attemptId);
        if (!attempt || attempt.outputInventoryDigest !== locator.outputInventoryDigest)
        {
            throw new Error(
                `terminal protection receipt does not bind attempt inventory:`
      + ` ${locator.attemptId}`
            );
        }
        return { kind: 'terminal-protection', receipt, attempt };
    }
    throw new Error(`unsupported producer receipt schema: ${receipt.schema ?? 'missing'}`);
}

function resolveReceiptFile({ layout, locator })
{
    const repositoryRoot = path.resolve(layout.repositoryRoot);
    const runOutputRoot = path.resolve(layout.runOutputRoot);
    const attemptRoot = path.resolve(layout.outputRoot);
    const candidate = path.resolve(repositoryRoot, locator.producerReceiptRef);
    const terminalProtection = path.join(runOutputRoot, 'terminal-attempts.json');
    const inAttempt = candidate === attemptRoot || candidate.startsWith(`${attemptRoot}${path.sep}`);
    if (candidate !== terminalProtection && !inAttempt)
    {
        throw new Error(
            `producer receipt must be inside the run-bound attempt or terminal protection:`
      + ` ${locator.producerReceiptRef}`
        );
    }
    if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink())
    {
        throw new Error(`producer receipt is missing or invalid: ${candidate}`);
    }
    return candidate;
}

function openVerifiedOutput({ layout, locator })
{
    const file = outputPath(layout, locator.relativePath);
    const before = digestFile(file);
    if (before !== locator.contentDigest)
    {
        throw new Error(
            `output content digest mismatch before read: ${locator.relativePath}`
      + ` (expected ${locator.contentDigest}, got ${before})`
        );
    }
    const text = fs.readFileSync(file, 'utf8');
    const after = digestFile(file);
    if (after !== before)
    {
        throw new Error(
            `output-drift: ${locator.relativePath} changed between hash and read`
      + ` (${before} -> ${after})`
        );
    }
    return { file, text, contentDigest: before };
}

// Read a terminal production-fresh output through its immutable locator.
// - candidateIdentityDigest: the consumer's own expected candidate identity;
//   mismatch fails closed before any file is opened.
// - diagnostic: marks the result non-qualifying; diagnostic viewers may browse
//   other runs but the returned result can never be injected into correctness.
// - requireTerminal: defaults to true (sealed attempt). Producer-internal
//   aggregation of an in-flight attempt may pass false explicitly.
export function readProductionFreshOutput({
    root,
    locator,
    expectedCandidateIdentityDigest,
    diagnostic = false,
    requireTerminal = true
})
{
    const normalized = createProductionFreshOutputLocator(locator);
    if (!diagnostic && !expectedCandidateIdentityDigest)
    {
        throw new Error(
            'correctness consumers must supply expectedCandidateIdentityDigest'
        );
    }
    if (expectedCandidateIdentityDigest
  && normalized.candidateIdentityDigest !== expectedCandidateIdentityDigest)
    {
        throw new Error(
            `candidate identity mismatch: locator ${normalized.candidateIdentityDigest},`
      + ` consumer expects ${expectedCandidateIdentityDigest}`
        );
    }
    const layout = resolveProductionFreshLocatorLayout({ root, locator: normalized });
    const boundLocator = normalized;
    let protection = null;
    if (requireTerminal)
    {
        protection = verifyTerminalProductionFreshOutputs(layout, {
            allowCurrentAttempt: true,
            requireProtection: true
        });
        verifyAttemptProtectionBinding({ layout, locator: boundLocator, protection });
    }
    const receiptFile = resolveReceiptFile({ layout, locator: boundLocator });
    const receiptBinding = verifyProducerReceipt({ layout, locator: boundLocator, receiptFile });
    const { file, text, contentDigest } = openVerifiedOutput({ layout, locator: boundLocator });
    return {
        value: text,
        file,
        contentDigest,
        qualificationEligible: !diagnostic,
        diagnostic,
        locator: boundLocator,
        producerReceipt: {
            kind: receiptBinding.kind,
            path: path.relative(path.resolve(layout.repositoryRoot), receiptFile).replaceAll(path.sep, '/'),
            contentDigest: locator.producerReceiptDigest
        }
    };
}

export function readProductionFreshJsonOutput(options)
{
    const result = readProductionFreshOutput(options);
    return {
        ...result,
        json: JSON.parse(result.value)
    };
}

// Diagnostic viewer accessor: never produces a qualification-eligible result.
export function readProductionFreshOutputDiagnostic(options)
{
    return readProductionFreshOutput({ ...options, diagnostic: true });
}

// Resolve the explicit run-bound locator context from the process environment.
// Consumers must receive run/attempt/output-root identity explicitly; missing
// identity fails closed and never falls back to a global or latest directory.
export function resolveProductionFreshLocatorEnvironment(env = process.env)
{
    const runId = String(env.FSUSBLOG_PRODUCTION_FRESH_RUN_ID ?? '').trim();
    const attemptId = String(env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? '').trim();
    const outputRoot = String(env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim();
    const missing = [];
    if (!runId)
    {
        missing.push('FSUSBLOG_PRODUCTION_FRESH_RUN_ID');
    }
    if (!attemptId)
    {
        missing.push('FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID');
    }
    if (!outputRoot)
    {
        missing.push('FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT');
    }
    if (missing.length > 0)
    {
        throw new Error(
            `production-fresh run-bound locator context is required: ${missing.join(', ')}`
        );
    }
    return { runId, attemptId, outputRoot: path.resolve(outputRoot) };
}

// Build an immutable locator for a named producer output inside the explicit
// run-bound attempt. The producer receipt is resolved deterministically from
// the named producer (no directory scan, no latest/first-match selection) and
// every digest is verified before the locator is returned. Consumers that only
// know run/attempt/producer/relative identity can use this bridge, then read
// through readProductionFreshOutput* which re-verifies the full contract.
export function createProductionFreshRunBoundLocator({
    repositoryRoot,
    runId,
    attemptId,
    outputRoot = null,
    producerId,
    relativePath,
    schema,
    candidateIdentityDigest = null,
    receiptRef = null
})
{
    const root = path.resolve(repositoryRoot);
    const layout = resolveProductionFreshOutputAttempt({ root, runId, attemptId });
    if (outputRoot)
    {
        const resolvedOutputRoot = path.resolve(outputRoot);
        if (resolvedOutputRoot !== path.resolve(layout.outputRoot))
        {
            throw new Error(
                `run-bound output root mismatch: provided ${resolvedOutputRoot},`
          + ` derived ${path.resolve(layout.outputRoot)}`
            );
        }
    }
    const producer = requireString(producerId, 'producerId');
    const relative = safeRelative(relativePath);
    const resolvedReceiptRef = receiptRef
        ? safeRelative(receiptRef)
        : `artifacts/producer-receipts/${producer}.json`;
    const receiptFile = resolveReceiptFile({
        layout,
        locator: { producerReceiptRef: resolvedReceiptRef }
    });
    const producerReceiptDigest = digestFile(receiptFile);
    const contentFile = outputPath(layout, relative);
    if (!fs.existsSync(contentFile)
  || !fs.lstatSync(contentFile).isFile()
  || fs.lstatSync(contentFile).isSymbolicLink())
    {
        throw new Error(`locator referenced output is missing or invalid: ${relative}`);
    }
    const contentDigest = digestFile(contentFile);
    const outputInventoryDigest = `sha256:${crypto.createHash('sha256').update(
        JSON.stringify(captureProductionFreshOutputInventory(layout))
    ).digest('hex')}`;
    const locator = createProductionFreshOutputLocator({
        schema: requireString(schema, 'locator schema'),
        runId: layout.runId,
        attemptId: layout.attemptId,
        producerId: producer,
        producerReceiptRef: resolvedReceiptRef,
        producerReceiptDigest,
        outputInventoryDigest,
        relativePath: relative,
        contentDigest,
        candidateIdentityDigest: requireDigest(
            candidateIdentityDigest,
            'locator candidateIdentityDigest'
        )
    });
    verifyProducerReceipt({ layout, locator, receiptFile });
    return {
        locator,
        layout,
        receiptFile,
        contentFile,
        contentDigest,
        producerReceiptDigest,
        outputInventoryDigest
    };
}

// Consumer input dependency receipt: records the exact locators and digests
// consumed, forming an auditable dependency graph. The consumer must persist
// this receipt in its own run-bound producer root.
export function createProductionFreshConsumerInputReceipt({
    consumerId,
    locators,
    consumerRunId = null,
    consumerAttemptId = null
})
{
    const consumer = requireString(consumerId, 'consumerId');
    if (!Array.isArray(locators) || locators.length === 0)
    {
        throw new Error('consumer input receipt requires at least one locator');
    }
    const inputs = locators.map((locator) =>
    {
        if (!locator || typeof locator !== 'object')
        {
            throw new Error('consumer input receipt locator is invalid');
        }
        return {
            runId: requireString(locator.runId, 'locator runId'),
            attemptId: requireString(locator.attemptId, 'locator attemptId'),
            producerId: requireString(locator.producerId, 'locator producerId'),
            producerReceiptRef: safeRelative(locator.producerReceiptRef),
            producerReceiptDigest: requireDigest(
                locator.producerReceiptDigest,
                'locator producerReceiptDigest'
            ),
            outputInventoryDigest: requireDigest(
                locator.outputInventoryDigest,
                'locator outputInventoryDigest'
            ),
            relativePath: safeRelative(locator.relativePath),
            contentDigest: requireDigest(locator.contentDigest, 'locator contentDigest'),
            schema: requireString(locator.schema, 'locator schema'),
            candidateIdentityDigest: requireDigest(
                locator.candidateIdentityDigest,
                'locator candidateIdentityDigest'
            )
        };
    });
    const receipt = {
        schema: productionFreshConsumerInputReceiptSchema,
        consumerId: consumer,
        consumerRunId: consumerRunId ? String(consumerRunId) : null,
        consumerAttemptId: consumerAttemptId ? String(consumerAttemptId) : null,
        inputs,
        contentDigest: null
    };
    const { contentDigest: _ignored, ...content } = receipt;
    receipt.contentDigest = sha256(JSON.stringify(content));
    return Object.freeze(receipt);
}

export function assertProductionFreshConsumerInputReceipt(receipt)
{
    if (!receipt || receipt.schema !== productionFreshConsumerInputReceiptSchema)
    {
        throw new Error('consumer input receipt schema mismatch');
    }
    const expected = createProductionFreshConsumerInputReceipt({
        consumerId: receipt.consumerId,
        locators: receipt.inputs,
        consumerRunId: receipt.consumerRunId,
        consumerAttemptId: receipt.consumerAttemptId
    });
    if (expected.contentDigest !== receipt.contentDigest)
    {
        throw new Error('consumer input receipt content digest mismatch');
    }
    return true;
}

// Static governance: reject ambient/fixed/global/latest/first-match consumption
// patterns in Production Fresh consumer sources.
export const productionFreshConsumerForbiddenPatterns = Object.freeze([
    {
        id: 'fixed-global-summary-read',
        pattern: /\.tmp[\\/]local-production[\\/][^'"`\s]*summary\.json/u,
        message: 'consumer must not read a fixed global local-production summary'
    },
    {
        id: 'fixed-global-release-evidence-read',
        pattern: /path\.join\([^)]*\.tmp[^)]*release-evidence[^)]*\)/u,
        message: 'consumer must not read fixed global release-evidence paths'
    },
    {
        id: 'latest-manifest-selection',
        pattern: /latestManifest\s*\(/u,
        message: 'consumer must not select the latest manifest by convention'
    },
    {
        id: 'mtime-selection',
        pattern: /mtimeMs/u,
        message: 'consumer must not select outputs by mtime/updatedAt'
    },
    {
        id: 'glob-first-match',
        pattern: /glob\s*\([^)]*\)\s*\[0\]/u,
        message: 'consumer must not use the first glob match'
    },
    {
        id: 'readdir-first-match',
        pattern: /readdirSync\s*\([^)]*\)\s*\[0\]/u,
        message: 'consumer must not use the first directory entry'
    },
    {
        id: 'ambient-directory-scan',
        pattern: /findFiles\s*\([^)]*release-evidence/u,
        message: 'consumer must not recursively scan release-evidence directories'
    }
]);

export function scanProductionFreshConsumerSource(source, options = {})
{
    const text = String(source ?? '');
    const hits = [];
    for (const rule of productionFreshConsumerForbiddenPatterns)
    {
        const match = text.match(rule.pattern);
        if (match)
        {
            hits.push({ id: rule.id, message: rule.message, match: match[0] });
        }
    }
    if (options.allowDiagnosticViewer !== true)
    {
        return hits;
    }
    return hits;
}

export function assertNoProductionFreshAmbientConsumption(source)
{
    const hits = scanProductionFreshConsumerSource(source);
    if (hits.length > 0)
    {
        throw new Error(
            `production-fresh ambient consumption rejected: ${hits.map(
                (hit) => `${hit.id} (${hit.message})`
            ).join('; ')}`
        );
    }
    return true;
}

// CLI: node tools/test-matrix/production-fresh-output-locator.mjs --check <files...>
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(new URL(import.meta.url).pathname))
{
    const args = process.argv.slice(2);
    if (args[0] !== '--check')
    {
        console.error('usage: production-fresh-output-locator.mjs --check <consumer-source-files...>');
        process.exit(2);
    }
    const failures = [];
    for (const file of args.slice(1))
    {
        const absolute = path.resolve(file);
        const source = fs.readFileSync(absolute, 'utf8');
        const hits = scanProductionFreshConsumerSource(source);
        for (const hit of hits)
        {
            failures.push(`${path.relative(process.cwd(), absolute)}: ${hit.id}: ${hit.message}`);
        }
    }
    if (failures.length > 0)
    {
        for (const failure of failures)
        {
            console.error(`[production-fresh-locator] violation: ${failure}`);
        }
        process.exit(1);
    }
    console.log(
        `[production-fresh-locator] ok sources=${args.length - 1}`
    );
}
