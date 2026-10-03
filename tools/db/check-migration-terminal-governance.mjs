#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCurrentSchemaAuthority } from './check-current-schema-authority.mjs';

const { maskCSharp } = await import(new URL('../architecture/backend-physical-topology/csharp-mask.mjs', import.meta.url));

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverPath = 'src/backend/FsusBlog.Server.csproj';
const migrationPath = 'src/migration/FsusBlog.Migration.csproj';
const sharedPath = 'src/shared/FsusBlog.Shared.csproj';
const migrationName = /FsusBlog\.Migration(?:\b|\/)/iu;

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function xmlItems(text, name)
{
    return [...text.replace(/<!--[\s\S]*?-->/gu, '').matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gu'))]
        .map(match => Object.fromEntries([...match[1].matchAll(/([\w.]+)\s*=\s*(["'])(.*?)\2/gu)]
            .map(attribute => [attribute[1], attribute[3]])));
}

// Resolve only static literal expressions at an already identified assembly
// attribute seam. Other expressions remain unresolved, never assumed benign.
function friendLiteralArgument(source)
{
    let remaining = source.trim();
    remaining = remaining.replace(/^assemblyName\s*:\s*/u, '');
    let value = '';
    let needsLiteral = true;
    while (remaining)
    {
        const trivia = remaining.match(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/u);
        if (trivia)
        {
            remaining = remaining.slice(trivia[0].length);
            continue;
        }
        if (!needsLiteral)
        {
            if (!remaining.startsWith('+'))
            {
                return null;
            }
            remaining = remaining.slice(1);
            needsLiteral = true;
            continue;
        }
        const verbatim = remaining.match(/^@"(?:""|[^"])*"/u);
        const quoted = verbatim ? null : remaining.match(/^"(?:[^"\\\r\n]|\\[^\r\n])*"/u);
        const literal = verbatim ?? quoted;
        if (!literal)
        {
            return null;
        }
        try
        {
            value += verbatim ? literal[0].slice(2, -1).replaceAll('""', '"') : JSON.parse(literal[0]);
        }
        catch
        {
            return null;
        }
        remaining = remaining.slice(literal[0].length);
        needsLiteral = false;
    }
    return needsLiteral ? null : value;
}

function assemblyFriendDeclarations(source)
{
    const code = maskCSharp(source);
    const declarations = [];
    for (const section of code.matchAll(/\[\s*assembly\s*:/gu))
    {
        let start = section.index + section[0].length;
        let parentheses = 0;
        let brackets = 0;
        for (let cursor = start; cursor < code.length; cursor += 1)
        {
            const character = code[cursor];
            if ((character === ',' || character === ']') && parentheses === 0 && brackets === 0)
            {
                const segment = code.slice(start, cursor);
                const attribute = segment.match(/^\s*((?:global\s*::\s*)?(?:@?[A-Za-z_]\w*\s*\.\s*)*@?InternalsVisibleTo(?:Attribute)?)\s*\(/u);
                const type = attribute?.[1].replace(/\s|@/gu, '').replace(/^global::/u, '');
                if (['InternalsVisibleTo', 'InternalsVisibleToAttribute',
                    'System.Runtime.CompilerServices.InternalsVisibleTo', 'System.Runtime.CompilerServices.InternalsVisibleToAttribute'].includes(type))
                {
                    const argumentStart = start + attribute[0].length;
                    let argumentEnd = argumentStart;
                    let argumentDepth = 0;
                    while (argumentEnd < cursor)
                    {
                        const token = code[argumentEnd];
                        if ((token === ',' || token === ')') && argumentDepth === 0)
                        {
                            break;
                        }
                        if (token === '(')
                        {
                            argumentDepth += 1;
                        }
                        if (token === ')')
                        {
                            argumentDepth -= 1;
                        }
                        argumentEnd += 1;
                    }
                    declarations.push(friendLiteralArgument(source.slice(argumentStart, argumentEnd)));
                }
                if (character === ']')
                {
                    break;
                }
                start = cursor + 1;
            }
            if (character === '(')
            {
                parentheses += 1;
            }
            if (character === ')')
            {
                parentheses -= 1;
            }
            if (character === '[')
            {
                brackets += 1;
            }
            if (character === ']')
            {
                brackets -= 1;
            }
        }
    }
    return declarations;
}

// Declared-source graph only: conditions are included, never evaluated as false.
// Missing evaluated assets and runtime executions cannot qualify as acceptance.
export function inspectMigrationTerminalGovernance(root = defaultRoot)
{
    root = resolve(root);
    const failures = [];
    const inputByPath = new Map();
    const projects = new Map();
    const missingObservations = new Set();

    function checkFriendDeclaration(value, owner, input)
    {
        const identity = typeof value === 'string' ? value.split(',')[0].trim() : null;
        reject(!identity || /[$@%&\p{Cc}]/u.test(identity), `friend: unresolved InternalsVisibleTo declaration in ${input}`);
        const forbidden = owner === migrationPath ? ['FsusBlog.Server', 'FsusBlog.Core', 'FsusBlog.Shared'] : ['FsusBlog.Migration'];
        reject(identity !== null && forbidden.some(name => name.toLowerCase() === identity.toLowerCase()),
            `source: ${owner === migrationPath ? 'Migration' : 'Server/CurrentContracts'} InternalsVisibleTo ${identity}: ${input}`);
    }

    function reject(condition, message)
    {
        if (condition)
        {
            failures.push(message);
        }
    }

    function localPath(absolute)
    {
        const path = relative(root, absolute).replaceAll('\\', '/');
        reject(path === '..' || path.startsWith('../'), `graph: input escapes repository: ${path}`);
        return path;
    }

    function read(path)
    {
        const absolute = join(root, path);
        if (!confinedPath(path))
        {
            return '';
        }
        if (!existsSync(absolute))
        {
            failures.push(`missing required path: ${path}`);
            return '';
        }
        if (!lstatSync(absolute).isFile())
        {
            failures.push(`non-regular input: ${path}`);
            return '';
        }
        const bytes = readFileSync(absolute);
        inputByPath.set(path, { path, bytes: bytes.length, sha256: sha256(bytes) });
        return bytes.toString('utf8');
    }

    function confinedPath(path)
    {
        const normalized = localPath(resolve(root, path));
        if (normalized === '..' || normalized.startsWith('../'))
        {
            return false;
        }
        let current = root;
        for (const part of ['', ...normalized.split('/')])
        {
            current = join(current, part);
            let entry;
            try
            {
                entry = lstatSync(current);
            }
            catch (error)
            {
                if (error.code === 'ENOENT')
                {
                    return true;
                }
                failures.push(`unreadable input boundary: ${path}`);
                return false;
            }
            if (entry.isSymbolicLink())
            {
                failures.push(`symbolic input path component: ${path}`);
                return false;
            }
        }
        return true;
    }

    function files(directory, includeBuild = false)
    {
        const absolute = join(root, directory);
        if (!confinedPath(directory))
        {
            return [];
        }
        if (!existsSync(absolute))
        {
            return [];
        }
        return readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
            .flatMap(entry =>
            {
                const path = `${directory}/${entry.name}`;
                if (!includeBuild && ['bin', 'obj', 'node_modules', '.git'].includes(entry.name))
                {
                    return [];
                }
                if (entry.isSymbolicLink())
                {
                    failures.push(`unresolved symbolic input: ${path}`);
                    return [];
                }
                if (entry.isDirectory())
                {
                    return files(path, includeBuild);
                }
                return entry.isFile() ? [path] : [];
            });
    }

    function resolveItem(path, value)
    {
        if (!value || /[$*?]|&(?:\w+|#\d+);/u.test(value))
        {
            failures.push(`graph: unresolved project/item path in ${path}: ${value ?? '<missing Include>'}`);
            return null;
        }
        const target = localPath(resolve(dirname(join(root, path)), value.replaceAll('\\', '/')));
        return target.startsWith('../') || target === '..' ? null : target;
    }

    function loadProject(path)
    {
        if (projects.has(path))
        {
            return;
        }
        const project = { path, references: [], packages: [], imports: [], items: [], linkedSources: [], assemblyNames: [], friends: [] };
        projects.set(path, project);
        const fragments = [];
        const imported = new Set();
        function collect(input, active = new Set())
        {
            if (active.has(input))
            {
                failures.push(`graph: MSBuild import cycle at ${input}`);
                return;
            }
            if (imported.has(input))
            {
                return;
            }
            imported.add(input);
            active.add(input);
            const text = read(input);
            fragments.push({ path: input, text });
            if (input !== path)
            {
                project.imports.push({ path: input, sha256: sha256(text) });
            }
            for (const item of xmlItems(text, 'Import'))
            {
                const target = resolveItem(input, item.Project);
                if (target)
                {
                    collect(target, active);
                }
            }
            active.delete(input);
        }
        collect(path);
        let directory = dirname(join(root, path));
        const automaticImports = new Set();
        while (directory === root || directory.startsWith(`${root}/`))
        {
            for (const name of ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props'])
            {
                const absolute = join(directory, name);
                if (!automaticImports.has(name) && existsSync(absolute))
                {
                    automaticImports.add(name);
                    collect(localPath(absolute));
                }
            }
            directory = dirname(directory);
        }
        for (const fragment of fragments)
        {
            const xml = fragment.text.replace(/<!--[\s\S]*?-->/gu, '');
            const assemblyNames = [...xml.matchAll(/<AssemblyName\b[^>]*>\s*([^<]+?)\s*<\/AssemblyName>/gu)].map(match => match[1]);
            reject(assemblyNames.some(name => /[$@%()]|&(?:\w+|#\d+);/u.test(name)), `graph: unresolved AssemblyName input in ${fragment.path}`);
            project.assemblyNames.push(...assemblyNames);
            // MSBuild items are relative to the main project, unlike Import paths.
            project.references.push(...xmlItems(fragment.text, 'ProjectReference').map(item => resolveItem(path, item.Include)).filter(Boolean));
            project.packages.push(...xmlItems(fragment.text, 'PackageReference').map(item => item.Include ?? item.Update).filter(Boolean));
            for (const item of xmlItems(fragment.text, 'InternalsVisibleTo'))
            {
                if (item.Remove && !item.Include && !item.Update)
                {
                    continue;
                }
                const value = item.Include ?? item.Update ?? null;
                project.friends.push({ input: fragment.path, value, condition: item.Condition ?? null });
            }
            for (const kind of ['Compile', 'Content', 'EmbeddedResource', 'None', 'Reference'])
            {
                for (const item of xmlItems(fragment.text, kind))
                {
                    project.items.push({ input: fragment.path, kind, ...item });
                    const include = (item.Include ?? '').replaceAll('\\', '/');
                    reject((migrationName.test(include) || /(?:^|\/)migration(?:\/|$)/iu.test(include)) && path !== migrationPath, `graph: ${path} includes Migration ${kind}`);
                    if (kind === 'Compile' && item.Include && !/[$*?]/u.test(item.Include))
                    {
                        const target = resolveItem(path, item.Include);
                        reject(target?.startsWith('src/migration/') && path !== migrationPath, `source: linked migration source in ${path}`);
                        if (target)
                        {
                            project.linkedSources.push(target);
                        }
                    }
                    else if (kind === 'Compile' && item.Include)
                    {
                        failures.push(`source: unresolved Compile input in ${path}: ${item.Include}`);
                    }
                }
            }
        }
        project.references = [...new Set(project.references)].sort();
        project.packages = [...new Set(project.packages)].sort();
        project.assemblyNames = [...new Set(project.assemblyNames)].sort();
        for (const reference of project.references)
        {
            loadProject(reference);
        }
    }

    function closure(path, active = new Set(), visited = new Set())
    {
        if (active.has(path))
        {
            failures.push(`graph: project cycle at ${path}`);
            return visited;
        }
        if (visited.has(path))
        {
            return visited;
        }
        visited.add(path);
        active.add(path);
        for (const target of projects.get(path)?.references ?? [])
        {
            closure(target, active, visited);
        }
        active.delete(path);
        return visited;
    }

    for (const path of new Set([serverPath, migrationPath, sharedPath, ...files('src').filter(path => path.endsWith('.csproj'))]))
    {
        loadProject(path);
    }
    const serverGraph = closure(serverPath);
    const migrationGraph = closure(migrationPath);
    const sharedGraph = closure(sharedPath);
    const migrationIdentities = [...projects.values()].filter(project => project.assemblyNames.includes('FsusBlog.Migration'));
    reject(migrationIdentities.length !== 1, 'graph: Migration assembly identity is not registered exactly once');
    reject(serverGraph.has(migrationPath), 'graph: Server → Migration (explicit or transitive)');
    reject(migrationGraph.has(serverPath), 'graph: Migration → Server (explicit or transitive)');
    reject(!serverGraph.has(sharedPath), 'graph: Server does not reference CurrentContracts');
    reject(!migrationGraph.has(sharedPath), 'graph: Migration does not reference CurrentContracts');
    reject(sharedGraph.has(migrationPath) || sharedGraph.has(serverPath), 'graph: CurrentContracts references an application assembly');
    reject([...migrationGraph].some(path => path.startsWith('src/') && ![migrationPath, sharedPath].includes(path)), 'graph: Migration references a runtime application project');
    for (const path of ['Directory.Build.props', 'Directory.Packages.props', 'FsusBlog.slnx'])
    {
        if (existsSync(join(root, path)))
        {
            read(path);
        }
        else
        {
            missingObservations.add(path);
        }
    }

    const sourceGroups = new Map();
    for (const path of projects.keys())
    {
        const sources = files(dirname(path)).filter(source => source.endsWith('.cs'));
        const generated = files(join(dirname(path), 'obj'), true).filter(source => source.endsWith('.cs'));
        const records = [...new Set([...sources, ...generated, ...projects.get(path).linkedSources])].sort().map(source => ({ path: source, text: read(source) }));
        sourceGroups.set(path, records);
        if (generated.length === 0)
        {
            missingObservations.add(`${path}: compiled generated sources`);
        }
    }
    const migrationSources = sourceGroups.get(migrationPath) ?? [];
    const migrationHashes = new Set(migrationSources
        .filter(source => !source.path.includes('/obj/') && /namespace\s+FsusBlog\s*\.\s*Migration\b/u.test(maskCSharp(source.text)))
        .map(source => sha256(source.text)));
    const serverSources = [...serverGraph].flatMap(path => sourceGroups.get(path) ?? []);
    const runtimeLoad = /(?:Type\s*\.\s*GetType|Assembly\s*\.\s*Load(?:From|File)?|AssemblyLoadContext[\s\S]{0,100}Load|Activator\s*\.\s*CreateInstance|Add(?:Keyed\w+|Singleton|Scoped|Transient)|ServiceDescriptor)[^;]{0,2000}/gu;
    for (const source of serverSources)
    {
        const code = maskCSharp(source.text);
        for (const friend of assemblyFriendDeclarations(source.text))
        {
            checkFriendDeclaration(friend, serverPath, source.path);
        }
        reject(/\bFsusBlog\s*\.\s*Migration\b/u.test(code), `source: Server imports Migration: ${source.path}`);
        reject(/\bTypeForwardedTo\b/u.test(code) && /SchemaMigration|Migration/u.test(code), `source: migration type-forwarder: ${source.path}`);
        reject(migrationHashes.has(sha256(source.text)), `source: duplicate migration source: ${source.path}`);
        reject(/\bnew\s+SchemaMigrationRegistry\s*\(|Add\w+\s*<\s*(?:ISchemaMigrationRegistry|SchemaMigrationRegistry)\b/u.test(code), `DI: migration registry registration: ${source.path}`);
        for (const match of code.matchAll(runtimeLoad))
        {
            const normalized = source.text.slice(match.index, match.index + match[0].length).replace(/[\s"'+]/gu, '');
            reject(/FsusBlog\.Migration\b|SchemaMigrationRegistry\b|SchemaMigrationDescriptor\b/u.test(normalized), `reflection/DI: migration loading or alias: ${source.path}`);
        }
    }
    for (const source of migrationSources)
    {
        const code = maskCSharp(source.text);
        reject(/\bFsusBlog\s*\.\s*(?:Server|Core)\b|Microsoft\s*\.\s*AspNetCore|\b(?:IHostedService|BackgroundService|WebApplication|TestServer)\b/u.test(code), `source: Migration imports Server/runtime: ${source.path}`);
        reject(/\bTypeForwardedTo\b|namespace\s+FsusBlog\s*\.\s*Server\s*\.\s*Infrastructure\s*\.\s*SchemaMigration/u.test(code), `source: type-forwarder or compat namespace: ${source.path}`);
        for (const friend of assemblyFriendDeclarations(source.text))
        {
            checkFriendDeclaration(friend, migrationPath, source.path);
        }
        for (const match of code.matchAll(runtimeLoad))
        {
            const normalized = source.text.slice(match.index, match.index + match[0].length).replace(/[\s"'+]/gu, '');
            reject(/FsusBlog\.(?:Server|Core)\b|Microsoft\.AspNetCore\b/u.test(normalized), `reflection/DI: Migration loads Server/runtime: ${source.path}`);
        }
    }
    for (const source of sourceGroups.get(sharedPath) ?? [])
    {
        reject(/LastUsernameUpdateTime|RefreshTokenExpiryTime/iu.test(maskCSharp(source.text)), `shared current contract contains a legacy column: ${source.path}`);
    }
    const authorityErrors = validateCurrentSchemaAuthority(root);
    failures.push(...authorityErrors.map(error => `current-schema-authority: ${error}`));
    for (const project of projects.values())
    {
        if (serverGraph.has(project.path) || migrationGraph.has(project.path))
        {
            // Shared projects retain the current-contract direction even when
            // reached by Migration: a friend does not make them its legacy owner.
            const owner = project.path === migrationPath ? migrationPath : serverPath;
            for (const friend of project.friends)
            {
                checkFriendDeclaration(friend.value, owner, friend.input);
            }
        }
    }

    const assets = [];
    for (const path of projects.keys())
    {
        const assetPath = `${dirname(path)}/obj/project.assets.json`;
        if (!existsSync(join(root, assetPath)))
        {
            missingObservations.add(`${path}: evaluated compile/runtime assets`);
            continue;
        }
        try
        {
            const asset = JSON.parse(read(assetPath));
            const libraries = Object.entries(asset.libraries ?? {}).map(([name, value]) => ({ name, type: value.type, path: value.path ?? null }));
            const targets = Object.entries(asset.targets ?? {}).map(([framework, values]) => ({ framework, libraries: Object.entries(values) }));
            reject(!asset.libraries || !asset.targets || typeof asset.libraries !== 'object' || typeof asset.targets !== 'object', `assets: missing library/target graph: ${assetPath}`);
            reject(serverGraph.has(path) && (libraries.some(item => migrationName.test(item.name) || /(?:^|\/)migration\//iu.test(item.path ?? '')) || targets.some(target => target.libraries.some(([name, value]) => migrationName.test(name) || migrationName.test(JSON.stringify(value))))), `assets: Migration in Server compile/runtime graph: ${assetPath}`);
            reject(migrationGraph.has(path) && !sharedGraph.has(path) && libraries.some(item => /FsusBlog\.(?:Server|Core)\b/iu.test(item.name)), `assets: runtime application in Migration graph: ${assetPath}`);
            assets.push({ path: assetPath, libraries, targets });
        }
        catch (error)
        {
            failures.push(`invalid assets: ${assetPath}: ${error.message}`);
        }
    }

    const serverAssetPaths = new Set([...serverGraph].map(path => `${dirname(path)}/obj/project.assets.json`));
    const serverAssetsComplete = [...serverAssetPaths].every(path => assets.some(asset => asset.path === path));
    const observedServerPackages = new Set(assets.filter(asset => serverAssetPaths.has(asset.path))
        .flatMap(asset => asset.libraries.filter(item => item.type === 'package').map(item => item.name.split('/')[0])));
    const migrationAssets = assets.find(asset => asset.path === 'src/migration/obj/project.assets.json');
    const migrationOnlyPackages = [...new Set((serverAssetsComplete ? migrationAssets?.libraries ?? [] : [])
        .filter(item => item.type === 'package' && !observedServerPackages.has(item.name.split('/')[0]))
        .map(item => item.name.split('/')[0]))].sort();
    const publishRoots = ['src/backend/bin/Release/net10.0/publish', '.tmp/publish'].filter(path => confinedPath(path) && existsSync(join(root, path)));
    const published = [];
    const residue = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (const publishRoot of publishRoots)
    {
        for (const path of files(publishRoot, true))
        {
            const hash = createHash('sha256');
            let tail = '';
            let bytes = 0;
            let contaminated = /FsusBlog\.Migration\b|migration[/\\].*fixture/iu.test(path)
                || migrationOnlyPackages.some(name => path.toLowerCase().includes(`${name.toLowerCase()}.dll`));
            const fd = openSync(join(root, path), 'r');
            try
            {
                let length;
                while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0)
                {
                    const chunk = buffer.subarray(0, length);
                    hash.update(chunk);
                    bytes += length;
                    const text = tail + chunk.toString('latin1').replaceAll('\0', '');
                    contaminated ||= /FsusBlog\.Migration\b|FsusBlog\.Server\.Infrastructure\.SchemaMigration\.(?:Definitions|Catalogs)|LastUsernameUpdateTime|RefreshTokenExpiryTime/iu.test(text)
                        || migrationOnlyPackages.some(name => text.toLowerCase().includes(`${name.toLowerCase()}/`));
                    tail = text.slice(-256);
                }
            }
            finally
            {
                closeSync(fd);
            }
            published.push({ path, bytes, sha256: hash.digest('hex') });
            if (contaminated)
            {
                residue.push(path);
                failures.push(`publish residue: ${path}`);
            }
        }
    }
    const inputs = [...inputByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    const graph = {
        scope: 'declared-project-source-and-observed-assets-only',
        projects: [...projects.values()].sort((left, right) => left.path.localeCompare(right.path)),
        directions: {
            currentContractsFromServer: serverGraph.has(sharedPath),
            currentContractsFromMigration: migrationGraph.has(sharedPath),
            serverToMigration: serverGraph.has(migrationPath),
            migrationToServer: migrationGraph.has(serverPath)
        },
        assets,
        inputs,
        missingObservations: [...missingObservations].sort()
    };
    const git = spawnSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return {
        schema: 'fsusblog.migration-terminal-static-observation.v1',
        sourceCommit: git.status === 0 ? git.stdout.trim() : null,
        scope: 'static-governance',
        qualificationEligible: false,
        graph: { ...graph, digest: sha256(JSON.stringify(graph)) },
        currentSchemaAuthority: { staticErrors: authorityErrors, runtimeProjectionEquivalence: 'not-run' },
        publish: { status: publishRoots.length === 0 ? 'not-observed' : 'observed-unqualified', roots: publishRoots, files: published, packageClassification: serverAssetsComplete && migrationAssets ? 'observed-unqualified' : 'not-observed', observedMigrationOnlyPackages: migrationOnlyPackages, residue: publishRoots.length === 0 ? null : residue },
        providers: { postgresql: 'not-run', mysql: 'not-run', sqlite: 'not-run' },
        mutation: { status: 'not-observed', reason: 'checker fixtures are not current-source terminal mutation evidence' },
        benchmark: { status: 'not-evaluable', reason: 'no bound symmetric warmup/samples, allocation or publish-size evidence' },
        finalAcceptance: { status: 'blocked', reasons: ['evaluated build/assembly graph', 'three real provider executions', 'bound publish/AOT/trim and size comparison', 'ten current-source mutation classes', 'symmetric cold-readiness/startup and allocation comparison'] },
        warnings: [],
        warningsCount: 0,
        failures
    };
}

function main()
{
    const rootIndex = process.argv.indexOf('--root');
    const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot;
    const receipt = inspectMigrationTerminalGovernance(root);
    if (process.argv.includes('--write'))
    {
        // The existing producer path is retained; the product is explicitly non-qualifying.
        const output = join(root, 'artifacts/schema-migration/terminal-acceptance-receipt.json');
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
        console.log('[migration-terminal-governance] wrote non-qualifying static observation');
    }
    for (const failure of receipt.failures)
    {
        console.error(`[migration-terminal-governance] ${failure}`);
    }
    process.exitCode = receipt.failures.length > 0 ? 1 : 0;
    if (receipt.failures.length === 0)
    {
        console.log('[migration-terminal-governance] ok static-only; terminal acceptance blocked');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
