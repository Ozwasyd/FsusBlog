#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createRequiredEvidenceDependencies, requiredEvidencePlanDigest, validateRequiredEvidenceMatrix } from './required-evidence-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalFile = path.join(root, 'tests/fixtures/test-matrix/release-final-evidence-inputs.json');
const contractFile = path.join(root, 'tests/fixtures/test-matrix/release-final-evidence-contract.json');
const expectedInputCount = 22;
export const releaseFinalizerCommand = 'tools/test/lanes/release-final.sh';
export const releaseFinalizerOutputReceiptSchema =
    'fsusblog.release-final-test-evidence-binding.v1';

function compareText(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function duplicateValues(values)
{
    const seen = new Set();
    return [...new Set(values.filter((value) =>
    {
        if (seen.has(value))
        {
            return true;
        }
        seen.add(value);
        return false;
    }))].sort(compareText);
}

export function validateCanonicalReleaseFinalEvidenceInputs(canonical)
{
    const errors = [];
    if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical))
    {
        return ['canonical release-final evidence inputs must be an object'];
    }
    if (canonical.schema !== 'fsusblog.release-final-evidence-inputs.v1')
    {
        errors.push(
            'canonical release-final evidence inputs must use schema fsusblog.release-final-evidence-inputs.v1'
        );
    }
    if (canonical.targetTier !== 'release-final')
    {
        errors.push('canonical release-final evidence inputs must target release-final');
    }
    if (!Array.isArray(canonical.inputs))
    {
        errors.push('canonical release-final evidence inputs must declare an inputs array');
        return errors;
    }
    if (canonical.inputs.length !== expectedInputCount)
    {
        errors.push(`canonical release-final evidence inputs must contain exactly ${expectedInputCount} tier ids`);
    }
    const invalidInputs = canonical.inputs.filter((input) => typeof input !== 'string' || input.length === 0);
    if (invalidInputs.length > 0)
    {
        errors.push('canonical release-final evidence inputs must contain only non-empty tier ids');
    }
    const duplicates = duplicateValues(canonical.inputs);
    if (duplicates.length > 0)
    {
        errors.push(`canonical release-final evidence inputs must be unique; duplicates: ${duplicates.join(', ')}`);
    }
    const sorted = [...canonical.inputs].sort(compareText);
    if (JSON.stringify(canonical.inputs) !== JSON.stringify(sorted))
    {
        errors.push('canonical release-final evidence inputs must be sorted');
    }
    return errors;
}

export function loadCanonicalReleaseFinalEvidenceInputs()
{
    return JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
}

export function buildReleaseFinalEvidenceContract(canonical)
{
    const errors = validateCanonicalReleaseFinalEvidenceInputs(canonical);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return {
        schema: 'fsusblog.release-final-evidence-contract.v1',
        source: 'tests/fixtures/test-matrix/release-final-evidence-inputs.json',
        producer: 'node tools/test-matrix/release-final-evidence-contract.mjs --write',
        targetTier: canonical.targetTier,
        inputCount: canonical.inputs.length,
        inputDigest: digest(canonical.inputs)
    };
}

export function serializeReleaseFinalEvidenceContract(contract)
{
    return `${JSON.stringify(contract, null, 4)}\n`;
}

export function validateReleaseFinalEvidenceBinding(matrix, canonical = loadCanonicalReleaseFinalEvidenceInputs())
{
    const errors = validateCanonicalReleaseFinalEvidenceInputs(canonical);
    if (errors.length > 0)
    {
        return errors.map((error) => `canonical contract: ${error}`);
    }
    const releaseFinal = matrix?.tiers?.find((tier) => tier.id === canonical.targetTier);
    if (!releaseFinal)
    {
        return ['release topology missing release-final tier'];
    }

    const executionInputs = releaseFinal.executionDependsOn;
    if (!Array.isArray(executionInputs) || executionInputs.length !== 0)
    {
        errors.push(
            'release-final.executionDependsOn must be empty; canonical producer tiers are evidence inputs only'
        );
    }

    const actual = releaseFinal.requiresEvidenceFrom;
    if (!Array.isArray(actual))
    {
        errors.push('release-final.requiresEvidenceFrom must declare the canonical evidence input array');
        return errors;
    }
    if (actual.length !== canonical.inputs.length)
    {
        errors.push(
            `release-final.requiresEvidenceFrom must contain exactly ${canonical.inputs.length} `
            + `canonical evidence inputs; got ${actual.length}`
        );
    }
    const duplicates = duplicateValues(actual);
    if (duplicates.length > 0)
    {
        errors.push(`release-final.requiresEvidenceFrom must be unique; duplicates: ${duplicates.join(', ')}`);
    }
    const sorted = [...actual].sort(compareText);
    if (JSON.stringify(actual) !== JSON.stringify(sorted))
    {
        errors.push('release-final.requiresEvidenceFrom must be sorted');
    }

    const actualSet = new Set(actual);
    const canonicalSet = new Set(canonical.inputs);
    const missing = canonical.inputs.filter((input) => !actualSet.has(input));
    const unexpected = [...new Set(actual.filter((input) => !canonicalSet.has(input)))].sort(compareText);
    if (missing.length > 0)
    {
        errors.push(`release-final.requiresEvidenceFrom is missing canonical evidence inputs: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0)
    {
        errors.push(`release-final.requiresEvidenceFrom contains unexpected evidence inputs: ${unexpected.join(', ')}`);
    }

    const tierIds = new Set(matrix.tiers.map((tier) => tier.id));
    const absentProducers = canonical.inputs.filter((input) => !tierIds.has(input));
    if (absentProducers.length > 0)
    {
        errors.push(`canonical release-final evidence inputs reference missing tiers: ${absentProducers.join(', ')}`);
    }
    const scheduledCanonicalInputs = Array.isArray(executionInputs)
        ? executionInputs.filter((input) => canonicalSet.has(input))
        : [];
    if (scheduledCanonicalInputs.length > 0)
    {
        errors.push(
            'canonical release-final evidence inputs must not be scheduler edges: '
            + scheduledCanonicalInputs.join(', ')
        );
    }
    return errors;
}

export function buildReleaseFinalizerPlan(
    matrix,
    target = 'release-final',
    canonical = loadCanonicalReleaseFinalEvidenceInputs(),
    { identity, ledger } = {}
)
{
    const errors = validateCanonicalReleaseFinalEvidenceInputs(canonical)
        .map((error) => `canonical contract: ${error}`);
    if (target !== canonical.targetTier)
    {
        errors.push(
            `${target} finalizer authority must target canonical tier ${canonical.targetTier}`
        );
    }
    const authority = matrix?.finalizerAuthorities?.[target];
    if (!authority || typeof authority !== 'object' || Array.isArray(authority))
    {
        return { errors: [...errors, `unknown finalizer authority: ${target}`] };
    }
    if (authority.id !== target)
    {
        errors.push(`${target}.id must equal its finalizer authority key`);
    }
    if (authority.commandKind !== 'finalizer')
    {
        errors.push(`${target}.commandKind must be finalizer`);
    }
    if (authority.command !== releaseFinalizerCommand)
    {
        errors.push(`${target}.command must equal the canonical release finalizer command`);
    }
    if (JSON.stringify(authority.summaryTierIds) !== JSON.stringify([target]))
    {
        errors.push(`${target}.summaryTierIds must contain only ${target}`);
    }
    if (authority.inputContractSchema !== canonical.schema)
    {
        errors.push(`${target}.inputContractSchema must equal ${canonical.schema}`);
    }
    if (authority.outputReceiptSchema !== releaseFinalizerOutputReceiptSchema)
    {
        errors.push(
            `${target}.outputReceiptSchema must equal ${releaseFinalizerOutputReceiptSchema}`
        );
    }

    const tier = matrix?.tiers?.find((entry) => entry.id === target);
    if (!tier)
    {
        errors.push(`${target}.summaryTierIds references unknown tier ${target}`);
    }
    else
    {
        if ((tier.executionMode ?? 'execute') !== 'summary')
        {
            errors.push(`${target}.executionMode must be summary`);
        }
        if (tier.commandKind !== 'finalizer')
        {
            errors.push(`${target}.commandKind must be finalizer`);
        }
        if (tier.summaryAuthority !== target)
        {
            errors.push(`${target}.summaryAuthority must equal finalizer authority ${target}`);
        }
        if (tier.command !== releaseFinalizerCommand)
        {
            errors.push(`${target}.command must match finalizer authority ${target}`);
        }
        if (JSON.stringify(tier.summaryInputs) !== JSON.stringify([canonical.schema]))
        {
            errors.push(`${target}.summaryInputs must contain only ${canonical.schema}`);
        }
        if (tier.outputReceiptSchema !== releaseFinalizerOutputReceiptSchema)
        {
            errors.push(
                `${target}.outputReceiptSchema must equal ${releaseFinalizerOutputReceiptSchema}`
            );
        }
        if ((tier.services?.length ?? 0) > 0
            || tier.requiresBootstrap !== 'none'
            || tier.requiresNode !== true
            || tier.requiresDotnet !== false
            || tier.requiresPlaywright !== 'none'
            || tier.cacheProfile !== 'none')
        {
            errors.push(
                `${target} finalizer must be Node-only without services, bootstrap, .NET, `
                + 'Playwright, or build/test cache'
            );
        }
    }
    errors.push(...validateReleaseFinalEvidenceBinding(matrix, canonical));

    let requiredEvidenceDependencies = null;
    try
    {
        errors.push(...validateRequiredEvidenceMatrix(matrix, ledger));
        if (errors.length === 0)
        {
            requiredEvidenceDependencies = createRequiredEvidenceDependencies(matrix, identity, ledger);
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }

    const plan = {
        schema: 'fsusblog.release-finalizer-plan.v1',
        target,
        authorityId: target,
        selectedTierIds: tier ? [target] : [],
        inputTierIds: [...canonical.inputs],
        inputContractSchema: canonical.schema,
        outputReceiptSchema: releaseFinalizerOutputReceiptSchema,
        command: releaseFinalizerCommand,
        artifactOnly: true,
        executesTestCommands: false,
        requiredEvidenceDependencies,
        errors
    };
    return { ...plan, contentDigest: requiredEvidencePlanDigest(plan) };
}

function main()
{
    const mode = process.argv[2] ?? '--check';
    if (!['--check', '--write'].includes(mode) || process.argv.length > 3)
    {
        throw new Error('usage: node tools/test-matrix/release-final-evidence-contract.mjs [--check|--write]');
    }
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    const expected = serializeReleaseFinalEvidenceContract(buildReleaseFinalEvidenceContract(canonical));
    if (mode === '--write')
    {
        fs.writeFileSync(contractFile, expected);
        console.log(
            '[release-final-evidence-contract] wrote '
            + 'tests/fixtures/test-matrix/release-final-evidence-contract.json'
        );
        return;
    }
    if (!fs.existsSync(contractFile) || fs.readFileSync(contractFile, 'utf8') !== expected)
    {
        throw new Error(
            'release-final evidence contract is stale; '
            + 'run node tools/test-matrix/release-final-evidence-contract.mjs --write'
        );
    }
    console.log('[release-final-evidence-contract] ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
