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
const classifierPath = 'tools/frontend/style-toolchain/closed-canonical-edge.mjs';
const initialModuleDigest = sha256(regularSource(authorityRoot, classifierPath));
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
    'tools/frontend/style-toolchain/package-lock.json',
    '.editorconfig',
    'src/frontend/eslint.config.mjs', 'src/frontend/stylelint.config.mjs',
    'tools/frontend/check-frontend-style.mjs',
    'tools/frontend/reviewed-residual-classification.mjs',
    'src/frontend/scripts/run-local-fsusui-typecheck.mjs',
    'src/frontend/scripts/fsusui-root.mjs',
    'src/frontend/tsconfig.node.json'
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
            const info = fs.lstatSync(absolute, { bigint: true });
            digest.update(`${relative}\0${info.mode}\0`);
            if (info.isDirectory())
            {
                visit(absolute);
            }
            else if (info.isFile())
            {
                if (info.nlink !== 1n)
                {
                    throw new Error('authority toolchain input must be a single-link regular file');
                }
                digest.update(stableFileBytes(absolute, info));
            }
            else if (info.isSymbolicLink() && path.basename(path.dirname(relative)) === '.bin')
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

function parseUniqueRegistry(source)
{
    // Validate JSON grammar, then scan retained raw tokens before any object-schema admission.
    const value = JSON.parse(source);
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu) ?? [];
    let position = 0;
    function visitValue()
    {
        const token = tokens[position++];
        if (token === '{')
        {
            const members = new Set();
            if (tokens[position] === '}')
            {
                position += 1;
                return;
            }
            while (position < tokens.length)
            {
                const member = JSON.parse(tokens[position++]);
                if (typeof member !== 'string' || members.has(member))
                {
                    throw new Error('duplicate raw registry member');
                }
                members.add(member);
                if (tokens[position++] !== ':')
                {
                    throw new Error('invalid raw registry member');
                }
                visitValue();
                const separator = tokens[position++];
                if (separator === '}')
                {
                    return;
                }
                if (separator !== ',')
                {
                    throw new Error('invalid raw registry object');
                }
            }
            throw new Error('incomplete raw registry object');
        }
        if (token === '[')
        {
            if (tokens[position] === ']')
            {
                position += 1;
                return;
            }
            while (position < tokens.length)
            {
                visitValue();
                const separator = tokens[position++];
                if (separator === ']')
                {
                    return;
                }
                if (separator !== ',')
                {
                    throw new Error('invalid raw registry array');
                }
            }
            throw new Error('incomplete raw registry array');
        }
        if (token === undefined)
        {
            throw new Error('incomplete raw registry value');
        }
    }
    visitValue();
    if (position !== tokens.length)
    {
        throw new Error('extra raw registry tokens');
    }
    return value;
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
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.nlink !== 1n)
    {
        throw new Error('closed edge source must be a single-link regular file');
    }
    if (!stat.isFile() || (stat.mode & 0o111n) !== 0n || stat.size > 1024n * 1024n)
    {
        throw new Error('closed edge source is nonregular or has executable mode');
    }
    return stableFileBytes(current, stat).toString('utf8');
}

function stableFileBytes(absolute, expected)
{
    // Bind actual reads like the original canonical authority reader, not just path metadata.
    const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n)
        {
            throw new Error('closed edge input must be a single-link regular file');
        }
        if (fields.some((field) => expected[field] !== before[field]))
        {
            throw new Error('closed edge source changed while opening');
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const verificationDescriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let verificationBefore;
        let verificationAfter;
        let verificationBytes;
        try
        {
            verificationBefore = fs.fstatSync(verificationDescriptor, { bigint: true });
            if (!verificationBefore.isFile() || verificationBefore.nlink !== 1n
                || fields.some((field) => after[field] !== verificationBefore[field]))
            {
                throw new Error('closed edge source changed before read verification');
            }
            verificationBytes = fs.readFileSync(verificationDescriptor);
            verificationAfter = fs.fstatSync(verificationDescriptor, { bigint: true });
        }
        finally
        {
            fs.closeSync(verificationDescriptor);
        }
        const current = fs.lstatSync(absolute, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
            || fs.realpathSync(absolute) !== absolute || BigInt(bytes.length) !== before.size
            || !verificationBefore.isFile() || verificationBefore.nlink !== 1n
            || !bytes.equals(verificationBytes)
            || fields.some((field) =>
                expected[field] !== before[field] || before[field] !== after[field]
                || after[field] !== verificationBefore[field]
                || verificationBefore[field] !== verificationAfter[field]
                || verificationAfter[field] !== current[field]))
        {
            throw new Error('closed edge source changed while reading');
        }
        return bytes;
    }
    finally
    {
        fs.closeSync(descriptor);
    }
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
    if (initialModuleDigest !== sha256(regularSource(authorityRoot, classifierPath)))
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
    const registry = parseUniqueRegistry(registryBytes);
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
            'tools/frontend/style-toolchain/eslint.config.mjs',
            '.editorconfig', 'src/frontend/eslint.config.mjs', 'src/frontend/stylelint.config.mjs',
            'tools/frontend/check-frontend-style.mjs', 'tools/frontend/reviewed-residual-classification.mjs',
            'config/development/frontend-style-rule-registry.json',
            'tools/frontend/style-toolchain/stylelint.config.mjs',
            'tools/frontend/style-toolchain/package.json', 'tools/frontend/style-toolchain/package-lock.json'
        ])
        || Object.values(registry.previousPolicySha256).some((digest) => !/^[a-f0-9]{64}$/u.test(digest)))
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
    for (const relative of [edgeRegistryPath, 'tools/frontend/style-toolchain/closed-canonical-edge.mjs'])
    {
        if (fs.lstatSync(path.join(candidateRoot, relative), { throwIfNoEntry: false })
            && regularSource(candidateRoot, relative) !== regularSource(authorityRoot, relative))
        {
            throw new Error('candidate edge registry or classifier cannot author its own decision');
        }
    }
}

function refuseInlineDirectives(source)
{
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', comment: true });
    if (ast.comments.some((comment) => /\beslint-(?:disable|enable)\b/u.test(comment.value)))
    {
        throw new Error('closed edge cannot use inline rule directives');
    }
}

export function validateSelectedCanonicalSource(candidateRoot, files)
{
    if (!files.includes(caller))
    {
        return;
    }
    const source = regularSource(candidateRoot, caller);
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const imports = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === specifier);
    if (imports.length !== 1 || !admitCanonicalEdge(candidateRoot, path.join(candidateRoot, caller), imports[0], source))
    {
        throw new Error('missing or duplicate closed canonical source edge');
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
    refuseInlineDirectives(callerSource);
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
    refuseInlineDirectives(ownerSource);
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
