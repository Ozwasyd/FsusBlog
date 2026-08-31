import fs from 'node:fs';
import path from 'node:path';

import {
    checkClasses,
    githubContexts,
    isLintOnly,
    report,
    requiredClasses,
    resolveGroupChecks,
    updateSurfaceRelative,
    updateTypes
} from './dependency-required-checks.mjs';

function validateCatalogShape(catalog, errors)
{
    if (catalog?.schema !== 'fsusblog.dependency-required-checks.v1')
    {
        report(errors, 'catalog-schema', catalog?.schema ?? '<missing>');
    }
    if (catalog?.defaultBranch !== 'master')
    {
        report(errors, 'catalog-default-branch', catalog?.defaultBranch ?? '<missing>');
    }
    if (JSON.stringify(catalog?.updateTypes) !== JSON.stringify(updateTypes))
    {
        report(errors, 'catalog-update-types', JSON.stringify(catalog?.updateTypes ?? []));
    }
}

function validateCheckInventory(catalog, workflowChecks, errors)
{
    const checkEntries = Object.entries(catalog?.checks ?? {});
    if (checkEntries.length === 0)
    {
        report(errors, 'catalog-checks-empty', 'checks must not be empty');
    }
    for (const [name, check] of checkEntries)
    {
        if (!check?.workflow || !check?.jobName)
        {
            report(errors, 'catalog-check-field', name);
            continue;
        }
        const expected = `${check.workflow} / ${check.jobName}`;
        if (expected !== name)
        {
            report(errors, 'catalog-check-name', `${name}:${expected}`);
        }
        if (!workflowChecks.has(name))
        {
            report(errors, 'check-missing-workflow', name);
        }
        if (!Array.isArray(check.classes) || check.classes.length === 0)
        {
            report(errors, 'catalog-check-classes', name);
        }
        const lintOnly = check.classes?.length === 1 && check.classes[0] === 'lint';
        if (Boolean(check.lintOnly) !== lintOnly)
        {
            report(errors, 'catalog-lint-only', name);
        }
    }
}

function validateBranchProtection(catalog, context, errors)
{
    const protectionContexts = [...new Set(catalog?.branchProtection?.contexts ?? [])];
    if (catalog?.branchProtection?.strict !== true)
    {
        report(errors, 'branch-protection-not-strict', String(catalog?.branchProtection?.strict));
    }
    const simulatedContexts = githubContexts(context.branchProtection ?? catalog?.branchProtection);
    for (const name of protectionContexts)
    {
        if (!catalog?.checks?.[name])
        {
            report(errors, 'branch-protection-unknown-check', name);
        }
        if (!simulatedContexts.includes(name))
        {
            report(errors, 'branch-protection-missing-catalog-check', name);
        }
    }
    for (const name of simulatedContexts)
    {
        if (!protectionContexts.includes(name))
        {
            report(errors, 'branch-protection-extra-check', name);
        }
    }
    return protectionContexts;
}

function validateGroupUpdateType(catalog, group, updateType, protectionContexts, errors)
{
    const names = resolveGroupChecks(catalog, group.id, updateType);
    if (names.length === 0)
    {
        report(errors, updateType === 'lockFileMaintenance' ? 'lockfile-checks-empty' : 'group-checks-empty', `${group.id}:${updateType}`);
        return names;
    }
    for (const name of names)
    {
        if (!catalog.checks?.[name])
        {
            report(errors, 'check-missing-workflow', `${group.id}:${updateType}:${name}`);
        }
        if (!protectionContexts.includes(name))
        {
            report(errors, 'branch-protection-missing-catalog-check', `${group.id}:${updateType}:${name}`);
        }
        if (catalog.checks?.[name]?.triggers && !catalog.checks[name].triggers.includes('pull_request'))
        {
            report(errors, 'group-push-only-check', `${group.id}:${updateType}:${name}`);
        }
    }
    const missingClass = requiredClasses.filter((item) => !checkClasses(catalog, names).has(item));
    if (missingClass.length > 0)
    {
        report(errors, 'contract-coverage-missing', `${group.id}:${updateType}:${missingClass.join(',')}`);
    }
    if (isLintOnly(catalog, names))
    {
        report(errors, updateType === 'major' ? 'major-lint-only' : 'toolchain-lint-only', `${group.id}:${updateType}`);
    }
    return names;
}

function validateGroups(catalog, protectionContexts, errors)
{
    const groups = catalog?.groups ?? [];
    const groupIds = new Set();
    const coveredSurfaces = new Set();
    for (const group of groups)
    {
        if (!group?.id)
        {
            report(errors, 'catalog-group-field', JSON.stringify(group ?? {}));
            continue;
        }
        if (groupIds.has(group.id))
        {
            report(errors, 'catalog-duplicate-group', group.id);
        }
        groupIds.add(group.id);
        for (const surface of group.surfaces ?? [])
        {
            coveredSurfaces.add(surface);
        }
        const selected = {};
        for (const updateType of updateTypes)
        {
            selected[updateType] = validateGroupUpdateType(catalog, group, updateType, protectionContexts, errors);
        }
        if (JSON.stringify(selected.patch) !== JSON.stringify(selected.minor))
        {
            report(errors, 'patch-minor-mismatch', group.id);
        }
        if (group.id !== 'lockfile-maintenance'
            && selected.major.length <= selected.patch.length
            && JSON.stringify(selected.major) === JSON.stringify(selected.patch))
        {
            report(errors, 'major-not-broader', group.id);
        }
    }
    for (const groupId of catalog?.requiredGroups ?? [])
    {
        if (!groupIds.has(groupId))
        {
            report(errors, 'group-unregistered', groupId);
        }
    }
    for (const surface of catalog?.requiredSurfaces ?? [])
    {
        if (!coveredSurfaces.has(surface))
        {
            report(errors, 'surface-uncovered', surface);
        }
    }
    return groupIds;
}

function validateCheckSets(catalog, errors)
{
    const setNames = new Set(Object.keys(catalog?.checkSets ?? {}));
    for (const group of catalog?.groups ?? [])
    {
        for (const setName of Object.values(group.checksByUpdateType ?? {}))
        {
            if (!setNames.has(setName))
            {
                report(errors, 'check-set-missing', `${group.id}:${setName}`);
            }
        }
    }
    for (const [setName, names] of Object.entries(catalog?.checkSets ?? {}))
    {
        if (new Set(names).size !== names.length)
        {
            report(errors, 'check-set-duplicate', setName);
        }
    }
}

function validateOptionalUpdateSurface(catalogGroups, context, errors)
{
    if (!context.root)
    {
        return;
    }
    const updateSurfacePath = path.join(context.root, updateSurfaceRelative);
    if (!fs.existsSync(updateSurfacePath))
    {
        return;
    }
    const surface = JSON.parse(fs.readFileSync(updateSurfacePath, 'utf8'));
    for (const group of new Set((surface.items ?? []).map((item) => item.group).filter(Boolean)))
    {
        if (!catalogGroups.has(group))
        {
            report(errors, 'group-unregistered', group);
        }
    }
}

function validateAutomergeForbidden(context, errors)
{
    if (context.forbidAutomerge !== true || !context.root)
    {
        return;
    }
    const renovatePath = path.join(context.root, 'renovate.json5');
    if (!fs.existsSync(renovatePath))
    {
        return;
    }
    const renovate = JSON.parse(fs.readFileSync(renovatePath, 'utf8'));
    if (renovate.automerge === true || (renovate.packageRules ?? []).some((rule) => rule.automerge === true))
    {
        report(errors, 'config-automerge', 'required-checks contract must not enable automerge');
    }
}

export function validateRequiredChecksCatalog(catalog, context = {})
{
    const errors = [];
    validateCatalogShape(catalog, errors);
    validateCheckInventory(catalog, context.workflowChecks ?? new Set(), errors);
    const protectionContexts = validateBranchProtection(catalog, context, errors);
    const groupIds = validateGroups(catalog, protectionContexts, errors);
    validateCheckSets(catalog, errors);
    validateOptionalUpdateSurface(groupIds, context, errors);
    validateAutomergeForbidden(context, errors);
    return errors;
}
