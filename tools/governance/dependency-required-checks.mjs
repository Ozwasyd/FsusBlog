import fs from 'node:fs';
import path from 'node:path';

export const catalogRelative = 'config/dependencies/required-checks.json';
export const schemaRelative = 'config/dependencies/required-checks.schema.json';
export const updateSurfaceRelative = 'config/dependencies/update-surface.json';
export const updateTypes = ['major', 'minor', 'patch', 'digest', 'lockFileMaintenance'];
export const requiredClasses = ['build', 'test', 'security', 'production'];
export const nonSuccessConclusions = new Set([
    'skipped',
    'neutral',
    'cancelled',
    'timed_out',
    'stale',
    'action_required',
    'failure',
    'startup_failure'
]);

export function clone(value)
{
    return JSON.parse(JSON.stringify(value));
}

export function readJson(root, relative)
{
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function report(errors, code, detail)
{
    errors.push({ code, detail });
}

export function discoverWorkflowChecks(root)
{
    const directory = path.join(root, '.github/workflows');
    const names = new Set();
    for (const file of fs.readdirSync(directory).filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml')))
    {
        const source = fs.readFileSync(path.join(directory, file), 'utf8');
        const workflowName = /^name:\s*(.+)\s*$/mu.exec(source)?.[1]?.trim();
        if (!workflowName)
        {
            continue;
        }
        const languages = [...source.matchAll(/^\s+-\s+language:\s*([A-Za-z0-9-]+)\s*$/gmu)].map((match) => match[1]);
        for (const match of source.matchAll(/^        name:\s*(.+)\s*$/gmu))
        {
            const jobName = match[1].trim();
            const expanded = jobName.includes('${{ matrix.language }}')
                ? languages.map((language) => jobName.replace('${{ matrix.language }}', language))
                : [jobName];
            for (const name of expanded)
            {
                if (!name.includes('${{'))
                {
                    names.add(`${workflowName} / ${name}`);
                }
            }
        }
    }
    return names;
}

export function resolveCheckSet(catalog, setName)
{
    const names = catalog.checkSets?.[setName];
    return Array.isArray(names) ? names : [];
}

export function resolveGroupChecks(catalog, groupId, updateType)
{
    const group = (catalog.groups ?? []).find((entry) => entry.id === groupId);
    return resolveCheckSet(catalog, group?.checksByUpdateType?.[updateType]);
}

export function checkClasses(catalog, names)
{
    const classes = new Set();
    for (const name of names)
    {
        for (const item of catalog.checks?.[name]?.classes ?? [])
        {
            classes.add(item);
        }
    }
    return classes;
}

export function isLintOnly(catalog, names)
{
    return names.length > 0 && names.every((name) => catalog.checks?.[name]?.lintOnly === true);
}

export function githubContexts(protection)
{
    const contexts = [
        ...(protection?.contexts ?? []),
        ...(protection?.checks ?? []).map((item) => item?.context).filter(Boolean)
    ];
    return [...new Set(contexts)];
}

export function evaluateRequiredChecks(requiredNames, checkRuns)
{
    const errors = [];
    const byName = new Map();
    for (const run of checkRuns ?? [])
    {
        if (run?.name)
        {
            byName.set(run.name, run);
        }
    }
    for (const name of requiredNames)
    {
        const run = byName.get(name);
        if (!run || run.status !== 'completed' || run.conclusion == null)
        {
            report(errors, 'check-missing', name);
            continue;
        }
        if (run.conclusion === 'success')
        {
            continue;
        }
        const code = nonSuccessConclusions.has(run.conclusion)
            ? `check-${run.conclusion.replaceAll('_', '-')}`
            : 'check-unsuccessful';
        report(errors, code, `${name}:${run.conclusion}`);
    }
    return errors;
}
