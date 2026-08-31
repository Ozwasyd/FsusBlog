import {
    evaluateRequiredChecks,
    report,
    resolveGroupChecks,
    updateTypes
} from './dependency-required-checks.mjs';

export const blockingLabels = Object.freeze(['dependency-blocked', 'status:blocked']);
export const automergeUpdateTypes = Object.freeze([...updateTypes]);

function hasAutomergeWindow(value)
{
    return Array.isArray(value?.automergeSchedule) && value.automergeSchedule.length > 0;
}

export function validateRenovateAutomerge(config)
{
    const errors = [];
    if (config?.automergeType && config.automergeType !== 'pr')
    {
        report(errors, 'automerge-type', config.automergeType);
    }
    if (config?.platformAutomerge !== true)
    {
        report(errors, 'platform-automerge-disabled', String(config?.platformAutomerge));
    }
    if (config?.ignoreTests === true)
    {
        report(errors, 'ignore-tests', 'ignoreTests must remain false');
    }
    if (config?.dependencyDashboardApproval === true)
    {
        report(errors, 'manual-approval', 'dependencyDashboardApproval');
    }
    if (hasAutomergeWindow(config) || (config?.packageRules ?? []).some(hasAutomergeWindow))
    {
        report(errors, 'merge-window', 'automergeSchedule is forbidden');
    }
    const serialized = JSON.stringify(config ?? {});
    if (serialized.includes('"automergeType":"branch"'))
    {
        report(errors, 'direct-push-forbidden', 'automergeType branch');
    }
    if (serialized.includes('Quality Gate /') || serialized.includes('required-checks.json'))
    {
        report(errors, 'required-checks-copied', 'renovate must not copy required check names');
    }

    const covered = new Set();
    const rules = [
        ...(config?.packageRules ?? []),
        config?.lockFileMaintenance ? { ...config.lockFileMaintenance, matchUpdateTypes: ['lockFileMaintenance'] } : null
    ].filter(Boolean);
    for (const rule of rules)
    {
        const types = rule.matchUpdateTypes ?? [];
        const enabled = rule.automerge === true && rule.automergeType === 'pr' && rule.platformAutomerge === true;
        if (!enabled)
        {
            continue;
        }
        for (const updateType of types)
        {
            covered.add(updateType);
        }
    }
    for (const updateType of automergeUpdateTypes)
    {
        if (!covered.has(updateType))
        {
            report(errors, 'automerge-update-type', updateType);
        }
    }
    if (config?.vulnerabilityAlerts?.automerge === true
        && (config.vulnerabilityAlerts.automergeType !== 'pr' || config.vulnerabilityAlerts.platformAutomerge !== true))
    {
        report(errors, 'security-bypass', 'vulnerability alerts must use platform PR automerge');
    }
    return errors;
}

export function evaluatePlatformAutomerge(request)
{
    const errors = [];
    const pr = request?.pullRequest ?? {};
    const catalog = request.catalog;
    const required = resolveGroupChecks(catalog, pr.group, pr.updateType);
    if (required.length === 0)
    {
        report(errors, 'group-unregistered', `${pr.group}:${pr.updateType}`);
    }
    if (pr.draft === true)
    {
        report(errors, 'draft', pr.number ?? pr.id ?? 'pull-request');
    }
    if (pr.mergeable === false || pr.mergeableState === 'dirty')
    {
        report(errors, 'conflict', pr.mergeableState ?? 'unmergeable');
    }
    const labels = pr.labels ?? [];
    for (const label of labels)
    {
        if (blockingLabels.includes(label))
        {
            report(errors, 'blocking-label', label);
        }
    }
    if (pr.baseSha && request.defaultHeadSha && pr.baseSha !== request.defaultHeadSha)
    {
        report(errors, 'stale-base', `${pr.baseSha}:${request.defaultHeadSha}`);
    }
    if (pr.mergeableState === 'behind')
    {
        report(errors, 'stale-base', 'behind');
    }
    if (pr.directPush === true || pr.bypassBranchProtection === true || pr.automergeType === 'branch')
    {
        report(errors, 'security-bypass', pr.automergeType ?? 'direct-push');
    }
    if (pr.platformAutomerge !== true || pr.automergeType !== 'pr')
    {
        report(errors, 'platform-automerge-disabled', `${pr.automergeType ?? '-'}:${String(pr.platformAutomerge)}`);
    }
    if (pr.targetVersion && request.latestStable && pr.targetVersion !== request.latestStable)
    {
        report(errors, 'stale-target', `${pr.targetVersion}:${request.latestStable}`);
    }
    errors.push(...evaluateRequiredChecks(required, pr.checkRuns));

    const checkFailed = errors.some((error) => error.code.startsWith('check-'));
    const ageHours = Number(pr.failedHours ?? 0);
    if (checkFailed && ageHours >= 24)
    {
        return {
            decision: 'label',
            label: 'dependency-blocked',
            close: false,
            downgrade: false,
            restorePrevious: false,
            errors
        };
    }
    if (errors.length > 0)
    {
        return { decision: 'reject', close: false, downgrade: false, restorePrevious: false, errors };
    }
    return { decision: 'merge', close: false, downgrade: false, restorePrevious: false, errors: [] };
}
