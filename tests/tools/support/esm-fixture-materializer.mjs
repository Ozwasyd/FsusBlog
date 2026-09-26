import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function isWithin(parent, candidate)
{
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function fixtureError(reason, importer, specifier, resolvedTarget)
{
    const details = [
        `importer=${importer}`,
        `specifier=${specifier}`,
        `resolved=${resolvedTarget}`
    ].join(' ');
    return new Error(`ESM fixture preflight failed: ${reason}; ${details}`);
}

const moduleRequestCache = new Map();
const moduleRequestParser = [
    "import vm from 'node:vm';",
    "let source = '';",
    "for await (const chunk of process.stdin) source += chunk;",
    "const module = new vm.SourceTextModule(source, { identifier: 'fixture-preflight' });",
    'process.stdout.write(JSON.stringify(module.moduleRequests.map(({ specifier }) => specifier)));'
].join('\n');

export function parseStaticRelativeEsmSpecifiers(source, importer = '<source>')
{
    const cached = moduleRequestCache.get(source);
    if (cached)
    {
        return cached;
    }
    const parsed = spawnSync(process.execPath, [
        '--experimental-vm-modules',
        '--input-type=module',
        '--eval',
        moduleRequestParser
    ], {
        input: source,
        encoding: 'utf8',
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
    if (parsed.status !== 0)
    {
        const detail = parsed.stderr.trim() || `parser exited with ${parsed.status}`;
        throw new Error(`ESM fixture parser failed for ${importer}: ${detail}`);
    }
    const specifiers = new Set(JSON.parse(parsed.stdout)
        .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../')));
    const dynamicImportUrlPattern = /import\(\s*new\s+URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url\s*\)\s*\)/gu;
    for (const match of source.matchAll(dynamicImportUrlPattern))
    {
        const specifier = match[1];
        if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.includes('${'))
        {
            specifiers.add(specifier);
        }
    }
    const result = [...specifiers];
    moduleRequestCache.set(source, result);
    return result;
}

function normalizeConfiguration(root, allowedRoots)
{
    const absoluteRoot = path.resolve(root);
    if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory())
    {
        throw new Error(`ESM fixture root does not exist: ${absoluteRoot}`);
    }
    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0)
    {
        throw new Error('ESM fixture materializer requires at least one explicit allowed root');
    }
    const absoluteAllowedRoots = allowedRoots.map((allowedRoot) => path.resolve(absoluteRoot, allowedRoot));
    for (const allowedRoot of absoluteAllowedRoots)
    {
        if (!isWithin(absoluteRoot, allowedRoot))
        {
            throw new Error(`ESM fixture allowed root escapes repository root: ${allowedRoot}`);
        }
    }
    return { absoluteRoot, absoluteAllowedRoots };
}

function assertAllowed(target, allowedRoots, importer, specifier)
{
    if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, target)))
    {
        throw fixtureError('resolved target escapes allowed roots', importer, specifier, target);
    }
}

function resolveLocalDependency(importer, specifier, allowedRoots)
{
    const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
    const target = path.resolve(path.dirname(importer), cleanSpecifier);
    assertAllowed(target, allowedRoots, importer, specifier);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile())
    {
        throw fixtureError('local dependency is missing or not a file', importer, specifier, target);
    }
    const realTarget = fs.realpathSync(target);
    assertAllowed(realTarget, allowedRoots, importer, specifier);
    return target;
}

function discoverClosure(root, entries, allowedRoots)
{
    const pending = entries.map((entry) => path.resolve(root, entry));
    const discovered = new Set();
    while (pending.length > 0)
    {
        const importer = pending.pop();
        assertAllowed(importer, allowedRoots, '<entry>', path.relative(root, importer));
        if (!fs.existsSync(importer) || !fs.statSync(importer).isFile())
        {
            throw fixtureError('entry is missing or not a file', '<entry>', path.relative(root, importer), importer);
        }
        assertAllowed(fs.realpathSync(importer), allowedRoots, '<entry>', path.relative(root, importer));
        if (discovered.has(importer))
        {
            continue;
        }
        discovered.add(importer);
        const source = fs.readFileSync(importer, 'utf8');
        for (const specifier of parseStaticRelativeEsmSpecifiers(source, importer))
        {
            pending.push(resolveLocalDependency(importer, specifier, allowedRoots));
        }
    }
    return [...discovered].sort();
}

function discoverRuntimeAssets(root, assets, allowedRoots)
{
    if (!Array.isArray(assets) || assets.some((asset) => typeof asset !== 'string' || !asset
        || path.isAbsolute(asset) || asset.includes('\\') || asset.split('/').some((part) => !part || part === '.' || part === '..'))
        || new Set(assets).size !== assets.length)
    {
        throw new Error('ESM fixture runtime assets must be unique repository-relative paths');
    }
    return assets.map((asset) =>
    {
        const target = path.resolve(root, asset);
        assertAllowed(target, allowedRoots, '<runtime-asset>', asset);
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stat)
        {
            throw fixtureError('runtime asset is missing', '<runtime-asset>', asset, target);
        }
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target)
        {
            throw fixtureError('runtime asset must be a literal regular file', '<runtime-asset>', asset, target);
        }
        return target;
    });
}

function prepareLiteralDestination(fixtureRoot, destination)
{
    const rootStat = fs.lstatSync(fixtureRoot, { throwIfNoEntry: false });
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink())
    {
        throw new Error(`ESM fixture root must be a literal directory: ${fixtureRoot}`);
    }
    const parent = path.dirname(destination);
    const relativeParent = path.relative(fixtureRoot, parent);
    let current = fixtureRoot;
    for (const part of relativeParent ? relativeParent.split(path.sep) : [])
    {
        current = path.join(current, part);
        if (!fs.existsSync(current))
        {
            fs.mkdirSync(current);
        }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`ESM fixture destination parent must be a literal directory: ${current}`);
        }
    }
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    {
        throw new Error(`ESM fixture destination must be a literal regular file: ${destination}`);
    }
}

export function preflightMaterializedEsmFixture({ fixtureRoot, entries, allowedRoots, assets = [] })
{
    const configuration = normalizeConfiguration(fixtureRoot, allowedRoots);
    return [...new Set([
        ...discoverClosure(configuration.absoluteRoot, entries, configuration.absoluteAllowedRoots),
        ...discoverRuntimeAssets(configuration.absoluteRoot, assets, configuration.absoluteAllowedRoots)
    ])].sort()
        .map((file) => path.relative(configuration.absoluteRoot, file).replaceAll(path.sep, '/'));
}

export function materializeEsmFixture({
    repositoryRoot,
    fixtureRoot,
    entries,
    allowedRoots,
    assets = []
})
{
    if (!Array.isArray(entries) || entries.length === 0)
    {
        throw new Error('ESM fixture materializer requires at least one entry');
    }
    const source = normalizeConfiguration(repositoryRoot, allowedRoots);
    const files = [...new Set([
        ...discoverClosure(source.absoluteRoot, entries, source.absoluteAllowedRoots),
        ...discoverRuntimeAssets(source.absoluteRoot, assets, source.absoluteAllowedRoots)
    ])].sort();
    const absoluteFixtureRoot = path.resolve(fixtureRoot);
    for (const file of files)
    {
        const relative = path.relative(source.absoluteRoot, file);
        const destination = path.resolve(absoluteFixtureRoot, relative);
        if (!isWithin(absoluteFixtureRoot, destination))
        {
            throw new Error(`ESM fixture destination escapes fixture root: ${destination}`);
        }
        prepareLiteralDestination(absoluteFixtureRoot, destination);
        fs.copyFileSync(file, destination);
    }
    const materializedFiles = preflightMaterializedEsmFixture({
        fixtureRoot: absoluteFixtureRoot,
        entries,
        allowedRoots,
        assets
    });
    return { entryFiles: entries.map((entry) => path.join(absoluteFixtureRoot, entry)), files: materializedFiles };
}
