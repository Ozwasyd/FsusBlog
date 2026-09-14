#!/usr/bin/env node
import {
    existsSync,
    lstatSync,
    readFileSync,
    readdirSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_PATH = 'tests/governance/frontend-test-layout.json';
const WALK_IGNORES = new Set(['.git', '.tmp', 'bin', 'coverage', 'dist', 'node_modules', 'obj', 'test-results']);
const REQUIRED_CATEGORIES = ['test-cases', 'fixtures', 'support', 'metadata'];
let resolverImportSequence = 0;

function repoPath(value)
{
    return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function normalizeRelative(value, label, errors)
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

function isWithin(candidate, owner)
{
    return candidate === owner || candidate.startsWith(`${owner}/`);
}

function walkEntries(root, relativeDirectory, errors)
{
    const files = [];
    const directories = [];
    const visit = (directory) =>
    {
        const absoluteDirectory = path.join(root, directory);
        if (!existsSync(absoluteDirectory))
        {
            return;
        }
        for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true }))
        {
            if (WALK_IGNORES.has(entry.name))
            {
                continue;
            }
            const relativePath = repoPath(path.join(directory, entry.name));
            if (entry.isSymbolicLink())
            {
                errors.push(`test ownership path must not be a symbolic link: ${relativePath}`);
            }
            else if (entry.isDirectory())
            {
                directories.push(relativePath);
                visit(relativePath);
            }
            else if (entry.isFile())
            {
                files.push(relativePath);
            }
        }
    };
    visit(relativeDirectory);
    return { files, directories };
}

function readJson(root, relativePath, errors)
{
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute))
    {
        errors.push(`missing frontend test layout manifest: ${relativePath}`);
        return null;
    }
    try
    {
        return JSON.parse(readFileSync(absolute, 'utf8'));
    }
    catch (error)
    {
        errors.push(`frontend test layout manifest is not valid JSON: ${error.message}`);
        return null;
    }
}

function requireDirectory(root, relativePath, label, errors)
{
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute) || !lstatSync(absolute).isDirectory())
    {
        errors.push(`${label} must be an existing directory: ${relativePath}`);
        return false;
    }
    return true;
}

function requireFile(root, relativePath, label, errors)
{
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile())
    {
        errors.push(`${label} must be an existing file: ${relativePath}`);
        return false;
    }
    return true;
}

function normalizePathList(values, label, errors)
{
    if (!Array.isArray(values))
    {
        errors.push(`${label} must be an array`);
        return [];
    }
    const normalized = values.flatMap((value, index) =>
    {
        const result = normalizeRelative(value, `${label}[${index}]`, errors);
        return result ? [result] : [];
    });
    const duplicates = normalized.filter((value, index) => normalized.indexOf(value) !== index);
    for (const duplicate of new Set(duplicates))
    {
        errors.push(`${label} contains duplicate path: ${duplicate}`);
    }
    return normalized;
}

function checkSourceOwnership(root, manifest, sourceRoot, errors)
{
    const allowlist = Array.isArray(manifest.sourceTestAllowlist) ? manifest.sourceTestAllowlist : [];
    if (!Array.isArray(manifest.sourceTestAllowlist))
    {
        errors.push('sourceTestAllowlist must be an array');
    }
    const allowed = allowlist.flatMap((entry, index) =>
    {
        const allowedPath = normalizeRelative(entry?.path, `sourceTestAllowlist[${index}].path`, errors);
        if (typeof entry?.reason !== 'string' || entry.reason.trim() === '')
        {
            errors.push(`sourceTestAllowlist[${index}].reason must explain the exception`);
        }
        if (allowedPath && !isWithin(allowedPath, sourceRoot))
        {
            errors.push(`source test allowlist entry must be owned by ${sourceRoot}: ${allowedPath}`);
        }
        if (allowedPath && !repoPath(path.posix.relative(sourceRoot, allowedPath)).split('/').includes('tests'))
        {
            errors.push(`source test allowlist entry does not name a tests tree: ${allowedPath}`);
        }
        return allowedPath ? [allowedPath] : [];
    });

    const retiredRoots = normalizePathList(manifest.retiredRoots, 'retiredRoots', errors);
    for (const retiredRoot of retiredRoots)
    {
        if (existsSync(path.join(root, retiredRoot)))
        {
            errors.push(`retired frontend test root exists: ${retiredRoot}`);
        }
    }

    if (!requireDirectory(root, sourceRoot, 'frontend source root', errors))
    {
        return;
    }
    const sourceEntries = walkEntries(root, sourceRoot, errors);
    for (const directory of sourceEntries.directories)
    {
        const relative = repoPath(path.posix.relative(sourceRoot, directory));
        if (!relative.split('/').includes('tests'))
        {
            continue;
        }
        if (!allowed.some((entry) => isWithin(directory, entry) || isWithin(entry, directory)))
        {
            errors.push(`source-local test tree is forbidden when tests/frontend is canonical: ${directory}`);
        }
    }
}

function checkCategories(root, manifest, canonicalRoot, errors)
{
    const categories = manifest.categories;
    if (!categories || typeof categories !== 'object' || Array.isArray(categories))
    {
        errors.push('categories must declare test-cases, fixtures, support, and metadata');
        return { supportRoots: [], canonicalEntries: { files: [], directories: [] } };
    }
    for (const required of REQUIRED_CATEGORIES)
    {
        if (!categories[required])
        {
            errors.push(`missing frontend test ownership category: ${required}`);
        }
    }

    const declarations = [];
    for (const [kind, declaration] of Object.entries(categories))
    {
        const roots = normalizePathList(declaration?.roots, `categories.${kind}.roots`, errors);
        const files = normalizePathList(declaration?.files, `categories.${kind}.files`, errors);
        for (const declaredRoot of roots)
        {
            if (!isWithin(declaredRoot, canonicalRoot))
            {
                errors.push(`frontend test category ${kind} escapes ${canonicalRoot}: ${declaredRoot}`);
            }
            requireDirectory(root, declaredRoot, `frontend test ${kind} root`, errors);
            declarations.push({ kind, path: declaredRoot, type: 'root' });
        }
        for (const declaredFile of files)
        {
            if (!isWithin(declaredFile, canonicalRoot))
            {
                errors.push(`frontend test category ${kind} escapes ${canonicalRoot}: ${declaredFile}`);
            }
            requireFile(root, declaredFile, `frontend test ${kind} file`, errors);
            declarations.push({ kind, path: declaredFile, type: 'file' });
        }
    }

    const canonicalEntries = requireDirectory(root, canonicalRoot, 'canonical frontend test root', errors)
        ? walkEntries(root, canonicalRoot, errors)
        : { files: [], directories: [] };
    for (const file of canonicalEntries.files)
    {
        const candidates = declarations.filter((entry) => (
      entry.type === 'file' ? file === entry.path : isWithin(file, entry.path)
        ));
        if (candidates.length === 0)
        {
            errors.push(`frontend test path has no ownership category: ${file}`);
            continue;
        }
        const longest = Math.max(...candidates.map((entry) => entry.path.length));
        const owners = new Set(candidates.filter((entry) => entry.path.length === longest).map((entry) => entry.kind));
        if (owners.size !== 1)
        {
            errors.push(`frontend test path has ambiguous ownership categories: ${file} (${[...owners].join(', ')})`);
        }
    }

    const supportRoots = normalizePathList(categories.support?.roots, 'categories.support.roots', []);
    const explicitTestCaseRoots = normalizePathList(categories['test-cases']?.roots, 'categories.test-cases.roots', []);
    for (const directory of canonicalEntries.directories.filter((entry) => path.posix.basename(entry) === 'support'))
    {
        if (!supportRoots.some((supportRoot) => isWithin(directory, supportRoot))
      && !explicitTestCaseRoots.includes(directory))
        {
            errors.push(`undeclared frontend test support namespace: ${directory}`);
        }
    }
    for (const file of canonicalEntries.files.filter((entry) => /\/(?:global-)?setup\.[cm]?[jt]sx?$/u.test(entry)))
    {
        if (!supportRoots.some((supportRoot) => isWithin(file, supportRoot)))
        {
            errors.push(`frontend test setup must live in a declared support namespace: ${file}`);
        }
    }
    return { supportRoots, canonicalEntries };
}

function checkRunnerInventory(root, manifest, errors)
{
    const runner = manifest.runnerConfiguration;
    if (!runner || typeof runner !== 'object')
    {
        errors.push('runnerConfiguration must be declared');
        return { files: [], sharedFiles: [] };
    }
    const runnerRoot = normalizeRelative(runner.root, 'runnerConfiguration.root', errors);
    const files = normalizePathList(runner.files, 'runnerConfiguration.files', errors);
    const sharedFiles = normalizePathList(runner.sharedFiles, 'runnerConfiguration.sharedFiles', errors);
    if (!runnerRoot || !requireDirectory(root, runnerRoot, 'Vitest runner configuration root', errors))
    {
        return { files, sharedFiles };
    }
    for (const file of [...files, ...sharedFiles])
    {
        requireFile(root, file, 'Vitest runner configuration', errors);
    }

    const discovered = readdirSync(path.join(root, runnerRoot), { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^vitest(?:\..+)?\.config\.ts$/u.test(entry.name))
        .map((entry) => repoPath(path.join(runnerRoot, entry.name)))
        .sort();
    const declared = [...files].sort();
    if (JSON.stringify(discovered) !== JSON.stringify(declared))
    {
        errors.push(`Vitest runner configuration inventory drift: declared=${declared.join(',')} discovered=${discovered.join(',')}`);
    }
    return { files, sharedFiles };
}

async function checkUnitSetup(root, manifest, runnerFiles, supportRoots, errors)
{
    const setup = manifest.unitSetup;
    if (!setup || typeof setup !== 'object')
    {
        errors.push('unitSetup ownership must be declared');
        return;
    }
    const resolverModule = normalizeRelative(setup.resolverModule, 'unitSetup.resolverModule', errors);
    const canonicalFile = normalizeRelative(setup.canonicalFile, 'unitSetup.canonicalFile', errors);
    const supportFiles = normalizePathList(setup.supportFiles, 'unitSetup.supportFiles', errors);
    const setupConfigs = normalizePathList(setup.configs, 'unitSetup.configs', errors);
    const cacheIdentity = normalizeRelative(setup.transformCacheIdentity, 'unitSetup.transformCacheIdentity', errors);
    const environmentConsumer = normalizeRelative(setup.environmentConsumer, 'unitSetup.environmentConsumer', errors);
    const resolverExport = setup.resolverExport;
    const dependencyDedupeExport = setup.dependencyDedupeExport;
    if (typeof resolverExport !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(resolverExport))
    {
        errors.push('unitSetup.resolverExport must be a JavaScript identifier');
    }
    if (typeof dependencyDedupeExport !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(dependencyDedupeExport))
    {
        errors.push('unitSetup.dependencyDedupeExport must be a JavaScript identifier');
    }

    for (const supportFile of supportFiles)
    {
        requireFile(root, supportFile, 'canonical frontend unit support file', errors);
        if (!supportRoots.some((supportRoot) => isWithin(supportFile, supportRoot)))
        {
            errors.push(`unit support file is outside a declared support namespace: ${supportFile}`);
        }
    }
    if (canonicalFile && !supportFiles.includes(canonicalFile))
    {
        errors.push(`canonical unit setup must be listed in unitSetup.supportFiles: ${canonicalFile}`);
    }

    const setupConfigSet = new Set(setupConfigs);
    for (const config of setupConfigs)
    {
        if (!runnerFiles.includes(config))
        {
            errors.push(`unit setup config is absent from runner inventory: ${config}`);
        }
        if (!requireFile(root, config, 'Vitest setup consumer', errors))
        {
            continue;
        }
        const source = readFileSync(path.join(root, config), 'utf8');
        const sharedImport = source.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/vitest\.shared\.mjs['"]/u);
        const importedNames = sharedImport?.[1].split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
        if (!importedNames.includes(resolverExport))
        {
            errors.push(`${config} must import ${resolverExport} from ./vitest.shared.mjs`);
        }
        if (!importedNames.includes(dependencyDedupeExport)
      || !new RegExp(`\\bdedupe\\s*:\\s*${dependencyDedupeExport}\\b`, 'u').test(source))
        {
            errors.push(`${config} must dedupe external setup dependencies with ${dependencyDedupeExport}`);
        }
        const setupDeclarations = [...source.matchAll(/setupFiles\s*:\s*\[([\s\S]*?)\]/gu)];
        if (setupDeclarations.length !== 1 || setupDeclarations[0][1].trim() !== resolverExport)
        {
            errors.push(`${config} must declare setupFiles: [${resolverExport}] exactly once`);
        }
        if (source.includes('src/frontend/tests/frontend') || source.includes('./tests/frontend/unit/setup.ts'))
        {
            errors.push(`${config} still references the retired frontend test root`);
        }
    }
    for (const config of runnerFiles)
    {
        const source = requireFile(root, config, 'Vitest runner configuration', errors)
            ? readFileSync(path.join(root, config), 'utf8')
            : '';
        if (/\bsetupFiles\s*:/u.test(source) && !setupConfigSet.has(config))
        {
            errors.push(`Vitest setupFiles consumer is not declared in unitSetup.configs: ${config}`);
        }
    }

    if (resolverModule && canonicalFile && requireFile(root, resolverModule, 'Vitest shared setup resolver', errors))
    {
        try
        {
            const resolverUrl = pathToFileURL(path.join(root, resolverModule));
            resolverUrl.searchParams.set('frontend-test-layout', String(resolverImportSequence += 1));
            const module = await import(resolverUrl.href);
            const resolved = module[resolverExport];
            const expected = path.resolve(root, canonicalFile);
            if (typeof resolved !== 'string' || path.resolve(resolved) !== expected)
            {
                errors.push(`${resolverModule} export ${resolverExport} resolves ${String(resolved)} instead of ${expected}`);
            }
            else if (!existsSync(resolved) || !lstatSync(resolved).isFile())
            {
                errors.push(`${resolverModule} export ${resolverExport} does not resolve to a file: ${resolved}`);
            }
            const dependencyDedupe = module[dependencyDedupeExport];
            if (!Array.isArray(dependencyDedupe) || !dependencyDedupe.includes('happy-dom'))
            {
                errors.push(`${resolverModule} export ${dependencyDedupeExport} must dedupe happy-dom for external setup resolution`);
            }
        }
        catch (error)
        {
            errors.push(`cannot load Vitest shared setup resolver ${resolverModule}: ${error.message}`);
        }
    }

    if (cacheIdentity && requireFile(root, cacheIdentity, 'Vitest transform-cache identity source', errors))
    {
        const source = readFileSync(path.join(root, cacheIdentity), 'utf8');
        for (const supportFile of supportFiles)
        {
            if (!source.includes(`'${supportFile}'`) && !source.includes(`"${supportFile}"`))
            {
                errors.push(`Vitest transform-cache identity omits canonical support input: ${supportFile}`);
            }
        }
        if (source.includes('src/frontend/tests/frontend'))
        {
            errors.push('Vitest transform-cache identity still accepts the retired frontend test root');
        }
    }

    if (environmentConsumer && requireFile(root, environmentConsumer, 'animation-frame environment consumer', errors))
    {
        const source = readFileSync(path.join(root, environmentConsumer), 'utf8');
        if (!source.includes("../../support/unit/animationFrameEnvironment"))
        {
            errors.push(`${environmentConsumer} must import animationFrameEnvironment from canonical unit support`);
        }
        if (source.includes('src/frontend/tests/frontend'))
        {
            errors.push(`${environmentConsumer} still imports from the retired frontend test root`);
        }
    }
}

function checkVisualFixture(root, manifest, errors)
{
    const visual = manifest.visualFixture;
    if (!visual || typeof visual !== 'object')
    {
        errors.push('visualFixture ownership must be declared');
        return;
    }
    const modulePath = normalizeRelative(visual.module, 'visualFixture.module', errors);
    const consumer = normalizeRelative(visual.consumer, 'visualFixture.consumer', errors);
    const viteConfig = normalizeRelative(visual.viteConfig, 'visualFixture.viteConfig', errors);
    const requiredDedupe = Array.isArray(visual.requiredDedupe) ? visual.requiredDedupe : [];
    if (!Array.isArray(visual.requiredDedupe) || requiredDedupe.some((entry) => typeof entry !== 'string' || !entry))
    {
        errors.push('visualFixture.requiredDedupe must be an array of package names');
    }
    if (modulePath && !isWithin(modulePath, 'tests/frontend/fixtures'))
    {
        errors.push(`visual fixture module must live under tests/frontend/fixtures: ${modulePath}`);
    }
    if (modulePath)
    {
        requireFile(root, modulePath, 'canonical frontend visual fixture', errors);
    }

    if (consumer && requireFile(root, consumer, 'frontend visual fixture consumer', errors))
    {
        const source = readFileSync(path.join(root, consumer), 'utf8');
        const relativeModule = modulePath
            ? path.posix.relative(path.posix.dirname(consumer), modulePath)
            : '';
        if (!source.includes(`new URL('${relativeModule}', import.meta.url)`)
      || !source.includes('`/@fs/${fileURLToPath('))
        {
            errors.push(`${consumer} must serve the canonical visual fixture through a fileURLToPath /@fs/ URL`);
        }
        if (source.includes('src/frontend/tests/frontend')
      || source.includes('src="/tests/frontend/fixtures/'))
        {
            errors.push(`${consumer} still serves the retired source-local visual fixture`);
        }
    }

    if (viteConfig && requireFile(root, viteConfig, 'Vite visual-fixture resolver configuration', errors))
    {
        const source = readFileSync(path.join(root, viteConfig), 'utf8');
        const dedupeDeclaration = source.match(/\bdedupe\s*:\s*command\s*===\s*['"]serve['"]\s*\?\s*\[([^\]]*)\]\s*:\s*\[\]/u);
        const dedupe = dedupeDeclaration?.[1] ?? '';
        if (!dedupeDeclaration)
        {
            errors.push(`${viteConfig} must limit repository-level browser-fixture dedupe to Vite serve mode`);
        }
        for (const packageName of requiredDedupe)
        {
            if (!dedupe.includes(`'${packageName}'`) && !dedupe.includes(`"${packageName}"`))
            {
                errors.push(`${viteConfig} must dedupe ${packageName} for repository-level browser fixtures`);
            }
        }
    }
}

export async function checkFrontendTestLayout(repositoryRoot)
{
    const root = path.resolve(repositoryRoot);
    const errors = [];
    const manifest = readJson(root, MANIFEST_PATH, errors);
    if (!manifest)
    {
        return errors;
    }
    if (manifest.schema !== 'fsusblog.frontend-test-layout.v1')
    {
        errors.push(`frontend test layout schema must be fsusblog.frontend-test-layout.v1, got ${manifest.schema ?? 'missing'}`);
    }
    if (manifest.project !== 'frontend')
    {
        errors.push('frontend test layout project must be frontend');
    }

    const sourceRoot = normalizeRelative(manifest.sourceRoot, 'sourceRoot', errors);
    const canonicalRoot = normalizeRelative(manifest.canonicalTestRoot, 'canonicalTestRoot', errors);
    if (!sourceRoot || !canonicalRoot)
    {
        return errors;
    }
    checkSourceOwnership(root, manifest, sourceRoot, errors);
    const { supportRoots } = checkCategories(root, manifest, canonicalRoot, errors);
    const runner = checkRunnerInventory(root, manifest, errors);
    await checkUnitSetup(root, manifest, runner.files, supportRoots, errors);
    checkVisualFixture(root, manifest, errors);
    return errors;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url))
{
    const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
    const errors = await checkFrontendTestLayout(root);
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[frontend-test-layout] ${error}`);
        }
        process.exit(1);
    }
    console.log('[frontend-test-layout] ok root=tests/frontend setup-configs=11 support-files=2');
}
