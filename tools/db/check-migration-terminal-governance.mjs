#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCurrentSchemaAuthority } from './check-current-schema-authority.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot;
const failures = [];
const warnings = [];

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function read(path)
{
    const fullPath = join(root, path);
    if (!existsSync(fullPath))
    {
        failures.push(`missing required path: ${path}`);
        return '';
    }
    return readFileSync(fullPath, 'utf8');
}

function files(directory)
{
    const fullPath = join(root, directory);
    if (!existsSync(fullPath))
    {
        return [];
    }
    return readdirSync(fullPath, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.parentPath.split('/').some(part => part === 'bin' || part === 'obj'))
        .map(entry => join(entry.parentPath, entry.name));
}

function reject(condition, message)
{
    if (condition)
    {
        failures.push(message);
    }
}

function decodeXmlAttribute(value)
{
    return value.replace(/&([^;]*);/g, (_, entity) =>
    {
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (Object.hasOwn(named, entity))
        {
            return named[entity];
        }
        if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity))
        {
            throw new Error('unsupported XML entity');
        }
        const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if ((code < 0x20 && ![9, 10, 13].includes(code)) || code > 0x10ffff
            || (code >= 0xd800 && code <= 0xdfff) || [0xfffe, 0xffff].includes(code))
        {
            throw new Error('invalid XML character');
        }
        return String.fromCodePoint(code);
    });
}

// This parses physical project declarations only. SDK/import evaluation, assets and
// compiled loading still require independent observations; this graph cannot qualify acceptance.
function physicalProjectReferences(xml)
{
    const stack = [];
    const references = [];
    let position = 0;
    let rootSeen = false;
    while (position < xml.length)
    {
        const start = xml.indexOf('<', position);
        const text = xml.slice(position, start < 0 ? xml.length : start);
        if (stack.length === 0 && text.trim().length > 0)
        {
            throw new Error('text outside project root');
        }
        if (start < 0)
        {
            break;
        }
        if (xml.startsWith('<!--', start))
        {
            const end = xml.indexOf('-->', start + 4);
            if (end < 0 || xml.slice(start + 4, end).includes('--'))
            {
                throw new Error('invalid XML comment');
            }
            position = end + 3;
            continue;
        }
        if (xml.startsWith('<?xml ', start) && !rootSeen)
        {
            const end = xml.indexOf('?>', start + 6);
            if (end < 0)
            {
                throw new Error('invalid XML declaration');
            }
            position = end + 2;
            continue;
        }
        if (xml.startsWith('<!', start) || xml.startsWith('<?', start))
        {
            throw new Error('unsupported XML directive');
        }
        let end = start + 1;
        let quote = null;
        for (; end < xml.length; end++)
        {
            const character = xml[end];
            if (quote !== null)
            {
                if (character === quote)
                {
                    quote = null;
                }
            }
            else if (character === '"' || character === "'")
            {
                quote = character;
            }
            else if (character === '>')
            {
                break;
            }
            else if (character === '<')
            {
                throw new Error('invalid XML tag');
            }
        }
        if (end === xml.length || quote !== null)
        {
            throw new Error('unterminated XML tag');
        }
        const body = xml.slice(start + 1, end);
        const closing = body.startsWith('/');
        const selfClosing = !closing && body.endsWith('/');
        const content = body.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
        const name = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(content)?.[0];
        if (!name)
        {
            throw new Error('unsupported XML element name');
        }
        let rest = content.slice(name.length);
        const attributes = {};
        while (rest.trim().length > 0)
        {
            const match = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(rest);
            if (closing || !match || Object.hasOwn(attributes, match[1].toLowerCase()) || match[3].includes('<') || /&(?!(?:[^&;]*);)/.test(match[3]))
            {
                throw new Error('invalid XML attributes');
            }
            attributes[match[1].toLowerCase()] = decodeXmlAttribute(match[3]);
            rest = rest.slice(match[0].length);
        }
        if (closing)
        {
            if (stack.pop()?.name !== name)
            {
                throw new Error('unbalanced XML elements');
            }
        }
        else
        {
            if (stack.length === 0)
            {
                if (rootSeen || name !== 'Project')
                {
                    throw new Error('expected one Project root');
                }
                rootSeen = true;
            }
            if (name.toLowerCase() === 'import' || name.toLowerCase() === 'importgroup')
            {
                throw new Error('imported project references require evaluated graph evidence');
            }
            if (name.toLowerCase() === 'projectreference')
            {
                if (!attributes.include || attributes.update || attributes.remove
                    || [attributes, ...stack.map(node => node.attributes)].some(item => Object.hasOwn(item, 'condition'))
                    || stack.some(node => ['target', 'choose'].includes(node.name.toLowerCase())))
                {
                    throw new Error('conditional or computed ProjectReference requires evaluated graph evidence');
                }
                for (const include of attributes.include.split(';'))
                {
                    if (!include.trim() || /[$@%*?]/.test(include))
                    {
                        throw new Error('nonliteral ProjectReference requires evaluated graph evidence');
                    }
                    references.push(include.trim().replaceAll('\\', '/'));
                }
            }
            if (!selfClosing)
            {
                stack.push({ name, attributes });
            }
        }
        position = end + 1;
    }
    if (!rootSeen || stack.length !== 0)
    {
        throw new Error('incomplete project XML');
    }
    return references;
}

function physicalFile(repositoryRoot, absolute)
{
    const rel = relative(repositoryRoot, absolute);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
    {
        throw new Error('path escapes repository');
    }
    let current = repositoryRoot;
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
    {
        throw new Error('repository root is not a physical directory');
    }
    for (const component of rel.split('/'))
    {
        current = join(current, component);
        if (lstatSync(current).isSymbolicLink())
        {
            throw new Error('symlink is not a physical graph input');
        }
    }
    if (!lstatSync(current).isFile())
    {
        throw new Error('graph input is not a regular file');
    }
    return rel.replaceAll('\\', '/');
}

export function inspectPhysicalProjectGraph(repositoryRoot)
{
    const physicalRoot = resolve(repositoryRoot);
    const entryProjects = ['src/backend/FsusBlog.Server.csproj', 'src/migration/FsusBlog.Migration.csproj', 'src/shared/FsusBlog.Shared.csproj'];
    const projects = new Map();
    const active = new Set();
    const errors = [];
    function visit(projectPath)
    {
        if (active.has(projectPath))
        {
            errors.push(`graph: physical ProjectReference cycle at ${projectPath}`);
            return;
        }
        if (projects.has(projectPath))
        {
            return;
        }
        try
        {
            const absolute = resolve(physicalRoot, projectPath);
            const path = physicalFile(physicalRoot, absolute);
            const bytes = readFileSync(absolute);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const references = physicalProjectReferences(text).map(include =>
            {
                if (isAbsolute(include) || /^[A-Za-z]:/.test(include))
                {
                    throw new Error('absolute ProjectReference is not repository-owned');
                }
                const target = resolve(dirname(absolute), include);
                return physicalFile(physicalRoot, target);
            }).sort();
            projects.set(path, { path, sha256: sha256(bytes), references: [...new Set(references)] });
            active.add(path);
            for (const target of references)
            {
                visit(target);
            }
            active.delete(path);
        }
        catch (error)
        {
            errors.push(`graph: cannot resolve physical project ${projectPath}: ${error.code ?? error.message}`);
        }
    }
    for (const path of entryProjects)
    {
        visit(path);
    }
    function reaches(start, target)
    {
        const pending = [...(projects.get(start)?.references ?? [])];
        const seen = new Set();
        while (pending.length > 0)
        {
            const current = pending.pop();
            if (current === target)
            {
                return true;
            }
            if (!seen.has(current))
            {
                seen.add(current);
                pending.push(...(projects.get(current)?.references ?? []));
            }
        }
        return false;
    }
    const [server, migration, shared] = entryProjects;
    if (reaches(server, migration))
    {
        errors.push('graph: Server → Migration through physical ProjectReference closure');
    }
    if (reaches(migration, server))
    {
        errors.push('graph: Migration → Server through physical ProjectReference closure');
    }
    if (reaches(shared, migration))
    {
        errors.push('graph: CurrentContracts → Migration through physical ProjectReference closure');
    }
    return { scope: 'physical-project-reference-declarations-only', evaluatedAssetsObserved: false,
        directions: { currentContractsFromServer: reaches(server, shared), currentContractsFromMigration: reaches(migration, shared),
            serverToMigration: reaches(server, migration), migrationToServer: reaches(migration, server) },
        projects: [...projects.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
        errors: [...new Set(errors)].sort() };
}

export function bindPhysicalGraphInputs(repositoryRoot, graph)
{
    const physicalRoot = resolve(repositoryRoot);
    const paths = new Set();
    function walk(directory)
    {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            if (entry.name === 'bin' || entry.name === 'obj')
            {
                continue;
            }
            const absolute = join(directory, entry.name);
            if (entry.isSymbolicLink())
            {
                throw new Error('symlink in physical source graph');
            }
            if (entry.isDirectory())
            {
                walk(absolute);
            }
            else if (entry.name.endsWith('.cs'))
            {
                paths.add(physicalFile(physicalRoot, absolute));
            }
        }
    }
    for (const project of graph.projects)
    {
        walk(dirname(resolve(physicalRoot, project.path)));
    }
    const sources = [...paths].sort().map(path => ({ path, sha256: sha256(readFileSync(join(physicalRoot, path))) }));
    const binding = { scope: graph.scope, evaluatedAssetsObserved: false, projects: graph.projects, sources };
    return { ...binding, digest: sha256(JSON.stringify(binding)) };
}

function literalSourceTokens(source)
{
    const tokens = [];
    let position = 0;
    let line = 1;
    function advance(end)
    {
        line += (source.slice(position, end).match(/\n/g) ?? []).length;
        position = end;
    }
    while (position < source.length)
    {
        if (/\s/.test(source[position]))
        {
            advance(position + 1);
            continue;
        }
        if (source.startsWith('//', position))
        {
            const end = source.indexOf('\n', position);
            advance(end < 0 ? source.length : end);
            continue;
        }
        if (source.startsWith('/*', position))
        {
            const end = source.indexOf('*/', position + 2);
            if (end < 0)
            {
                throw new Error('unterminated source comment');
            }
            advance(end + 2);
            continue;
        }
        const prefix = /^(?:\$+@?|@\$?)?["']/.exec(source.slice(position))?.[0];
        if (prefix)
        {
            const startLine = line;
            const quotedAt = position + prefix.length - 1;
            const delimiter = source[quotedAt];
            const verbatim = prefix.includes('@');
            const dynamic = prefix.includes('$');
            const raw = delimiter === '"' ? /^"{3,}/.exec(source.slice(quotedAt))?.[0] : null;
            let end = raw ? source.indexOf(raw, quotedAt + raw.length) : quotedAt + 1;
            let value = '';
            if (raw)
            {
                if (end < 0)
                {
                    throw new Error('unterminated raw source literal');
                }
                value = source.slice(quotedAt + raw.length, end);
                end += raw.length;
            }
            else
            {
                let closed = false;
                let interpolationDepth = 0;
                while (end < source.length)
                {
                    if (dynamic && source[end] === '{')
                    {
                        if (interpolationDepth === 0 && source[end + 1] === '{')
                        {
                            end += 2;
                            continue;
                        }
                        interpolationDepth++;
                    }
                    else if (dynamic && source[end] === '}' && interpolationDepth > 0)
                    {
                        interpolationDepth--;
                    }
                    if (interpolationDepth > 0 && (source[end] === '"' || source[end] === "'"))
                    {
                        const nestedDelimiter = source[end++];
                        while (end < source.length)
                        {
                            if (source[end] === '\\')
                            {
                                end += 2;
                            }
                            else if (source[end++] === nestedDelimiter)
                            {
                                break;
                            }
                        }
                        continue;
                    }
                    if (source[end] === delimiter)
                    {
                        if (verbatim && source[end + 1] === delimiter)
                        {
                            value += delimiter;
                            end += 2;
                            continue;
                        }
                        end++;
                        closed = true;
                        break;
                    }
                    if (!verbatim && source[end] === '\\')
                    {
                        const escape = source[end + 1];
                        const hexadecimal = /^(?:u[0-9a-f]{4}|U[0-9a-f]{8}|x[0-9a-f]{1,4})/i.exec(source.slice(end + 1))?.[0];
                        if (hexadecimal)
                        {
                            value += String.fromCodePoint(Number.parseInt(hexadecimal.slice(1), 16));
                            end += hexadecimal.length + 1;
                            continue;
                        }
                        value += ({ n: '\n', r: '\r', t: '\t', '0': '\0' })[escape] ?? escape;
                        end += 2;
                        continue;
                    }
                    value += source[end++];
                }
                if (!closed)
                {
                    throw new Error('unterminated source literal');
                }
            }
            tokens.push({ kind: dynamic ? 'dynamic-literal' : 'literal', value, line: startLine });
            advance(end);
            continue;
        }
        const identifier = /^@?[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(position))?.[0];
        const value = identifier ?? source[position];
        tokens.push({ kind: identifier ? 'identifier' : 'symbol', value: value.replace(/^@/, ''), line });
        advance(position + value.length);
    }
    return tokens;
}

// A targeted literal/const-alias diagnostic, not a C# semantic or runtime loader proof.
// Unresolved expressions and compiled/generated loading remain unobserved in terminal acceptance.
export function findMigrationLoadingLiterals(source)
{
    const tokens = literalSourceTokens(source);
    const constants = new Map();
    const definitions = [];
    const names = new Set();
    const ambiguous = new Set();
    for (let i = 0; i < tokens.length - 4; i++)
    {
        if (tokens[i].value === 'const' && tokens[i + 1].value === 'string' && tokens[i + 3].value === '=')
        {
            let end = i + 4;
            while (end < tokens.length && tokens[end].value !== ';')
            {
                end++;
            }
            const name = tokens[i + 2].value;
            if (names.has(name))
            {
                ambiguous.add(name);
            }
            names.add(name);
            definitions.push({ name, expression: tokens.slice(i + 4, end) });
        }
    }
    for (let pass = 0; pass < definitions.length; pass++)
    {
        let changed = false;
        for (const { name, expression } of definitions)
        {
            if (ambiguous.has(name) || constants.has(name))
            {
                continue;
            }
            const pieces = [];
            let resolved = expression.length > 0;
            for (const token of expression)
            {
                if (token.kind === 'literal')
                {
                    pieces.push(token.value);
                }
                else if (token.kind === 'identifier' && constants.has(token.value))
                {
                    pieces.push(constants.get(token.value));
                }
                else if (!['+', '(', ')'].includes(token.value))
                {
                    resolved = false;
                }
            }
            if (resolved)
            {
                constants.set(name, pieces.join(''));
                changed = true;
            }
        }
        if (!changed)
        {
            break;
        }
    }
    const matches = [];
    for (let i = 0; i < tokens.length; i++)
    {
        const method = tokens[i].value;
        const receiver = tokens[i - 2]?.value;
        const assemblyCall = receiver === 'Assembly' && ['Load', 'LoadFrom', 'LoadFile', 'LoadWithPartialName'].includes(method);
        const reflectionCall = receiver === 'Type' && method === 'GetType'
            || receiver === 'Activator' && method === 'CreateInstance';
        const contextCall = ['LoadFromAssemblyPath', 'LoadFromAssemblyName', 'LoadFromStream'].includes(method);
        const keyedCall = ['AddKeyedSingleton', 'AddKeyedScoped', 'AddKeyedTransient', 'GetKeyedService', 'GetRequiredKeyedService'].includes(method);
        if (!assemblyCall && !reflectionCall && !contextCall && !keyedCall)
        {
            continue;
        }
        let start = i + 1;
        if (tokens[start]?.value === '<')
        {
            let depth = 1;
            while (++start < tokens.length && depth > 0)
            {
                depth += tokens[start].value === '<' ? 1 : tokens[start].value === '>' ? -1 : 0;
            }
        }
        if (tokens[start]?.value !== '(')
        {
            continue;
        }
        let depth = 1;
        const values = [];
        for (let j = start + 1; j < tokens.length && depth > 0; j++)
        {
            const token = tokens[j];
            depth += token.value === '(' ? 1 : token.value === ')' ? -1 : 0;
            if (token.kind === 'literal')
            {
                values.push(token.value);
            }
            else if (token.kind === 'identifier' && constants.has(token.value))
            {
                values.push(constants.get(token.value));
            }
        }
        const value = values.find(item => /(?:^|[^A-Za-z0-9_])FsusBlog\.Migration(?:[^A-Za-z0-9_]|$)/.test(item)) ?? null;
        if (value !== null)
        {
            matches.push({ line: tokens[i].line, kind: keyedCall ? 'keyed-di-alias' : 'reflection-assembly-load', value });
        }
    }
    return matches;
}

function main()
{
    const serverProject = read('src/backend/FsusBlog.Server.csproj').replaceAll('\\', '/');
    const migrationProject = read('src/migration/FsusBlog.Migration.csproj').replaceAll('\\', '/');
    const sharedProject = read('src/shared/FsusBlog.Shared.csproj').replaceAll('\\', '/');
    reject(/FsusBlog\.Migration\.csproj/.test(serverProject), 'graph: Server → Migration');
    reject(/FsusBlog\.Server\.csproj/.test(migrationProject), 'graph: Migration → Server');
    reject(!/shared\/FsusBlog\.Shared\.csproj/.test(serverProject), 'graph: Server does not reference CurrentContracts');
    reject(!/shared\/FsusBlog\.Shared\.csproj/.test(migrationProject), 'graph: Migration does not reference CurrentContracts');
    reject(/FsusBlog\.Migration/.test(sharedProject), 'graph: CurrentContracts → Migration');

    const serverText = files('src/backend').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n');
    const migrationText = files('src/migration').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n');
    const physicalGraph = inspectPhysicalProjectGraph(root);
    failures.push(...physicalGraph.errors);
    let graphBinding = null;
    try
    {
        graphBinding = bindPhysicalGraphInputs(root, physicalGraph);
        const serverProjects = new Set();
        const pending = ['src/backend/FsusBlog.Server.csproj'];
        while (pending.length > 0)
        {
            const current = pending.pop();
            if (!serverProjects.has(current))
            {
                serverProjects.add(current);
                pending.push(...(physicalGraph.projects.find(project => project.path === current)?.references ?? []));
            }
        }
        const serverDirectories = [...serverProjects].map(path => dirname(path) + '/');
        for (const source of graphBinding.sources.filter(input => serverDirectories.some(directory => input.path.startsWith(directory))))
        {
            for (const diagnostic of findMigrationLoadingLiterals(readFileSync(join(root, source.path), 'utf8')))
            {
                failures.push(`source: ${diagnostic.kind} loads Migration at ${source.path}:${diagnostic.line}`);
            }
        }
    }
    catch (error)
    {
        failures.push(`graph: cannot bind complete physical source inputs: ${error.code ?? error.message}`);
    }
    reject(/using\s+FsusBlog\.Migration|FsusBlog\.Migration\./.test(serverText), 'source: Server imports Migration');
    reject(/using\s+FsusBlog\.Server|Microsoft\.AspNetCore|IHostedService/.test(migrationText), 'source: Migration imports Server/runtime');
    reject(/TypeForwardedTo|namespace\s+FsusBlog\.Server\.Infrastructure\.SchemaMigration/.test(migrationText), 'source: type-forwarder or compat namespace');
    reject(/LastUsernameUpdateTime|RefreshTokenExpiryTime/i.test(files('src/shared').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n')), 'shared current contract contains a legacy column');

    for (const error of validateCurrentSchemaAuthority(root))
    {
        failures.push(`current-schema-authority: ${error}`);
    }

    reject(/CopyToPublishDirectory[\s\S]{0,200}migration/i.test(serverProject), 'publish: Server copies migration source');
    const publishRoots = [
        join(root, 'src/backend/bin/Release/net10.0/publish'),
        join(root, '.tmp/publish')
    ];
    let publishScanned = false;
    for (const publishRoot of publishRoots)
    {
        if (!existsSync(publishRoot))
        {
            continue;
        }
        publishScanned = true;
        const published = readdirSync(publishRoot, { recursive: true }).map(String);
        reject(published.length === 0, `publish: published output is empty: ${publishRoot}`);
        reject(published.some(name => /FsusBlog\.Migration/i.test(name)), `publish residue: ${publishRoot} contains Migration assembly`);
        reject(published.some(name => /Npgsql\.EntityFramework|MySqlConnector|SQLitePCL/i.test(name) && /migration/i.test(name)), `publish residue: provider package in ${publishRoot}`);
    }


    const authorityErrors = validateCurrentSchemaAuthority(root);
    const receipt = {
        schema: 'fsusblog.migration-terminal-acceptance.v1',
        sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
        graph: {
            scope: physicalGraph.scope,
            directions: physicalGraph.directions,
            digest: graphBinding?.digest ?? null,
            evaluatedAssetsObserved: false,
            compiledLoadingObserved: false
        },
        currentSchemaAuthority: {
            exactOne: authorityErrors.length === 0,
            errors: authorityErrors
        },
        publish: {
            scanned: publishScanned,
            residue: 0
        },
        providers: {
            postgresql: 'not-observed',
            mysql: 'not-observed',
            sqlite: 'not-observed'
        },
        mutation: {
            classes: [
                'server-migration-reference',
                'legacy-descriptor-import',
                'reflection-or-di-alias',
                'shared-legacy-column',
                'migration-runtime-import',
                'type-forwarder',
                'dual-assembly-registration',
                'old-schema-startup-write',
                'publish-residue',
                'second-current-schema-inventory'
            ],
            status: 'not-observed'
        },
        benchmark: {
            status: 'not-evaluable',
            reason: 'three-provider cold-readiness hosts were not started in this worktree; no fabricated 0% delta'
        },
        warnings,
        warningsCount: warnings.length,
        failures
    };

    // Static source inspection does not observe executable provider, mutation or
    // benchmark results. Missing observations must not become an acceptance receipt.
    reject(!receipt.graph.evaluatedAssetsObserved || !receipt.graph.compiledLoadingObserved,
        'graph: evaluated compile/runtime assets and compiled loading observations are missing');
    reject(!publishScanned, 'publish: no published output was observed');
    reject(
        Object.values(receipt.providers).some(status => status !== 'passed'),
        'providers: executable PostgreSQL, MySQL and SQLite observations are missing');
    reject(receipt.mutation.status !== 'passed', 'mutation: terminal mutation results were not observed');
    reject(receipt.benchmark.status === 'not-evaluable', 'benchmark: not-evaluable cannot qualify terminal acceptance');

    if (failures.length > 0)
    {
        for (const failure of failures)
        {
            console.error(`[migration-terminal-governance] ${failure}`);
        }
        process.exitCode = 1;
    }
    else
    {
        if (process.argv.includes('--write'))
        {
            const output = join(root, 'artifacts/schema-migration/terminal-acceptance-receipt.json');
            mkdirSync(dirname(output), { recursive: true });
            writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
            console.log('[migration-terminal-governance] wrote artifacts/schema-migration/terminal-acceptance-receipt.json');
        }
        console.log('[migration-terminal-governance] ok graph exact-one publish-residue=0 warnings=' + warnings.length);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
