#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const projectRoots = ['src/', 'tests/', 'benchmarks/', 'tools/'];
const packageReferencePattern = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference\s*>)/giu;
const packageVersionPattern = /<PackageVersion\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageVersion\s*>)/giu;

function attribute(attributes, name)
{
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'iu').exec(attributes);
    return match?.[1]?.trim() ?? null;
}

function nestedValue(body, name)
{
    const match = new RegExp(`<${name}\\b[^>]*>([^<]+)<\\/${name}\\s*>`, 'iu').exec(body ?? '');
    return match?.[1]?.trim() ?? null;
}

function packageItems(xml, pattern)
{
    return [...xml.matchAll(pattern)].map((match) => ({
        id: attribute(match[1], 'Include') ?? attribute(match[1], 'Update'),
        version: attribute(match[1], 'Version') ?? nestedValue(match[2], 'Version'),
        versionOverride: attribute(match[1], 'VersionOverride') ?? nestedValue(match[2], 'VersionOverride')
    }));
}

function exactStableVersion(version)
{
    return /^\d+(?:\.\d+){1,3}(?:\+[0-9A-Za-z.]+)?$/u.test(version);
}

function normalizedLockPackages(lock)
{
    const entries = [];
    for (const [framework, dependencies] of Object.entries(lock.dependencies ?? {}))
    {
        for (const [id, metadata] of Object.entries(dependencies ?? {}))
        {
            entries.push(`${framework}\u0000${id.toLowerCase()}\u0000${metadata.resolved ?? ''}`);
        }
    }
    return entries.sort();
}

function auditSnapshot({ centralXml, projects })
{
    const errors = [];
    if (!/<ManagePackageVersionsCentrally>\s*true\s*<\/ManagePackageVersionsCentrally>/iu.test(centralXml))
    {
        errors.push({ code: 'central-management-disabled', path: 'Directory.Packages.props' });
    }

    const centralById = new Map();
    for (const item of packageItems(centralXml, packageVersionPattern))
    {
        if (!item.id)
        {
            errors.push({ code: 'central-package-id-missing', path: 'Directory.Packages.props' });
            continue;
        }
        const key = item.id.toLowerCase();
        if (centralById.has(key))
        {
            errors.push({ code: 'central-package-duplicate', package: item.id, path: 'Directory.Packages.props' });
            continue;
        }
        centralById.set(key, item);
        if (!item.version || !exactStableVersion(item.version))
        {
            errors.push({
                code: 'central-version-not-exact-stable',
                package: item.id,
                path: 'Directory.Packages.props',
                version: item.version
            });
        }
    }

    const referenced = new Set();
    for (const project of projects)
    {
        const references = packageItems(project.xml, packageReferencePattern);
        for (const reference of references)
        {
            if (!reference.id)
            {
                errors.push({ code: 'project-package-id-missing', path: project.path });
                continue;
            }
            const key = reference.id.toLowerCase();
            referenced.add(key);
            if (reference.version)
            {
                errors.push({ code: 'project-package-version', package: reference.id, path: project.path });
            }
            if (reference.versionOverride)
            {
                errors.push({ code: 'project-version-override', package: reference.id, path: project.path });
            }
            if (!centralById.has(key))
            {
                errors.push({ code: 'project-package-uncentralized', package: reference.id, path: project.path });
            }
        }

        if (project.lock === null)
        {
            errors.push({ code: 'project-lock-missing', path: project.lockPath });
            continue;
        }
        for (const dependencies of Object.values(project.lock.dependencies ?? {}))
        {
            for (const [id, metadata] of Object.entries(dependencies ?? {}))
            {
                if (metadata.type !== 'Direct')
                {
                    continue;
                }
                const central = centralById.get(id.toLowerCase());
                if (central?.version && metadata.resolved !== central.version)
                {
                    errors.push({
                        code: 'lock-direct-version-drift',
                        package: id,
                        path: project.lockPath,
                        expected: central.version,
                        resolved: metadata.resolved
                    });
                }
            }
        }
    }

    for (const [key, item] of centralById)
    {
        if (!referenced.has(key))
        {
            errors.push({ code: 'central-package-unreferenced', package: item.id, path: 'Directory.Packages.props' });
        }
    }
    return errors;
}

function trackedProjects(root)
{
    const output = execFileSync('git', ['-C', root, 'ls-files', '*.csproj'], { encoding: 'utf8' });
    return output.split(/\r?\n/u)
        .filter((value) => projectRoots.some((prefix) => value.startsWith(prefix)))
        .sort();
}

function readRepositorySnapshot(root)
{
    const centralPath = path.join(root, 'Directory.Packages.props');
    const centralXml = fs.existsSync(centralPath) ? fs.readFileSync(centralPath, 'utf8') : '';
    const projects = trackedProjects(root).map((relativePath) =>
    {
        const projectPath = path.join(root, relativePath);
        const lockPath = path.join(path.dirname(projectPath), 'packages.lock.json');
        return {
            path: relativePath,
            xml: fs.readFileSync(projectPath, 'utf8'),
            lockPath: path.relative(root, lockPath).split(path.sep).join('/'),
            lock: fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null
        };
    });
    return { centralXml, projects };
}

function compareLocks(root, projects, reference)
{
    const errors = [];
    let compared = 0;
    let added = 0;
    for (const project of projects)
    {
        let baseline;
        try
        {
            baseline = JSON.parse(execFileSync(
                'git',
                ['-C', root, 'show', `${reference}:${project.lockPath}`],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
            ));
        }
        catch
        {
            added += 1;
            continue;
        }
        compared += 1;
        const before = normalizedLockPackages(baseline);
        const after = normalizedLockPackages(project.lock ?? {});
        if (JSON.stringify(before) !== JSON.stringify(after))
        {
            errors.push({ code: 'lock-resolved-set-drift', path: project.lockPath, reference });
        }
    }
    return { errors, compared, added };
}

function runFixtures(fixtureFile)
{
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    if (fixture.schema !== 'fsusblog.central-package-management-fixtures.v1')
    {
        throw new Error(`unsupported fixture schema: ${fixture.schema ?? '<missing>'}`);
    }
    const failures = [];
    for (const fixtureCase of fixture.cases ?? [])
    {
        const actual = auditSnapshot(fixtureCase.snapshot).map((error) => error.code).sort();
        const expected = [...fixtureCase.expectedCodes].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
        {
            failures.push({ id: fixtureCase.id, expected, actual });
        }
    }
    if (failures.length > 0)
    {
        console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
        return 1;
    }
    console.log(`central-package-management fixtures ok: ${fixture.cases.length} cases`);
    return 0;
}

function parseArguments(argv)
{
    const options = { root: defaultRoot, compareRef: null, fixtures: null };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--root')
        {
            options.root = path.resolve(argv[++index]);
        }
        else if (argument === '--compare-ref')
        {
            options.compareRef = argv[++index];
        }
        else if (argument === '--fixtures')
        {
            options.fixtures = path.resolve(argv[++index]);
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.fixtures)
{
    process.exitCode = runFixtures(options.fixtures);
}
else
{
    const snapshot = readRepositorySnapshot(options.root);
    const errors = auditSnapshot(snapshot);
    let comparison = null;
    if (options.compareRef)
    {
        comparison = compareLocks(options.root, snapshot.projects, options.compareRef);
        errors.push(...comparison.errors);
    }
    if (errors.length > 0)
    {
        console.error(JSON.stringify({ status: 'failed', errors }, null, 2));
        process.exitCode = 1;
    }
    else
    {
        const centralCount = packageItems(snapshot.centralXml, packageVersionPattern).length;
        console.log(JSON.stringify({
            status: 'ok',
            projects: snapshot.projects.length,
            centralPackages: centralCount,
            ...(comparison ? { lockComparison: comparison } : {})
        }));
    }
}
