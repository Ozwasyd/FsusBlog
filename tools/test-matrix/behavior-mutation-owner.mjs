/**
 * Per-behavior C# implementation-owner mutation closure (#2187).
 *
 * The exact mutants for a required release behavior are derived from the
 * machine-readable BehaviorCatalog + reviewed mutation-owner catalog
 * (config/testing/mutation/behavior-mutation-owners.v3.json). The catalog
 * selects reviewed executable runtime kernels independently from BehaviorDoc
 * fact-extractor inputs: those inputs also include DTOs, declarative catalogs
 * and broad hosting files that are observation dependencies but not useful
 * mutation targets. Each selected source kernel is owned by exactly one
 * behavior so every Stryker mutant attributes uniquely.
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

export const behaviorMutationOwnerSchema = 'fsusblog.behavior-mutation-owner-closure.v2';
export const behaviorMutationOwnerCatalogSchema = 'fsusblog.behavior-mutation-owners.v3';
export const defaultOwnerCatalogRelative = 'config/testing/mutation/behavior-mutation-owners.v3.json';

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

function normalizeMutationScope(scope, sourcePath, sourceLineCount, errors, behaviorId)
{
    if (!scope || typeof scope !== 'object' || Array.isArray(scope))
    {
        errors.push(`${behaviorId} owner kernel requires mutationScope: ${sourcePath}`);
        return null;
    }
    if (scope.kind === 'whole-file')
    {
        if (Object.keys(scope).some((key) => key !== 'kind'))
        {
            errors.push(`${behaviorId} whole-file mutationScope accepts only kind: ${sourcePath}`);
            return null;
        }
        return { kind: 'whole-file' };
    }
    if (scope.kind !== 'line-regions')
    {
        errors.push(`${behaviorId} mutationScope kind must be whole-file or line-regions: ${sourcePath}`);
        return null;
    }
    if (
        Object.keys(scope).some((key) => !['kind', 'regions'].includes(key))
        || !Array.isArray(scope.regions)
        || scope.regions.length === 0
    )
    {
        errors.push(`${behaviorId} line-regions mutationScope requires only non-empty regions[]: ${sourcePath}`);
        return null;
    }
    const regions = [];
    let previousEnd = 0;
    for (const [index, region] of scope.regions.entries())
    {
        if (
            !region
            || typeof region !== 'object'
            || Array.isArray(region)
            || Object.keys(region).sort().join(',') !== 'endLineExclusive,startLine'
            || !Number.isSafeInteger(region.startLine)
            || !Number.isSafeInteger(region.endLineExclusive)
            || region.startLine < 1
            || region.endLineExclusive <= region.startLine
            || region.endLineExclusive > sourceLineCount + 1
        )
        {
            errors.push(
                `${behaviorId} mutation region ${index} is invalid or outside ${sourcePath} `
                + `(lineCount=${sourceLineCount})`
            );
            continue;
        }
        if (region.startLine < previousEnd)
        {
            errors.push(`${behaviorId} mutation regions must be sorted and non-overlapping: ${sourcePath}`);
            continue;
        }
        regions.push({
            startLine: region.startLine,
            endLineExclusive: region.endLineExclusive
        });
        previousEnd = region.endLineExclusive;
    }
    return regions.length === scope.regions.length
        ? { kind: 'line-regions', regions }
        : null;
}

function mutationPattern(sourcePath, mutationScope)
{
    if (mutationScope.kind === 'whole-file')
    {
        return sourcePath;
    }
    return sourcePath + mutationScope.regions
        .map(({ startLine, endLineExclusive }) => `{${startLine}..${endLineExclusive}}`)
        .join('');
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

export function loadBehaviorCatalog(repositoryRoot = defaultRoot)
{
    return loadCatalog(path.join(repositoryRoot, catalogRelative));
}

/**
 * Validate the reviewed per-behavior runtime mutation kernels against the
 * BehaviorCatalog and reviewed AEDS critical slice.
 *
 * Fail-closed rules (delivery items 1, 11):
 *   - every active mutation-required behavior has exactly one catalog entry;
 *   - every source kernel exists, is .cs and lives under a mutation source project;
 *   - every source file is owned by exactly one behavior (unique attribution);
 *   - line regions are ordered, non-overlapping and within current source bounds;
 *   - binary-api-aeds-contract must cover the reviewed AEDS critical slice
 *     source regions (AedsEncoder.cs) from critical.json/release-parity-subset.json.
 */
export function validateBehaviorMutationOwnerCatalog({
    behaviorCatalog,
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
    if (
        ownerCatalog.version !== 3
        || Object.keys(ownerCatalog).sort().join(',') !== 'behaviors,description,schema,version'
    )
    {
        errors.push('owner catalog v3 requires only schema, version, description and behaviors');
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
        if (
            Object.keys(entry).sort().join(',') !== 'behaviorId,provenance,sourceKernels'
            || typeof entry.provenance !== 'string'
            || entry.provenance.length === 0
        )
        {
            errors.push(`${entry.behaviorId} owner catalog entry requires only behaviorId, provenance and sourceKernels`);
            continue;
        }
        if (!Array.isArray(entry.sourceKernels) || entry.sourceKernels.length === 0)
        {
            errors.push(`${entry.behaviorId} owner catalog entry requires non-empty sourceKernels[]`);
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
    const normalizedKernelsByBehavior = new Map();
    for (const behaviorId of requiredBehaviors)
    {
        const entry = entryByBehavior.get(behaviorId);
        if (!entry)
        {
            continue;
        }
        const normalizedKernels = [];
        const seenEntryPaths = new Set();
        for (const kernel of entry.sourceKernels)
        {
            if (
                !kernel
                || typeof kernel !== 'object'
                || Array.isArray(kernel)
                || Object.keys(kernel).sort().join(',') !== 'mutationScope,sourcePath'
            )
            {
                errors.push(`${behaviorId} owner kernel requires only sourcePath and mutationScope`);
                continue;
            }
            const sourcePath = normalize(kernel.sourcePath);
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
            if (seenEntryPaths.has(sourcePath))
            {
                errors.push(`${behaviorId} owner source is duplicated: ${sourcePath}`);
                continue;
            }
            seenEntryPaths.add(sourcePath);
            if (ownerByFile.has(sourcePath) && ownerByFile.get(sourcePath) !== behaviorId)
            {
                errors.push(
                    `owner source is shared by multiple behaviors (unique attribution required): ${sourcePath} (${ownerByFile.get(sourcePath)} and ${behaviorId})`
                );
                continue;
            }
            ownerByFile.set(sourcePath, behaviorId);
            const source = readFileSync(absolute, 'utf8');
            const sourceLineCount = source.split(/\r?\n/u).length;
            const mutationScope = normalizeMutationScope(
                kernel.mutationScope,
                sourcePath,
                sourceLineCount,
                errors,
                behaviorId
            );
            if (mutationScope)
            {
                normalizedKernels.push({
                    sourcePath,
                    mutationScope,
                    mutationPattern: mutationPattern(sourcePath, mutationScope)
                });
            }
        }
        normalizedKernelsByBehavior.set(behaviorId, normalizedKernels);
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
            for (const kernel of (normalizedKernelsByBehavior.get(behaviorId) ?? [])
                .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)))
            {
                const { sourcePath, mutationScope } = kernel;
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
                    bindingKind: 'reviewed-runtime-kernel',
                    mutationScope,
                    mutationPattern: kernel.mutationPattern,
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
    ownerCatalog,
    sourceProjects = ['src/backend', 'src/core'],
    repositoryRoot = defaultRoot,
    worktreeDigest = resolveWorktreeDigest(repositoryRoot),
    reviewedSliceSourceFiles
})
{
    const validated = validateBehaviorMutationOwnerCatalog({
        behaviorCatalog,
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
                mutationScope: binding.mutationScope,
                mutationPattern: binding.mutationPattern,
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
