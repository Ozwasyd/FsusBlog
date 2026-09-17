#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '..');
const defaultPolicy = 'tests/governance/repository-source-layout.json';
const rootClassifications = new Set([
    'automation',
    'build-output',
    'canonical-source',
    'configuration',
    'deployment-configuration',
    'documentation',
    'generated-artifacts',
    'release-index',
    'runtime-configuration',
    'security-manifests',
    'source-exception',
    'tool-configuration'
]);
const establishedRootDirectories = new Set([
    '.github',
    'Properties',
    'artifacts',
    'benchmarks',
    'build',
    'config',
    'configs',
    'docs',
    'ops',
    'security',
    'src',
    'tests',
    'tools'
]);

function sha256File(file)
{
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file, label, errors)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        errors.push(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
        return {};
    }
}

function text(value)
{
    return typeof value === 'string' ? value.trim() : '';
}

function object(value)
{
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value)
{
    return Array.isArray(value) ? value : [];
}

function nested(document, field)
{
    return String(field).split('.').reduce((value, key) => object(value)[key], document);
}

function resolveInside(root, relative, errors, label)
{
    const absoluteRoot = path.resolve(root);
    const absolute = path.resolve(absoluteRoot, text(relative));
    const fromRoot = path.relative(absoluteRoot, absolute);
    if (!text(relative) || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
    {
        errors.push(`${label} must stay inside the repository root`);
        return '';
    }
    return absolute;
}

function resolveRegularFileInside(root, relative, errors, label)
{
    const absolute = resolveInside(root, relative, errors, label);
    if (!absolute)
    {
        return '';
    }
    let stat;
    try
    {
        stat = fs.lstatSync(absolute);
    }
    catch (error)
    {
        errors.push(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`);
        return '';
    }
    if (stat.isSymbolicLink())
    {
        errors.push(`${label} must not be a symbolic link`);
        return '';
    }
    if (!stat.isFile())
    {
        errors.push(`${label} must be a regular file`);
        return '';
    }
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(absolute);
    const fromRoot = path.relative(realRoot, realFile);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
    {
        errors.push(`${label} real path must stay inside the repository root`);
        return '';
    }
    return absolute;
}

export function validateRepositoryFileBoundary(root, relative, label = 'repository file')
{
    const errors = [];
    resolveRegularFileInside(root, relative, errors, label);
    return errors;
}

export function validatePolicy(policy)
{
    const errors = [];
    if (policy?.schema !== 'fsusblog.repository-source-layout.v1')
    {
        errors.push('repository source layout schema must be fsusblog.repository-source-layout.v1');
    }
    if (policy?.canonicalSourceRoot !== 'src')
    {
        errors.push('canonicalSourceRoot must be src');
    }

    const declarations = array(policy?.rootDirectories);
    const paths = declarations.map((entry) => text(entry?.path)).filter(Boolean);
    if (paths.length !== declarations.length || new Set(paths).size !== paths.length)
    {
        errors.push('rootDirectories must use unique non-empty paths');
    }
    const canonical = declarations.find((entry) => entry?.path === 'src');
    if (canonical?.classification !== 'canonical-source')
    {
        errors.push('src must be the only canonical-source root');
    }
    if (declarations.filter((entry) => entry?.classification === 'canonical-source').length !== 1)
    {
        errors.push('rootDirectories must declare exactly one canonical-source root');
    }
    for (const entry of declarations)
    {
        const rootPath = text(entry?.path);
        const classification = text(entry?.classification);
        if (rootPath && (rootPath === '.' || rootPath === '..' || rootPath.includes('/') || rootPath.includes('\\')))
        {
            errors.push(`root directory ${rootPath} must be one top-level path segment`);
        }
        if (!rootClassifications.has(classification))
        {
            errors.push(`root directory ${rootPath || '<missing>'} uses unsupported classification ${classification || '<missing>'}`);
        }
        const requiresException = classification === 'source-exception'
      || (rootPath && !establishedRootDirectories.has(rootPath));
        if (requiresException && !text(entry.architecturalException))
        {
            errors.push(`root directory ${rootPath || '<missing>'} requires architecturalException`);
        }
    }

    const csharpEntrypoint = object(policy?.languageOwnership?.csharpEntrypoint);
    if (csharpEntrypoint.policy !== 'tests/governance/csharp-entrypoint-ownership.json')
    {
        errors.push('C# entrypoint ownership policy must be tests/governance/csharp-entrypoint-ownership.json');
    }
    if (csharpEntrypoint.checker !== 'tools/check-csharp-entrypoint-ownership.mjs')
    {
        errors.push('C# entrypoint ownership checker must be tools/check-csharp-entrypoint-ownership.mjs');
    }

    const zk = object(policy?.zk);
    const boundaryPaths = [
        zk.circuitSourceRoot,
        zk.generatedArtifactsRoot,
        zk.securityManifestsRoot,
        zk.runtimeConfigurationRoot,
        zk.testFixturesRoot
    ].map(text);
    if (new Set(boundaryPaths).size !== 5 || boundaryPaths.some((value) => !value))
    {
        errors.push('ZK source, artifact, security, configuration and fixture roots must be five distinct paths');
    }
    if (zk.circuitSourceRoot !== 'src/zk/circuits')
    {
        errors.push('ZK circuit source root must be src/zk/circuits');
    }

    const sources = array(zk.circuitSources);
    const sourceIds = sources.map((entry) => text(entry?.id));
    const expectedSourceIds = ['anonymous-comment-v5'];
    if (
        sources.length !== expectedSourceIds.length ||
    new Set(sourceIds).size !== sources.length ||
    expectedSourceIds.some((id) => !sourceIds.includes(id))
    )
    {
        errors.push('ZK circuitSources must declare only the active v5 source identity');
    }
    for (const source of sources)
    {
        if (!text(source.path).startsWith(`${zk.circuitSourceRoot}/`))
        {
            errors.push(`circuit source ${source.id || '<missing>'} must stay under ${zk.circuitSourceRoot}`);
        }
        if (!/^[a-f0-9]{64}$/u.test(text(source.sha256)))
        {
            errors.push(`circuit source ${source.id || '<missing>'} requires a lowercase SHA-256 digest`);
        }
    }
    const bindings = array(zk.jsonSourceBindings);
    const expectedBindingPaths = ['security/zk/contracts/comment-v5-circuit.manifest.json'];
    const bindingPaths = bindings.map((entry) => text(entry?.path));
    if (
        bindings.length !== expectedBindingPaths.length ||
    new Set(bindingPaths).size !== bindings.length ||
    expectedBindingPaths.some((bindingPath) => !bindingPaths.includes(bindingPath))
    )
    {
        errors.push('ZK jsonSourceBindings must cover only the active v5 circuit manifest');
    }
    for (const binding of bindings)
    {
        if (!sourceIds.includes(text(binding?.sourceId)))
        {
            errors.push(`source binding ${binding?.path || '<missing>'} references an unknown sourceId`);
        }
        if (!text(binding?.pathField) || !text(binding?.hashField))
        {
            errors.push(`source binding ${binding?.path || '<missing>'} requires pathField and hashField`);
        }
    }
    return errors;
}

export function validateRootDirectoryInventory(policy, rootDirectories)
{
    const allowed = new Set(array(policy?.rootDirectories).map((entry) => text(entry?.path)).filter(Boolean));
    return [...new Set(rootDirectories.map(text).filter(Boolean))]
        .filter((directory) => !allowed.has(directory))
        .sort()
        .map((directory) => `undeclared top-level directory ${directory}; handwritten source belongs under src or requires an architectural exception`);
}

function trackedFiles(root, errors)
{
    const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'buffer'
    });
    if (result.status !== 0)
    {
        errors.push(`cannot enumerate repository files: ${String(result.stderr ?? result.stdout ?? '').trim()}`);
        return [];
    }
    return result.stdout.toString('utf8').split('\0').filter(Boolean).map((file) => file.replaceAll(path.sep, '/'));
}

function validateLegacyReferences(root, files, errors)
{
    const legacyPrefix = ['circuits', 'anonymous-comment-v'].join('/');
    const legacy = new RegExp(`(?<!src/zk/)${legacyPrefix}[25](?:/|\\b)`, 'u');
    for (const file of files)
    {
        const absolute = path.join(root, file);
        let stat;
        try
        {
            stat = fs.statSync(absolute);
        }
        catch
        {
            continue;
        }
        if (!stat.isFile() || stat.size > 1024 * 1024)
        {
            continue;
        }
        const bytes = fs.readFileSync(absolute);
        if (bytes.includes(0))
        {
            continue;
        }
        if (legacy.test(bytes.toString('utf8')))
        {
            errors.push(`legacy top-level circuit source reference remains in ${file}`);
        }
    }
}

export function checkRepositorySourceLayout({ root = defaultRoot, policyFile = defaultPolicy } = {})
{
    const errors = [];
    const absoluteRoot = path.resolve(root);
    const absolutePolicy = path.isAbsolute(policyFile) ? policyFile : path.join(absoluteRoot, policyFile);
    const policy = readJson(absolutePolicy, 'repository source layout policy', errors);
    errors.push(...validatePolicy(policy));

    const files = trackedFiles(absoluteRoot, errors);
    const rootDirectories = files.filter((file) => file.includes('/')).map((file) => file.split('/')[0]);
    errors.push(...validateRootDirectoryInventory(policy, rootDirectories));

    for (const forbidden of array(policy?.forbiddenRootSourceDirectories).map(text))
    {
        if (rootDirectories.includes(forbidden) || fs.existsSync(path.join(absoluteRoot, forbidden)))
        {
            errors.push(`forbidden top-level source directory remains: ${forbidden}`);
        }
    }

    const csharpEntrypoint = object(policy?.languageOwnership?.csharpEntrypoint);
    let languageOwnershipBindingCount = 0;
    for (const [field, label] of [
        ['policy', 'C# entrypoint ownership policy'],
        ['checker', 'C# entrypoint ownership checker']
    ])
    {
        if (resolveRegularFileInside(absoluteRoot, csharpEntrypoint[field], errors, label))
        {
            languageOwnershipBindingCount += 1;
        }
    }

    const zk = object(policy?.zk);
    const sourceById = new Map();
    for (const declaration of array(zk.circuitSources))
    {
        const file = resolveRegularFileInside(absoluteRoot, declaration.path, errors, `circuit source ${declaration.id || '<missing>'}`);
        if (!file)
        {
            continue;
        }
        const actualHash = sha256File(file);
        if (actualHash !== declaration.sha256)
        {
            errors.push(`circuit source ${declaration.id} semantic hash changed`);
        }
        sourceById.set(declaration.id, declaration);
    }

    for (const binding of array(zk.jsonSourceBindings))
    {
        const file = resolveRegularFileInside(absoluteRoot, binding.path, errors, `source binding ${binding.path || '<missing>'}`);
        if (!file)
        {
            continue;
        }
        const document = readJson(file, `source binding ${binding.path}`, errors);
        const source = sourceById.get(binding.sourceId);
        if (!source)
        {
            continue;
        }
        if (nested(document, binding.pathField) !== source.path)
        {
            errors.push(`${binding.path} ${binding.pathField} must equal ${source.path}`);
        }
        if (nested(document, binding.hashField) !== source.sha256)
        {
            errors.push(`${binding.path} ${binding.hashField} must equal the canonical source hash`);
        }
    }

    validateLegacyReferences(absoluteRoot, files, errors);
    return {
        ok: errors.length === 0,
        errors,
        rootDirectoryCount: new Set(rootDirectories).size,
        languageOwnershipBindingCount,
        circuitSourceCount: sourceById.size,
        bindingCount: array(zk.jsonSourceBindings).length
    };
}

function parseArgs(args)
{
    const options = { root: defaultRoot, policyFile: defaultPolicy };
    for (let index = 0; index < args.length; index += 1)
    {
        const argument = args[index];
        if (argument === '--root')
        {
            options.root = args[++index];
        }
        else if (argument.startsWith('--root='))
        {
            options.root = argument.slice('--root='.length);
        }
        else if (argument === '--policy')
        {
            options.policyFile = args[++index];
        }
        else if (argument.startsWith('--policy='))
        {
            options.policyFile = argument.slice('--policy='.length);
        }
        else
        {
            throw new Error(`unknown option ${argument}`);
        }
    }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile)
{
    try
    {
        const result = checkRepositorySourceLayout(parseArgs(process.argv.slice(2)));
        if (!result.ok)
        {
            for (const error of result.errors)
            {
                console.error(`[repository-source-layout] ${error}`);
            }
            process.exit(1);
        }
        console.log(`[repository-source-layout] ok roots=${result.rootDirectoryCount} ownership-bindings=${result.languageOwnershipBindingCount} circuits=${result.circuitSourceCount} bindings=${result.bindingCount}`);
    }
    catch (error)
    {
        console.error(`[repository-source-layout] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
