/* eslint-disable import-x/no-relative-parent-imports -- The matrix profile composes the canonical fixture catalog authority. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { performanceSteps } from '../test/bundles/bundle-steps.mjs';
import { expandFixtureProfile } from '../testing/fixture-catalog.mjs';

import { createArtifactDigestTable } from './artifact-digest-table.mjs';
import {
    behaviorDocStaticAdmissionTierId,
    isExternalBehaviorDocAdmissionDependency,
    localBehaviorDocCandidateBundleIds
} from './behavior-doc-static-admission-contract.mjs';
import { productionResidentServiceIds } from './resident-resource-leases.mjs';

function profileEntries(localProfiles)
{
    return Object.entries(localProfiles ?? {});
}

function tierExecutionDependencies(tier)
{
    return tier?.executionDependsOn ?? tier?.dependsOn ?? [];
}

const bundleSummarySchema = 'fsusblog.local-production.bundle.v1';
const summaryOnlySchema = 'fsusblog.local-production.summary-only.v1';
const logicalProjectionSchema = 'fsusblog.local-profile-projection.v1';
export const productionWallClockBudgetMs = 3_600_000;
export const performanceMixedWindowFloorMs = 60_000;
const performanceDeadlineEvidenceSchema = 'fsusblog.performance-deadline-evidence.v2';
const performanceMeasurementStepIds = Object.freeze(performanceSteps()
    .filter((step) => step.evidencePhase === 'measurement')
    .map((step) => step.id).sort());

function terminalDigest(value)
{
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const generatedRuntimeRoots = [
    '.tmp',
    'BenchmarkDotNet.Artifacts',
    'src/backend/wwwroot',
    'src/frontend/coverage',
    'src/frontend/dist',
    'src/frontend/playwright-report',
    'src/frontend/test-results'
];

function normalizeDeclaration(value)
{
    return String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/');
}

function acceptanceNamespace(value)
{
    const slug = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    return slug && slug !== '.' && slug !== '..' ? slug : 'local';
}

function generatedRuntimeDeclaration(value)
{
    const normalized = normalizeDeclaration(value);
    return generatedRuntimeRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function matrixGeneratedRuntimePaths(tier)
{
    return sortedUnique([...(tier?.artifacts ?? []), ...(tier?.evidence ?? [])]
        .map(normalizeDeclaration)
        .filter(generatedRuntimeDeclaration));
}

function plainRecord(value)
{
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeRepositoryDeclaration(value)
{
    const normalized = normalizeDeclaration(value);
    return Boolean(normalized)
    && !path.isAbsolute(normalized)
    && normalized !== '..'
    && !normalized.startsWith('../');
}

function authoritativeSubstitutionProofPath(value)
{
    const normalized = normalizeDeclaration(value).toLowerCase();
    return normalized.endsWith('.trx')
    || normalized.includes('/coverage/')
    || normalized.endsWith('/coverage')
    || normalized.endsWith('/summary.json');
}

function buildArtifactSubstitutionContract(bundle, matrixTiers)
{
    const errors = [];
    const byTier = {};
    const rawContract = bundle?.artifactSubstitutions;
    if (rawContract === undefined)
    {
        return { errors, byTier };
    }
    if (!Array.isArray(rawContract) || rawContract.length === 0)
    {
        return { errors: ['artifactSubstitutions must be a non-empty flat array'], byTier };
    }
    const matrixById = new Map((matrixTiers ?? []).map((tier) => [tier.id, tier]));
    const normalizedMappingsByTier = new Map();
    for (const rawEntry of rawContract)
    {
        const entry = String(rawEntry ?? '').trim();
        const separatorIndex = entry.indexOf('::');
        const arrowIndex = entry.indexOf('=>', separatorIndex + 2);
        if (!entry || separatorIndex <= 0 || arrowIndex <= separatorIndex + 2
      || entry.indexOf('::', separatorIndex + 2) >= 0 || entry.indexOf('=>', arrowIndex + 2) >= 0)
        {
            errors.push(`artifactSubstitutions entry is malformed: ${entry || '<empty>'}`);
            continue;
        }
        const tierId = entry.slice(0, separatorIndex).trim();
        const rawCanonical = entry.slice(separatorIndex + 2, arrowIndex).trim();
        const rawActualPaths = entry.slice(arrowIndex + 2).split('|').map((value) => value.trim());
        if (!tierId || !(bundle?.members ?? []).includes(tierId) || !matrixById.has(tierId))
        {
            errors.push(`artifactSubstitutions references unknown bundle tier: ${tierId || '<empty>'}`);
            continue;
        }
        const canonicalRuntimePaths = new Set(matrixGeneratedRuntimePaths(matrixById.get(tierId)));
        const normalizedMappings = normalizedMappingsByTier.get(tierId) ?? {};
        normalizedMappingsByTier.set(tierId, normalizedMappings);
        const canonical = normalizeDeclaration(rawCanonical);
        if (!safeRepositoryDeclaration(rawCanonical))
        {
            errors.push(`artifactSubstitutions.${tierId} has an invalid canonical path: ${canonical || '<empty>'}`);
            continue;
        }
        if (Object.hasOwn(normalizedMappings, canonical))
        {
            errors.push(`artifactSubstitutions.${tierId} has duplicate canonical path: ${canonical}`);
            continue;
        }
        if (!canonicalRuntimePaths.has(canonical))
        {
            errors.push(`artifactSubstitutions.${tierId} references unknown canonical path: ${canonical}`);
            continue;
        }
        if (rawActualPaths.length === 0 || rawActualPaths.some((actualPath) => !actualPath))
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} must declare actual proof paths`);
            continue;
        }
        const actualPaths = rawActualPaths.map(normalizeDeclaration);
        if (actualPaths.some((actualPath, index) => !safeRepositoryDeclaration(rawActualPaths[index])))
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} contains an invalid actual proof path`);
            continue;
        }
        if (actualPaths.some((actualPath) => !generatedRuntimeDeclaration(actualPath)))
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} actual proof paths must be generated runtime paths`);
            continue;
        }
        if (actualPaths.some((actualPath) => actualPath.endsWith('.log')))
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} cannot use command logs as actual proof`);
            continue;
        }
        if (new Set(actualPaths).size !== actualPaths.length)
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} contains duplicate actual proof paths`);
            continue;
        }
        if (actualPaths.includes(canonical))
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} cannot substitute itself`);
            continue;
        }
        if (!actualPaths.some(authoritativeSubstitutionProofPath))
        {
            errors.push(`artifactSubstitutions.${tierId}.${canonical} must include a TRX, coverage, or summary proof`);
            continue;
        }
        normalizedMappings[canonical] = [...actualPaths].sort();
    }
    for (const [tierId, mappings] of normalizedMappingsByTier)
    {
        const tier = matrixById.get(tierId);
        for (const runtimePath of matrixGeneratedRuntimePaths(tier))
        {
            if (Object.hasOwn(mappings, runtimePath))
            {
                continue;
            }
            const parent = Object.keys(mappings)
                .filter((canonical) => runtimePath.startsWith(`${canonical}/`))
                .sort((left, right) => right.length - left.length)[0];
            if (parent)
            {
                mappings[runtimePath] = [...mappings[parent]];
            }
        }
        if (Object.keys(mappings).length > 0)
        {
            byTier[tierId] = mappings;
        }
    }
    return { errors, byTier };
}

export function validateArtifactSubstitutions(bundle, matrixTiers)
{
    return buildArtifactSubstitutionContract(bundle, matrixTiers).errors;
}

export function resolveArtifactSubstitutions(bundle, matrixTiers)
{
    const contract = buildArtifactSubstitutionContract(bundle, matrixTiers);
    if (contract.errors.length > 0)
    {
        throw new Error(contract.errors.join('; '));
    }
    return contract.byTier;
}

export function artifactSubstitutionBindingDigest(canonicalPath, actualDigests)
{
    const canonical = normalizeDeclaration(canonicalPath);
    const normalizedActualDigests = Object.fromEntries(Object.entries(actualDigests ?? {})
        .map(([declaration, digest]) => [normalizeDeclaration(declaration), String(digest)])
        .sort(([left], [right]) => left.localeCompare(right)));
    return `sha256:${sha256(JSON.stringify({
        schema: 'fsusblog.local-artifact-substitution.v1',
        canonicalPath: canonical,
        actualDigests: normalizedActualDigests
    }))}`;
}

function wildcardPattern(value)
{
    const normalized = normalizeDeclaration(value);
    let source = '';
    for (let index = 0; index < normalized.length; index += 1)
    {
        const character = normalized[index];
        if (character === '*' && normalized[index + 1] === '*')
        {
            if (normalized[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
        }
        else if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else
        {
            source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`, 'u');
}

function hasWildcard(value)
{
    return value.includes('*') || value.includes('?');
}

function walkOutputPaths(rootDirectory)
{
    const paths = [];
    const visit = (absolutePath) =>
    {
        const stat = fs.lstatSync(absolutePath);
        paths.push(absolutePath);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            return;
        }
        for (const name of fs.readdirSync(absolutePath).sort())
        {
            visit(path.join(absolutePath, name));
        }
    };
    visit(rootDirectory);
    return paths;
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function outputPathFingerprint(absolutePath)
{
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink())
    {
        return `symlink:${sha256(fs.readlinkSync(absolutePath))}`;
    }
    if (stat.isFile())
    {
        return `file:${stat.mode}:${stat.size}:${sha256(fs.readFileSync(absolutePath))}`;
    }
    if (!stat.isDirectory())
    {
        return `other:${stat.mode}:${stat.size}`;
    }
    const entries = fs.readdirSync(absolutePath).sort()
        .map((name) => [name, outputPathFingerprint(path.join(absolutePath, name))]);
    return `directory:${sha256(JSON.stringify(entries))}`;
}

function wildcardSearchRoot(root, declaration)
{
    const wildcardIndex = declaration.search(/[?*]/u);
    const prefix = wildcardIndex < 0 ? declaration : declaration.slice(0, wildcardIndex);
    const directoryPrefix = prefix.endsWith('/') ? prefix : path.posix.dirname(prefix);
    const absolutePath = path.resolve(root, directoryPrefix === '.' ? '' : directoryPrefix);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`declared artifact is outside the repository: ${declaration}`);
    }
    return absolutePath;
}

export function resolveRunBoundArtifactDeclaration(rootValue, declarationValue, env = process.env)
{
    const root = path.resolve(rootValue);
    const declaration = normalizeDeclaration(declarationValue);
    if (String(env.FSUSBLOG_TEST_NAMESPACE ?? '').trim()
    && (declaration === '.tmp/acceptance' || declaration.startsWith('.tmp/acceptance/')))
    {
        const canonicalRoot = '.tmp/acceptance';
        const suffix = declaration.slice(canonicalRoot.length).replace(/^\//u, '');
        const target = path.posix.join(canonicalRoot, acceptanceNamespace(env.FSUSBLOG_TEST_NAMESPACE));
        return suffix ? path.posix.join(target, suffix) : target;
    }
    const mappings = [
        ['src/frontend/dist', env.FSUSBLOG_FRONTEND_DIST_ROOT],
        ['src/frontend/public/wasm', env.FSUSBLOG_FRONTEND_WASM_ROOT],
        ['src/backend/wwwroot', env.FSUSBLOG_BACKEND_WEBROOT]
    ];
    for (const [canonicalRoot, targetValue] of mappings)
    {
        if (declaration !== canonicalRoot && !declaration.startsWith(`${canonicalRoot}/`))
        {
            continue;
        }
        if (!String(targetValue ?? '').trim())
        {
            break;
        }
        const target = path.resolve(String(targetValue));
        if (target === root || !target.startsWith(`${root}${path.sep}`))
        {
            break;
        }
        const suffix = declaration.slice(canonicalRoot.length).replace(/^\//u, '');
        return normalizeDeclaration(path.relative(root, suffix ? path.join(target, suffix) : target));
    }
    return declaration;
}

export function digestDeclaredOutputs(rootValue, declarations, env = process.env)
{
    const root = path.resolve(rootValue);
    if (String(env.FSUSBLOG_ARTIFACT_DIGEST_TABLE ?? '').trim()
    && String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
    && String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim())
    {
        return createArtifactDigestTable({
            root,
            file: env.FSUSBLOG_ARTIFACT_DIGEST_TABLE,
            runId: env.FSUSBLOG_TEST_RUN_ID,
            sourceState: {
                commit: env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
                worktreeFingerprint: env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
            }
        }).digestDeclarations(declarations, {
            env,
            producer: {
                bundle: env.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? env.CURRENT_TIER ?? 'production',
                step: env.CURRENT_TIER ?? 'digest-consumer'
            }
        }).digests;
    }
    const digests = {};
    for (const declarationValue of sortedUnique(declarations ?? []))
    {
        const declaration = normalizeDeclaration(declarationValue);
        if (!declaration || path.isAbsolute(declaration) || declaration === '..' || declaration.startsWith('../'))
        {
            throw new Error(`declared artifact path is invalid: ${declaration || '<empty>'}`);
        }
        const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, declaration, env);
        const absoluteDeclaration = path.resolve(root, resolvedDeclaration);
        if (absoluteDeclaration !== root && !absoluteDeclaration.startsWith(`${root}${path.sep}`))
        {
            throw new Error(`declared artifact is outside the repository: ${declaration}`);
        }
        if (!hasWildcard(resolvedDeclaration))
        {
            if (!fs.existsSync(absoluteDeclaration))
            {
                throw new Error(`declared artifact is missing: ${declaration}`);
            }
            digests[declaration] = `sha256:${sha256(outputPathFingerprint(absoluteDeclaration))}`;
            continue;
        }
        const matcher = wildcardPattern(resolvedDeclaration);
        const searchRoot = wildcardSearchRoot(root, resolvedDeclaration);
        const matches = fs.existsSync(searchRoot)
            ? walkOutputPaths(searchRoot)
        .map((absolutePath) => path.relative(root, absolutePath).replaceAll(path.sep, '/'))
        .filter((relativePath) => matcher.test(relativePath))
        .sort()
            : [];
        if (matches.length === 0)
        {
            throw new Error(`declared artifact is missing: ${declaration}`);
        }
        const fingerprints = matches.map((relativePath) => [
            relativePath,
            outputPathFingerprint(path.join(root, relativePath))
        ]);
        digests[declaration] = `sha256:${sha256(JSON.stringify(fingerprints))}`;
    }
    return digests;
}

export function localBundleSummaryPath(profileId, bundleId)
{
    return `.tmp/local-${profileId}/${bundleId}/summary.json`;
}

function requirePositiveResourceDeclaration(bundle, field)
{
    const value = Number(bundle?.[field]);
    if (!Number.isFinite(value) || value <= 0)
    {
        throw new Error(`local profile bundle ${bundle?.id ?? '<unknown>'} requires positive ${field}`);
    }
    return value;
}

export function resolveFrontendVitestAdmissionFloor({ cpuCount, eventualFrontendCapacity })
{
    const machineCpuUnits = Math.max(1, Math.floor(Number(cpuCount) || 1));
    const eventualCapacity = Math.max(1, Math.floor(Number(eventualFrontendCapacity) || 1));
    return Math.max(1, Math.min(
        eventualCapacity,
        Math.ceil(Math.sqrt(machineCpuUnits))
    ));
}

function allocateIntegerCpuUnits(bundles, availableCpuUnits, minimumField = 'minCpuUnits', weightField = 'cpuWeight')
{
    const weights = bundles.map((bundle) => requirePositiveResourceDeclaration(bundle, weightField));
    const minimums = bundles.map((bundle) =>
    {
        const value = Number(bundle?.[minimumField]);
        if (!Number.isInteger(value) || value < 1)
        {
            throw new Error(`local profile bundle ${bundle?.id ?? '<unknown>'} requires positive integer ${minimumField}`);
        }
        return value;
    });
    if (minimums.reduce((total, value) => total + value, 0) > availableCpuUnits)
    {
        throw new Error(`local profile minimum CPU allocation exceeds ${availableCpuUnits} available units`);
    }

    const weightTotal = weights.reduce((total, value) => total + value, 0);
    const quotas = weights.map((weight) => availableCpuUnits * weight / weightTotal);
    const allocation = quotas.map((quota, index) => Math.max(minimums[index], Math.floor(quota)));
    let allocated = allocation.reduce((total, value) => total + value, 0);

    while (allocated < availableCpuUnits)
    {
        let selected = 0;
        for (let index = 1; index < allocation.length; index += 1)
        {
            if (quotas[index] - allocation[index] > quotas[selected] - allocation[selected])
            {
                selected = index;
            }
        }
        allocation[selected] += 1;
        allocated += 1;
    }
    while (allocated > availableCpuUnits)
    {
        let selected = -1;
        for (let index = 0; index < allocation.length; index += 1)
        {
            if (allocation[index] <= minimums[index])
            {
                continue;
            }
            if (selected < 0 || allocation[index] - quotas[index] > allocation[selected] - quotas[selected])
            {
                selected = index;
            }
        }
        if (selected < 0)
        {
            throw new Error('local profile CPU allocation cannot satisfy declared minimums');
        }
        allocation[selected] -= 1;
        allocated -= 1;
    }
    return allocation;
}

function allocateStartupCpuUnits(bundles, availableCpuUnits)
{
    const minimumById = new Map(bundles.map((bundle) => [bundle.id, Number(bundle.startupMinCpuUnits)]));
    let remaining = availableCpuUnits - [...minimumById.values()].reduce((total, value) => total + value, 0);
    if (remaining < 0)
    {
        throw new Error(`local profile minimum CPU allocation exceeds ${availableCpuUnits} available units`);
    }
    const ordered = [...bundles].sort((left, right) => (
        Number(right.startupPriority ?? 0) - Number(left.startupPriority ?? 0)
      || Number(right.deadlineWeight ?? 0) - Number(left.deadlineWeight ?? 0)
      || left.id.localeCompare(right.id)
    ));
    for (const bundle of ordered)
    {
        const deficit = Math.max(0, Number(bundle.minCpuUnits) - minimumById.get(bundle.id));
        const addition = Math.min(remaining, deficit);
        minimumById.set(bundle.id, minimumById.get(bundle.id) + addition);
        remaining -= addition;
        if (remaining === 0)
        {
            break;
        }
    }
    return allocateIntegerCpuUnits(
        bundles.map((bundle) => ({ ...bundle, startupAllocationMinimum: minimumById.get(bundle.id) })),
        availableCpuUnits,
        'startupAllocationMinimum',
        'cpuWeight'
    );
}

export function resolveLocalProfileResources(profile, detectedResources)
{
    const availableCpuUnits = Number(detectedResources?.availableCpuUnits);
    const usableMemoryGiB = Number(detectedResources?.availableMemoryGiB);
    if (!Number.isInteger(availableCpuUnits) || availableCpuUnits < 1)
    {
        throw new Error('local production profile requires positive integer available CPU units');
    }
    if (!Number.isFinite(usableMemoryGiB) || usableMemoryGiB <= 0)
    {
        throw new Error('local production profile requires positive usable memory');
    }

    const bundles = (profile?.bundles ?? []).map((bundle) => ({
        ...bundle,
        startupMinCpuUnits: bundle.startupMinCpuUnits ?? bundle.minCpuUnits,
        startupMemoryWeight: bundle.startupMemoryWeight ?? bundle.memoryWeight,
        startupPriority: bundle.startupPriority ?? 0
    }));
    const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
    const frontendBundle = byId.get('frontend-tests');
    const backendBundle = byId.get('backend-tests');
    const runtimeBundle = byId.get('runtime-browser');
    if (frontendBundle && backendBundle && runtimeBundle)
    {
        const eventualFrontendCapacity = Math.max(
            1,
            availableCpuUnits
        - requirePositiveResourceDeclaration(backendBundle, 'minCpuUnits')
        - requirePositiveResourceDeclaration(runtimeBundle, 'minCpuUnits')
        );
        frontendBundle.minCpuUnits = Math.max(
            Number(frontendBundle.minCpuUnits),
            resolveFrontendVitestAdmissionFloor({
                cpuCount: availableCpuUnits,
                eventualFrontendCapacity
            })
        );
    }
    const initialIds = ['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser'];
    const initialBundles = initialIds.map((id) =>
    {
        const bundle = byId.get(id);
        if (!bundle)
        {
            throw new Error(`local production profile is missing ${id}`);
        }
        return bundle;
    });
    const minimumInitialCpuUnits = initialBundles.reduce((total, bundle) =>
    {
        const value = Number(bundle?.startupMinCpuUnits);
        if (!Number.isInteger(value) || value < 1)
        {
            throw new Error(`local profile bundle ${bundle?.id ?? '<unknown>'} requires positive integer startupMinCpuUnits`);
        }
        return total + value;
    }, 0);
    if (availableCpuUnits < minimumInitialCpuUnits)
    {
        throw new Error(`local production profile requires at least ${minimumInitialCpuUnits} available CPU units from declared minima`);
    }
    for (const id of ['performance-evidence'])
    {
        if (!byId.has(id))
        {
            throw new Error(`local production profile is missing ${id}`);
        }
    }

    const initialCpuUnits = allocateStartupCpuUnits(initialBundles, availableCpuUnits);
    const memoryWeights = initialBundles.map((bundle) => requirePositiveResourceDeclaration(bundle, 'startupMemoryWeight'));
    const memoryWeightTotal = memoryWeights.reduce((total, value) => total + value, 0);
    const resolvedById = new Map(initialBundles.map((bundle, index) => [bundle.id, {
        cpuUnits: initialCpuUnits[index],
        memoryGiB: usableMemoryGiB * memoryWeights[index] / memoryWeightTotal
    }]));
    resolvedById.set('performance-evidence', {
        cpuUnits: availableCpuUnits,
        memoryGiB: usableMemoryGiB
    });

    const resourceResolvedBundles = bundles.map((bundle) =>
    {
        const resources = resolvedById.get(bundle.id);
        if (!resources)
        {
            throw new Error(`local production profile has unsupported bundle ${bundle.id}`);
        }
        return { ...bundle, ...resources };
    });
    const deadlineDemandById = new Map(resourceResolvedBundles.map((bundle) =>
    {
        const deadlineWeight = requirePositiveResourceDeclaration(bundle, 'deadlineWeight');
        const memoryEquivalentCpuUnits = bundle.memoryGiB * availableCpuUnits / usableMemoryGiB;
        const effectiveThroughput = Math.sqrt(bundle.cpuUnits * memoryEquivalentCpuUnits);
        if (!Number.isFinite(effectiveThroughput) || effectiveThroughput <= 0)
        {
            throw new Error(`local profile bundle ${bundle.id} has no effective deadline capacity`);
        }
        return [bundle.id, deadlineWeight / effectiveThroughput];
    }));
    const wallClockBudgetMs = Number(profile?.budgetMs);
    if (!Number.isFinite(wallClockBudgetMs) || wallClockBudgetMs <= 0)
    {
        throw new Error('local profile wall-clock budget must be positive before resolving deadlines');
    }
    const minimumBudgetById = new Map(resourceResolvedBundles.map((bundle) =>
    {
        const share = Number(bundle.minimumDeadlineShare ?? 0);
        if (!Number.isFinite(share) || share < 0 || share >= 1)
        {
            throw new Error(`local profile bundle ${bundle.id} minimumDeadlineShare must be between 0 and 1`);
        }
        return [bundle.id, wallClockBudgetMs * share];
    }));
    const criticalPathAtScale = (scale) => localProfileBudgetCriticalPath(
        { ...profile, bundles: resourceResolvedBundles },
        (bundle) => Math.max(
            1,
            minimumBudgetById.get(bundle.id),
            deadlineDemandById.get(bundle.id) * scale)
    );
    const minimumCriticalPath = criticalPathAtScale(0);
    if (!Number.isFinite(minimumCriticalPath) || minimumCriticalPath > wallClockBudgetMs)
    {
        throw new Error(`local profile minimum deadline shares exceed wall-clock budget: ${minimumCriticalPath}/${wallClockBudgetMs}ms`);
    }
    let lowerScale = 0;
    let upperScale = 1;
    while (criticalPathAtScale(upperScale) <= wallClockBudgetMs)
    {
        upperScale *= 2;
    }
    for (let iteration = 0; iteration < 80; iteration += 1)
    {
        const midpoint = (lowerScale + upperScale) / 2;
        if (criticalPathAtScale(midpoint) <= wallClockBudgetMs)
        {
            lowerScale = midpoint;
        }
        else
        {
            upperScale = midpoint;
        }
    }
    const budgetById = new Map(resourceResolvedBundles.map((bundle) =>
    {
        const budgetMs = Math.floor(Math.max(
            1,
            minimumBudgetById.get(bundle.id),
            deadlineDemandById.get(bundle.id) * lowerScale));
        if (budgetMs < 1)
        {
            throw new Error(`local profile bundle ${bundle.id} resolved deadline is below 1ms`);
        }
        return [bundle.id, budgetMs];
    }));

    return {
        ...profile,
        bundles: resourceResolvedBundles.map((bundle) =>
        {
            return {
                ...bundle,
                requiresSchedulerTerminalReceipts: true,
                budgetMs: budgetById.get(bundle.id),
                stepMaxParallel: Math.max(1, Math.floor(bundle.cpuUnits))
            };
        })
    };
}

export function createLocalBundleTiers(profileId, profile, { maxParallel = null } = {})
{
    const prefix = `local-${profileId}-`;
    for (const bundle of profile?.bundles ?? [])
    {
        if (!Number.isFinite(bundle.cpuUnits)
      || !Number.isFinite(bundle.memoryGiB)
      || !Number.isInteger(bundle.stepMaxParallel)
      || !Number.isFinite(bundle.cpuWeight)
      || !Number.isFinite(bundle.memoryWeight)
      || !Number.isInteger(bundle.minCpuUnits)
      || !Number.isInteger(bundle.startupMinCpuUnits)
      || bundle.startupMinCpuUnits < 1
      || bundle.startupMinCpuUnits > bundle.minCpuUnits
      || !Number.isFinite(bundle.startupMemoryWeight)
      || bundle.startupMemoryWeight <= 0
      || !Number.isFinite(bundle.startupPriority)
      || bundle.startupPriority < 0)
        {
            throw new Error(`local bundle resource policy must be resolved before creating tier ${bundle.id}`);
        }
    }
    const defaultMaxParallel = Math.max(
        1,
        Number(maxParallel) || Number(profile?.maxParallel) || 0,
        ...(profile?.bundles ?? []).map((bundle) => Number(bundle.stepMaxParallel) || 1)
    );
    return (profile?.bundles ?? []).map((bundle) =>
    {
        const summaryPath = localBundleSummaryPath(profileId, bundle.id);
        return {
            id: `${prefix}${bundle.id}`,
            physicalBundleId: bundle.id,
            residentLeaseProducer: bundle.id === 'runtime-browser',
            residentLeaseTarget: bundle.id === 'runtime-browser' ? 'performance-evidence' : null,
            residentLeaseServiceIds: bundle.id === 'runtime-browser' ? [...productionResidentServiceIds] : null,
            residentLeaseConsumer: bundle.id === 'performance-evidence',
            logicalMembers: [...(bundle.members ?? [])],
            command: bundle.command,
            executionDependsOn: (bundle.dependsOn ?? [])
                .filter((dependencyId) => !isExternalBehaviorDocAdmissionDependency(dependencyId))
                .map((dependencyId) => `${prefix}${dependencyId}`),
            services: [...(bundle.services ?? [])],
            parallelizable: true,
            exclusiveResources: [...(bundle.exclusiveResources ?? [])],
            // Physical bundle ordering is fully expressed by executionDependsOn. Keeping every
            // local bundle in one scheduler phase lets independent ready work overlap;
            // resource and exclusive-resource gates still bound actual concurrency.
            phase: 0,
            cost: 'very-high',
            resourceClass: bundle.resourceClass ?? 'cpu',
            maxParallel: defaultMaxParallel,
            // The resolved units above are used only to derive a machine-specific
            // deadline. Actual execution grants are assigned from the scheduler's
            // live envelope when this bundle becomes runnable, so a downstream
            // bundle is never held back by a stale reference allocation.
            resourceGrantMode: 'dynamic',
            cpuWeight: bundle.cpuWeight,
            memoryWeight: bundle.memoryWeight,
            minCpuUnits: bundle.minCpuUnits,
            startupMinCpuUnits: bundle.startupMinCpuUnits,
            startupMemoryWeight: bundle.startupMemoryWeight,
            startupPriority: bundle.startupPriority,
            budgetMs: bundle.budgetMs,
            cacheInputs: [
                'tests/matrix.yml',
                'tools/test/bundles',
                bundle.command,
                ...(bundle.id === 'backend-tests'
                    ? [
              'tools/test/run-backend-production-shards.mjs',
              'tools/test/backend-production-topology.mjs'
            ]
                    : [])
            ],
            executionKey: `${profileId}/${bundle.id}`,
            executionVariant: 'runtime',
            artifacts: [summaryPath],
            evidence: [summaryPath]
        };
    });
}

export function projectLocalBootstrapFixtureProfile(physicalTiers, logicalTiers)
{
    const runtimeTier = physicalTiers.find((tier) => tier.physicalBundleId === 'runtime-browser');
    if (!runtimeTier)
    {
        throw new Error('local production requires a runtime-browser bundle');
    }
    const runtimeMembers = new Set(runtimeTier.logicalMembers);
    const logicalBootstrapTiers = logicalTiers.filter(
        (tier) => runtimeMembers.has(tier.id) && tier.selfBootstraps === true
    );
    if (logicalBootstrapTiers.length !== 1)
    {
        throw new Error(`local runtime-browser bundle requires exactly one logical self-bootstrap tier; found ${logicalBootstrapTiers.length}`);
    }
    const logicalBootstrap = logicalBootstrapTiers[0];
    for (const tier of physicalTiers)
    {
        delete tier.selfBootstraps;
        delete tier.fixtureProfile;
        delete tier.requiresBootstrap;
    }
    const bootstrapCapabilities = expandFixtureProfile(logicalBootstrap.fixtureProfile).capabilities;
    Object.assign(runtimeTier, {
        selfBootstraps: true,
        fixtureProfile: logicalBootstrap.fixtureProfile,
        fixtureCapabilities: bootstrapCapabilities.slice(),
        requiresBootstrap: logicalBootstrap.requiresBootstrap
    });
    return physicalTiers;
}

/** Preserve a logical member's ephemeral service requirement at its physical scheduler owner. */
export function projectLocalNonResidentServiceRequirements(physicalTiers, logicalTiers)
{
    const logicalById = new Map(logicalTiers.map((tier) => [tier.id, tier]));
    if (logicalById.size !== logicalTiers.length)
    {
        throw new Error('local service projection requires unique logical tier identities');
    }
    for (const physical of physicalTiers)
    {
        const memberServices = new Set();
        for (const id of physical.logicalMembers ?? [])
        {
            const logical = logicalById.get(id);
            if (!logical || !Array.isArray(logical.services))
            {
                throw new Error(`local service projection lacks the exact logical member ${id}`);
            }
            for (const service of logical.services)
            {
                memberServices.add(service);
            }
        }
        if (physical.residentLeaseProducer || physical.residentLeaseConsumer)
        {
            // The resident-service handoff owns these bundles' service roster.
            if (memberServices.has('mysql'))
            {
                throw new Error('MySQL cannot be projected onto a resident-service bundle');
            }
            continue;
        }
        if (!Array.isArray(physical.services)
            || physical.services.some((service) => !memberServices.has(service)))
        {
            throw new Error(`local service projection found a service outside ${physical.id}'s logical members`);
        }
        physical.services = [...memberServices].sort();
    }
    return physicalTiers;
}

export function localProfileSystemResources(profile, system = {})
{
    const cpuCount = Number(system.cpuCount);
    const availableMemoryGiB = Number(system.availableMemoryGiB);
    const load1 = Number(system.load1);
    const initialBundleIds = new Set(['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser']);
    const minimumCpuUnits = (profile?.bundles ?? [])
        .filter((bundle) => initialBundleIds.has(bundle.id))
        .reduce((total, bundle) => total + Number(bundle.startupMinCpuUnits ?? bundle.minCpuUnits), 0);
    if (!Number.isInteger(minimumCpuUnits) || minimumCpuUnits < 1)
    {
        throw new Error('local production profile must declare positive initial CPU minima');
    }
    const supportedCpuFloor = Number(profile?.minimumSupportedCpuUnits);
    if (!Number.isInteger(supportedCpuFloor) || supportedCpuFloor < minimumCpuUnits)
    {
        throw new Error(`local production profile supported CPU floor must cover ${minimumCpuUnits} startup units`);
    }
    if (!Number.isInteger(cpuCount) || cpuCount < supportedCpuFloor)
    {
        throw new Error(`local production profile requires at least ${supportedCpuFloor} available CPU units`);
    }
    if (!Number.isFinite(availableMemoryGiB) || availableMemoryGiB <= 0)
    {
        throw new Error('local profile requires positive available memory');
    }
    if (!Number.isFinite(load1) || load1 < 0)
    {
        throw new Error('local profile initial load1 must be a non-negative number');
    }
    const memoryReserveShare = Number(profile?.memoryReserveShare);
    if (!Number.isFinite(memoryReserveShare) || memoryReserveShare <= 0 || memoryReserveShare >= 1)
    {
        throw new Error('local production profile memoryReserveShare must be between 0 and 1');
    }
    const memoryReserveGiB = availableMemoryGiB * memoryReserveShare;
    const usableMemoryGiB = availableMemoryGiB - memoryReserveGiB;
    return {
        cpuCount,
        availableCpuUnits: cpuCount,
        availableMemoryGiB: usableMemoryGiB,
        load1,
        // Strict builds can leave load1 elevated after their processes have exited.
        // Record it as telemetry, but let live resource admission fill every CPU.
        launchParallelism: cpuCount,
        memoryReserveGiB
    };
}

function commandLogPath(profileId, bundleId, value)
{
    const normalized = normalizeDeclaration(value);
    return normalized.startsWith(`.tmp/local-${profileId}/${bundleId}/steps/`) && normalized.endsWith('.log');
}

function sameStringArray(left, right)
{
    return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function validateLocalBundleSummary(summary, bundle, {
    expectedRunId = null,
    expectedSourceState = null,
    matrixTiers = null,
    profileId = 'production',
    expectedArtifactRefs = false
} = {})
{
    const errors = [];
    const matrixById = matrixTiers === null
        ? null
        : new Map((matrixTiers ?? []).map((tier) => [tier.id, tier]));
    const substitutionContract = matrixById === null
        ? { errors: [], byTier: {} }
        : buildArtifactSubstitutionContract(bundle, matrixTiers);
    errors.push(...substitutionContract.errors);
    if (summary?.schema !== bundleSummarySchema)
    {
        errors.push(`schema must be ${bundleSummarySchema}`);
    }
    if (summary?.physicalBundleId !== bundle.id)
    {
        errors.push(`physicalBundleId must be ${bundle.id}`);
    }
    if (summary?.executionSource !== 'fresh')
    {
        errors.push('executionSource must be fresh');
    }
    if (summary?.status !== 'success')
    {
        errors.push('status must be success');
    }
    if (expectedRunId !== null && summary?.schedulerRunId !== expectedRunId)
    {
        errors.push(`schedulerRunId must be ${expectedRunId}`);
    }
    if (bundle?.requiresSchedulerTerminalReceipts === true && summary?.status === 'success' && (!plainRecord(summary?.schedulerTerminalReceipts)
    || !Array.isArray(summary?.schedulerTerminalReceiptIds) || summary.schedulerTerminalReceiptIds.length === 0))
    {
        errors.push('successful bundle summary requires scheduler terminal receipts');
    }
    if (summary?.schedulerTerminalReceipts !== undefined)
    {
        if (!plainRecord(summary.schedulerTerminalReceipts))
        {
            errors.push('schedulerTerminalReceipts must be an object');
        }
        else
        {
            if (!sameStringArray(Object.keys(summary.schedulerTerminalReceipts).sort(),
                [...(summary.schedulerTerminalReceiptIds ?? [])].sort()))
            {
                errors.push('schedulerTerminalReceiptIds must exactly match schedulerTerminalReceipts');
            }
            for (const [stepId, receipt] of Object.entries(summary.schedulerTerminalReceipts))
            {
                if (!plainRecord(receipt) || receipt.schema !== 'fsusblog.scheduler.terminal-receipt.v1')
                {
                    errors.push(`${stepId} has an invalid scheduler terminal receipt`);
                    continue;
                }
                if (receipt.stepId !== stepId || !['physical', 'settled-join', 'finalizer'].includes(receipt.stepKind))
                {
                    errors.push(`${stepId} has an invalid scheduler step identity or kind`);
                }
                if (!['success', 'failed', 'timed-out', 'cancelled', 'blocked', 'internal-error'].includes(receipt.terminalState))
                {
                    errors.push(`${stepId} has an invalid terminal state`);
                }
                if (typeof receipt.dependencyOutcomeDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.dependencyOutcomeDigest))
                {
                    errors.push(`${stepId} is missing dependencyOutcomeDigest`);
                }
                if (!Array.isArray(receipt.dependencyOutcomes) && !plainRecord(receipt.dependencyOutcomes))
                {
                    errors.push(`${stepId} is missing dependency outcomes`);
                }
                const isJoin = receipt.stepKind === 'settled-join';
                const dependencies = Array.isArray(receipt.dependencyOutcomes) ? receipt.dependencyOutcomes : [];
                const dependencyDigest = terminalDigest(dependencies.map((dependency) => ({
                    id: dependency.id,
                    outcome: dependency.outcome,
                    receiptPresent: dependency.receiptPresent,
                    receiptTerminalState: dependency.receiptTerminalState
                })));
                if (isJoin && receipt.dependencyOutcomeDigest !== dependencyDigest)
                {
                    errors.push(`${stepId} join dependency outcome digest mismatch`);
                }
                if (isJoin && (!receipt.evidenceRef || !/^[a-f0-9]{64}$/u.test(String(receipt.contentDigest ?? ''))))
                {
                    errors.push(`${stepId} join receipt is missing evidence reference or content digest`);
                }
                if (isJoin)
                {
                    const primaryFailureRefs = receipt.primaryFailureRefs ?? [];
                    const canonicalDependencyOrder = dependencies.map((dependency) => dependency.id);
                    const contentDigest = terminalDigest({
                        status: receipt.terminalState,
                        terminalState: receipt.terminalState,
                        reasonCode: receipt.reasonCode,
                        primaryFailureRefs,
                        stepId,
                        evidenceRef: receipt.evidenceRef,
                        canonicalDependencyOrder,
                        dependencies,
                        dependencyOutcomeDigest: receipt.dependencyOutcomeDigest
                    });
                    if (receipt.contentDigest !== contentDigest)
                    {
                        errors.push(`${stepId} join content digest mismatch`);
                    }
                    const failureStates = new Set(['failed', 'timed-out', 'internal-error']);
                    const incomplete = dependencies.some((dependency) =>
                    {
                        const sibling = summary.schedulerTerminalReceipts[dependency.id];
                        return !sibling || sibling.stepId !== dependency.id
              || sibling.terminalState !== dependency.outcome
              || dependency.receiptPresent !== true
              || dependency.receiptTerminalState !== dependency.outcome
              || dependency.outcome === 'blocked';
                    });
                    const failedDependencies = dependencies.filter((dependency) => failureStates.has(dependency.outcome));
                    const expectedState = incomplete ? 'failed'
                        : failedDependencies.length > 0 ? 'failed'
              : dependencies.some((dependency) => dependency.outcome === 'cancelled') ? 'cancelled' : 'success';
                    const expectedReason = incomplete ? 'dependency-outcome-incomplete'
                        : failedDependencies.length > 0 ? 'dependency-terminal-failure'
              : expectedState === 'cancelled' ? 'dependency-cancelled' : 'all-dependencies-succeeded';
                    const expectedPrimaryRefs = failedDependencies.map((dependency) => dependency.id);
                    if (receipt.terminalState !== expectedState || receipt.reasonCode !== expectedReason
            || JSON.stringify(receipt.primaryFailureRefs ?? []) !== JSON.stringify(expectedPrimaryRefs))
                    {
                        errors.push(`${stepId} join terminal mapping does not match dependency receipts`);
                    }
                }
            }
        }
    }
    for (const tierId of bundle.members ?? [])
    {
        const evidence = summary?.members?.[tierId];
        if (!evidence)
        {
            errors.push(`missing member evidence: ${tierId}`);
            continue;
        }
        if (evidence.status !== 'success')
        {
            errors.push(`${tierId}.status must be success`);
        }
        if (!Number.isFinite(evidence.durationMs) || evidence.durationMs < 0)
        {
            errors.push(`${tierId}.durationMs must be a non-negative number`);
        }
        if (!Array.isArray(evidence.testIds) || evidence.testIds.length === 0)
        {
            errors.push(`${tierId}.testIds must be non-empty`);
        }
        if (!evidence.artifactDigests || Object.keys(evidence.artifactDigests).length === 0)
        {
            errors.push(`${tierId}.artifactDigests must be non-empty`);
        }
        else if (Object.values(evidence.artifactDigests).some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest)))
        {
            errors.push(`${tierId}.artifactDigests must contain sha256 digests`);
        }
        if (expectedArtifactRefs)
        {
            if (!plainRecord(evidence.artifactRefs)
        || !sameStringArray(Object.keys(evidence.artifactRefs).sort(), Object.keys(evidence.artifactDigests ?? {}).sort()))
            {
                errors.push(`${tierId}.artifactRefs must exactly match artifactDigests`);
            }
            else if (Object.values(evidence.artifactRefs).some((artifactId) => !/^artifact:[a-f0-9]{64}$/u.test(String(artifactId))))
            {
                errors.push(`${tierId}.artifactRefs must contain physical artifact IDs`);
            }
        }
        if (matrixById !== null)
        {
            const matrixTier = matrixById.get(tierId);
            if (!matrixTier)
            {
                errors.push(`${tierId} is missing from matrix tiers`);
                continue;
            }
            const runtimePaths = matrixGeneratedRuntimePaths(matrixTier);
            const substitutions = substitutionContract.byTier[tierId] ?? {};
            const substitutedCanonicalPaths = Object.keys(substitutions).sort();
            const substitutionProofs = evidence.artifactSubstitutionProofs;
            if (!plainRecord(substitutionProofs))
            {
                errors.push(`${tierId}.artifactSubstitutionProofs must be an object`);
            }
            else if (!sameStringArray(Object.keys(substitutionProofs).sort(), substitutedCanonicalPaths))
            {
                errors.push(`${tierId}.artifactSubstitutionProofs must exactly match configured substitutions`);
            }
            if (runtimePaths.length > 0)
            {
                const expectedProofMode = substitutedCanonicalPaths.length > 0
                    ? 'matrix-runtime-artifacts-with-substitutions'
                    : 'matrix-runtime-artifacts';
                if (evidence.artifactProofMode !== expectedProofMode)
                {
                    errors.push(`${tierId}.artifactProofMode must be ${expectedProofMode}`);
                }
                if (!sameStringArray(evidence.matrixRuntimePaths, runtimePaths))
                {
                    errors.push(`${tierId}.matrixRuntimePaths must exactly match matrix generated runtime paths`);
                }
                for (const declaration of runtimePaths)
                {
                    const actualPaths = substitutions[declaration];
                    if (!actualPaths && !/^sha256:[a-f0-9]{64}$/u.test(String(evidence.artifactDigests?.[declaration] ?? '')))
                    {
                        errors.push(`${tierId} is missing the matrix runtime artifact digest: ${declaration}`);
                        continue;
                    }
                    if (!actualPaths)
                    {
                        continue;
                    }
                    const proof = substitutionProofs?.[declaration];
                    if (!plainRecord(proof))
                    {
                        errors.push(`${tierId} is missing the artifact substitution proof: ${declaration}`);
                        continue;
                    }
                    const expectedProofFields = expectedArtifactRefs
                        ? ['actualDigests', 'actualPaths', 'actualRefs', 'canonicalArtifactRef', 'canonicalDigest', 'canonicalPath']
                        : ['actualDigests', 'actualPaths', 'canonicalDigest', 'canonicalPath'];
                    if (!sameStringArray(Object.keys(proof).sort(), expectedProofFields))
                    {
                        errors.push(`${tierId} artifact substitution proof has unexpected fields: ${declaration}`);
                    }
                    if (proof.canonicalPath !== declaration)
                    {
                        errors.push(`${tierId} artifact substitution canonicalPath must be ${declaration}`);
                    }
                    if (!sameStringArray(proof.actualPaths, actualPaths))
                    {
                        errors.push(`${tierId} artifact substitution actualPaths must match configuration: ${declaration}`);
                    }
                    const actualDigestKeys = plainRecord(proof.actualDigests)
                        ? Object.keys(proof.actualDigests).sort()
                        : [];
                    if (!plainRecord(proof.actualDigests) || !sameStringArray(actualDigestKeys, actualPaths))
                    {
                        errors.push(`${tierId} artifact substitution actualDigests must exactly match actualPaths: ${declaration}`);
                        continue;
                    }
                    if (expectedArtifactRefs)
                    {
                        if (!plainRecord(proof.actualRefs)
              || !sameStringArray(Object.keys(proof.actualRefs).sort(), actualPaths))
                        {
                            errors.push(`${tierId} artifact substitution actualRefs must exactly match actualPaths: ${declaration}`);
                        }
                        else
                        {
                            for (const actualPath of actualPaths)
                            {
                                if (proof.actualRefs[actualPath] !== evidence.artifactRefs?.[actualPath])
                                {
                                    errors.push(`${tierId} artifact substitution actual ref must match artifactRefs: ${actualPath}`);
                                }
                            }
                        }
                        if (proof.canonicalArtifactRef !== evidence.artifactRefs?.[declaration])
                        {
                            errors.push(`${tierId} artifact substitution canonical ref must match artifactRefs: ${declaration}`);
                        }
                    }
                    for (const actualPath of actualPaths)
                    {
                        const actualDigest = proof.actualDigests[actualPath];
                        if (!/^sha256:[a-f0-9]{64}$/u.test(String(actualDigest ?? '')))
                        {
                            errors.push(`${tierId} artifact substitution actual digest must be sha256: ${actualPath}`);
                        }
                        if (evidence.artifactDigests?.[actualPath] !== actualDigest)
                        {
                            errors.push(`${tierId} artifact substitution actual digest must match artifactDigests: ${actualPath}`);
                        }
                    }
                    const canonicalDigest = artifactSubstitutionBindingDigest(declaration, proof.actualDigests);
                    if (proof.canonicalDigest !== canonicalDigest)
                    {
                        errors.push(`${tierId} artifact substitution canonicalDigest is invalid: ${declaration}`);
                    }
                    if (evidence.artifactDigests?.[declaration] !== canonicalDigest)
                    {
                        errors.push(`${tierId} artifact substitution canonical digest must match artifactDigests: ${declaration}`);
                    }
                }
            }
            else
            {
                if (evidence.artifactProofMode !== 'command-log-and-test-ids')
                {
                    errors.push(`${tierId}.artifactProofMode must be command-log-and-test-ids`);
                }
                if (!sameStringArray(evidence.matrixRuntimePaths, []))
                {
                    errors.push(`${tierId}.matrixRuntimePaths must be empty when the matrix declares no generated runtime paths`);
                }
                const hasCommandLog = Object.keys(evidence.artifactDigests ?? {})
                    .some((declaration) => commandLogPath(profileId, bundle.id, declaration));
                if (!hasCommandLog)
                {
                    errors.push(`${tierId} must provide a command log digest`);
                }
                if (substitutedCanonicalPaths.length > 0)
                {
                    errors.push(`${tierId} cannot substitute artifacts because the matrix declares no generated runtime paths`);
                }
            }
        }
    }
    for (const tierId of Object.keys(summary?.members ?? {}))
    {
        if (!(bundle.members ?? []).includes(tierId))
        {
            errors.push(`unexpected member evidence: ${tierId}`);
        }
    }
    if (bundle.id === 'performance-evidence')
    {
        errors.push(...validatePerformanceDeadlineEvidence(summary?.deadlineEvidence, {
            expectedRunId: expectedRunId ?? summary?.schedulerRunId,
            expectedSourceState
        }));
    }
    return errors;
}

export function validatePerformanceDeadlineEvidence(evidence, {
    expectedRunId = null,
    expectedSourceState = null
} = {})
{
    const errors = [];
    if (evidence?.schema !== performanceDeadlineEvidenceSchema)
    {
        return [`deadlineEvidence.schema must be ${performanceDeadlineEvidenceSchema}`];
    }
    if (evidence.status !== 'sufficient')
    {
        errors.push('deadlineEvidence.status must be sufficient');
    }
    if (expectedRunId !== null && evidence.schedulerRunId !== expectedRunId)
    {
        errors.push(`deadlineEvidence.schedulerRunId must be ${expectedRunId}`);
    }
    if (!String(evidence.sourceState?.commit ?? '').trim()
    || !String(evidence.sourceState?.worktreeFingerprint ?? '').trim())
    {
        errors.push('deadlineEvidence.sourceState must be present');
    }
    else if (expectedSourceState !== null && (evidence.sourceState.commit !== expectedSourceState?.commit
    || evidence.sourceState.worktreeFingerprint !== expectedSourceState?.worktreeFingerprint))
    {
        errors.push('deadlineEvidence.sourceState must match the checkpoint');
    }
    const candidateBudgetMs = Number(evidence.candidateBudgetMs);
    const bundleDurationMs = Number(evidence.bundleDurationMs);
    const mixedDurationMs = Number(evidence.mixedWindow?.measuredDurationMs);
    const measuredOtherSerialMs = Number(evidence.measuredOtherSerialMs);
    const requiredBudgetMs = Number(evidence.requiredBudgetMs);
    if (!Number.isFinite(candidateBudgetMs) || candidateBudgetMs <= 0)
    {
        errors.push('deadlineEvidence.candidateBudgetMs must be positive');
    }
    if (!Number.isFinite(bundleDurationMs) || bundleDurationMs < 0)
    {
        errors.push('deadlineEvidence.bundleDurationMs must be non-negative');
    }
    if (evidence.mixedWindow?.stepId !== 'mixed-performance-window')
    {
        errors.push('deadlineEvidence.mixedWindow.stepId must be mixed-performance-window');
    }
    if (evidence.mixedWindow?.minimumDurationMs !== performanceMixedWindowFloorMs)
    {
        errors.push(`deadlineEvidence.mixedWindow.minimumDurationMs must be ${performanceMixedWindowFloorMs}`);
    }
    if (!Number.isFinite(mixedDurationMs) || mixedDurationMs < performanceMixedWindowFloorMs)
    {
        errors.push(`deadlineEvidence.mixedWindow.measuredDurationMs must be at least ${performanceMixedWindowFloorMs}`);
    }
    const expectedOtherSerialMs = Number.isFinite(bundleDurationMs) && Number.isFinite(mixedDurationMs)
        ? Math.max(0, bundleDurationMs - mixedDurationMs)
        : Number.NaN;
    if (!Number.isFinite(measuredOtherSerialMs) || measuredOtherSerialMs !== expectedOtherSerialMs)
    {
        errors.push('deadlineEvidence.measuredOtherSerialMs must equal bundleDurationMs minus mixed duration');
    }
    const expectedRequiredBudgetMs = Number.isFinite(measuredOtherSerialMs)
        ? performanceMixedWindowFloorMs + measuredOtherSerialMs
        : Number.NaN;
    if (!Number.isFinite(requiredBudgetMs) || requiredBudgetMs !== expectedRequiredBudgetMs)
    {
        errors.push('deadlineEvidence.requiredBudgetMs must equal mixed floor plus measured other serial time');
    }
    if (Number.isFinite(candidateBudgetMs) && Number.isFinite(requiredBudgetMs) && candidateBudgetMs < requiredBudgetMs)
    {
        errors.push(`deadlineEvidence candidate budget ${candidateBudgetMs} is below required ${requiredBudgetMs}`);
    }
    if (!Array.isArray(evidence.steps) || evidence.steps.length === 0)
    {
        errors.push('deadlineEvidence.steps must be non-empty');
    }
    else
    {
        const ids = new Set();
        const phases = new Set(['coordination', 'preparation', 'measurement', 'post-measurement']);
        for (const step of evidence.steps)
        {
            if (!String(step?.id ?? '') || ids.has(step.id))
            {
                errors.push('deadlineEvidence.steps must contain unique non-empty ids');
            }
            ids.add(step.id);
            if (step.status !== 'success')
            {
                errors.push(`deadlineEvidence step ${step.id} must be success`);
            }
            if (!phases.has(step.evidencePhase))
            {
                errors.push(`deadlineEvidence step ${step.id} evidencePhase is invalid`);
            }
            if (!Number.isFinite(step.durationMs) || step.durationMs < 0)
            {
                errors.push(`deadlineEvidence step ${step.id} durationMs must be non-negative`);
            }
            if (!Number.isFinite(step.startedAtMs) || !Number.isFinite(step.finishedAtMs)
        || step.finishedAtMs < step.startedAtMs || step.finishedAtMs - step.startedAtMs !== step.durationMs)
            {
                errors.push(`deadlineEvidence step ${step.id} timing must match durationMs`);
            }
        }
        if (!ids.has('mixed-performance-window'))
        {
            errors.push('deadlineEvidence.steps must include mixed-performance-window');
        }
        const phaseDuration = (phase) => evidence.steps.filter((step) => step.evidencePhase === phase)
            .reduce((total, step) => total + Number(step.durationMs), 0);
        for (const [field, phase] of [
            ['coordinationWaitMs', 'coordination'],
            ['preparationWorkMs', 'preparation'],
            ['postMeasurementWorkMs', 'post-measurement']
        ])
        {
            if (!Number.isFinite(Number(evidence[field])) || Number(evidence[field]) !== phaseDuration(phase))
            {
                errors.push(`deadlineEvidence.${field} must equal ${phase} step duration`);
            }
        }
        const measurements = evidence.steps.filter((step) => step.evidencePhase === 'measurement');
        const measurementIds = measurements.map((step) => step.id).sort();
        if (!sameStringArray(measurementIds, performanceMeasurementStepIds))
        {
            errors.push(`deadlineEvidence measurement steps must be exactly ${performanceMeasurementStepIds.join(', ')}`);
        }
        const noise = evidence.steps.filter((step) => ['preparation', 'post-measurement'].includes(step.evidencePhase));
        const overlaps = noise.flatMap((noiseStep) => measurements
            .filter((measurement) => noiseStep.startedAtMs < measurement.finishedAtMs
        && measurement.startedAtMs < noiseStep.finishedAtMs)
            .map((measurement) => `${noiseStep.id}:${measurement.id}`));
        const measurementOverlaps = measurements.flatMap((left, index) => measurements.slice(index + 1)
            .filter((right) => left.startedAtMs < right.finishedAtMs && right.startedAtMs < left.finishedAtMs)
            .map((right) => `${left.id}:${right.id}`));
        if (overlaps.length > 0)
        {
            errors.push(`deadlineEvidence measurement overlaps noise: ${overlaps.join(', ')}`);
        }
        if (measurementOverlaps.length > 0)
        {
            errors.push(`deadlineEvidence benchmark-window measurements overlap: ${measurementOverlaps.join(', ')}`);
        }
        if (evidence.measurementIsolation?.status !== 'isolated'
      || !Array.isArray(evidence.measurementIsolation?.noiseOverlaps)
      || evidence.measurementIsolation.noiseOverlaps.length !== 0)
        {
            errors.push('deadlineEvidence.measurementIsolation must prove zero noise overlaps');
        }
    }
    return errors;
}

export function validateLocalProfileCheckpointDuration(checkpoint, profile)
{
    const errors = [];
    const budgetMs = Number(profile?.budgetMs);
    const enforceBudget = profile?.enforceBudget !== false;
    const checkpointBudgetMs = checkpoint?.budgetMs === null ? null : Number(checkpoint?.budgetMs);
    const startedAt = Date.parse(checkpoint?.startedAt ?? '');
    const finishedAt = Date.parse(checkpoint?.finishedAt ?? '');
    if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    {
        errors.push('profile budgetMs must be positive');
    }
    const expectedCheckpointBudgetMs = enforceBudget ? budgetMs : null;
    if (checkpointBudgetMs !== expectedCheckpointBudgetMs)
    {
        errors.push(`checkpoint budgetMs must be ${expectedCheckpointBudgetMs ?? 'null'}`);
    }
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt)
    {
        errors.push('checkpoint startedAt/finishedAt must define a valid duration');
    }
    else if (enforceBudget && finishedAt - startedAt > budgetMs)
    {
        errors.push(`checkpoint duration ${finishedAt - startedAt} exceeds ${budgetMs}`);
    }
    return errors;
}

export function validateLocalProfileRunSummary(summary, profile)
{
    const errors = [];
    const budgetMs = Number(profile?.budgetMs);
    const durationMs = Number(summary?.durationMs);
    if (summary?.budgetMs !== budgetMs)
    {
        errors.push(`summary budgetMs must be ${budgetMs}`);
    }
    if (!Number.isFinite(durationMs) || durationMs < 0)
    {
        errors.push('summary durationMs must be a non-negative number');
    }
    else if (profile?.enforceBudget !== false && durationMs > budgetMs)
    {
        errors.push(`summary duration ${durationMs} exceeds ${budgetMs}`);
    }
    return errors;
}

function sameSourceState(left, right)
{
    return Boolean(left && right)
    && String(left.commit ?? '') === String(right.commit ?? '')
    && String(left.worktreeFingerprint ?? '') === String(right.worktreeFingerprint ?? '');
}

function collectionEntry(collection, id)
{
    return collection instanceof Map ? collection.get(id) : collection?.[id];
}

function sortedUnique(values)
{
    return [...new Set(values)].sort();
}

function canonicalReceiptValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalReceiptValue);
    }
    if (plainRecord(value))
    {
        return Object.fromEntries(Object.keys(value).sort()
            .map((key) => [key, canonicalReceiptValue(value[key])]));
    }
    return value;
}

export function externalEvidenceReceiptDigest(receipt)
{
    const unsigned = structuredClone(receipt ?? {});
    delete unsigned.contentDigest;
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalReceiptValue(unsigned))).digest('hex')}`;
}

function requiredReceiptIds(receipt, field, tierId, errors)
{
    const values = receipt?.[field];
    if (!Array.isArray(values) || values.length === 0
    || values.some((value) => typeof value !== 'string' || !value.trim())
    || new Set(values).size !== values.length)
    {
        errors.push(`${tierId} external receipt ${field} must be non-empty unique strings`);
        return [];
    }
    return sortedUnique(values);
}

export function resolveExternalEvidenceReceipts({ summaryOnlyEvidence, externalEvidenceReceipts, checkpoint, canonicalAuthorities = {}, buildIdentity = null })
{
    const resolved = {};
    const declaredTierIds = Object.keys(externalEvidenceReceipts ?? {}).sort();
    const expectedTierIds = Object.keys(summaryOnlyEvidence ?? {}).sort();
    if (declaredTierIds.length > 0 && (declaredTierIds.length !== expectedTierIds.length
    || declaredTierIds.some((tierId, index) => tierId !== expectedTierIds[index])))
    {
        throw new Error('external receipt declarations must exactly match summary-only tiers');
    }
    for (const [tierId, placeholder] of Object.entries(summaryOnlyEvidence ?? {}))
    {
        const candidates = collectionEntry(externalEvidenceReceipts, tierId) ?? [];
        if (!Array.isArray(candidates))
        {
            throw new Error(`${tierId} external receipts must be an array`);
        }
        if (candidates.length === 0)
        {
            continue;
        }
        if (candidates.length !== 1)
        {
            throw new Error(`${tierId} external receipts are ambiguous; exact-one is required`);
        }
        const candidate = candidates[0];
        const receipt = candidate?.receipt;
        const receiptPath = normalizeDeclaration(candidate?.receiptPath);
        const errors = [];
        if (!plainRecord(receipt))
        {
            errors.push(`${tierId} external receipt must be an object`);
        }
        if (!safeRepositoryDeclaration(receiptPath))
        {
            errors.push(`${tierId} external receipt path is invalid`);
        }
        if (receipt?.schema !== 'fsusblog.external-correctness-receipt.v1')
        {
            errors.push(`${tierId} external receipt schema is invalid`);
        }
        if (receipt?.tierId !== tierId)
        {
            errors.push(`${tierId} external receipt tierId must match`);
        }
        if (typeof canonicalAuthorities?.[tierId] !== 'string' || !canonicalAuthorities[tierId])
        {
            errors.push(`${tierId} has no unique canonical external authority`);
        }
        else if (receipt?.authorityId !== canonicalAuthorities[tierId])
        {
            errors.push(`${tierId} external receipt authorityId does not match canonical authority`);
        }
        if (receipt?.schedulerRunId !== checkpoint.runId)
        {
            errors.push(`${tierId} external receipt schedulerRunId must match current run`);
        }
        if (!buildIdentity || JSON.stringify(canonicalReceiptValue(receipt?.buildIdentity)) !== JSON.stringify(canonicalReceiptValue(buildIdentity))
      || !sameSourceState(receipt?.sourceState, checkpoint.sourceState))
        {
            errors.push(`${tierId} external receipt source/worktree/build identity must match current run`);
        }
        const testIds = requiredReceiptIds(receipt, 'testIds', tierId, errors);
        const coverageIds = requiredReceiptIds(receipt, 'coverageIds', tierId, errors);
        const assertionIds = requiredReceiptIds(receipt, 'assertionIds', tierId, errors);
        if (receipt?.status !== 'success')
        {
            errors.push(`${tierId} external receipt status must be success`);
        }
        if (receipt?.contentDigest !== externalEvidenceReceiptDigest(receipt))
        {
            errors.push(`${tierId} external receipt contentDigest is invalid`);
        }
        if (errors.length > 0)
        {
            throw new Error(errors.join('; '));
        }
        resolved[tierId] = {
            tierId,
            evidenceKind: 'external-executed',
            physicalBundleId: null,
            status: 'success',
            executionSource: 'external-environment',
            durationMs: null,
            testIds,
            coverageIds,
            assertionIds,
            authorityId: receipt.authorityId,
            schedulerRunId: receipt.schedulerRunId,
            sourceState: { ...receipt.sourceState },
            buildIdentity: { ...receipt.buildIdentity, sourceState: { ...receipt.buildIdentity.sourceState } },
            blockedPlaceholder: {
                schema: placeholder.schema,
                tierId: placeholder.tierId,
                status: placeholder.status,
                executionSource: placeholder.executionSource,
                evidencePath: placeholder.evidencePath,
                artifactDigest: placeholder.artifactDigest,
                schedulerRunId: placeholder.schedulerRunId,
                sourceState: { ...placeholder.sourceState }
            },
            artifactDigests: { [receiptPath]: receipt.contentDigest }
        };
    }
    return resolved;
}

function validateSummaryOnlyEvidence(evidence, tierId, checkpoint)
{
    const errors = [];
    if (!evidence)
    {
        return [`missing summary-only evidence: ${tierId}`];
    }
    if (evidence.schema !== summaryOnlySchema)
    {
        errors.push(`${tierId} summary-only schema must be ${summaryOnlySchema}`);
    }
    if (evidence.tierId !== tierId)
    {
        errors.push(`${tierId} summary-only tierId must match`);
    }
    if (evidence.status !== 'collected-blocked')
    {
        errors.push(`${tierId} summary-only status must be collected-blocked`);
    }
    if (evidence.executionSource !== 'external-environment')
    {
        errors.push(`${tierId} summary-only executionSource must be external-environment`);
    }
    if (evidence.schedulerRunId !== checkpoint.runId)
    {
        errors.push(`${tierId} summary-only schedulerRunId must be ${checkpoint.runId}`);
    }
    if (!sameSourceState(evidence.sourceState, checkpoint.sourceState))
    {
        errors.push(`${tierId} summary-only sourceState must match the checkpoint`);
    }
    if (!String(evidence.evidencePath ?? '').trim())
    {
        errors.push(`${tierId} summary-only evidencePath must be non-empty`);
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(evidence.artifactDigest ?? '')))
    {
        errors.push(`${tierId} summary-only artifactDigest must be sha256`);
    }
    return errors;
}

export function buildLocalProfileProjection({
    profileId,
    profile,
    tiers,
    checkpoint,
    bundleSummaries,
    summaryOnlyEvidence,
    externalEvidenceReceipts = null,
    artifactDigestTable = null
})
{
    const errors = [];
    if (!Array.isArray(tiers) || tiers.length === 0)
    {
        throw new Error('local profile projection requires matrix tiers');
    }
    const matrixById = new Map();
    for (const tier of tiers)
    {
        if (!tier?.id)
        {
            errors.push('matrix tier id must be non-empty');
            continue;
        }
        if (matrixById.has(tier.id))
        {
            errors.push(`duplicate matrix tier: ${tier.id}`);
        }
        matrixById.set(tier.id, tier);
    }
    if (!matrixById.has(profileId))
    {
        errors.push(`matrix target tier is missing: ${profileId}`);
    }
    for (const tier of tiers)
    {
        for (const dependencyId of tierExecutionDependencies(tier))
        {
            if (!matrixById.has(dependencyId))
            {
                errors.push(`${tier.id} depends on missing matrix tier: ${dependencyId}`);
            }
        }
    }
    const logicalTierIds = collectLogicalTierIds(tiers, profileId);
    const entries = {};
    if (!checkpoint || typeof checkpoint !== 'object')
    {
        throw new Error('local profile projection requires a scheduler checkpoint');
    }
    if (checkpoint.targetTierId !== profileId)
    {
        errors.push(`checkpoint targetTierId must be ${profileId}`);
    }
    if (checkpoint.mode !== 'fresh')
    {
        errors.push('checkpoint mode must be fresh');
    }
    if (checkpoint.status !== 'success')
    {
        errors.push('checkpoint status must be success');
    }
    if (!String(checkpoint.runId ?? '').trim())
    {
        errors.push('checkpoint runId must be non-empty');
    }
    if (!checkpoint.sourceState || !String(checkpoint.sourceState.worktreeFingerprint ?? '').trim())
    {
        errors.push('checkpoint sourceState must be present');
    }
    if (artifactDigestTable !== null)
    {
        if (artifactDigestTable.schema !== 'fsusblog.production-artifact-digest-table.v1'
      || artifactDigestTable.runId !== checkpoint.runId
      || artifactDigestTable.sourceState?.commit !== checkpoint.sourceState?.commit
      || artifactDigestTable.sourceState?.worktreeFingerprint !== checkpoint.sourceState?.worktreeFingerprint
      || !/^sha256:[a-f0-9]{64}$/u.test(String(artifactDigestTable.contentDigest ?? ''))
      || !safeRepositoryDeclaration(artifactDigestTable.path))
        {
            errors.push('artifactDigestTable must be final, run-bound checkpoint evidence');
        }
    }
    errors.push(...validateLocalProfileCheckpointDuration(checkpoint, profile));

    for (const bundle of profile?.bundles ?? [])
    {
        const physicalTierId = `local-${profileId}-${bundle.id}`;
        const physical = checkpoint?.tiers?.[physicalTierId];
        if (physical?.status !== 'success')
        {
            errors.push(`${physicalTierId} checkpoint status must be success`);
        }
        if (physical?.reused !== false)
        {
            errors.push(`${physicalTierId} checkpoint must not be reused`);
        }
        const summaryPath = localBundleSummaryPath(profileId, bundle.id);
        if (!Object.hasOwn(physical?.outputs ?? {}, summaryPath))
        {
            errors.push(`${physicalTierId} checkpoint output is missing ${summaryPath}`);
        }

        const summary = collectionEntry(bundleSummaries, bundle.id);
        const summaryErrors = validateLocalBundleSummary(summary, bundle, {
            expectedRunId: checkpoint.runId,
            expectedSourceState: checkpoint.sourceState,
            matrixTiers: tiers,
            profileId,
            expectedArtifactRefs: artifactDigestTable !== null
        });
        if (summaryErrors.length > 0)
        {
            errors.push(`${bundle.id} bundle evidence invalid: ${summaryErrors.join(', ')}`);
            continue;
        }
        for (const tierId of bundle.members ?? [])
        {
            if (entries[tierId])
            {
                errors.push(`logical tier projected more than once: ${tierId}`);
                continue;
            }
            const evidence = summary.members[tierId];
            entries[tierId] = {
                tierId,
                evidenceKind: 'executed',
                physicalBundleId: bundle.id,
                status: 'success',
                executionSource: 'fresh',
                durationMs: Number(evidence.durationMs),
                testIds: sortedUnique(evidence.testIds),
                artifactProofMode: evidence.artifactProofMode,
                matrixRuntimePaths: [...evidence.matrixRuntimePaths],
                artifactSubstitutionProofs: Object.fromEntries(Object.entries(evidence.artifactSubstitutionProofs)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([canonicalPath, proof]) => [canonicalPath, {
                        canonicalPath: proof.canonicalPath,
                        canonicalDigest: proof.canonicalDigest,
                        actualPaths: [...proof.actualPaths],
                        actualDigests: Object.fromEntries(Object.entries(proof.actualDigests).sort()),
                        ...(artifactDigestTable !== null ? {
              actualRefs: Object.fromEntries(Object.entries(proof.actualRefs).sort()),
              canonicalArtifactRef: proof.canonicalArtifactRef
            } : {})
                    }])),
                artifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort()),
                ...(artifactDigestTable !== null ? {
          artifactRefs: Object.fromEntries(Object.entries(evidence.artifactRefs).sort())
        } : {})
            };
        }
    }

    let externalEntries = {};
    let externalEvidenceFailure = null;
    try
    {
        externalEntries = resolveExternalEvidenceReceipts({
            summaryOnlyEvidence,
            externalEvidenceReceipts,
            checkpoint,
            canonicalAuthorities: profile?.externalAuthorities ?? {},
            buildIdentity: artifactDigestTable === null ? null : {
        schedulerRunId: checkpoint.runId,
        sourceState: { ...checkpoint.sourceState },
        artifactDigestTableDigest: artifactDigestTable.contentDigest
      }
        });
    }
    catch (error)
    {
        externalEvidenceFailure = error instanceof Error ? error.message : String(error);
    }
    for (const tierId of profile?.summaryOnly ?? [])
    {
        if (entries[tierId])
        {
            errors.push(`logical tier projected more than once: ${tierId}`);
            continue;
        }
        const evidence = collectionEntry(summaryOnlyEvidence, tierId);
        const summaryErrors = validateSummaryOnlyEvidence(evidence, tierId, checkpoint);
        if (summaryErrors.length > 0)
        {
            errors.push(...summaryErrors);
            continue;
        }
        entries[tierId] = externalEntries[tierId] ?? {
            tierId,
            evidenceKind: 'summary-only',
            physicalBundleId: null,
            status: 'collected-blocked',
            executionSource: 'external-environment',
            durationMs: null,
            testIds: [],
            artifactDigests: { [evidence.evidencePath]: evidence.artifactDigest },
            ...(artifactDigestTable !== null ? {
        artifactRefs: { [evidence.evidencePath]: evidence.artifactRef }
      } : {})
        };
    }

    const projectedTierIds = Object.keys(entries).sort();
    const missingTierIds = logicalTierIds.filter((tierId) => !entries[tierId]);
    const unexpectedTierIds = projectedTierIds.filter((tierId) => !logicalTierIds.includes(tierId));
    if (missingTierIds.length > 0)
    {
        errors.push(`missing logical tier projection: ${missingTierIds.join(', ')}`);
    }
    if (unexpectedTierIds.length > 0)
    {
        errors.push(`unexpected logical tier projection: ${unexpectedTierIds.join(', ')}`);
    }
    if (projectedTierIds.length !== logicalTierIds.length)
    {
        errors.push(`logical tier projection count must be ${logicalTierIds.length}, received ${projectedTierIds.length}`);
    }
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }

    const orderedEntries = Object.fromEntries(logicalTierIds.map((tierId) => [tierId, entries[tierId]]));
    const summaryOnlyTierCount = Object.values(orderedEntries)
        .filter((entry) => entry.evidenceKind === 'summary-only').length;
    const qualificationEligible = summaryOnlyTierCount === 0 && externalEvidenceFailure === null;
    return {
        schema: logicalProjectionSchema,
        profileId,
        runId: checkpoint.runId,
        sourceState: { ...checkpoint.sourceState },
        executionSource: 'fresh',
        // A summary-only placeholder records a required external execution, not a
        // successful correctness result.  Keep this distinction at the projection
        // boundary so every consumer has a fail-closed qualification signal.
        status: externalEvidenceFailure === null
            ? (qualificationEligible ? 'complete-success' : 'incomplete-external-evidence')
            : 'complete-failure',
        qualificationEligible,
        ...(externalEvidenceFailure === null ? {} : { failure: { kind: 'external-evidence', reason: externalEvidenceFailure } }),
        logicalTierCount: logicalTierIds.length,
        executedTierCount: logicalTierIds.length - summaryOnlyTierCount,
        summaryOnlyTierCount,
        requiredSummaryOnlyTierIds: [...(profile?.summaryOnly ?? [])].sort(),
        logicalTierIds,
        ...(artifactDigestTable !== null ? { artifactDigestTable } : {}),
        entries: orderedEntries
    };
}

export function collectLogicalTierIds(tiers, targetTierId)
{
    const byId = new Map((tiers ?? []).map((tier) => [tier.id, tier]));
    const summariesByAuthority = new Map();
    for (const tier of tiers ?? [])
    {
        if (tier.executionMode !== 'summary' || !String(tier.summaryAuthority ?? '').trim())
        {
            continue;
        }
        const siblings = summariesByAuthority.get(tier.summaryAuthority) ?? [];
        siblings.push(tier.id);
        summariesByAuthority.set(tier.summaryAuthority, siblings);
    }
    const collected = new Set();
    const expanded = new Set();
    const visit = (tierId) =>
    {
        if (expanded.has(tierId))
        {
            return;
        }
        expanded.add(tierId);
        const tier = byId.get(tierId);
        if (!tier)
        {
            return;
        }
        if (tierId !== behaviorDocStaticAdmissionTierId)
        {
            collected.add(tierId);
        }
        for (const siblingId of summariesByAuthority.get(tier.summaryAuthority) ?? [])
        {
            visit(siblingId);
        }
        for (const dependencyId of [
            ...tierExecutionDependencies(tier),
            ...(tier.requiresEvidenceFrom ?? [])
        ])
        {
            visit(dependencyId);
        }
    };
    visit(targetTierId);
    return [...collected].sort();
}

export function localProfileBudgetCriticalPath(profile, costForBundle = (bundle) => Number(bundle.budgetMs))
{
    const bundles = new Map((profile?.bundles ?? []).map((bundle) => [bundle.id, bundle]));
    const memo = new Map();
    const visiting = new Set();
    const visit = (bundleId) =>
    {
        if (memo.has(bundleId))
        {
            return memo.get(bundleId);
        }
        if (visiting.has(bundleId))
        {
            return Number.POSITIVE_INFINITY;
        }
        const bundle = bundles.get(bundleId);
        if (!bundle)
        {
            return Number.POSITIVE_INFINITY;
        }
        visiting.add(bundleId);
        const dependencyBudget = Math.max(
            0,
            ...(bundle.dependsOn ?? [])
                .filter((dependencyId) => !isExternalBehaviorDocAdmissionDependency(dependencyId))
                .map(visit)
        );
        visiting.delete(bundleId);
        const ownCost = Number(costForBundle(bundle));
        if (!Number.isFinite(ownCost) || ownCost <= 0)
        {
            return Number.POSITIVE_INFINITY;
        }
        const total = ownCost + dependencyBudget;
        memo.set(bundleId, total);
        return total;
    };
    return Math.max(0, ...bundles.keys().map(visit));
}

export function validateLocalProfiles(localProfiles, tiers)
{
    const errors = [];
    for (const [profileId, profile] of profileEntries(localProfiles))
    {
        if (!Number.isFinite(profile?.budgetMs) || profile.budgetMs <= 0)
        {
            errors.push(`localProfiles.${profileId}.budgetMs must be positive`);
        }
        if (profileId === 'production' && profile?.budgetMs !== productionWallClockBudgetMs)
        {
            errors.push(`localProfiles.production.budgetMs must be ${productionWallClockBudgetMs}`);
        }
        if (profile?.enforceBudget !== undefined && typeof profile.enforceBudget !== 'boolean')
        {
            errors.push(`localProfiles.${profileId}.enforceBudget must be boolean`);
        }
        if (!Number.isInteger(profile?.minimumSupportedCpuUnits) || profile.minimumSupportedCpuUnits < 1)
        {
            errors.push(`localProfiles.${profileId}.minimumSupportedCpuUnits must be a positive integer`);
        }
        if (!Number.isFinite(profile?.memoryReserveShare)
      || profile.memoryReserveShare <= 0
      || profile.memoryReserveShare >= 1)
        {
            errors.push(`localProfiles.${profileId}.memoryReserveShare must be between 0 and 1`);
        }
        if (!Array.isArray(profile?.bundles) || profile.bundles.length !== 5)
        {
            errors.push(`localProfiles.${profileId} must declare exactly 5 bundles`);
            continue;
        }
        if (profileId === 'production')
        {
            const productionBundleContract = new Map([
                ...localBehaviorDocCandidateBundleIds.map((bundleId) => [
                    bundleId,
                    [behaviorDocStaticAdmissionTierId]
                ]),
                ['performance-evidence', ['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser']]
            ]);
            for (const [bundleId, expected] of productionBundleContract)
            {
                const productionBundle = profile.bundles.find((bundle) => bundle.id === bundleId);
                if (!productionBundle)
                {
                    errors.push(`localProfiles.production must declare ${bundleId}`);
                    continue;
                }
                if (JSON.stringify(productionBundle.dependsOn ?? []) !== JSON.stringify(expected))
                {
                    errors.push(`localProfiles.production.${bundleId}.dependsOn must be [${expected.join(', ')}]`);
                }
            }
        }

        const bundleIds = new Set();
        const mapped = new Map();
        for (const bundle of profile.bundles)
        {
            if (typeof bundle?.id !== 'string' || bundle.id.length === 0)
            {
                errors.push(`localProfiles.${profileId} bundle id must be non-empty`);
                continue;
            }
            if (bundleIds.has(bundle.id))
            {
                errors.push(`localProfiles.${profileId} duplicate bundle id: ${bundle.id}`);
            }
            bundleIds.add(bundle.id);
            if (typeof bundle.command !== 'string' || bundle.command.length === 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.command must be non-empty`);
            }
            if (!Number.isFinite(bundle.deadlineWeight) || bundle.deadlineWeight <= 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.deadlineWeight must be positive`);
            }
            if (bundle.minimumDeadlineShare !== undefined
        && (!Number.isFinite(bundle.minimumDeadlineShare)
          || bundle.minimumDeadlineShare < 0
          || bundle.minimumDeadlineShare >= 1))
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.minimumDeadlineShare must be between 0 and 1`);
            }
            if (!Number.isFinite(bundle.cpuWeight) || bundle.cpuWeight <= 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.cpuWeight must be positive`);
            }
            if (!Number.isFinite(bundle.memoryWeight) || bundle.memoryWeight <= 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.memoryWeight must be positive`);
            }
            if (!Number.isInteger(bundle.minCpuUnits)
        || bundle.minCpuUnits <= 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.minCpuUnits must be positive`);
            }
            const startupMinCpuUnits = bundle.startupMinCpuUnits ?? bundle.minCpuUnits;
            const startupMemoryWeight = bundle.startupMemoryWeight ?? bundle.memoryWeight;
            const startupPriority = bundle.startupPriority ?? 0;
            if (!Number.isInteger(startupMinCpuUnits) || startupMinCpuUnits <= 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.startupMinCpuUnits must be positive`);
            }
            else if (Number.isInteger(bundle.minCpuUnits) && startupMinCpuUnits > bundle.minCpuUnits)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.startupMinCpuUnits must not exceed minCpuUnits`);
            }
            if (!Number.isFinite(startupMemoryWeight) || startupMemoryWeight <= 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.startupMemoryWeight must be positive`);
            }
            if (!Number.isFinite(startupPriority) || startupPriority < 0)
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.startupPriority must be non-negative`);
            }
            for (const resolvedOnlyField of ['budgetMs', 'cpuUnits', 'memoryGiB', 'stepMaxParallel'])
            {
                if (Object.hasOwn(bundle, resolvedOnlyField))
                {
                    errors.push(`localProfiles.${profileId}.${bundle.id}.${resolvedOnlyField} must be machine-resolved, not declared`);
                }
            }
            for (const substitutionError of validateArtifactSubstitutions(bundle, tiers))
            {
                errors.push(`localProfiles.${profileId}.${bundle.id}.${substitutionError}`);
            }
            for (const tierId of bundle.members ?? [])
            {
                const owners = mapped.get(tierId) ?? [];
                owners.push(bundle.id);
                mapped.set(tierId, owners);
            }
        }

        const t0Bundles = profile.bundles.filter((bundle) =>
            (bundle.dependsOn ?? []).every(isExternalBehaviorDocAdmissionDependency));
        // The scheduler admits a priority-ordered subset when more t0 bundles are
        // ready than the machine can host. Requiring their aggregate minimum to
        // fit would forbid useful early-start wait/coordination bundles.
        const startupMinimumTotal = Math.min(...t0Bundles.map(
            (bundle) => Number(bundle.startupMinCpuUnits ?? bundle.minCpuUnits)
        ));
        if (Number.isInteger(profile.minimumSupportedCpuUnits)
      && startupMinimumTotal > profile.minimumSupportedCpuUnits)
        {
            errors.push(`localProfiles.${profileId} smallest startup CPU minimum ${startupMinimumTotal} exceeds supported machine floor ${profile.minimumSupportedCpuUnits}`);
        }

        for (const tierId of profile.summaryOnly ?? [])
        {
            const owners = mapped.get(tierId) ?? [];
            owners.push('summaryOnly');
            mapped.set(tierId, owners);
        }
        const summaryOnlyTierIds = [...(profile.summaryOnly ?? [])].sort();
        if (summaryOnlyTierIds.length > 0)
        {
            const authorityIds = Object.keys(profile.externalAuthorities ?? {}).sort();
            if (authorityIds.length !== summaryOnlyTierIds.length
        || authorityIds.some((tierId, index) => tierId !== summaryOnlyTierIds[index])
        || authorityIds.some((tierId) => !String(profile.externalAuthorities[tierId] ?? '').trim()))
            {
                errors.push(`localProfiles.${profileId}.externalAuthorities must exactly declare one canonical authority per summary-only tier`);
            }
        }

        for (const bundle of profile.bundles)
        {
            for (const dependencyId of bundle.dependsOn ?? [])
            {
                if (!bundleIds.has(dependencyId)
          && !isExternalBehaviorDocAdmissionDependency(dependencyId))
                {
                    errors.push(`localProfiles.${profileId}.${bundle.id} depends on unknown bundle: ${dependencyId}`);
                }
            }
        }

        const logicalTierIds = collectLogicalTierIds(tiers, profileId);
        for (const tierId of logicalTierIds)
        {
            const owners = mapped.get(tierId) ?? [];
            if (owners.length === 0)
            {
                errors.push(`localProfiles.${profileId} missing logical tier: ${tierId}`);
            }
            if (owners.length > 1)
            {
                errors.push(`localProfiles.${profileId} logical tier mapped more than once: ${tierId}`);
            }
        }
        for (const tierId of mapped.keys())
        {
            if (!logicalTierIds.includes(tierId))
            {
                errors.push(`localProfiles.${profileId} maps unrelated logical tier: ${tierId}`);
            }
        }
    }
    return errors;
}
