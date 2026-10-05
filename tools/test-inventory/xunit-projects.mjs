/**
 * Project ownership for the existing Roslyn xUnit adapter. Independent test
 * assemblies keep their own compile context; source paths do not move cases
 * into the Server assembly or constitute runtime execution evidence.
 */
import { xunitTestProjects } from './adapters.mjs';

export const xunitProjects = Object.freeze(xunitTestProjects.map(({ directory, project }) =>
    Object.freeze({ project, sourceDirectory: directory })));


export function xunitProjectForSource(file)
{
    return xunitProjects.find((owner) => file.startsWith(`${owner.sourceDirectory}/`));
}

export function isXunitProjectSource(file)
{
    return xunitProjectForSource(file) !== undefined;
}

export function groupXunitSources(sourceFiles, projects = xunitProjects)
{
    const paths = new Set();
    const directories = new Set();
    for (const owner of projects)
    {
        if (!/^tests\/[a-z][a-z0-9-]*$/u.test(owner.sourceDirectory ?? '')
            || !owner.project?.startsWith(`${owner.sourceDirectory}/`)
            || !/^[A-Za-z0-9.]+\.csproj$/u.test(owner.project.slice(owner.sourceDirectory.length + 1))
            || paths.has(owner.project)
            || directories.has(owner.sourceDirectory))
        {
            throw new Error('xunit project ownership must use unique repository test projects');
        }
        paths.add(owner.project);
        directories.add(owner.sourceDirectory);
    }
    const groups = projects.map((owner) => ({ ...owner, sourceFiles: [] }));
    const sources = new Set();
    for (const source of sourceFiles.filter((file) => file.adapter === 'xunit'))
    {
        if (typeof source.path !== 'string'
            || source.path.includes('\\')
            || source.path.split('/').some((part) => part === '' || part === '.' || part === '..')
            || sources.has(source.path))
        {
            throw new Error('xunit source paths must be unique normalized repository paths');
        }
        sources.add(source.path);
        const owners = groups.filter((owner) => source.path.startsWith(`${owner.sourceDirectory}/`));
        if (owners.length !== 1)
        {
            throw new Error(`xunit source requires exactly one project owner: ${source.path}`);
        }
        owners[0].sourceFiles.push(source);
    }
    return groups;
}

export function validateXunitProjectReport(owner, report)
{
    if (report?.schema !== 'fsusblog.test-inventory.xunit-roslyn.v1'
        || report.adapter !== 'xunit'
        || report.adapterVersion !== 'xunit.v2'
        || !Array.isArray(report.testCases)
        || !Array.isArray(report.diagnostics))
    {
        throw new Error(`xunit adapter report header is invalid for ${owner.project}`);
    }
    if (report.diagnostics.length > 0)
    {
        throw new Error(`xunit extraction diagnostics for ${owner.project}: ${JSON.stringify(report.diagnostics)}`);
    }
    if (report.testCases.length === 0)
    {
        throw new Error(`xunit adapter returned no cases for ${owner.project}`);
    }
    const ownedFiles = new Set(owner.sourceFiles.map((file) => file.path));
    const ids = new Set();
    for (const testCase of report.testCases)
    {
        if (testCase?.adapter !== 'xunit'
            || !ownedFiles.has(testCase.ownerFile)
            || typeof testCase.id !== 'string'
            || !testCase.id.startsWith(`xunit:${testCase.ownerFile}#`)
            || testCase.id.endsWith('#'))
        {
            throw new Error(`xunit adapter returned a case outside ${owner.project} ownership`);
        }
        if (ids.has(testCase.id))
        {
            throw new Error(`xunit adapter returned duplicate case ${testCase.id}`);
        }
        ids.add(testCase.id);
    }
    return report;
}
