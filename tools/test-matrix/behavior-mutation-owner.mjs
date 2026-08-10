/**
 * Per-behavior C# implementation-owner mutation closure (#2187).
 *
 * The exact mutants for a required release behavior are derived from the
 * machine-readable BehaviorCatalog + reviewed mutation-owner catalog
 * (config/testing/mutation/behavior-mutation-owners.v1.json). The catalog is
 * cross-validated against the fact-extractor registry consumedInputs and the
 * reviewed AEDS critical slice, so registry/source drift fails closed instead
 * of silently changing the required mutant closure. Each source file is owned
 * by exactly one behavior so every Stryker mutant attributes uniquely.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    catalogRelative,
    loadCatalog,
    root as defaultRoot,
    validateCatalog
} from '../contracts/behavior-contract-catalog.mjs';
import { resolveWorktreeDigest } from '../contracts/behavior-owner-binding.mjs';

export const behaviorMutationOwnerSchema = 'fsusblog.behavior-mutation-owner-closure.v1';
export const behaviorMutationOwnerCatalogSchema = 'fsusblog.behavior-mutation-owners.v1';
export const defaultOwnerCatalogRelative = 'config/testing/mutation/behavior-mutation-owners.v1.json';
export const defaultFactExtractorRegistryRelative = 'config/contracts/behavior-fact-extractors.json';

const digestPattern = /^[a-f0-9]{64}$/u;

const normalize = (relative) => String(relative ?? '').replaceAll('\\', '/');

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

export function digestValue(value)
{
    return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function sha256Text(value)
{
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceProjectFor(sourcePath, sourceProjects)
{
    const normalized = normalize(sourcePath);
    const candidates = [...sourceProjects]
        .map((project) => normalize(project).replace(/\/+$/u, ''))
        .filter((project) => normalized.startsWith(`${project}/`))
        .sort((left, right) => right.length - left.length);
    return candidates[0] ?? null;
}

function symbolFromPath(sourcePath)
{
    const base = path.posix.basename(normalize(sourcePath));
    return base.replace(/\.cs$/u, '');
}

function csharpClosureFromRegistry(extractor, sourceProjects)
{
    return (extractor?.consumedInputs ?? [])
        .map((input) => normalize(input))
        .filter((input) => input.endsWith('.cs'))
        .filter((input) => sourceProjectFor(input, sourceProjects) !== null)
        .sort((left, right) => left.localeCompare(right));
}

export function loadBehaviorMutationOwnerCatalog(repositoryRoot = defaultRoot)
{
    return JSON.parse(
        readFileSync(
            path.join(repositoryRoot, defaultOwnerCatalogRelative),
            'utf8'
        )
    );
}

export function loadFactExtractorRegistry(repositoryRoot = defaultRoot)
{
    return JSON.parse(
        readFileSync(
            path.join(repositoryRoot, defaultFactExtractorRegistryRelative),
            'utf8'
        )
    );
}

export function loadBehaviorCatalog(repositoryRoot = defaultRoot)
{
    return loadCatalog(path.join(repositoryRoot, catalogRelative));
}

/**
 * Validate the reviewed per-behavior mutation owner catalog against the
 * BehaviorCatalog, fact-extractor registry and reviewed AEDS critical slice.
 *
 * Fail-closed rules (delivery items 1, 11):
 *   - every active mutation-required behavior has exactly one catalog entry;
 *   - every source file exists, is .cs and lives under a mutation source project;
 *   - every source file is owned by exactly one behavior (unique attribution);
 *   - every C# registry input under a mutation source project is covered by the
 *     union of catalog entries (registry drift fails closed);
 *   - binary-api-aeds-contract must cover the reviewed AEDS critical slice
 *     source regions (AedsEncoder.cs) from critical.json/release-parity-subset.json.
 */
export function validateBehaviorMutationOwnerCatalog({
    behaviorCatalog,
    factExtractorRegistry,
    ownerCatalog,
    sourceProjects = ['src/backend', 'src/core'],
    repositoryRoot = defaultRoot,
    reviewedSliceSourceFiles = ['src/core/Algorithms/AedsEncoder.cs']
})
{
    const errors = [];
    if (!ownerCatalog || ownerCatalog.schema !== behaviorMutationOwnerCatalogSchema)
    {
        return {
            ok: false,
            errors: [`owner catalog schema must be ${behaviorMutationOwnerCatalogSchema}`],
            bindings: []
        };
    }
    if (!Array.isArray(ownerCatalog.behaviors))
    {
        return { ok: false, errors: ['owner catalog must declare behaviors[]'], bindings: [] };
    }
    const requiredBehaviors = (behaviorCatalog?.contracts ?? [])
        .filter((contract) =>
            contract?.status === 'active'
      && contract?.mutationPolicy?.mutationRequired === true)
        .map((contract) => contract.id)
        .sort((left, right) => left.localeCompare(right));

    const entryByBehavior = new Map();
    for (const entry of ownerCatalog.behaviors)
    {
        if (!entry || typeof entry.behaviorId !== 'string' || entry.behaviorId.length === 0)
        {
            errors.push('owner catalog entry requires behaviorId');
            continue;
        }
        if (!Array.isArray(entry.sourceFiles) || entry.sourceFiles.length === 0)
        {
            errors.push(`${entry.behaviorId} owner catalog entry requires non-empty sourceFiles[]`);
            continue;
        }
        if (entryByBehavior.has(entry.behaviorId))
        {
            errors.push(`${entry.behaviorId} owner catalog entry is duplicated`);
            continue;
        }
        entryByBehavior.set(entry.behaviorId, entry);
    }

    for (const behaviorId of requiredBehaviors)
    {
        if (!entryByBehavior.has(behaviorId))
        {
            errors.push(`${behaviorId} missing mutation-owner catalog entry`);
        }
    }
    for (const behaviorId of [...entryByBehavior.keys()].sort())
    {
        if (!requiredBehaviors.includes(behaviorId))
        {
            errors.push(`${behaviorId} owner catalog entry is not an active mutation-required behavior`);
        }
    }

    // File existence + source-project eligibility + unique ownership.
    const ownerByFile = new Map();
    for (const behaviorId of requiredBehaviors)
    {
        const entry = entryByBehavior.get(behaviorId);
        if (!entry)
        {
            continue;
        }
        for (const rawPath of entry.sourceFiles)
        {
            const sourcePath = normalize(rawPath);
            if (!sourcePath.endsWith('.cs'))
            {
                errors.push(`${behaviorId} owner source must be a C# file: ${sourcePath}`);
                continue;
            }
            if (sourceProjectFor(sourcePath, sourceProjects) === null)
            {
                errors.push(`${behaviorId} owner source is outside mutation source projects: ${sourcePath}`);
                continue;
            }
            const absolute = path.join(repositoryRoot, sourcePath);
            if (!existsSync(absolute))
            {
                errors.push(`${behaviorId} owner source does not exist: ${sourcePath}`);
                continue;
            }
            if (ownerByFile.has(sourcePath) && ownerByFile.get(sourcePath) !== behaviorId)
            {
                errors.push(
                    `owner source is shared by multiple behaviors (unique attribution required): ${sourcePath} (${ownerByFile.get(sourcePath)} and ${behaviorId})`
                );
                continue;
            }
            ownerByFile.set(sourcePath, behaviorId);
        }
    }

    // Registry coverage: every C# consumed input under a source project must be
    // owned by exactly one catalog behavior. Registry drift fails closed.
    if (factExtractorRegistry && Array.isArray(factExtractorRegistry.extractors))
    {
        const extractorById = new Map(
            factExtractorRegistry.extractors
                .filter((entry) => entry && typeof entry.id === 'string')
                .map((entry) => [entry.id, entry])
        );
        for (const behaviorId of requiredBehaviors)
        {
            const contract = (behaviorCatalog?.contracts ?? []).find((entry) => entry.id === behaviorId);
            const extractor = contract?.factExtractorId
                ? extractorById.get(contract.factExtractorId)
                : null;
            if (!extractor)
            {
                errors.push(`${behaviorId} has no fact-extractor registry entry`);
                continue;
            }
            for (const file of csharpClosureFromRegistry(extractor, sourceProjects))
            {
                if (!ownerByFile.has(file))
                {
                    errors.push(
                        `${behaviorId} fact-extractor registry C# input is not covered by the mutation-owner catalog: ${file}`
                    );
                }
            }
        }
    }

    // Reviewed AEDS critical slice coverage for binary-api-aeds-contract.
    for (const file of [...new Set(reviewedSliceSourceFiles.map(normalize))])
    {
        if (ownerByFile.has(file))
        {
            continue;
        }
        if (file.endsWith('.cs') && sourceProjectFor(file, sourceProjects) !== null)
        {
            errors.push(`reviewed AEDS critical slice source is not in the mutation-owner catalog: ${file}`);
        }
    }

    const bindings = [];
    const sourceDigests = {};
    if (errors.length === 0)
    {
        const { digest: catalogDigest } = validateCatalog(behaviorCatalog, repositoryRoot);
        for (const behaviorId of requiredBehaviors)
        {
            const entry = entryByBehavior.get(behaviorId);
            if (!entry)
            {
                continue;
            }
            for (const sourcePath of [...new Set(entry.sourceFiles.map(normalize))].sort())
            {
                if (!ownerByFile.has(sourcePath) || ownerByFile.get(sourcePath) !== behaviorId)
                {
                    continue;
                }
                const absolute = path.join(repositoryRoot, sourcePath);
                if (!existsSync(absolute))
                {
                    continue;
                }
                const sourceDigest = sha256Text(readFileSync(absolute, 'utf8'));
                sourceDigests[sourcePath] = sourceDigest;
                bindings.push({
                    behaviorId,
                    language: 'csharp',
                    sourcePath,
                    symbol: symbolFromPath(sourcePath),
                    bindingKind: 'fact-extractor-consumed',
                    sourceDigest,
                    catalogDigest,
                    worktreeDigest: null,
                    status: 'ok'
                });
            }
        }
        bindings.sort((left, right) =>
            `${left.behaviorId}\0${left.sourcePath}`.localeCompare(`${right.behaviorId}\0${right.sourcePath}`));
    }

    return {
        ok: errors.length === 0,
        errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right)),
        bindings,
        sourceDigests
    };
}

/**
 * Derive + seal the exact C# implementation-owner mutation closure.
 *
 * @returns {{ closure: object|null, errors: string[] }}
 */
export function deriveBehaviorMutationOwners({
    behaviorCatalog,
    factExtractorRegistry,
    ownerCatalog,
    sourceProjects = ['src/backend', 'src/core'],
    repositoryRoot = defaultRoot,
    worktreeDigest = resolveWorktreeDigest(repositoryRoot),
    reviewedSliceSourceFiles
})
{
    const validated = validateBehaviorMutationOwnerCatalog({
        behaviorCatalog,
        factExtractorRegistry,
        ownerCatalog,
        sourceProjects,
        repositoryRoot,
        reviewedSliceSourceFiles
    });
    if (!validated.ok)
    {
        return { closure: null, errors: validated.errors };
    }
    const { digest: catalogDigest } = validateCatalog(behaviorCatalog, repositoryRoot);
    const closure = sealBehaviorMutationOwnerClosure({
        schema: behaviorMutationOwnerSchema,
        catalogDigest,
        worktreeDigest,
        bindings: validated.bindings.map((binding) => ({ ...binding, worktreeDigest })),
        errors: []
    });
    return { closure, errors: [] };
}

/**
 * Seal a derived owner closure with a contentDigest so it can be bound into
 * the mutation selection and evidence receipts.
 */
export function sealBehaviorMutationOwnerClosure(report)
{
    if (!report || report.schema !== behaviorMutationOwnerSchema)
    {
        throw new Error(`[behavior-mutation-owner] closure schema must be ${behaviorMutationOwnerSchema}`);
    }
    if (!digestPattern.test(String(report.catalogDigest ?? '')))
    {
        throw new Error('[behavior-mutation-owner] closure catalogDigest must be a SHA-256 digest');
    }
    if (!Array.isArray(report.bindings) || !Array.isArray(report.errors))
    {
        throw new Error('[behavior-mutation-owner] closure bindings/errors required');
    }
    const payload = {
        schema: report.schema,
        catalogDigest: report.catalogDigest,
        worktreeDigest: String(report.worktreeDigest ?? ''),
        bindings: report.bindings
            .map((binding) => ({
                behaviorId: binding.behaviorId,
                language: binding.language,
                sourcePath: binding.sourcePath,
                symbol: binding.symbol,
                bindingKind: binding.bindingKind,
                sourceDigest: binding.sourceDigest,
                catalogDigest: binding.catalogDigest ?? report.catalogDigest,
                worktreeDigest: binding.worktreeDigest ?? report.worktreeDigest,
                status: binding.status ?? 'ok'
            }))
            .sort((left, right) =>
                `${left.behaviorId}\0${left.sourcePath}`.localeCompare(`${right.behaviorId}\0${right.sourcePath}`)),
        errors: [...report.errors].sort((left, right) => left.localeCompare(right))
    };
    payload.contentDigest = digestValue(payload);
    return payload;
}
