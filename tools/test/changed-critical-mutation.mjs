#!/usr/bin/env node
/**
 * Changed-critical mutation selection — receipt-driven.
 *
 * Fixed selection chain:
 *   changed paths → ImplementationOwner receipt → Behavior IDs
 *   → BehaviorCatalog mutationPolicy → BehaviorTestBinding receipt → test filters
 *   → Stryker tool policy
 *
 * No hand-written source-pattern→test-owner glob mappings.
 *
 * Two scopes are supported:
 *   - scope=pr      : behaviors whose implementation owners changed, plus a
 *                     fail-closed full required-behavior trigger when any
 *                     governance-sensitive path (docs/bindings/catalog/tooling)
 *                     changed so docs-only or binding/catalog changes can never
 *                     skip required mutation qualification.
 *   - scope=release : every active mutation-required behavior in the catalog
 *                     (release candidates must never omit required mutants).
 */
import {
    canonicalJson,
    requireChangedCriticalSourceState,
    sha256
} from './changed-critical-mutation-identity.mjs';
import {
    matchesChangedPath,
    normalizeChangedPath,
    resolveChangedCriticalSourceProject
} from './changed-critical-mutation-support.mjs';

const TOOL_POLICY_SCHEMA = 'fsusblog.changed-critical-mutation-tool-policy.v3';

/**
 * Governance-sensitive paths that always trigger the full required-behavior
 * qualification. Docs, binding receipts, catalogs, schemas and the mutation
 * tooling itself are part of the qualification contract, so changing them can
 * never produce an empty mutation closure on the justification that source
 * implementation files did not change.
 */
export const GOVERNANCE_SENSITIVE_PATH_PATTERNS = Object.freeze([
    'docs/testing.md',
    'docs/testing/**',
    'config/contracts/behavior-contracts.json',
    'config/contracts/behavior-contract-catalog.schema.json',
    'config/testing/behavior-test-binding*',
    'config/testing/mutation/**',
    'config/schemas/behavior-test-binding*',
    'config/schemas/mutation-evidence-receipt*',
    'tools/contracts/behavior-test-binding*',
    'tools/contracts/behavior-contract-catalog*',
    'tools/contracts/behavior-graph*',
    'tools/test/changed-critical-mutation*',
    'tools/test/mutation-evidence-receipt*',
    'tools/test-matrix/produce-behavior-test-evidence*',
    'tools/test-matrix/verify-behavior-test-evidence*',
    'tools/test-matrix/produce-behavior-mutation-qualification*',
    'tools/test-matrix/verify-behavior-mutation-qualification*',
    'tools/governance/check-behavior-mutation-governance*',
    'tools/test/lanes/backend-mutation-changed-critical.sh',
    'tests/tools/behavior-test-binding.test.mjs',
    'tests/tools/changed-critical-mutation.test.mjs',
    'tests/tools/behavior-mutation-qualification.test.mjs',
    'tests/tools/check-behavior-mutation-governance.test.mjs',
    'tests/tools/produce-behavior-test-evidence.test.mjs',
    'tests/tools/verify-behavior-test-evidence.test.mjs',
    'tests/matrix.yml'
]);

export function validateToolPolicy(toolPolicy)
{
    if (toolPolicy?.schema !== TOOL_POLICY_SCHEMA || toolPolicy.version !== 3)
    {
        throw new Error('changed-critical mutation tool policy must use schema v3');
    }
    const defaults = toolPolicy.defaults;
    if (
        !defaults?.configuration
    || !defaults?.mutationLevel
    || defaults?.coverageAnalysis !== 'perTestInIsolation'
    || !Number.isFinite(defaults?.thresholds?.high)
    || !Number.isFinite(defaults?.thresholds?.low)
    || !Number.isFinite(defaults?.thresholds?.break)
    )
    {
        throw new Error(
            'tool policy defaults must declare configuration, mutationLevel, '
            + 'perTestInIsolation coverageAnalysis, and thresholds'
        );
    }
    if (!Array.isArray(toolPolicy.sourceProjects) || toolPolicy.sourceProjects.length === 0)
    {
        throw new Error('tool policy sourceProjects must be non-empty');
    }
    if (
        !Number.isSafeInteger(toolPolicy.executionLimits?.maxConcurrentTestRunners)
        || toolPolicy.executionLimits.maxConcurrentTestRunners < 1
    )
    {
        throw new Error('tool policy maxConcurrentTestRunners must be a positive integer');
    }
    const executionLimitKeys = Object.keys(toolPolicy.executionLimits).sort();
    if (
        executionLimitKeys.length !== 1
        || executionLimitKeys[0] !== 'maxConcurrentTestRunners'
    )
    {
        throw new Error('changed-critical execution limits must use only maxConcurrentTestRunners');
    }
    return toolPolicy;
}

function mutationRequiredContracts(behaviorCatalog)
{
    return (behaviorCatalog?.contracts ?? [])
        .filter((contract) => contract?.mutationPolicy?.mutationRequired === true && contract.status === 'active');
}

function sourceOwnerBindings(ownerReceipt, implementationOwnerClosure, behaviorId)
{
    return [
        ...(ownerReceipt?.bindings ?? []),
        ...(implementationOwnerClosure?.bindings ?? [])
    ].filter((binding) => binding?.behaviorId === behaviorId && binding?.status !== 'error');
}

function isMutationEligibleOwner(binding, sourceProjects)
{
    const sourcePath = String(binding?.sourcePath ?? '').replaceAll('\\', '/');
    if (
        binding?.bindingKind !== 'reviewed-runtime-kernel'
        || !sourcePath.endsWith('.cs')
        || typeof binding?.mutationPattern !== 'string'
        || binding.mutationPattern.length === 0
    )
    {
        return false;
    }
    try
    {
        resolveChangedCriticalSourceProject(sourcePath, sourceProjects);
        return true;
    }
    catch
    {
        return false;
    }
}

function collectRequiredBehaviorEntries({
    behaviorCatalog,
    ownerReceipt,
    implementationOwnerClosure,
    reasonPrefix
})
{
    const entries = new Map();
    for (const contract of mutationRequiredContracts(behaviorCatalog))
    {
        const owners = sourceOwnerBindings(ownerReceipt, implementationOwnerClosure, contract.id);
        entries.set(contract.id, {
            behaviorId: contract.id,
            contract,
            owners,
            reasons: owners.length > 0
                ? owners.map((binding) => `${reasonPrefix}:${String(binding.sourcePath).replaceAll('\\', '/')}`)
                : [`${reasonPrefix}:no-owner-binding`]
        });
    }
    return entries;
}

/**
 * Shared downstream builder: owner entries → test filters → mutate files →
 * behavior-owner execution closures → sealed selection.
 */
function finalizeBehaviorSelection({
    toolPolicy,
    rawToolPolicy,
    sourceState,
    ownerReceipt,
    implementationOwnerClosure,
    behaviorCatalog,
    testBindingScan,
    rawTestBindingScan,
    entries,
    uniquePaths,
    scope
})
{
    validateToolPolicy(toolPolicy);
    const normalizedSourceState = requireChangedCriticalSourceState(sourceState);
    const policyBytes = rawToolPolicy ?? Buffer.from(`${JSON.stringify(toolPolicy, null, 2)}\n`);
    const policyDigest = sha256(policyBytes);

    // BehaviorTestBinding receipt → exact test filters.
    const testBindings = testBindingScan?.bindings ?? [];
    const behaviors = [...entries.values()]
        .map((entry) =>
        {
            const behaviorTestBindings = testBindings.filter(
                (b) => b.behaviorId === entry.behaviorId
            );
            // Derive FullyQualifiedName~ filters from test binding class names.
            const testFilters = [...new Set(
                behaviorTestBindings.map((b) =>
                {
                    const fqn = String(b.fullyQualifiedName ?? '');
                    const testId = String(b.canonicalTestId ?? '');
                    const canonicalClass = testId.match(/^xunit-trx:([^#]+)#/u)?.[1];
                    const className = canonicalClass ?? fqn.split('.').at(-2) ?? '';
                    return className.trim();
                }).filter(Boolean)
            )].sort();
            const filterExpression = testFilters
                .map((cls) => `FullyQualifiedName~${cls}`)
                .join('|');
            const mutateTargets = entry.owners
                .filter((owner) => isMutationEligibleOwner(owner, toolPolicy.sourceProjects))
                .map((owner) => ({
                    sourcePath: String(owner.sourcePath).replaceAll('\\', '/'),
                    mutationPattern: String(owner.mutationPattern).replaceAll('\\', '/'),
                    mutationScope: owner.mutationScope
                }))
                .filter((target, index, targets) =>
                    targets.findIndex((candidate) =>
                        candidate.sourcePath === target.sourcePath
                        && candidate.mutationPattern === target.mutationPattern) === index)
                .sort((left, right) =>
                    `${left.sourcePath}\0${left.mutationPattern}`
                        .localeCompare(`${right.sourcePath}\0${right.mutationPattern}`));
            const mutateFiles = [...new Set(mutateTargets.map(({ sourcePath }) => sourcePath))].sort();
            return {
                behaviorId: entry.behaviorId,
                risk: entry.contract.risk,
                mutationPolicy: entry.contract.mutationPolicy,
                reasons: [...new Set(entry.reasons)].sort(),
                owners: entry.owners.map((o) => ({
                    sourcePath: String(o.sourcePath).replaceAll('\\', '/'),
                    symbol: o.symbol,
                    language: o.language,
                    bindingKind: o.bindingKind ?? null,
                    mutationScope: o.mutationScope ?? null,
                    mutationPattern: o.mutationPattern ?? null
                })),
                mutateFiles,
                mutateTargets,
                testBindings: behaviorTestBindings.map((b) => ({
                    canonicalTestId: b.canonicalTestId,
                    fullyQualifiedName: b.fullyQualifiedName,
                    testKind: b.testKind
                })),
                testFilters,
                testFilter: filterExpression
            };
        })
        .sort((left, right) => left.behaviorId.localeCompare(right.behaviorId));

    const mutateFiles = [...new Set(behaviors.flatMap((b) => b.mutateFiles))].sort();
    const mutateTargets = behaviors
        .flatMap((behavior) => behavior.mutateTargets)
        .filter((target, index, targets) =>
            targets.findIndex((candidate) =>
                candidate.sourcePath === target.sourcePath
                && candidate.mutationPattern === target.mutationPattern) === index)
        .sort((left, right) =>
            `${left.sourcePath}\0${left.mutationPattern}`
                .localeCompare(`${right.sourcePath}\0${right.mutationPattern}`));
    const testFilter = [...new Set(
        behaviors.flatMap((b) => b.testFilters)
    )].sort().map((cls) => `FullyQualifiedName~${cls}`).join('|');

    // Physical execution closures partition every selected source file by
    // source project and its exact behavior-owner set. This keeps a file in
    // exactly one Stryker run while preventing unrelated behaviors/tests from
    // sharing one heavily instrumented assembly.
    const sourceProjects = [...new Set(
        mutateFiles
            .map((file) => resolveChangedCriticalSourceProject(file, toolPolicy.sourceProjects))
    )].sort();
    const executionClosureGroups = new Map();
    for (const sourceProject of sourceProjects)
    {
        const files = mutateFiles.filter((file) => file.startsWith(`${sourceProject}/`));
        for (const file of files)
        {
            const behaviorIds = behaviors
                .filter((behavior) => behavior.mutateFiles.includes(file))
                .map((behavior) => behavior.behaviorId)
                .sort();
            if (behaviorIds.length === 0)
            {
                throw new Error(`selected mutate file has no behavior owner: ${file}`);
            }
            const ownershipKey = behaviorIds.join('+');
            const runKey = `${ownershipKey}--${sourceProject.replaceAll('/', '-')}`;
            if (!executionClosureGroups.has(runKey))
            {
                executionClosureGroups.set(runKey, {
                    runKey,
                    sourceProject,
                    behaviorIds,
                    mutateFiles: [],
                    mutatePatterns: []
                });
            }
            executionClosureGroups.get(runKey).mutateFiles.push(
                file.slice(sourceProject.length + 1)
            );
            const target = mutateTargets.find(({ sourcePath }) => sourcePath === file);
            if (!target)
            {
                throw new Error(`selected mutate file has no reviewed mutation target: ${file}`);
            }
            executionClosureGroups.get(runKey).mutatePatterns.push(
                target.mutationPattern.slice(sourceProject.length + 1)
            );
        }
    }
    const executionClosures = [...executionClosureGroups.values()]
        .map((closure) =>
        {
            const closureBehaviors = behaviors.filter((behavior) =>
                closure.behaviorIds.includes(behavior.behaviorId));
            const testFilters = [...new Set(
                closureBehaviors.flatMap((behavior) => behavior.testFilters)
            )].sort();
            return {
                runKey: closure.runKey,
                sourceProject: closure.sourceProject,
                behaviors: closureBehaviors.map(({ behaviorId, risk }) => ({ behaviorId, risk })),
                mutateFiles: [...new Set(closure.mutateFiles)].sort(),
                mutatePatterns: [...new Set(closure.mutatePatterns)].sort(),
                testFilters,
                testFilter: testFilters.map((cls) => `FullyQualifiedName~${cls}`).join('|')
            };
        })
        .sort((left, right) => left.runKey.localeCompare(right.runKey));

    for (const closure of executionClosures)
    {
        if (closure.testFilters.length === 0)
        {
            throw new Error(`execution closure ${closure.runKey} has no binding-derived tests`);
        }
    }

    const base = {
        schema: 'fsusblog.changed-critical-mutation-selection.v4',
        status: behaviors.length === 0 ? 'empty' : 'selected',
        scope,
        sourceState: normalizedSourceState,
        toolPolicy: {
            path: 'config/testing/mutation/changed-critical-domains.v1.json',
            sha256: policyDigest,
            version: toolPolicy.version
        },
        ownerReceiptDigest: ownerReceipt?.contentDigest ?? null,
        implementationOwnerClosureDigest: implementationOwnerClosure?.contentDigest ?? null,
        behaviorCatalogDigest: behaviorCatalog?.digest ?? sha256(canonicalJson(behaviorCatalog)),
        testBindingScanDigest: sha256(rawTestBindingScan ?? canonicalJson(testBindingScan)),
        changedPaths: uniquePaths,
        behaviors,
        mutateFiles,
        mutateTargets,
        testFilter,
        executionClosures,
        reasons: behaviors.flatMap((b) => b.reasons).sort()
    };
    return {
        ...base,
        closureDigest: sha256(canonicalJson(base))
    };
}

function requireSourceProjectMapping(behaviorId, owners, sourceProjects)
{
    const eligible = owners.filter((owner) => isMutationEligibleOwner(owner, sourceProjects));
    const unmapped = eligible.filter((owner) =>
    {
        try
        {
            resolveChangedCriticalSourceProject(
                String(owner.sourcePath).replaceAll('\\', '/'),
                sourceProjects
            );
            return false;
        }
        catch
        {
            return true;
        }
    });
    return unmapped;
}

/**
 * Select the full required-behavior mutation closure (release candidate scope).
 *
 * Every active behavior with mutationPolicy.mutationRequired=true must be
 * included; a missing C# implementation-owner binding for any required
 * behavior fails closed because the exact required mutants cannot be derived.
 */
export function selectRequiredBehaviorMutations({
    toolPolicy,
    rawToolPolicy,
    sourceState,
    ownerReceipt,
    implementationOwnerClosure,
    behaviorCatalog,
    testBindingScan,
    rawTestBindingScan
})
{
    validateToolPolicy(toolPolicy);
    const entries = collectRequiredBehaviorEntries({
        behaviorCatalog,
        ownerReceipt,
        implementationOwnerClosure,
        reasonPrefix: 'required:release'
    });
    if (entries.size === 0)
    {
        throw new Error('release mutation scope requires at least one active mutation-required behavior in the catalog');
    }
    const unmappedByBehavior = [];
    for (const [behaviorId, entry] of entries)
    {
        if (!entry.owners.some((owner) => isMutationEligibleOwner(owner, toolPolicy.sourceProjects)))
        {
            unmappedByBehavior.push(`${behaviorId} (no C# implementation-owner mutation source)`);
            continue;
        }
        const unmapped = requireSourceProjectMapping(behaviorId, entry.owners, toolPolicy.sourceProjects);
        if (unmapped.length > 0)
        {
            unmappedByBehavior.push(
                `${behaviorId} (${unmapped.map((o) => o.sourcePath).join(', ')} has no source-project mapping)`
            );
        }
    }
    if (unmappedByBehavior.length > 0)
    {
        throw new Error(
            'release mutation scope cannot derive exact C# mutants for required behavior(s): '
      + unmappedByBehavior.join('; ')
        );
    }
    return finalizeBehaviorSelection({
        toolPolicy,
        rawToolPolicy,
        sourceState,
        ownerReceipt,
        implementationOwnerClosure,
        behaviorCatalog,
        testBindingScan,
        rawTestBindingScan,
        entries,
        uniquePaths: [],
        scope: 'release'
    });
}

/**
 * Select changed-critical mutation closure from receipts.
 *
 * @param {object} options
 * @param {object} options.toolPolicy - Tool policy (thresholds, source projects, execution limits)
 * @param {Buffer|string} options.rawToolPolicy - Raw bytes of tool policy for digest
 * @param {string[]} options.changedPaths - Changed file paths (repo-relative)
 * @param {object} options.sourceState - { commit, worktreeFingerprint }
 * @param {object} options.ownerReceipt - Sealed ImplementationOwner receipt with bindings[]
 * @param {object} options.behaviorCatalog - behavior-contracts.json with mutationPolicy per contract
 * @param {object} options.testBindingScan - BehaviorTestBinding scan with bindings[]
 * @param {Buffer|string} [options.rawTestBindingScan] - Raw scan bytes for identity
 */
export function selectChangedCriticalMutation({
    toolPolicy,
    rawToolPolicy,
    changedPaths,
    sourceState,
    ownerReceipt,
    implementationOwnerClosure,
    behaviorCatalog,
    testBindingScan,
    rawTestBindingScan
})
{
    validateToolPolicy(toolPolicy);
    const normalizedSourceState = requireChangedCriticalSourceState(sourceState);
    const uniquePaths = [...new Set(changedPaths.map(normalizeChangedPath))].sort();

    // Step 0: governance-sensitive changes always trigger the full required
    // behavior closure; docs-only/binding/catalog changes must never skip the
    // required mutation qualification because source implementation files did
    // not change.
    const governanceChanges = uniquePaths.filter((path) =>
        matchesChangedPath(path, GOVERNANCE_SENSITIVE_PATH_PATTERNS));
    if (governanceChanges.length > 0)
    {
        const entries = collectRequiredBehaviorEntries({
            behaviorCatalog,
            ownerReceipt,
            implementationOwnerClosure,
            reasonPrefix: 'governance-change'
        });
        for (const path of governanceChanges)
        {
            for (const entry of entries.values())
            {
                entry.reasons.push(`governance-change:${path}`);
            }
        }
        const unmappedByBehavior = [];
        for (const [behaviorId, entry] of entries)
        {
            if (!entry.owners.some((owner) => isMutationEligibleOwner(owner, toolPolicy.sourceProjects)))
            {
                unmappedByBehavior.push(`${behaviorId} (no C# implementation-owner mutation source)`);
                continue;
            }
            const unmapped = requireSourceProjectMapping(behaviorId, entry.owners, toolPolicy.sourceProjects);
            if (unmapped.length > 0)
            {
                unmappedByBehavior.push(
                    `${behaviorId} (${unmapped.map((o) => o.sourcePath).join(', ')} has no source-project mapping)`
                );
            }
        }
        if (unmappedByBehavior.length > 0)
        {
            throw new Error(
                'governance change requires the full required-behavior mutation closure but '
        + 'exact C# mutants cannot be derived for: ' + unmappedByBehavior.join('; ')
            );
        }
        return finalizeBehaviorSelection({
            toolPolicy,
            rawToolPolicy,
            sourceState: normalizedSourceState,
            ownerReceipt,
            implementationOwnerClosure,
            behaviorCatalog,
            testBindingScan,
            rawTestBindingScan,
            entries,
            uniquePaths,
            scope: 'pr'
        });
    }

    // Step 1: changed paths → ImplementationOwner receipt → Behavior IDs.
    const ownerBindings = [
        ...(ownerReceipt?.bindings ?? []),
        ...(implementationOwnerClosure?.bindings ?? [])
    ];
    const pathToBehaviors = new Map();
    for (const binding of ownerBindings)
    {
        if (binding.status === 'error')
        {
            continue;
        }
        const normalizedSource = String(binding.sourcePath ?? '').replaceAll('\\', '/');
        if (uniquePaths.includes(normalizedSource))
        {
            if (!pathToBehaviors.has(normalizedSource))
            {
                pathToBehaviors.set(normalizedSource, []);
            }
            pathToBehaviors.get(normalizedSource).push(binding);
        }
    }

    // Step 2: filter to behaviors with mutationRequired in BehaviorCatalog.
    const contractsById = new Map(
        (behaviorCatalog?.contracts ?? []).map((c) => [c.id, c])
    );
    const selectedBehaviors = new Map();

    for (const [changedPath, bindings] of pathToBehaviors)
    {
        for (const binding of bindings)
        {
            const contract = contractsById.get(binding.behaviorId);
            if (contract?.mutationPolicy?.mutationRequired === true && contract.status === 'active')
            {
                if (!selectedBehaviors.has(binding.behaviorId))
                {
                    selectedBehaviors.set(binding.behaviorId, {
                        behaviorId: binding.behaviorId,
                        contract,
                        owners: sourceOwnerBindings(
                            ownerReceipt,
                            implementationOwnerClosure,
                            binding.behaviorId
                        ),
                        reasons: []
                    });
                }
                const entry = selectedBehaviors.get(binding.behaviorId);
                entry.reasons.push(`changed:${changedPath}`);
            }
        }
    // If path matched an owner but no behavior has mutationRequired, it is not critical
    // (no fail-closed for non-mutation behaviors).
    }

    return finalizeBehaviorSelection({
        toolPolicy,
        rawToolPolicy,
        sourceState: normalizedSourceState,
        ownerReceipt,
        implementationOwnerClosure,
        behaviorCatalog,
        testBindingScan,
        rawTestBindingScan,
        entries: selectedBehaviors,
        uniquePaths,
        scope: 'pr'
    });
}

export function createChangedCriticalStrykerConfig(selection, toolPolicy, runKey = null)
{
    if (selection.status !== 'selected' || selection.mutateFiles.length === 0 || !selection.testFilter)
    {
        throw new Error('cannot generate Stryker config for an empty critical closure');
    }
    validateToolPolicy(toolPolicy);
    const selectedRun = runKey ?? selection.executionClosures[0]?.runKey;
    const closure = selection.executionClosures.find((entry) => entry.runKey === selectedRun);
    if (!closure)
    {
        throw new Error(`selection has no execution closure for ${selectedRun}`);
    }
    return {
        'stryker-config': {
            'test-projects': ['../../tests/backend/FsusBlog.Server.Tests.csproj'],
            configuration: toolPolicy.defaults.configuration,
            'test-case-filter': closure.testFilter,
            'mutation-level': toolPolicy.defaults.mutationLevel,
            'coverage-analysis': toolPolicy.defaults.coverageAnalysis,
            thresholds: toolPolicy.defaults.thresholds,
            'break-on-initial-test-failure': true,
            concurrency: toolPolicy.executionLimits.maxConcurrentTestRunners,
            reporters: ['progress', 'html', 'json'],
            'report-file-name': 'changed-critical-mutation',
            mutate: closure.mutatePatterns,
            'ignore-methods': toolPolicy.defaults.ignoreMethods
        }
    };
}
