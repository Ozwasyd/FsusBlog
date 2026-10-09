import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FIXTURE_PROFILE_MATRIX_SCHEMA = 'fsusblog.fixture-profile-matrix.v1';
export const FIXTURE_PROFILE_MATRIX_FILE = path.join(root, 'config/testing/fixture-profile-matrix.generated.json');

/**
 * Closed execution-class vocabulary for every matrix tier. The classes are the
 * machine-readable static property required by #2053: non-fixture steps are
 * coordination/build/static-governance; fixture-bound consumers use one of the
 * #1707 profile execution classes.
 */
export const FIXTURE_EXECUTION_CLASSES = Object.freeze([
    'acceptance',
    'benchmark',
    'browser',
    'build',
    'coordination',
    'diagnostic',
    'development',
    'load',
    'runtime',
    'security',
    'static-governance'
]);

export const NON_FIXTURE_EXECUTION_CLASSES = Object.freeze([
    'build',
    'coordination',
    'static-governance'
]);

const COORDINATION_IDS = new Set([
    'behavior-document-consistency-final',
    'behavior-evidence-post-runtime',
    'changed-code-coverage',
    'ci',
    'coverage-backend',
    'coverage-frontend',
    'coverage-gate',
    'coverage-gate-strict',
    'coverage-merge',
    'coverage-threshold',
    'data-scale-evidence-summary',
    'fast',
    'frontend-fast-summary',
    'integrity-proof-verification',
    'performance-evidence-summary',
    'pr-smart-gate-plan',
    'release-closeout',
    'release-evidence',
    'release-final',
    'release-final-flaky-governance',
    'release-final-shard-completeness',
    'rights-v3-test-matrix',
    'runtime-cache-evidence',
    'source-governance',
    'ux-viewport-plan-progress',
    'validate-declarations',
    'validate-matrix',
    'visual'
]);

const BUILD_IDS = new Set([
    'backend-build-governance',
    'frontend-build',
    'production-build-artifacts',
    'test-inventory',
    'wasm-build-artifacts'
]);

const STATIC_GOVERNANCE_IDS = new Set([
    'backend-test-governance',
    'behavior-doc-static-admission',
    'behavior-evidence-pre-runtime',
    'frontend-static-governance',
    'static-governance',
    'test-quality-lint'
]);

/**
 * Deterministic execution-class classification. The result is a static
 * contract input: inventory generation, validator and matrix declarations must
 * agree on the same class for the same tier.
 */
export function classifyTierExecutionClass(tier)
{
    if (tier?.executionClass === 'static-governance')
    {
        return 'static-governance';
    }
    if ((tier?.executionMode ?? 'execute') !== 'execute'
    || ['aggregate', 'finalizer', 'receipt', 'projection'].includes(tier?.commandKind))
    {
        return 'coordination';
    }
    const id = String(tier?.id ?? '');
    if (COORDINATION_IDS.has(id))
    {
        return 'coordination';
    }
    if (BUILD_IDS.has(id))
    {
        return 'build';
    }
    if (STATIC_GOVERNANCE_IDS.has(id))
    {
        return 'static-governance';
    }
    if (/^(?:csrf|security)/u.test(id))
    {
        return 'security';
    }
    if (/^(?:backend-qps|data-scale|load|soak)/u.test(id))
    {
        return 'load';
    }
    if (tier?.resourceClass === 'browser')
    {
        return 'browser';
    }
    if (tier?.resourceClass === 'benchmark'
    || /(?:benchmark|redteam|character-v3-release-gate|perf(?:ormance)?(?:-|$))/u.test(id))
    {
        return 'benchmark';
    }
    return 'runtime';
}

export function expectedFixtureProfileReason(tier)
{
    const executionClass = classifyTierExecutionClass(tier);
    const profileId = String(tier?.fixtureProfile ?? '');
    return profileId === 'none' ? `none-${executionClass}` : `binds-${profileId}`;
}

export function expectedFixtureMutatorAllowed(tier)
{
    return String(tier?.fixtureProfile ?? '') !== 'none';
}

function stableStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Json(value)
{
    return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

/** The one authorized prerequisite is a distinct profile, never a capability union. */
export function matrixFixturePrerequisites(tier)
{
    const expected = [{ id: 'typed-admin-session', profileId: 'auth-basic',
        producerId: 'auth-session', capabilityId: 'auth.admin.full-permission',
        semanticRole: 'admin.full-permission', consumerId: 'runtime-cache-hot-featured-frame' }];
    if (tier.id === 'runtime-cache-hot-featured-frame')
    {
        if (tier.fixtureProfile !== 'public-content-lifecycle' || tier.executionClass !== 'runtime'
            || stableStringify(tier.fixturePrerequisites) !== stableStringify(expected))
        {
            throw new Error('hot-featured matrix requires exact typed-admin-session prerequisite declaration');
        }
        return expected;
    }
    if (Object.hasOwn(tier, 'fixturePrerequisites'))
    {
        throw new Error('fixture prerequisite is only authorized for hot-featured runtime tier');
    }
    return [];
}

/**
 * Stable per-tier inventory for every matrix step (not only fixture consumers).
 * The digest covers tier id, execution class and fixture-profile declaration so
 * a new step without a declaration or any declaration change fails closed.
 */
export function buildFixtureProfileMatrixInventory(matrix)
{
    const entries = (matrix?.tiers ?? [])
        .map((tier) => ({
            tierId: String(tier.id),
            executionClass: classifyTierExecutionClass(tier),
            fixtureProfile: String(tier.fixtureProfile ?? ''),
            fixtureProfileReason: expectedFixtureProfileReason(tier),
            fixtureProfileProof: String(tier.fixtureProfileProof ?? ''),
            fixtureMutatorAllowed: expectedFixtureMutatorAllowed(tier),
            ...(Object.hasOwn(tier, 'fixturePrerequisites') ? { fixturePrerequisites: tier.fixturePrerequisites } : {})
        }))
        .sort((left, right) => left.tierId.localeCompare(right.tierId));
    return {
        schema: FIXTURE_PROFILE_MATRIX_SCHEMA,
        generatedBy: 'tools/test-matrix/fixture-profile-contract.mjs',
        entries,
        digest: sha256Json(entries)
    };
}

export function validateFixtureProfileMatrix(matrix, {
    inventoryFile = FIXTURE_PROFILE_MATRIX_FILE,
    repositoryRoot = root,
    catalogFile = path.join(root, 'config/testing/fixture-profile-catalog.json')
} = {})
{
    const errors = [];
    if (!Array.isArray(matrix?.tiers) || matrix.tiers.length === 0)
    {
        errors.push('matrix tiers must be a non-empty list');
        return errors;
    }
    const profileIds = new Set();
    const statusById = new Map();
    try
    {
        const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
        for (const profile of catalog.profiles ?? [])
        {
            profileIds.add(profile.id);
        }
        for (const profile of catalog.profiles ?? [])
        {
            statusById.set(profile.id, profile.status ?? 'available');
        }
    }
    catch (error)
    {
        errors.push(`fixture profile catalog is unreadable for profile-matrix validation: ${error.message}`);
        return errors;
    }
    for (const tier of matrix.tiers)
    {
        const id = String(tier?.id ?? '<unknown>');
        const missing = [];
        for (const field of ['executionClass', 'fixtureProfile', 'fixtureProfileReason', 'fixtureProfileProof', 'fixtureMutatorAllowed'])
        {
            if (!Object.hasOwn(tier ?? {}, field))
            {
                missing.push(field);
            }
        }
        if (missing.length)
        {
            errors.push(`matrix tier ${id} must bind ${missing.join(', ')}`);
            continue;
        }
        const profileId = String(tier.fixtureProfile);
        try
        {
            matrixFixturePrerequisites(tier);
        }
        catch (error)
        {
            errors.push(`matrix tier ${id}: ${error.message}`);
        }
        if (!FIXTURE_EXECUTION_CLASSES.includes(tier.executionClass))
        {
            errors.push(`matrix tier ${id} has unknown executionClass ${tier.executionClass}`);
        }
        if (!profileIds.has(profileId))
        {
            errors.push(`matrix tier ${id} references unknown fixture profile ${profileId}`);
            continue;
        }
        if (statusById.get(profileId) === 'deprecated')
        {
            errors.push(`matrix tier ${id} references deprecated fixture profile ${profileId}`);
        }
        if (typeof tier.fixtureMutatorAllowed !== 'boolean'
      || tier.fixtureMutatorAllowed !== expectedFixtureMutatorAllowed(tier))
        {
            errors.push(`matrix tier ${id} fixtureMutatorAllowed must be ${expectedFixtureMutatorAllowed(tier)}`);
        }
        const expectedReason = expectedFixtureProfileReason(tier);
        if (tier.fixtureProfileReason !== expectedReason)
        {
            errors.push(`matrix tier ${id} fixtureProfileReason must be ${expectedReason}`);
        }
        if (typeof tier.fixtureProfileProof !== 'string' || !tier.fixtureProfileProof.startsWith('tests/tools/')
      || !tier.fixtureProfileProof.endsWith('.test.mjs'))
        {
            errors.push(`matrix tier ${id} fixtureProfileProof must reference a tests/tools focused test`);
        }
        else if (!fs.existsSync(path.join(repositoryRoot, tier.fixtureProfileProof)))
        {
            errors.push(`matrix tier ${id} fixtureProfileProof ${tier.fixtureProfileProof} does not exist`);
        }
        if (Object.hasOwn(tier, 'fixtureCapabilities'))
        {
            errors.push(`matrix tier ${id} must not declare retired fixtureCapabilities field`);
        }
        const expectedClass = classifyTierExecutionClass(tier);
        if (tier.executionClass !== expectedClass)
        {
            errors.push(`matrix tier ${id} executionClass must be ${expectedClass}`);
        }
    }
    let expected;
    try
    {
        expected = buildFixtureProfileMatrixInventory(matrix);
        const actual = fs.readFileSync(inventoryFile, 'utf8');
        const actualJson = JSON.parse(actual);
        if (JSON.stringify(actualJson) !== JSON.stringify(expected))
        {
            errors.push('fixture-profile-matrix generated inventory is stale; run tools/testing/generate-fixture-catalog-artifacts.mjs');
        }
    }
    catch (error)
    {
        errors.push(`fixture-profile-matrix inventory is unreadable or stale: ${error.message}`);
    }
    return errors;
}
