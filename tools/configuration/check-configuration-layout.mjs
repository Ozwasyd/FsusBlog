#!/usr/bin/env node
import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = 'config/configuration-ownership.json';
const REQUIRED_GENERIC_ROOT = 'config';
const REQUIRED_FRAMEWORK_ROOTS = ['.config'];
const ROOT_JSON_ALLOWLIST = ['global.json'];
const FORBIDDEN_GENERIC_ROOTS = ['configs'];
const PROJECT_EXTENSIONS = new Set(['.csproj', '.dcproj', '.esproj', '.fsproj', '.vbproj']);
const WALK_IGNORES = new Set(['.git', '.tmp', 'bin', 'node_modules', 'obj']);

function repoPath(value)
{
    return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeDeclaredPath(value, label, errors)
{
    if (typeof value !== 'string' || value.trim() === '')
    {
        errors.push(`${label} must be a non-empty repository-relative path`);
        return null;
    }
    const normalized = path.posix.normalize(repoPath(value.trim()));
    if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        errors.push(`${label} escapes the repository root: ${value}`);
        return null;
    }
    return normalized;
}

function walkFiles(root, relativeDirectory = '', results = [])
{
    const directory = path.join(root, relativeDirectory);
    if (!existsSync(directory))
    {
        return results;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true }))
    {
        if (entry.isDirectory() && WALK_IGNORES.has(entry.name))
        {
            continue;
        }
        const relativePath = repoPath(path.join(relativeDirectory, entry.name));
        if (entry.isDirectory())
        {
            walkFiles(root, relativePath, results);
        }
        else if (entry.isFile())
        {
            results.push(relativePath);
        }
    }
    return results;
}

function readJson(root, relativePath, errors, label = relativePath)
{
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath))
    {
        errors.push(`missing ${label}: ${relativePath}`);
        return null;
    }
    try
    {
        return JSON.parse(readFileSync(absolutePath, 'utf8'));
    }
    catch (error)
    {
        errors.push(`${label} is not valid JSON: ${error.message}`);
        return null;
    }
}

function projectFilesAt(root, relativeDirectory)
{
    const absoluteDirectory = path.join(root, relativeDirectory);
    if (!existsSync(absoluteDirectory))
    {
        return [];
    }
    return readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && PROJECT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => repoPath(path.join(relativeDirectory, entry.name)));
}

function matchesOwnership(file, entry)
{
    if (entry.pathType === 'file')
    {
        return file === entry.canonicalPath;
    }
    return entry.recursive === true && file.startsWith(`${entry.canonicalPath}/`);
}

function checkRootLayout(root, manifest, errors)
{
    if (manifest.genericRoot !== REQUIRED_GENERIC_ROOT)
    {
        errors.push(`configuration ownership genericRoot must be ${REQUIRED_GENERIC_ROOT}`);
    }
    if (JSON.stringify(manifest.frameworkRoots) !== JSON.stringify(REQUIRED_FRAMEWORK_ROOTS))
    {
        errors.push(`configuration ownership frameworkRoots must be ${JSON.stringify(REQUIRED_FRAMEWORK_ROOTS)}`);
    }
    if (JSON.stringify(manifest.rootJsonAllowlist) !== JSON.stringify(ROOT_JSON_ALLOWLIST))
    {
        errors.push(`configuration ownership rootJsonAllowlist must be ${JSON.stringify(ROOT_JSON_ALLOWLIST)}`);
    }

    for (const forbiddenRoot of FORBIDDEN_GENERIC_ROOTS)
    {
        if (existsSync(path.join(root, forbiddenRoot)))
        {
            errors.push(`forbidden competing configuration root exists: ${forbiddenRoot}/`);
        }
    }

    const ownedRootJson = (manifest.ownership ?? [])
        .filter((entry) => entry.pathType === 'file' && !entry.canonicalPath.includes('/') && entry.canonicalPath.endsWith('.json'))
        .map((entry) => entry.canonicalPath);
    const allowedRootJson = new Set([...ROOT_JSON_ALLOWLIST, ...ownedRootJson]);
    for (const entry of readdirSync(root, { withFileTypes: true }))
    {
        if (entry.isFile() && entry.name.endsWith('.json') && !allowedRootJson.has(entry.name))
        {
            errors.push(`unapproved repository-root configuration JSON: ${entry.name}`);
        }
    }

    const rootProperties = path.join(root, 'Properties');
    if (existsSync(rootProperties) && statSync(rootProperties).isDirectory() && projectFilesAt(root, '').length === 0)
    {
        errors.push('repository-root Properties/ has no owning root project');
    }
}

function checkOwnership(root, manifest, errors)
{
    if (!Array.isArray(manifest.ownership) || manifest.ownership.length === 0)
    {
        errors.push('configuration ownership registry must declare ownership entries');
        return;
    }

    const entries = [];
    const ids = new Set();
    const canonicalPaths = new Set();
    for (const [index, rawEntry] of manifest.ownership.entries())
    {
        const label = `ownership[${index}]`;
        if (typeof rawEntry?.id !== 'string' || rawEntry.id.trim() === '')
        {
            errors.push(`${label}.id must be non-empty`);
            continue;
        }
        if (ids.has(rawEntry.id))
        {
            errors.push(`duplicate configuration ownership id: ${rawEntry.id}`);
        }
        ids.add(rawEntry.id);
        if (typeof rawEntry.owner !== 'string' || rawEntry.owner.trim() === '')
        {
            errors.push(`${label}.owner must be non-empty`);
        }
        else if (PROJECT_EXTENSIONS.has(path.extname(rawEntry.owner).toLowerCase()))
        {
            const ownerPath = normalizeDeclaredPath(rawEntry.owner, `${label}.owner`, errors);
            if (ownerPath && !existsSync(path.join(root, ownerPath)))
            {
                errors.push(`${label}.owner project does not exist: ${ownerPath}`);
            }
        }
        if (!['file', 'directory'].includes(rawEntry.pathType))
        {
            errors.push(`${label}.pathType must be file or directory`);
            continue;
        }
        if (rawEntry.pathType === 'directory' && rawEntry.recursive !== true)
        {
            errors.push(`${label} directory ownership must be recursive`);
        }
        const canonicalPath = normalizeDeclaredPath(rawEntry.canonicalPath, `${label}.canonicalPath`, errors);
        if (!canonicalPath)
        {
            continue;
        }
        if (canonicalPaths.has(canonicalPath))
        {
            errors.push(`duplicate canonical configuration path: ${canonicalPath}`);
        }
        canonicalPaths.add(canonicalPath);

        const absolutePath = path.join(root, canonicalPath);
        if (!existsSync(absolutePath))
        {
            errors.push(`missing canonical configuration path: ${canonicalPath}`);
        }
        else
        {
            const stats = statSync(absolutePath);
            if (rawEntry.pathType === 'file' && !stats.isFile())
            {
                errors.push(`canonical configuration path must be a file: ${canonicalPath}`);
            }
            if (rawEntry.pathType === 'directory' && !stats.isDirectory())
            {
                errors.push(`canonical configuration path must be a directory: ${canonicalPath}`);
            }
            else if (rawEntry.pathType === 'directory' && walkFiles(root, canonicalPath).length === 0)
            {
                errors.push(`canonical configuration directory must not be empty: ${canonicalPath}`);
            }
        }

        for (const [rejectedIndex, rejectedValue] of (rawEntry.rejectedPaths ?? []).entries())
        {
            const rejectedPath = normalizeDeclaredPath(rejectedValue, `${label}.rejectedPaths[${rejectedIndex}]`, errors);
            if (rejectedPath && existsSync(path.join(root, rejectedPath)))
            {
                errors.push(`non-canonical configuration path still exists: ${rejectedPath}`);
            }
        }

        if (Array.isArray(rawEntry.consumers))
        {
            for (const [consumerIndex, consumerValue] of rawEntry.consumers.entries())
            {
                const consumerPath = normalizeDeclaredPath(consumerValue, `${label}.consumers[${consumerIndex}]`, errors);
                if (consumerPath && !existsSync(path.join(root, consumerPath)))
                {
                    errors.push(`${label}.consumers path does not exist: ${consumerPath}`);
                }
            }
        }

        if (rawEntry.id === 'runtime-scenario-catalog')
        {
            if (typeof rawEntry.purpose !== 'string' || rawEntry.purpose.trim() === '')
            {
                errors.push(`${label}.purpose must be non-empty string`);
            }
            if (!Array.isArray(rawEntry.consumers) || rawEntry.consumers.length === 0)
            {
                errors.push(`${label}.consumers must be a non-empty array`);
            }
            if (typeof rawEntry.validationCommand !== 'string' || rawEntry.validationCommand.trim() === '')
            {
                errors.push(`${label}.validationCommand must be non-empty string`);
            }
            if (typeof rawEntry.changePolicy !== 'string' || rawEntry.changePolicy.trim() === '')
            {
                errors.push(`${label}.changePolicy must be non-empty string`);
            }
            if (typeof rawEntry.status !== 'string' || rawEntry.status.trim() === '')
            {
                errors.push(`${label}.status must be non-empty string`);
            }
        }

        entries.push({ ...rawEntry, canonicalPath });
    }

    for (const configurationRoot of [REQUIRED_GENERIC_ROOT, ...REQUIRED_FRAMEWORK_ROOTS])
    {
        for (const file of walkFiles(root, configurationRoot))
        {
            const owners = entries.filter((entry) => matchesOwnership(file, entry));
            if (owners.length !== 1)
            {
                errors.push(`configuration file must have exactly one canonical owner: ${file} (found ${owners.length})`);
            }
        }
    }

    const repositoryFiles = walkFiles(root);
    for (const entry of entries.filter((candidate) => candidate.exclusiveBasename === true))
    {
        const basename = path.posix.basename(entry.canonicalPath);
        const matches = repositoryFiles.filter((file) => path.posix.basename(file) === basename);
        if (matches.length !== 1 || matches[0] !== entry.canonicalPath)
        {
            errors.push(`exclusive canonical configuration ${basename} must exist only at ${entry.canonicalPath}; found ${matches.join(', ') || 'none'}`);
        }
    }
}

function checkLaunchProfileOwnership(root, errors)
{
    const launchProfiles = walkFiles(root).filter((file) => file.endsWith('/Properties/launchSettings.json') || file === 'Properties/launchSettings.json');
    for (const launchProfile of launchProfiles)
    {
        const projectDirectory = repoPath(path.posix.dirname(path.posix.dirname(launchProfile)));
        const projects = projectFilesAt(root, projectDirectory === '.' ? '' : projectDirectory);
        if (projects.length === 0)
        {
            errors.push(`launch profile is not colocated with an owning project: ${launchProfile}`);
        }
    }
}

function checkSolutionLaunch(root, errors)
{
    const solutionPath = path.join(root, 'FsusBlog.slnx');
    if (!existsSync(solutionPath))
    {
        errors.push('missing solution project registry: FsusBlog.slnx');
        return;
    }
    const solution = readFileSync(solutionPath, 'utf8');
    const solutionProjects = new Set();
    for (const match of solution.matchAll(/<Project\s+Path="([^"]+)"/g))
    {
        const projectPath = repoPath(match[1]);
        solutionProjects.add(projectPath);
        if (!existsSync(path.join(root, projectPath)))
        {
            errors.push(`FsusBlog.slnx project path does not exist: ${projectPath}`);
        }
    }
    if (solutionProjects.size === 0)
    {
        errors.push('FsusBlog.slnx does not declare any projects');
    }

    const launch = readJson(root, 'FsusBlog.slnLaunch', errors, 'solution launch configuration');
    if (!Array.isArray(launch))
    {
        return;
    }
    for (const [profileIndex, profile] of launch.entries())
    {
        if (!Array.isArray(profile?.Projects))
        {
            errors.push(`FsusBlog.slnLaunch[${profileIndex}].Projects must be an array`);
            continue;
        }
        for (const [projectIndex, project] of profile.Projects.entries())
        {
            const label = `FsusBlog.slnLaunch[${profileIndex}].Projects[${projectIndex}].Path`;
            const projectPath = normalizeDeclaredPath(project?.Path, label, errors);
            if (!projectPath)
            {
                continue;
            }
            if (!solutionProjects.has(projectPath))
            {
                errors.push(`${label} is not a project declared by FsusBlog.slnx: ${projectPath}`);
            }
            if (!existsSync(path.join(root, projectPath)))
            {
                errors.push(`${label} does not exist: ${projectPath}`);
            }
        }
    }
}

function checkDockerComposeProjects(root, errors)
{
    const composeProjects = walkFiles(root).filter((file) => file.endsWith('.dcproj'));
    for (const projectPath of composeProjects)
    {
        const source = readFileSync(path.join(root, projectPath), 'utf8');
        const projectDirectory = path.posix.dirname(projectPath);
        for (const match of source.matchAll(/<(?:None|Content)\s+Include="([^"]+)"/g))
        {
            const include = match[1];
            if (/\$\(|[*?]/.test(include))
            {
                errors.push(`${projectPath} contains a non-literal Include path that cannot be ownership-checked: ${include}`);
                continue;
            }
            const includedPath = normalizeDeclaredPath(path.posix.join(projectDirectory, repoPath(include)), `${projectPath} Include`, errors);
            if (includedPath && !existsSync(path.join(root, includedPath)))
            {
                errors.push(`${projectPath} includes a missing file: ${includedPath}`);
            }
        }
    }
}

export function checkConfigurationLayout(repositoryRoot)
{
    const root = path.resolve(repositoryRoot);
    const errors = [];
    const manifest = readJson(root, MANIFEST_PATH, errors, 'configuration ownership registry');
    if (!manifest)
    {
        return errors;
    }
    if (manifest.schema !== 'fsusblog.configuration-ownership.v1')
    {
        errors.push(`configuration ownership schema must be fsusblog.configuration-ownership.v1, got ${manifest.schema ?? 'missing'}`);
    }

    checkRootLayout(root, manifest, errors);
    checkOwnership(root, manifest, errors);
    checkLaunchProfileOwnership(root, errors);
    checkSolutionLaunch(root, errors);
    checkDockerComposeProjects(root, errors);
    return errors;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url))
{
    const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
    const errors = checkConfigurationLayout(root);
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[configuration-layout] ${error}`);
        }
        process.exit(1);
    }
    console.log('[configuration-layout] ok');
}
