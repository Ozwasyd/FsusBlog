#!/usr/bin/env node

export const FSUSUI_PACKAGE = '@ozwasyd/element-plus';
export const FSUSUI_ITEM_ID = 'npm-ozwasyd-element-plus-frontend';
export const FSUSUI_RELEASE_TRAIN_MANAGER = 'fsusui-release-train';
export const FSUSUI_RENOVATE_MANAGER = 'npm';
export const FSUSUI_DELEGATED_MANAGER = 'delegated';
export const FSUSUI_RENOVATE_DELEGATION_DESCRIPTION = 'FsusUI release train owns @ozwasyd/element-plus after the first verified public npm migration (#1985).';
export const FSUSUI_PACKAGE_FILES = Object.freeze([
    'src/frontend/package.json',
    'src/frontend/package-lock.json'
]);

function ownershipError(detail)
{
    return new Error(`FsusUI dependency ownership: ${detail}`);
}

function requireCondition(condition, detail)
{
    if (!condition)
    {
        throw ownershipError(detail);
    }
}

export function cloneCatalog(catalog)
{
    return JSON.parse(JSON.stringify(catalog));
}

export function findFsusuiDependencyItems(catalog)
{
    return (catalog?.items ?? []).filter((item) => item.packageName === FSUSUI_PACKAGE);
}

function targetItem(catalog)
{
    const items = findFsusuiDependencyItems(catalog);
    requireCondition(items.length === 1, `target must have exactly one catalog owner, found ${items.length}`);
    requireCondition(items[0].id === FSUSUI_ITEM_ID, `target catalog id must be ${FSUSUI_ITEM_ID}`);
    return items[0];
}

function assertPackageFiles(item)
{
    for (const file of FSUSUI_PACKAGE_FILES)
    {
        requireCondition(item.files?.includes(file), `target owner must include ${file}`);
    }
}

export function fsusuiManagerPhase(catalog)
{
    const item = targetItem(catalog);
    assertPackageFiles(item);
    if (item.manager === FSUSUI_RENOVATE_MANAGER)
    {
        requireCondition(item.customManager === undefined, 'Renovate owner must not have a custom manager');
        requireCondition(
            JSON.stringify(item.fieldPaths ?? []) === JSON.stringify(['/dependencies/@ozwasyd~1element-plus']),
            'Renovate owner must retain the exact direct dependency field path'
        );
        return 'pre-migration';
    }
    if (item.manager === FSUSUI_DELEGATED_MANAGER)
    {
        requireCondition(item.customManager === FSUSUI_RELEASE_TRAIN_MANAGER, 'delegated owner must use fsusui-release-train');
        requireCondition(!item.fieldPaths || item.fieldPaths.length === 0, 'delegated owner must not retain Renovate field paths');
        return 'post-migration';
    }
    throw ownershipError(`unsupported target manager ${item.manager ?? '-'}`);
}

export function assertFsusuiManagerState(catalog, expectedPhase = 'any')
{
    const phase = fsusuiManagerPhase(catalog);
    requireCondition(expectedPhase === 'any' || expectedPhase === phase, `expected ${expectedPhase}, found ${phase}`);
    return {
        phase,
        item: targetItem(catalog)
    };
}

export function activateFsusuiReleaseTrainManager(catalog, migration)
{
    requireCondition(migration?.migration === 'first-public-npm', 'manager activation requires the first public npm migration');
    requireCondition(migration?.verified === true, 'manager activation requires a verified migration result');
    requireCondition(/^[a-f0-9]{64}$/u.test(migration?.verifiedReceiptSha256 ?? ''), 'manager activation requires the sealed receipt digest');
    requireCondition(Array.isArray(migration?.privateReferencesAfter) && migration.privateReferencesAfter.length === 0, 'manager activation requires a clean migration postcondition');
    requireCondition(typeof migration.version === 'string' && migration.version.length > 0, 'manager activation requires a migration version');
    assertFsusuiManagerState(catalog, 'pre-migration');
    const next = cloneCatalog(catalog);
    const item = targetItem(next);
    item.manager = FSUSUI_DELEGATED_MANAGER;
    item.customManager = FSUSUI_RELEASE_TRAIN_MANAGER;
    delete item.fieldPaths;
    assertFsusuiManagerState(next, 'post-migration');
    return next;
}

function requireStableVersion(version)
{
    requireCondition(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version ?? ''), 'Renovate delegation requires an exact stable version');
}

export function activateFsusuiReleaseTrainRenovateDelegation(renovate, version)
{
    requireStableVersion(version);
    const next = cloneCatalog(renovate);
    const rules = next.packageRules ?? [];
    requireCondition(Array.isArray(rules), 'Renovate packageRules must be an array');
    requireCondition(!rules.some((rule) => (rule.matchPackageNames ?? []).includes(FSUSUI_PACKAGE)), 'Renovate already has an FsusUI package rule');
    next.packageRules = [...rules, {
        description: FSUSUI_RENOVATE_DELEGATION_DESCRIPTION,
        matchPackageNames: [FSUSUI_PACKAGE],
        allowedVersions: version
    }];
    assertFsusuiReleaseTrainRenovateDelegation(next, version);
    return next;
}

export function synchronizeFsusuiReleaseTrainRenovateDelegation(renovate, version)
{
    requireStableVersion(version);
    const next = cloneCatalog(renovate);
    const rule = assertFsusuiReleaseTrainRenovateDelegation(next);
    rule.allowedVersions = version;
    assertFsusuiReleaseTrainRenovateDelegation(next, version);
    return next;
}

export function assertFsusuiReleaseTrainRenovateDelegation(renovate, expectedVersion)
{
    const rules = (renovate?.packageRules ?? []).filter((rule) => (rule.matchPackageNames ?? []).includes(FSUSUI_PACKAGE));
    requireCondition(rules.length === 1, 'Renovate must have exactly one FsusUI release-train delegation rule');
    const [rule] = rules;
    requireCondition(rule.description === FSUSUI_RENOVATE_DELEGATION_DESCRIPTION, 'Renovate delegation description is not exact');
    requireCondition(JSON.stringify(rule.matchPackageNames) === JSON.stringify([FSUSUI_PACKAGE]), 'Renovate delegation must match only the FsusUI package');
    requireStableVersion(rule.allowedVersions);
    requireCondition(expectedVersion === undefined || rule.allowedVersions === expectedVersion, `Renovate delegation must allow only ${expectedVersion}`);
    requireCondition(rule.enabled !== false, 'Renovate delegation must not use permanent enabled:false');
    requireCondition(!Object.hasOwn(rule, 'ignoreDeps') && !Object.hasOwn(rule, 'matchFileNames'), 'Renovate delegation must not use ignoreDeps or path ignores');
    return rule;
}

export function evaluateFsusuiManagerOwnership({
    catalog,
    migrationComplete,
    renovatePullRequests = [],
    releaseTrainPullRequests = []
} = {})
{
    const errors = [];
    let phase;
    try
    {
        phase = assertFsusuiManagerState(catalog).phase;
    }
    catch (error)
    {
        errors.push({ code: 'fsusui-manager-invalid', detail: error.message });
        return { status: 'fail', phase: null, errors };
    }
    if (migrationComplete === true && phase !== 'post-migration')
    {
        errors.push({ code: 'fsusui-manager-migration-state', detail: `migration complete with ${phase} owner` });
    }
    if (migrationComplete === false && phase !== 'pre-migration')
    {
        errors.push({ code: 'fsusui-manager-migration-state', detail: `migration pending with ${phase} owner` });
    }
    if (phase === 'pre-migration' && releaseTrainPullRequests.length > 0)
    {
        errors.push({ code: 'fsusui-manager-double-owner', detail: 'release-train PR exists before manager migration' });
    }
    if (phase === 'post-migration' && renovatePullRequests.length > 0)
    {
        errors.push({ code: 'fsusui-manager-double-owner', detail: 'Renovate PR exists after manager migration' });
    }
    if (releaseTrainPullRequests.length > 1)
    {
        errors.push({ code: 'fsusui-manager-pr-not-exact-one', detail: String(releaseTrainPullRequests.length) });
    }
    return { status: errors.length === 0 ? 'pass' : 'fail', phase, errors };
}
