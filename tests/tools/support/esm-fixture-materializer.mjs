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
const moduleRequestBatchSize = 16;
const moduleRequestOutputLimit = 1024 * 1024;
const moduleRequestParser = [
    "import Module from 'node:module';",
    "import vm from 'node:vm';",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    'const sources = JSON.parse(input);',
    `if (!Array.isArray(sources) || sources.length < 1 || sources.length > ${moduleRequestBatchSize}`,
    "  || sources.some(source => typeof source !== 'string')) throw new Error('invalid parser batch');",
    // Parse imports, never evaluate fixture source or infer dependencies from comments/string contents.
    "const parser = new Module('fixture-preflight-acorn');",
    "parser._compile(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], 'fixture-preflight-acorn');",
    'const literal = node => {',
    "  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;",
    "  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;",
    '  return null;',
    '};',
    'const results = [];',
    'for (const [index, source] of sources.entries()) {',
    '  try {',
    "    const module = new vm.SourceTextModule(source, { identifier: 'fixture-preflight' });",
    '    const requests = module.moduleRequests.map(({ specifier }) => specifier);',
    "    const ast = parser.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });",
    '    const pending = [ast];',
    '    while (pending.length) {',
    '      const node = pending.pop();',
    "      if (!node || typeof node !== 'object') continue;",
    "      if (node.type === 'ImportExpression') {",
    '        let target = node.source;',
    '        const base = target?.arguments?.[1];',
    "        if (target?.type === 'NewExpression' && target.callee.type === 'Identifier' && target.callee.name === 'URL'",
    "          && target.arguments.length === 2 && base?.type === 'MemberExpression' && !base.computed",
    "          && base.object.type === 'MetaProperty' && base.object.meta.name === 'import'",
    "          && base.object.property.name === 'meta' && base.property.name === 'url') target = target.arguments[0];",
    '        const specifier = literal(target);',
    '        if (specifier !== null) requests.push(specifier);',
    '      }',
    '      for (const value of Object.values(node)) {',
    '        if (Array.isArray(value)) pending.push(...value);',
    "        else if (value && typeof value === 'object') pending.push(value);",
    '      }',
    '    }',
    `    if (Buffer.byteLength(JSON.stringify(requests), 'utf8') > ${moduleRequestOutputLimit})`,
    "      throw new Error('module requests exceed the per-module parser output limit');",
    '    results.push({ index, requests });',
    '  } catch (error) {',
    "    process.stderr.write('fixture-preflight-module=' + index + '\\n' + String(error.stack));",
    '    process.exit(1);',
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(results));'
].join('\n');

function parseModuleRequestBatch(modules)
{
    const uncached = [...new Map(modules.filter(({ source }) => !moduleRequestCache.has(source))
        .map(module => [module.source, module])).values()];
    if (uncached.length === 0)
    {
        return modules.map(({ source }) => moduleRequestCache.get(source));
    }
    if (uncached.length > moduleRequestBatchSize)
    {
        throw new Error('ESM fixture parser batch exceeds its module limit');
    }
    const parsed = spawnSync(process.execPath, [
        '--experimental-vm-modules',
        '--input-type=module',
        '--eval',
        moduleRequestParser
    ], {
        input: JSON.stringify(uncached.map(({ source }) => source)),
        encoding: 'utf8',
        // Framing grows with the batch; each module retains spawnSync's original 1 MiB output ceiling.
        maxBuffer: moduleRequestOutputLimit * uncached.length + 1024,
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
    if (parsed.status !== 0 || parsed.error)
    {
        const detail = parsed.stderr?.trim() || parsed.error?.message || `parser exited with ${parsed.status}`;
        const index = Number(detail.match(/^fixture-preflight-module=(\d+)\n/u)?.[1] ?? 0);
        const importer = uncached[index]?.importer ?? uncached[0].importer;
        throw new Error(`ESM fixture parser failed for ${importer}: ${detail}`);
    }
    let rows;
    try
    {
        rows = JSON.parse(parsed.stdout);
    }
    catch
    {
        throw new Error(`ESM fixture parser returned malformed output for ${uncached[0].importer}`);
    }
    if (!Array.isArray(rows) || rows.length !== uncached.length || rows.some((row, index) => !row
        || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'index,requests'
        || row.index !== index || !Array.isArray(row.requests) || row.requests.some(request => typeof request !== 'string')
        || Buffer.byteLength(JSON.stringify(row.requests), 'utf8') > moduleRequestOutputLimit))
    {
        throw new Error(`ESM fixture parser returned malformed or over-limit output for ${uncached[0].importer}`);
    }
    const results = rows.map(({ requests }) => [...new Set(requests
        .filter(specifier => specifier.startsWith('./') || specifier.startsWith('../')))]);
    for (const [index, { source }] of uncached.entries())
    {
        moduleRequestCache.set(source, results[index]);
    }
    return modules.map(({ source }) => moduleRequestCache.get(source));
}

export function parseStaticRelativeEsmSpecifiers(source, importer = '<source>')
{
    if (typeof source !== 'string' && !ArrayBuffer.isView(source))
    {
        throw new TypeError('ESM fixture parser source must be a string or an ArrayBuffer view');
    }
    const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8')
        : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    return parseModuleRequestBatch([{ source: bytes.toString('utf8'), importer }])[0];
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
        const modules = [];
        while (pending.length > 0 && modules.length < moduleRequestBatchSize)
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
            modules.push({ importer, source: fs.readFileSync(importer, 'utf8') });
        }
        const requests = parseModuleRequestBatch(modules);
        for (const [index, { importer }] of modules.entries())
        {
            for (const specifier of requests[index])
            {
                pending.push(resolveLocalDependency(importer, specifier, allowedRoots));
            }
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
    const copies = files.map((file) =>
    {
        const relative = path.relative(source.absoluteRoot, file);
        const destination = path.resolve(absoluteFixtureRoot, relative);
        if (!isWithin(absoluteFixtureRoot, destination))
        {
            throw new Error(`ESM fixture destination escapes fixture root: ${destination}`);
        }
        prepareLiteralDestination(absoluteFixtureRoot, destination);
        return { file, destination };
    });
    for (const { file, destination } of copies)
    {
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
