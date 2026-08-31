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

const TOOL_POLICY_SCHEMA = 'fsusblog.changed-critical-mutation-tool-policy.v2';

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
    if (toolPolicy?.schema !== TOOL_POLICY_SCHEMA || toolPolicy.version !== 2)
    {
        throw new Error('changed-critical mutation tool policy must use schema v2');
    }
    const defaults = toolPolicy.defaults;
    if (
        !defaults?.configuration
    || !defaults?.mutationLevel
    || !Number.isFinite(defaults?.thresholds?.high)
    || !Number.isFinite(defaults?.thresholds?.low)
    || !Number.isFinite(defaults?.thresholds?.break)
    )
    {
        throw new Error('tool policy defaults must declare configuration, mutationLevel, and thresholds');
    }
    if (!Array.isArray(toolPolicy.sourceProjects) || toolPolicy.sourceProjects.length === 0)
    {
        throw new Error('tool policy sourceProjects must be non-empty');
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
    if (!sourcePath.endsWith('.cs'))
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
 * source-project closures → sealed selection.
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
            // Keep the physical mutation scope identical to the binding receipt.
            // A class-only filter would also execute unbound sibling tests, allowing
            // them to cover or kill mutants without a canonical behavior binding.
            const testFilters = [...new Set(
                behaviorTestBindings.map((b) =>
                {
                    const fqn = String(b.fullyQualifiedName ?? '');
                    const testId = String(b.canonicalTestId ?? '');
                    const canonicalParts = testId.match(/^xunit-trx:([^#]+)#([^#]+)$/u);
                    const canonicalFqn = canonicalParts
                        ? `${canonicalParts[1]}.${canonicalParts[2]}`
                        : fqn;
                    return canonicalFqn.trim();
                }).filter(Boolean)
            )].sort();
            const filterExpression = testFilters
                .map((test) => `FullyQualifiedName~${test}`)
                .join('|');
            const mutateFiles = [...new Set(
                entry.owners
                    .map((o) => String(o.sourcePath).replaceAll('\\', '/'))
                    .filter((sourcePath) =>
                    {
                        if (!sourcePath.endsWith('.cs'))
                        {
                            return false;
                        }
                        try
                        {
                            resolveChangedCriticalSourceProject(sourcePath, toolPolicy.sourceProjects);
                            return true;
                        }
                        catch
                        {
                            return false;
                        }
                    })
            )].sort();
            return {
                behaviorId: entry.behaviorId,
                risk: entry.contract.risk,
                mutationPolicy: entry.contract.mutationPolicy,
                reasons: [...new Set(entry.reasons)].sort(),
                owners: entry.owners.map((o) => ({
                    sourcePath: String(o.sourcePath).replaceAll('\\', '/'),
                    symbol: o.symbol,
                    language: o.language
                })),
                mutateFiles,
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
    const testFilter = [...new Set(
        behaviors.flatMap((b) => b.testFilters)
    )].sort().map((test) => `FullyQualifiedName~${test}`).join('|');

    // Source project closures.
    const sourceProjects = [...new Set(
        mutateFiles
            .map((file) => resolveChangedCriticalSourceProject(file, toolPolicy.sourceProjects))
    )].sort();
    const projectClosures = sourceProjects.map((sourceProject) =>
    {
        const projectBehaviors = behaviors.filter((b) =>
            b.mutateFiles.some((f) => f.startsWith(`${sourceProject}/`)));
        const projectMutateFiles = [...new Set(
            projectBehaviors.flatMap((b) =>
                b.mutateFiles
                    .filter((f) => f.startsWith(`${sourceProject}/`))
                    .map((f) => f.slice(sourceProject.length + 1))
            )
        )].sort();
        const projectTestFilters = [...new Set(
            projectBehaviors.flatMap((b) => b.testFilters)
        )].sort();
        return {
            sourceProject,
            behaviors: projectBehaviors.map(({ behaviorId, risk }) => ({ behaviorId, risk })),
            mutateFiles: projectMutateFiles,
            testFilters: projectTestFilters,
            testFilter: projectTestFilters.map((test) => `FullyQualifiedName~${test}`).join('|')
        };
    });

    const base = {
        schema: 'fsusblog.changed-critical-mutation-selection.v2',
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
        testFilter,
        projectClosures,
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
        let hasMutationRequired = false;
        for (const binding of bindings)
        {
            const contract = contractsById.get(binding.behaviorId);
            if (contract?.mutationPolicy?.mutationRequired === true && contract.status === 'active')
            {
                hasMutationRequired = true;
                if (!selectedBehaviors.has(binding.behaviorId))
                {
                    selectedBehaviors.set(binding.behaviorId, {
                        behaviorId: binding.behaviorId,
                        contract,
                        owners: [],
                        reasons: []
                    });
                }
                const entry = selectedBehaviors.get(binding.behaviorId);
                entry.owners.push(binding);
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

export function createChangedCriticalStrykerConfig(selection, toolPolicy, sourceProject = null)
{
    if (selection.status !== 'selected' || selection.mutateFiles.length === 0 || !selection.testFilter)
    {
        throw new Error('cannot generate Stryker config for an empty critical closure');
    }
    validateToolPolicy(toolPolicy);
    const selectedProject = sourceProject ?? selection.projectClosures[0]?.sourceProject;
    const closure = selection.projectClosures.find((entry) => entry.sourceProject === selectedProject);
    if (!closure)
    {
        throw new Error(`selection has no source-project closure for ${selectedProject}`);
    }
    return {
        'stryker-config': {
            'test-projects': ['../../tests/backend/FsusBlog.Server.Tests.csproj'],
            configuration: toolPolicy.defaults.configuration,
            'test-case-filter': closure.testFilter,
            'mutation-level': toolPolicy.defaults.mutationLevel,
            // The selected closure can contain Docker/PostgreSQL tests whose
            // lease semantics are part of the behavior under qualification.
            // Parallel mutant workers would turn host contention into an
            // unrelated kill, so the authority records a serialized topology.
            concurrency: 1,
            thresholds: toolPolicy.defaults.thresholds,
            'break-on-initial-test-failure': true,
            reporters: ['progress', 'html', 'json'],
            'report-file-name': 'changed-critical-mutation',
            mutate: closure.mutateFiles,
            'ignore-methods': toolPolicy.defaults.ignoreMethods
        }
    };
}
