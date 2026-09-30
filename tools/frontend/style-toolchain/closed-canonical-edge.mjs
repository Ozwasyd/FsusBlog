import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'espree';

export const authorityRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const edgeRegistryPath = 'config/development/canonical-digest-edge.json';
const caller = 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
const owner = 'tools/fact-extractors/lib/canonicalize.mjs';
const specifier = '../fact-extractors/lib/canonicalize.mjs';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const initialModuleDigest = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
const initialRegistryBytes = regularSource(authorityRoot, edgeRegistryPath);
const ignoredAstKeys = new Set(['start', 'end', 'loc', 'range', 'raw', 'parent']);
const authorityFiles = [
    edgeRegistryPath,
    'config/development/frontend-style-policy.json',
    'config/development/frontend-style-rule-registry.json',
    'eslint.config.mjs', 'stylelint.config.mjs',
    'tools/frontend/style-toolchain/eslint.config.mjs',
    'tools/frontend/style-toolchain/stylelint.config.mjs',
    'tools/frontend/style-toolchain/package.json',
    'tools/frontend/style-toolchain/package-lock.json'
];
const initialAuthorityDigest = authorityDigest();

function authorityDigest()
{
    const digest = createHash('sha256');
    for (const relative of authorityFiles)
    {
        digest.update(relative).update(regularSource(authorityRoot, relative));
    }
    const dependencyRoot = path.join(authorityRoot, 'tools/frontend/style-toolchain/node_modules');
    function visit(directory)
    {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error('authority toolchain directory is redirected');
        }
        for (const entry of fs.readdirSync(directory).sort())
        {
            const absolute = path.join(directory, entry);
            const relative = path.relative(dependencyRoot, absolute);
            const info = fs.lstatSync(absolute);
            digest.update(`${relative}\0${info.mode}\0`);
            if (info.isDirectory())
            {
                visit(absolute);
            }
            else if (info.isFile())
            {
                digest.update(fs.readFileSync(absolute));
            }
            else if (info.isSymbolicLink() && path.dirname(relative) === '.bin')
            {
                const target = fs.realpathSync(absolute);
                if (!target.startsWith(`${dependencyRoot}${path.sep}`) || !fs.statSync(target).isFile())
                {
                    throw new Error('authority executable alias escaped the locked toolchain');
                }
                digest.update(fs.readlinkSync(absolute));
            }
            else
            {
                throw new Error('authority toolchain has a nonregular dependency');
            }
        }
    }
    visit(dependencyRoot);
    return digest.digest('hex');
}

function keys(value, expected)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function semanticTree(value)
{
    if (Array.isArray(value))
    {
        return value.map(semanticTree);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort()
            .filter((key) => !ignoredAstKeys.has(key))
            .map((key) => [key, semanticTree(value[key])]));
    }
    return value;
}

export function semanticDigest(source)
{
    return sha256(JSON.stringify(semanticTree(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }))));
}

export function regularSource(root, relative)
{
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
        || relative.split('/').some((part) => !part || part === '.' || part === '..')
        || relative.includes('\\'))
    {
        throw new Error('closed edge path is not canonical');
    }
    const resolvedRoot = path.resolve(root);
    if (fs.realpathSync(resolvedRoot) !== resolvedRoot)
    {
        throw new Error('closed edge root is redirected');
    }
    let current = resolvedRoot;
    for (const part of relative.split('/'))
    {
        current = path.join(current, part);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || (current !== path.join(resolvedRoot, relative) && !stat.isDirectory()))
        {
            throw new Error('closed edge path is redirected or nonregular');
        }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isFile() || (stat.mode & 0o111) !== 0 || stat.size > 1024 * 1024)
    {
        throw new Error('closed edge source is nonregular or has executable mode');
    }
    return fs.readFileSync(current, 'utf8');
}

function walk(node, visit)
{
    if (!node || typeof node !== 'object')
    {
        return;
    }
    if (Array.isArray(node))
    {
        node.forEach((child) => walk(child, visit));
        return;
    }
    if (node.type)
    {
        visit(node);
    }
    for (const [key, value] of Object.entries(node))
    {
        if (!ignoredAstKeys.has(key))
        {
            walk(value, visit);
        }
    }
}

export function assertCanonicalLanguage(ast)
{
    const allowedNodes = new Set([
        'Program', 'ImportDeclaration', 'ImportSpecifier', 'Identifier', 'Literal',
        'ExportNamedDeclaration', 'VariableDeclaration', 'VariableDeclarator',
        'ArrowFunctionExpression', 'LogicalExpression', 'BinaryExpression', 'UnaryExpression',
        'CallExpression', 'MemberExpression', 'FunctionDeclaration', 'BlockStatement',
        'IfStatement', 'ReturnStatement', 'ArrayExpression'
    ]);
    const names = new Set([
        'createHash', 'isPlainObject', 'value', 'stable', 'Object', 'Array', 'JSON',
        'canonicalize', 'digestValue', 'digestText', 'digestBuffer', 'text', 'buffer', 'key',
        'isArray', 'map', 'fromEntries', 'keys', 'sort', 'stringify', 'update', 'digest'
    ]);
    walk(ast, (node) =>
    {
        if (!allowedNodes.has(node.type) || (node.type === 'Identifier' && !names.has(node.name)))
        {
            throw new Error(`canonical capability is outside the finite language: ${node.type}`);
        }
        if (node.type === 'MemberExpression' && node.computed
            && !(node.object.type === 'Identifier' && node.object.name === 'value'
                && node.property.type === 'Identifier' && node.property.name === 'key'))
        {
            throw new Error('canonical computed ambient access is forbidden');
        }
    });
    const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
    if (imports.length !== 1 || imports[0].source.value !== 'node:crypto'
        || imports[0].specifiers.length !== 1 || imports[0].specifiers[0].type !== 'ImportSpecifier'
        || imports[0].specifiers[0].imported.name !== 'createHash'
        || imports[0].specifiers[0].local.name !== 'createHash')
    {
        throw new Error('canonical transitive closure is not the single crypto value capability');
    }
}

function readRegistry()
{
    if (initialModuleDigest !== sha256(fs.readFileSync(fileURLToPath(import.meta.url))))
    {
        throw new Error('cached classifier authority drift');
    }
    if (initialAuthorityDigest !== authorityDigest())
    {
        throw new Error('cached configuration, parser or toolchain authority drift');
    }
    const registryBytes = regularSource(authorityRoot, edgeRegistryPath);
    if (registryBytes !== initialRegistryBytes)
    {
        throw new Error('cached edge registry authority drift');
    }
    const registry = JSON.parse(registryBytes);
    if (!keys(registry, ['schema', 'edge', 'ownerSemanticSha256', 'callerSemanticSha256', 'previousPolicySha256'])
        || registry.schema !== 'fsusblog.canonical-digest-edge.v1'
        || !keys(registry.edge, ['caller', 'owner', 'specifier', 'symbol'])
        || registry.edge.caller !== caller || registry.edge.owner !== owner
        || registry.edge.specifier !== specifier || registry.edge.symbol !== 'digestValue'
        || !/^[a-f0-9]{64}$/u.test(registry.ownerSemanticSha256)
        || !Array.isArray(registry.callerSemanticSha256) || registry.callerSemanticSha256.length !== 2
        || new Set(registry.callerSemanticSha256).size !== 2
        || registry.callerSemanticSha256.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))
        || !keys(registry.previousPolicySha256, [
            'config/development/frontend-style-policy.json', 'eslint.config.mjs', 'stylelint.config.mjs',
            'tools/frontend/style-toolchain/eslint.config.mjs'
        ]))
    {
        throw new Error('closed canonical edge registry is not the exact finite decision');
    }
    return registry;
}

export function validateCandidatePolicy(candidateRoot)
{
    const registry = readRegistry();
    for (const [relative, previous] of Object.entries(registry.previousPolicySha256))
    {
        const actual = sha256(regularSource(candidateRoot, relative));
        if (actual !== previous && actual !== sha256(regularSource(authorityRoot, relative)))
        {
            throw new Error(`candidate policy drift: ${relative}`);
        }
    }
    const candidateRegistry = path.join(candidateRoot, edgeRegistryPath);
    if (fs.existsSync(candidateRegistry)
        && regularSource(candidateRoot, edgeRegistryPath) !== regularSource(authorityRoot, edgeRegistryPath))
    {
        throw new Error('candidate edge registry cannot author its own decision');
    }
}

export function admitCanonicalEdge(candidateRoot, filename, importNode, sourceText)
{
    const relative = path.relative(path.resolve(candidateRoot), path.resolve(filename)).split(path.sep).join('/');
    if (relative !== caller)
    {
        return false;
    }
    if (importNode.source.value !== specifier)
    {
        return false;
    }
    validateCandidatePolicy(candidateRoot);
    const registry = readRegistry();
    const callerSource = regularSource(candidateRoot, caller);
    if (callerSource !== sourceText || importNode.type !== 'ImportDeclaration'
        || importNode.source.value !== specifier || importNode.specifiers.length !== 1
        || importNode.specifiers[0].type !== 'ImportSpecifier'
        || importNode.specifiers[0].imported.name !== 'digestValue'
        || importNode.specifiers[0].local.name !== 'digestValue'
        || !registry.callerSemanticSha256.includes(semanticDigest(callerSource)))
    {
        throw new Error('canonical caller or exact static named edge drift');
    }
    if (path.resolve(path.dirname(filename), specifier) !== path.join(path.resolve(candidateRoot), owner))
    {
        throw new Error('canonical owner resolution drift');
    }
    const ownerSource = regularSource(candidateRoot, owner);
    const ast = parse(ownerSource, { ecmaVersion: 'latest', sourceType: 'module' });
    assertCanonicalLanguage(ast);
    if (semanticDigest(ownerSource) !== registry.ownerSemanticSha256)
    {
        throw new Error('canonical pure value semantics drift');
    }
    return true;
}

export function wrapParentImportRule(original)
{
    return {
        ...original,
        create(context)
        {
            const listeners = original.create(context);
            const legacyImport = listeners.ImportDeclaration;
            const candidateRoot = path.resolve(process.env.FSUSBLOG_STYLE_ROOT ?? authorityRoot);
            return {
                ...listeners,
                Program(node)
                {
                    const relative = path.relative(candidateRoot, context.physicalFilename).split(path.sep).join('/');
                    if (relative === caller)
                    {
                        try
                        {
                            const matchingImports = node.body.filter((entry) => entry.type === 'ImportDeclaration'
                                && entry.source.value === specifier);
                            if (matchingImports.length !== 1
                                || !admitCanonicalEdge(candidateRoot, context.physicalFilename,
                                    matchingImports[0], context.sourceCode.text))
                            {
                                throw new Error('missing or duplicate canonical edge');
                            }
                        }
                        catch (error)
                        {
                            context.report({ node, messageId: 'closedEdgeRefusal', data: { reason: error.message } });
                        }
                    }
                    listeners.Program?.(node);
                },
                ImportDeclaration(node)
                {
                    try
                    {
                        if (admitCanonicalEdge(candidateRoot, context.physicalFilename, node, context.sourceCode.text))
                        {
                            return;
                        }
                    }
                    catch (error)
                    {
                        context.report({ node, messageId: 'closedEdgeRefusal', data: { reason: error.message } });
                    }
                    legacyImport?.(node);
                }
            };
        },
        meta: {
            ...original.meta,
            messages: { ...original.meta.messages, closedEdgeRefusal: 'Closed canonical edge refused: {{reason}}' }
        }
    };
}
