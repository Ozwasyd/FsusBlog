#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    noisyMeasurementClassification,
    readMeasurementNoiseAuthoritySequence,
    validateMeasurementNoiseAuthorityReceipt,
    validateMeasurementNoiseAuthoritySequence,
    validateMeasurementNoiseReceipt
} from './measurement-noise-envelope.mjs';
import { digestValue } from './release-reliability-receipt.mjs';
export const measurementQualificationRequestEnvironment =
    'FSUSBLOG_MEASUREMENT_QUALIFICATION_REQUEST_DIR';
const measurementEnvelopeOwnerEnvironment = 'FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function productReference(file)
{
    const relative = path.relative(repositoryRoot, file).replaceAll(path.sep, '/');
    return relative.startsWith('../') ? file : relative;
}

function atomicWriteJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function fileBinding(file)
{
    const absolute = path.resolve(file);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`measurement product evidence must be a regular file: ${absolute}`);
    }
    const bytes = fs.readFileSync(absolute);
    return {
        path: absolute,
        size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    };
}

function authorityBinding(receipt)
{
    return {
        runId: receipt.authority.runId,
        windowId: receipt.windowId,
        attemptId: receipt.authority.attemptId,
        attemptSequence: receipt.authority.attemptSequence,
        receiptDigest: receipt.authority.contentDigest
    };
}

function infraConclusion(request, receipt, reason = null)
{
    return {
        schema: 'fsusblog.measurement-product-conclusion.v1',
        status: 'infra-no-conclusion',
        classification: receipt?.classification ?? noisyMeasurementClassification,
        qualificationEligible: false,
        productConclusionEligible: false,
        consumer: request.kind,
        ...(request.profile ? { profile: request.profile } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(receipt ? { measurementNoiseAuthority: authorityBinding(receipt) } : {}),
        ...(reason ? { reason } : {}),
        generatedAt: new Date().toISOString()
    };
}

function qualifiedSummary(request, product, receipt, authoritySequence)
{
    const common = {
        status: product.status,
        measurementNoiseAuthority: authorityBinding(receipt),
        measurementNoiseEnvelope: receipt,
        measurementNoiseAuthoritySequence: authoritySequence,
        qualificationEligible: true,
        productConclusionEligible: true,
        generatedAt: new Date().toISOString()
    };
    if (request.kind === 'load-profile')
    {
        if (product.schema === 'fsusblog.release-load-profile.v2' && product.evidenceClass !== 'correctness')
        {
            return infraConclusion(request, receipt, 'diagnostic load evidence cannot qualify');
        }
        const summary = {
            ...structuredClone(product),
            ...common,
            schema: 'fsusblog.qualified-load-profile-summary.v1',
            profile: request.profile,
            profileName: product.profileName ?? request.profile,
            summary: productReference(request.productFile)
        };
        if (product.schema === 'fsusblog.release-load-profile.v2')
        {
            summary.contentDigest = digestValue(summary);
        }
        return summary;
    }
    if (request.kind === 'release-resource-budget')
    {
        return {
            ...structuredClone(product),
            ...common,
            schema: 'fsusblog.qualified-release-resource-budget-summary.v1',
            mode: request.mode,
            summary: productReference(request.productFile)
        };
    }
    throw new Error(`unsupported measurement product consumer: ${request.kind}`);
}

function validateRequest(request)
{
    if (request?.schema !== 'fsusblog.measurement-product-qualification-request.v1'
    || !['load-profile', 'release-resource-budget'].includes(request.kind)
    || !path.isAbsolute(request.productFile ?? '')
    || !path.isAbsolute(request.outputFile ?? '')
    || !String(request.owner ?? '').trim()
    || !String(request.requestId ?? '').trim())
    {
        throw new Error('measurement product qualification request is invalid');
    }
    return request;
}

function writeConclusion(
    request,
    receipt,
    productBinding = null,
    reason = null,
    authoritySequence = null
)
{
    if (!receipt || receipt.status !== 'clean' || receipt.qualificationEligible !== true
    || receipt.productConclusionEligible !== true || reason)
    {
        const conclusion = infraConclusion(request, receipt, reason);
        atomicWriteJson(request.outputFile, conclusion);
        return conclusion;
    }
    validateMeasurementNoiseReceipt(receipt, { authoritySequence });
    const expectedBinding = productBinding ?? receipt.productOutcome?.productEvidence;
    const actualBinding = fileBinding(request.productFile);
    if (!expectedBinding
    || expectedBinding.path !== actualBinding.path
    || expectedBinding.size !== actualBinding.size
    || expectedBinding.digest !== actualBinding.digest
    || receipt.productOutcome?.status !== 'completed')
    {
        throw new Error('measurement product evidence does not match the qualified envelope binding');
    }
    const product = JSON.parse(fs.readFileSync(request.productFile, 'utf8'));
    const conclusion = qualifiedSummary(request, product, receipt, authoritySequence);
    atomicWriteJson(request.outputFile, conclusion);
    return conclusion;
}

export function registerOrFinalizeMeasurementProduct({
    kind,
    windowId,
    evidenceFile,
    productFile,
    outputFile,
    profile = null,
    mode = null,
    probeStatus = 0,
    env = process.env
} = {})
{
    const request = validateRequest({
        schema: 'fsusblog.measurement-product-qualification-request.v1',
        requestId: randomUUID(),
        owner: String(env[measurementEnvelopeOwnerEnvironment] ?? '').trim() || 'standalone',
        kind,
        windowId,
        evidenceFile: path.resolve(evidenceFile),
        productFile: path.resolve(productFile),
        outputFile: path.resolve(outputFile),
        profile,
        mode
    });
    const outerOwner = String(env[measurementEnvelopeOwnerEnvironment] ?? '').trim();
    const requestDirectory = String(env[measurementQualificationRequestEnvironment] ?? '').trim();
    if (outerOwner)
    {
        if (!requestDirectory)
        {
            throw new Error('nested measurement product consumer has no outer qualification request directory');
        }
        fs.rmSync(request.outputFile, { force: true });
        fs.mkdirSync(requestDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(requestDirectory, `${request.requestId}.json`),
            `${JSON.stringify(request, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        return { status: 'deferred-to-outer-owner', request };
    }
    const sequence = readMeasurementNoiseAuthoritySequence(request.evidenceFile, {
        expectedWindowId: windowId
    });
    const receipt = sequence.at(-1);
    validateMeasurementNoiseAuthorityReceipt(receipt, { expectedWindowId: windowId });
    return writeConclusion(
        request,
        receipt,
        null,
    Number(probeStatus) === 0 ? null : `measurement admission or workload exited ${probeStatus}`,
    sequence
    );
}

export function collectMeasurementQualificationRequests(directory, owner)
{
    if (!fs.existsSync(directory))
    {
        return [];
    }
    return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) =>
    {
        const request = validateRequest(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
        if (request.owner !== owner)
        {
            throw new Error('measurement product request owner mismatch');
        }
        return {
            request,
            productEvidence: fileBinding(request.productFile)
        };
    });
}

export function finalizeMeasurementQualificationRequests(bindings, receipt, {
    error = null,
    authoritySequence = null
} = {})
{
    if (bindings.length === 0)
    {
        return [];
    }
    const validatedSequence = validateMeasurementNoiseAuthoritySequence(authoritySequence, {
        expectedRunId: receipt?.authority?.runId,
        expectedWindowId: receipt?.windowId
    });
    if (validatedSequence.at(-1).authority.contentDigest !== receipt?.authority?.contentDigest)
    {
        throw new Error('measurement product conclusion receipt is not the authority sequence head');
    }
    return bindings.map(({ request, productEvidence }) =>
    {
        const authorityBinding = receipt.productOutcome?.qualificationRequests?.find(
            (entry) => entry.requestId === request.requestId
        );
        const bindingMatches = authorityBinding?.kind === request.kind
      && JSON.stringify(authorityBinding.productEvidence) === JSON.stringify(productEvidence);
        return writeConclusion(
            request,
            receipt,
      bindingMatches ? productEvidence : null,
      error ?? (receipt.status === 'clean' && !bindingMatches
          ? 'measurement product request is not bound by the outer envelope'
          : null),
      validatedSequence
        );
    });
}

function parseCli(args)
{
    const options = {};
    for (let index = 0; index < args.length; index += 2)
    {
        const flag = args[index];
        const value = args[index + 1];
        if (!flag?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid measurement product conclusion option: ${String(flag)}`);
        }
        options[flag.slice(2)] = value;
    }
    for (const required of ['kind', 'window-id', 'evidence', 'product', 'output'])
    {
        if (!options[required])
        {
            throw new Error(`--${required} is required`);
        }
    }
    return {
        kind: options.kind,
        windowId: options['window-id'],
        evidenceFile: options.evidence,
        productFile: options.product,
        outputFile: options.output,
        profile: options.profile ?? null,
        mode: options.mode ?? null,
        probeStatus: Number(options['probe-status'] ?? 0)
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const result = registerOrFinalizeMeasurementProduct(parseCli(process.argv.slice(2)));
        console.log(`[measurement-product-conclusion] ${result.status}`);
    }
    catch (error)
    {
        console.error(`[measurement-product-conclusion] ${error.message}`);
        process.exitCode = 1;
    }
}
