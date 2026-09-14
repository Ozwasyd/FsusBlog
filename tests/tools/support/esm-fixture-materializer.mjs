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
    const specifiers = [...new Set(JSON.parse(parsed.stdout)
        .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../')))];
    moduleRequestCache.set(source, specifiers);
    return specifiers;
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

export function preflightMaterializedEsmFixture({ fixtureRoot, entries, allowedRoots })
{
    const configuration = normalizeConfiguration(fixtureRoot, allowedRoots);
    return discoverClosure(configuration.absoluteRoot, entries, configuration.absoluteAllowedRoots)
        .map((file) => path.relative(configuration.absoluteRoot, file).replaceAll(path.sep, '/'));
}

export function materializeEsmFixture({
    repositoryRoot,
    fixtureRoot,
    entries,
    allowedRoots
})
{
    if (!Array.isArray(entries) || entries.length === 0)
    {
        throw new Error('ESM fixture materializer requires at least one entry');
    }
    const source = normalizeConfiguration(repositoryRoot, allowedRoots);
    const files = discoverClosure(source.absoluteRoot, entries, source.absoluteAllowedRoots);
    const absoluteFixtureRoot = path.resolve(fixtureRoot);
    for (const file of files)
    {
        const relative = path.relative(source.absoluteRoot, file);
        const destination = path.resolve(absoluteFixtureRoot, relative);
        if (!isWithin(absoluteFixtureRoot, destination))
        {
            throw new Error(`ESM fixture destination escapes fixture root: ${destination}`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file, destination);
    }
    const materializedFiles = preflightMaterializedEsmFixture({
        fixtureRoot: absoluteFixtureRoot,
        entries,
        allowedRoots
    });
    return { entryFiles: entries.map((entry) => path.join(absoluteFixtureRoot, entry)), files: materializedFiles };
}
