import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from './parse-matrix.mjs';
import { loadPublicShellLocaleGateConfig, resolveGatePath } from './public-shell-locale-gate.mjs';

const {buildLocaleDomainArtifacts} = await import(new URL('../frontend/check-locale-domain-static.mjs', import.meta.url));
const {parseYamlDocument} = await import(new URL('../yaml/parse-document.mjs', import.meta.url));

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalLegacyPaths = [
    'tests/frontend/e2e/public-shell-locale-lifecycle.spec.ts',
    'tests/frontend/fixtures/publicShellLocaleLifecycle.ts'
];
const canonicalForbiddenTokens = [
    '__public-shell-locale-fixture',
    '__advancePublicShellPhase',
    'resetLocaleRuntimeForTests',
    'requestLocale',
    'LocaleToggle',
    'waitForTimeout',
    'flakyAllowlist',
    'warningFilter',
    'second-runner'
];

function readText(root, relative)
{
    return readFile(resolveGatePath(root, relative, 'legacy inventory')).then((value) => value.toString('utf8'));
}

// Use the already locked repository tooling parser, never execute candidate modules.
const requireParser = createRequire(new URL('../frontend/style-toolchain/package.json', import.meta.url));
const ts = requireParser('typescript');
const parserLock = JSON.parse(fs.readFileSync(new URL('../frontend/style-toolchain/package-lock.json', import.meta.url)));
assert.equal(ts.version, parserLock.packages['node_modules/typescript'].version, 'locked TypeScript parser required');

function nodes(root)
{
    const result = [];
    function visit(node)
    {
        result.push(node);
        ts.forEachChild(node, visit);
    }
    visit(root);
    return result;
}

function name(node)
{
    return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null;
}

function resolveActiveImport(root, file, specifier)
{
    const target = specifier.startsWith('/') ? specifier.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const absolute = resolveGatePath(root, target, 'active import');
    if (path.posix.extname(target))
    {
        return target;
    }
    const inside = (candidate) => path.resolve(candidate).startsWith(`${root}${path.sep}`);
    const resolved = ts.resolveModuleName(`./${path.basename(absolute)}`, path.join(path.dirname(absolute), '__active_import__.ts'),
        { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true }, {
            fileExists: (candidate) => inside(candidate) && ts.sys.fileExists(candidate),
            readFile: (candidate) => inside(candidate) ? ts.sys.readFile(candidate) : undefined,
            directoryExists: (candidate) => inside(candidate) && ts.sys.directoryExists(candidate)
        }).resolvedModule;
    return resolved ? path.relative(root, resolved.resolvedFileName).replaceAll(path.sep, '/') : target;
}

// Tokenize only the shell's literal command surface; never execute substitutions.
function shellTokens(source)
{
    const tokens = [];
    tokens.substitutions = [];
    let value = '';
    let quote = null;
    const flush = () =>
    {
        if (value)
        {
            tokens.push(value);
            value = '';
        }
    };
    for (let index = 0; index < source.length; index += 1)
    {
        const character = source[index];
        if (character === '$' && source[index + 1] === '(' && quote !== "'")
        {
            const frames = [null];
            const start = index + 2;
            let end = start;
            for (; end < source.length && frames.length; end += 1)
            {
                const next = source[end];
                const currentQuote = frames.at(-1);
                if (next === '\\' && currentQuote !== "'")
                {
                    end += 1;
                }
                else if (next === '$' && source[end + 1] === '(' && currentQuote !== "'")
                {
                    frames.push(null);
                    end += 1;
                }
                else if (currentQuote)
                {
                    if (next === currentQuote)
                    {
                        frames[frames.length - 1] = null;
                    }
                }
                else if (next === '"' || next === "'")
                {
                    frames[frames.length - 1] = next;
                }
                else if (next === '(')
                {
                    frames.push(null);
                }
                else if (next === ')')
                {
                    frames.pop();
                }
            }
            assert.equal(frames.length, 0, 'unresolved command substitution');
            tokens.substitutions.push(source.slice(start, end - 1));
            value += source.slice(index, end);
            index = end - 1;
        }
        else if (character === '\\' && quote !== "'")
        {
            if (source[index + 1] !== '\n')
            {
                value += source[index + 1] ?? '';
            }
            index += 1;
        }
        else if (quote)
        {
            if (character === quote)
            {
                quote = null;
            }
            else
            {
                value += character;
            }
        }
        else if (character === '"' || character === "'")
        {
            quote = character;
        }
        else if (character === '#' && !value)
        {
            while (index < source.length && source[index] !== '\n')
            {
                index += 1;
            }
            flush();
            tokens.push(';');
        }
        else if (character === '&' && (/[<>]$/u.test(value) || source[index + 1] === '>'))
        {
            value += character;
        }
        else if (/\s/u.test(character) || [';', '|', '&'].includes(character))
        {
            flush();
            if (character === '\n' || [';', '|', '&'].includes(character))
            {
                tokens.push(';');
            }
        }
        else
        {
            value += character;
        }
    }
    assert.equal(quote, null, 'unresolved command quoting');
    flush();
    return tokens;
}

function executableRoots(source, label, matrix)
{
    const tokens = shellTokens(source);
    const roots = [];
    const inline = [];
    let commandPosition = true;
    let condition = false;
    for (const substitution of tokens.substitutions)
    {
        const nested = executableRoots(substitution, label, matrix);
        roots.push(...nested.roots);
        inline.push(...nested.inline);
    }
    for (let index = 0; index < tokens.length; index += 1)
    {
        const token = tokens[index];
        if (condition)
        {
            condition = token !== ']]';
            continue;
        }
        if (token === ';')
        {
            commandPosition = true;
            continue;
        }
        if (commandPosition)
        {
            if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token) || ['then', 'else', 'do', 'exec', 'if', 'elif'].includes(token))
            {
                continue;
            }
            const direct = token.replace(/^\$(?:ROOT_DIR|\{ROOT_DIR\})\//u, '').replace(/^\.\//u, '');
            if (token.startsWith('./') || /^\$(?:ROOT_DIR|\{ROOT_DIR\})\//u.test(token))
            {
                if (direct === 'tools/test.sh')
                {
                    const owners = matrix.tiers.filter((tier) => tier.id === tokens[index + 2]);
                    assert.ok(tokens[index + 1] === 'ci-tier' && owners.length === 1,
                        `${label}: unresolved canonical tier command`);
                    assert.ok(tokens[index + 3] === '--no-deps' && [';', undefined].includes(tokens[index + 4]),
                        `${label}: unresolved canonical tier command arguments`);
                }
                else
                {
                    assert.ok(!/[\s$`]/u.test(direct) && /\.(?:mjs|cjs|js|ts|sh)$/u.test(direct),
                        `${label}: unresolved executable command ${token}`);
                    roots.push(direct);
                }
            }
            else
            {
                assert.ok(['node', '$NODE_BIN', '${NODE_BIN}', 'bash', 'sh', 'set', 'export', 'if', 'elif', 'fi', '[[', ']]',
                    'printf', 'exit', 'cd', 'pwd', 'dirname', 'date', 'timeout', 'corepack', 'for', 'done'].includes(token),
                `${label}: unresolved executable command ${token}`);
                condition = token === '[[';
            }
            commandPosition = false;
        }
        if (!['node', '$NODE_BIN', '${NODE_BIN}', 'bash', 'sh'].includes(token))
        {
            assert.notEqual(token, 'eval', `${label}: unresolved command eval`);
            continue;
        }
        const node = !['bash', 'sh'].includes(token);
        if (node && tokens[index + 1] === '--test')
        {
            continue;
        }
        let argument = index + 1;
        while (tokens[argument]?.startsWith('-'))
        {
            if (['-e', '--eval', '-p', '--print'].includes(tokens[argument]))
            {
                assert.ok(tokens[argument + 1], `${label}: unresolved inline command`);
                inline.push(tokens[argument + 1]);
                argument = -1;
                break;
            }
            argument += 1;
        }
        if (argument < 0)
        {
            continue;
        }
        const file = tokens[argument]?.replace(/^\$(?:ROOT_DIR|\{ROOT_DIR\})\//u, '').replace(/^\.\//u, '');
        assert.ok(file && !/[\s$`]/u.test(file) && /\.(?:mjs|cjs|js|ts|sh)$/u.test(file),
            `${label}: unresolved executable command ${tokens[argument] ?? '<missing>'}`);
        roots.push(file);
    }
    return { roots, inline };
}

function inspectModule(source, file, config, localeCodes, selectedExports = new Set(['*']), depth = 0, entrypoint = false,
    externalEffects = new Set(), sourceRoot = defaultRoot)
{
    assert.ok(depth < 16, `${file}: active import nesting exceeds static admission`);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    assert.equal(ast.parseDiagnostics.length, 0, `${file}: active parser failure`);
    const definitions = nodes(ast);
    const declarations = new Map();
    const imports = [];
    const errors = [];
    const scopeOf = (node) =>
    {
        let current = node.parent;
        while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current) && !ts.isBlock(current)
            && !((ts.isForOfStatement(current) || ts.isForInStatement(current))
                && ts.isVariableDeclarationList(current.initializer) && (current.initializer.flags & ts.NodeFlags.BlockScoped) !== 0))
        {
            current = current.parent;
        }
        return current ?? ast;
    };
    function bind(node, key, value)
    {
        const scope = scopeOf(node);
        if (!declarations.has(scope))
        {
            declarations.set(scope, new Map());
        }
        declarations.get(scope).set(key, value);
    }
    for (const node of definitions)
    {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        {
            if (node.importClause?.name)
            {
                bind(node, node.importClause.name.text, { imported: 'default', module: name(node.moduleSpecifier) });
            }
            if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings))
            {
                bind(node, node.importClause.namedBindings.name.text, { imported: '*', module: name(node.moduleSpecifier) });
            }
            for (const item of node.importClause?.namedBindings?.elements ?? [])
            {
                bind(node, item.name.text, { imported: name(item.propertyName ?? item.name), module: name(node.moduleSpecifier) });
            }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        {
            bind(node, node.name.text, node.initializer ?? { shadow: true });
        }
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name))
        {
            for (const item of node.name.elements)
            {
                if (ts.isIdentifier(item.name))
                {
                    bind(node, item.name.text, { imported: name(item.propertyName ?? item.name) });
                }
            }
        }
        if (ts.isFunctionDeclaration(node) && node.name)
        {
            bind(node, node.name.text, node);
        }
        if (ts.isParameter(node) || ts.isCatchClause(node))
        {
            const binding = ts.isParameter(node) ? node.name : node.variableDeclaration?.name;
            if (binding)
            {
                for (const item of nodes(binding).filter(ts.isIdentifier))
                {
                    bind(node, item.text, { shadow: true });
                }
            }
        }
    }
    function lookup(node, key)
    {
        for (let scope = scopeOf(node); scope; scope = scope === ast ? null : scopeOf(scope))
        {
            if (declarations.get(scope)?.has(key))
            {
                return declarations.get(scope).get(key);
            }
        }
        return null;
    }
    function targetLeaves(target)
    {
        if (!target || ts.isOmittedExpression(target))
        {
            return [];
        }
        if (ts.isParenthesizedExpression(target) || ts.isSpreadElement(target) || ts.isSpreadAssignment(target))
        {
            return targetLeaves(target.expression);
        }
        if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        {
            return targetLeaves(target.left);
        }
        if (ts.isArrayLiteralExpression(target))
        {
            return target.elements.flatMap(targetLeaves);
        }
        if (ts.isObjectLiteralExpression(target))
        {
            return target.properties.flatMap((property) =>
            {
                if (ts.isPropertyAssignment(property))
                {
                    return targetLeaves(property.initializer);
                }
                return ts.isShorthandPropertyAssignment(property) ? [property.name] : targetLeaves(property);
            });
        }
        return ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? [target] : [];
    }
    const writeTargets = definitions.flatMap((node) =>
    {
        if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
        {
            return targetLeaves(node.initializer);
        }
        const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
            : ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ? node.operand : null;
        return targetLeaves(target);
    });
    function stableBinding(node)
    {
        const binding = lookup(node, node.text);
        return !writeTargets.some((target) => ts.isIdentifier(target) && target.text === node.text && lookup(target, target.text) === binding);
    }
    const active = new Set();
    const functions = new Set();
    const references = new Set();
    function globalProcess(node)
    {
        if (!node || !ts.isIdentifier(node) || node.text !== 'process')
        {
            return false;
        }
        const binding = lookup(node, node.text);
        return !binding || (binding.module === 'node:process' && binding.imported === 'default');
    }
    function argvValue(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return false;
        }
        seen = new Set([...seen, node]);
        return (ts.isPropertyAccessExpression(node) && node.name.text === 'argv' && globalProcess(node.expression))
            || (ts.isIdentifier(node) && argvValue(lookup(node, node.text), seen));
    }
    const processStable = !writeTargets.some((target) => argvValue(target) || globalProcess(target)
        || ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && argvValue(target.expression)))
        && !definitions.some((node) =>
        {
            return ts.isCallExpression(node) && (node.arguments.some((argument) => argvValue(argument) || globalProcess(argument))
                || (ts.isPropertyAccessExpression(node.expression) && argvValue(node.expression.expression)
                    && !['slice', 'at', 'includes', 'indexOf', 'join'].includes(node.expression.name.text)));
        });
    function cliValue(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return null;
        }
        seen = new Set([...seen, node]);
        if (ts.isParenthesizedExpression(node))
        {
            return cliValue(node.expression, seen);
        }
        if (ts.isIdentifier(node))
        {
            const binding = lookup(node, node.text);
            return stableBinding(node) && binding?.kind !== undefined ? cliValue(binding, seen) : node;
        }
        return node;
    }
    const builtinStability = new WeakMap();
    function builtinStable(binding)
    {
        if (builtinStability.has(binding))
        {
            return builtinStability.get(binding);
        }
        const refers = (node) =>
        {
            node = cliValue(node);
            return node && ts.isIdentifier(node) && lookup(node, node.text) === binding;
        };
        const stable = !writeTargets.some((target) =>
        {
            while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
            {
                target = target.expression;
            }
            return refers(target);
        }) && !definitions.some((node) => ts.isCallExpression(node) && node.arguments.some(refers));
        builtinStability.set(binding, stable);
        return stable;
    }
    function nodeBuiltin(node, module, member)
    {
        node = cliValue(node);
        if (!node)
        {
            return false;
        }
        if (ts.isIdentifier(node))
        {
            const binding = lookup(node, node.text);
            return stableBinding(node) && binding?.module === module && binding.imported === member && builtinStable(binding);
        }
        if (ts.isPropertyAccessExpression(node) && node.name.text === member && ts.isIdentifier(node.expression))
        {
            const binding = lookup(node.expression, node.expression.text);
            return stableBinding(node.expression) && binding?.module === module && ['default', '*'].includes(binding.imported)
                && builtinStable(binding);
        }
        return false;
    }
    function cliArgument(node)
    {
        node = cliValue(node);
        return node && ts.isElementAccessExpression(node) && argvValue(node.expression)
            && node.argumentExpression.getText(ast) === '1';
    }
    function cliPath(node)
    {
        node = cliValue(node);
        return cliArgument(node) || (node && ts.isCallExpression(node) && node.arguments.length === 1
            && nodeBuiltin(node.expression, 'node:path', 'resolve') && cliArgument(node.arguments[0]));
    }
    function ownModulePath(node)
    {
        node = cliValue(node);
        return node && ts.isCallExpression(node) && node.arguments.length === 1
            && nodeBuiltin(node.expression, 'node:url', 'fileURLToPath') && node.arguments[0].getText(ast) === 'import.meta.url';
    }
    function cliUrl(node)
    {
        node = cliValue(node);
        if (!node || !ts.isPropertyAccessExpression(node) || node.name.text !== 'href')
        {
            return false;
        }
        const call = cliValue(node.expression);
        return call && ts.isCallExpression(call) && call.arguments.length === 1
            && nodeBuiltin(call.expression, 'node:url', 'pathToFileURL') && cliPath(call.arguments[0]);
    }
    function importedCliGuard(node)
    {
        node = cliValue(node);
        if (!node || !ts.isBinaryExpression(node))
        {
            return false;
        }
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        {
            return importedCliGuard(node.left) || importedCliGuard(node.right);
        }
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
        {
            return false;
        }
        return (cliPath(node.left) && ownModulePath(node.right)) || (cliPath(node.right) && ownModulePath(node.left))
            || (cliUrl(node.left) && node.right.getText(ast) === 'import.meta.url')
            || (cliUrl(node.right) && node.left.getText(ast) === 'import.meta.url');
    }
    function visit(node)
    {
        if (!node || active.has(node))
        {
            return;
        }
        active.add(node);
        if (!entrypoint && processStable && ts.isIfStatement(node) && ts.isSourceFile(node.parent)
            && importedCliGuard(node.expression))
        {
            // The proved own-file CLI predicate is false for an imported module; guard expressions and else remain active.
            visit(node.expression);
            visit(node.elseStatement);
            return;
        }
        if (ts.isFunctionLike(node))
        {
            const declaration = ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node.parent);
            if (declaration && !functions.has(node))
            {
                return;
            }
        }
        if (ts.isIdentifier(node) && !(ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent))
            && !(ts.isBindingElement(node.parent) && (node.parent.name === node || node.parent.propertyName === node))
            && !((ts.isFunctionDeclaration(node.parent) || ts.isParameter(node.parent)
                || ts.isVariableDeclaration(node.parent) || ts.isPropertyAccessExpression(node.parent)
                || ts.isPropertyAssignment(node.parent)) && node.parent.name === node))
        {
            references.add(node.text);
            const target = lookup(node, node.text);
            if (target && ts.isFunctionLike(target) && !functions.has(target))
            {
                functions.add(target);
                active.delete(target);
                visit(target);
            }
        }
        ts.forEachChild(node, visit);
    }
    for (const node of definitions)
    {
        if (ts.isFunctionDeclaration(node) && node.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)
            && (selectedExports.has('*') || selectedExports.has(name(node.name))
                || (selectedExports.has('default') && node.modifiers.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword))))
        {
            functions.add(node);
        }
        if (ts.isVariableDeclaration(node) && ts.isFunctionLike(node.initializer ?? {})
            && node.parent.parent.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)
            && (selectedExports.has('*') || selectedExports.has(name(node.name))))
        {
            functions.add(node.initializer);
        }
    }
    visit(ast);
    const all = definitions.filter((node) => active.has(node));
    for (const node of ast.statements)
    {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        {
            const bindings = node.importClause?.namedBindings;
            const names = !node.importClause || (bindings && ts.isNamespaceImport(bindings))
                ? ['*'] : (bindings?.elements ?? []).filter((item) => references.has(item.name.text))
                    .map((item) => name(item.propertyName ?? item.name));
            if (node.importClause?.name && references.has(node.importClause.name.text))
            {
                names.push('default');
            }
            imports.push({ specifier: name(node.moduleSpecifier), names });
        }
    }
    function expression(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return null;
        }
        seen = new Set([...seen, node]);
        if (node.imported)
        {
            return node.imported;
        }
        if (ts.isStringLiteralLike(node))
        {
            return node.text;
        }
        if (ts.isTemplateExpression(node))
        {
            let value = node.head.text;
            for (const span of node.templateSpans)
            {
                const part = expression(span.expression, seen);
                if (typeof part !== 'string' || (ts.isIdentifier(span.expression) && !lookup(span.expression, span.expression.text)))
                {
                    return null;
                }
                value += part + span.literal.text;
            }
            return value;
        }
        if (ts.isIdentifier(node))
        {
            if (!stableBinding(node))
            {
                return null;
            }
            return expression(lookup(node, node.text), seen) ?? node.text;
        }
        if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))
        {
            return expression(node.expression, seen);
        }
        if (ts.isPropertyAccessExpression(node))
        {
            return node.name.text === 'href' ? expression(node.expression, seen)
                : `${expression(node.expression, seen)}.${node.name.text}`;
        }
        if (ts.isElementAccessExpression(node))
        {
            return `${expression(node.expression, seen)}.${expression(node.argumentExpression, seen)}`;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        {
            const left = expression(node.left, seen);
            const right = expression(node.right, seen);
            return left === null || right === null ? null : left + right;
        }
        if (ts.isFunctionLike(node))
        {
            const returns = node.body && (ts.isBlock(node.body)
                ? nodes(node.body).filter(ts.isReturnStatement).map((item) => item.expression) : [node.body]);
            const values = (returns ?? []).map((item) => expression(item, seen));
            const data = values.find((value) => value?.startsWith('data:'));
            // The matrix memoizes only its constructed data URL. Prove each cache
            // return's writes, rather than exempting a filename or helper name.
            const cacheReturns = (returns ?? []).filter((item, index) => !values[index]?.startsWith('data:'));
            const cacheSafe = cacheReturns.every((item) =>
            {
                if (!item || !ts.isCallExpression(item) || !ts.isPropertyAccessExpression(item.expression)
                    || item.expression.name.text !== 'get')
                {
                    return false;
                }
                const object = expression(item.expression.expression, seen);
                const writes = all.filter((candidate) => ts.isCallExpression(candidate)
                    && expression(candidate.expression, seen) === `${object}.set`);
                return writes.length > 0 && writes.every((write) => expression(write.arguments[1], seen)?.startsWith('data:'));
            });
            return data && cacheSafe ? data : null;
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node))
        {
            const callable = expression(node.expression, seen);
            if (callable === 'URL' || callable === 'pathToFileURL')
            {
                return expression(node.arguments?.[0], seen);
            }
            if (callable === 'path.join' || callable === 'path.resolve' || callable === 'default.join' || callable === 'default.resolve')
            {
                const last = node.arguments?.at(-1);
                return last && ts.isStringLiteralLike(last) ? `/${last.text}` : null;
            }
            if (callable?.startsWith('data:'))
            {
                return callable;
            }
        }
        return null;
    }
    function sourceDataFiles(argument, seen = new Set())
    {
        if (!argument || seen.has(argument))
        {
            return null;
        }
        seen = new Set([...seen, argument]);
        if (ts.isAwaitExpression(argument) || ts.isParenthesizedExpression(argument))
        {
            return sourceDataFiles(argument.expression, seen);
        }
        if (ts.isIdentifier(argument))
        {
            return stableBinding(argument) ? sourceDataFiles(lookup(argument, argument.text), seen) : null;
        }
        if (!ts.isCallExpression(argument) || !ts.isIdentifier(argument.expression))
        {
            return null;
        }
        const fn = lookup(argument, argument.expression.text);
        if (!fn || !ts.isFunctionLike(fn) || !fn.body)
        {
            return null;
        }
        const body = nodes(fn.body);
        const returned = body.filter(ts.isReturnStatement).map((item) => item.expression);
        const output = returned.find((item) => ts.isIdentifier(item ?? {})
            && ts.isTemplateExpression(lookup(item, item.text) ?? {}));
        if (!output)
        {
            return null;
        }
        const template = lookup(output, output.text);
        if (template.head.text !== 'data:text/javascript;base64,' || template.templateSpans.length !== 1
            || template.templateSpans[0].literal.text !== '')
        {
            return null;
        }
        const encoded = template.templateSpans[0].expression;
        if (!ts.isCallExpression(encoded) || !ts.isPropertyAccessExpression(encoded.expression)
            || encoded.expression.name.text !== 'toString' || expression(encoded.arguments[0]) !== 'base64')
        {
            return null;
        }
        const buffer = encoded.expression.expression;
        if (!ts.isCallExpression(buffer) || buffer.expression.getText(ast) !== 'Buffer.from' || lookup(buffer, 'Buffer')
            || buffer.arguments.length !== 1 || !ts.isIdentifier(buffer.arguments[0]))
        {
            return null;
        }
        const codeName = buffer.arguments[0].text;
        const transform = lookup(buffer, codeName);
        if (!transform || !ts.isCallExpression(transform) || !ts.isIdentifier(transform.expression)
            || lookup(transform, transform.expression.text)?.module !== 'node:module'
            || lookup(transform, transform.expression.text)?.imported !== 'stripTypeScriptTypes'
            || transform.arguments.length !== 1 || !ts.isIdentifier(transform.arguments[0]))
        {
            return null;
        }
        const loaded = lookup(transform, transform.arguments[0].text);
        const read = ts.isAwaitExpression(loaded ?? {}) ? loaded.expression : loaded;
        const reader = read && ts.isCallExpression(read) && ts.isIdentifier(read.expression) ? lookup(read, read.expression.text) : null;
        if (!reader || !ts.isFunctionLike(reader) || !reader.body || read.arguments.length !== 1
            || name(read.arguments[0]) !== name(fn.parameters[0]?.name))
        {
            return null;
        }
        const fileReads = nodes(reader.body).filter((item) => ts.isCallExpression(item) && ts.isIdentifier(item.expression)
            && lookup(item, item.expression.text)?.module === 'node:fs/promises'
            && lookup(item, item.expression.text)?.imported === 'readFile');
        if (fileReads.length !== 1)
        {
            return null;
        }
        const filename = fileReads[0].arguments[0];
        if (!filename || !ts.isCallExpression(filename) || filename.arguments.length !== 2
            || expression(filename.expression) !== 'default.join'
            || name(filename.arguments[1]) !== name(reader.parameters[0]?.name))
        {
            return null;
        }
        const readDeclaration = fileReads[0].parent.parent;
        const bytesName = ts.isVariableDeclaration(readDeclaration) ? name(readDeclaration.name) : null;
        const readerReturns = nodes(reader.body).filter(ts.isReturnStatement);
        if (!bytesName || readerReturns.length !== 1 || !ts.isCallExpression(readerReturns[0].expression ?? {})
            || readerReturns[0].expression.expression.getText(ast) !== `${bytesName}.toString`
            || expression(readerReturns[0].expression.arguments[0]) !== 'utf8')
        {
            return null;
        }
        const stableNames = new Set([bytesName, transform.arguments[0].text, output.text]);
        if (definitions.some((item) => (ts.isBinaryExpression(item)
            && item.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && item.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && stableNames.has(name(item.left))) || ((ts.isPostfixUnaryExpression(item) || ts.isPrefixUnaryExpression(item))
            && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(item.operator)
            && stableNames.has(name(item.operand)))))
        {
            return null;
        }
        // The only admitted code rewrite is the loader's literal import substitution.
        for (const write of body.filter((item) => ts.isBinaryExpression(item) && name(item.left) === codeName))
        {
            const replacement = write.right;
            if (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isCallExpression(replacement)
                || !ts.isPropertyAccessExpression(replacement.expression) || name(replacement.expression.expression) !== codeName
                || replacement.expression.name.text !== 'replaceAll' || replacement.arguments.length !== 2
                || !replacement.arguments.every((item) => ts.isTemplateExpression(item) && item.head.text === "'"
                    && item.templateSpans.length === 1 && item.templateSpans[0].literal.text === "'"))
            {
                return null;
            }
            let loop = write.parent;
            while (loop && !ts.isForOfStatement(loop))
            {
                loop = loop.parent;
            }
            if (!loop || !ts.isCallExpression(loop.expression) || loop.expression.expression.getText(ast) !== 'Object.entries'
                || name(loop.expression.arguments[0]) !== name(fn.parameters[1]?.name)
                || !ts.isVariableDeclarationList(loop.initializer)
                || !ts.isArrayBindingPattern(loop.initializer.declarations[0]?.name ?? {}))
            {
                return null;
            }
            const bindings = loop.initializer.declarations[0].name.elements.map((item) => name(item.name));
            if (bindings.length !== 2 || replacement.arguments.some((item, index) =>
                name(item.templateSpans[0].expression) !== bindings[index]))
            {
                return null;
            }
        }
        const cacheReturns = returned.filter((item) => item !== output);
        if (!cacheReturns.every((item) =>
        {
            if (!item || !ts.isCallExpression(item) || !ts.isPropertyAccessExpression(item.expression)
                || item.expression.name.text !== 'get' || !ts.isIdentifier(item.expression.expression))
            {
                return false;
            }
            const cache = lookup(item, item.expression.expression.text);
            const writes = definitions.filter((write) => ts.isCallExpression(write)
                && ts.isPropertyAccessExpression(write.expression) && write.expression.name.text === 'set'
                && write.expression.expression.getText(ast) === item.expression.expression.getText(ast));
            return cache && ts.isNewExpression(cache) && name(cache.expression) === 'Map' && !lookup(cache, 'Map')
                && writes.length > 0 && writes.every((write) => name(write.arguments[1]) === output.text);
        }))
        {
            return null;
        }
        let pathValue = argument.arguments[0];
        const pathAliases = new Set();
        while (pathValue && ts.isIdentifier(pathValue) && !pathAliases.has(pathValue))
        {
            pathAliases.add(pathValue);
            pathValue = lookup(pathValue, pathValue.text);
        }
        const relative = expression(pathValue);
        let files = typeof relative === 'string' && (ts.isStringLiteralLike(pathValue ?? {})
            || ts.isTemplateExpression(pathValue ?? {})) ? [relative] : null;
        if (!files && ts.isPropertyAccessExpression(argument.arguments[0]) && argument.arguments[0].name.text === 'relativeFile')
        {
            const binding = argument.arguments[0].expression.getText(ast);
            for (let parent = argument.parent; parent; parent = parent.parent)
            {
                if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)
                    || name(parent.initializer.declarations[0]?.name) !== binding || !ts.isCallExpression(parent.expression)
                    || !ts.isIdentifier(parent.expression.expression))
                {
                    continue;
                }
                const producer = lookup(parent.expression, parent.expression.expression.text);
                const producerFile = producer?.module?.startsWith('.')
                    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), producer.module)) : null;
                if (producerFile === 'tools/frontend/check-locale-domain-static.mjs' && producer.imported === 'buildLocaleDomainArtifacts'
                    && parent.expression.arguments.length === 1 && ts.isObjectLiteralExpression(parent.expression.arguments[0])
                    && parent.expression.arguments[0].properties.length === 1
                    && name(parent.expression.arguments[0].properties[0].name) === 'rootDir')
                {
                    files = buildLocaleDomainArtifacts({ rootDir: sourceRoot }).map((item) => item.relativeFile);
                }
            }
        }
        if (!files)
        {
            return null;
        }
        if (argument.arguments[1])
        {
            if (!ts.isObjectLiteralExpression(argument.arguments[1]))
            {
                return null;
            }
            for (const mapping of argument.arguments[1].properties)
            {
                if (!ts.isPropertyAssignment(mapping) || !ts.isStringLiteralLike(mapping.name))
                {
                    return null;
                }
                const replacement = sourceDataFiles(mapping.initializer, seen);
                if (!replacement)
                {
                    return null;
                }
                files.push(...replacement);
            }
        }
        return files;
    }
    function dataPayloads(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return null;
        }
        seen = new Set([...seen, node]);
        if (ts.isIdentifier(node))
        {
            return stableBinding(node) ? dataPayloads(lookup(node, node.text), seen) : null;
        }
        if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))
        {
            return dataPayloads(node.expression, seen);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        {
            const fn = lookup(node, node.expression.text);
            if (fn && ts.isFunctionLike(fn) && fn.body)
            {
                const candidates = nodes(fn.body).filter((item) => ts.isReturnStatement(item) && enclosingFunction(item) === fn)
                    .map((item) => dataPayloads(item.expression, seen));
                return candidates.length > 0 && candidates.every((item) => item?.length)
                    ? [...new Set(candidates.flat())] : null;
            }
        }
        const value = expression(node);
        return typeof value === 'string' && value.startsWith('data:') ? [value] : null;
    }
    const calls = all.filter(ts.isCallExpression);
    const browserActions = new Set(['goto', 'click', 'reload', 'goBack', 'goForward', 'launch', 'launchPersistentContext']);
    function importedKey(binding)
    {
        if (!binding?.module?.startsWith('.'))
        {
            return null;
        }
        return `${resolveActiveImport(sourceRoot, file, binding.module)}:${binding.imported}`;
    }
    function functionKey(node)
    {
        return `${file}:${name(node.name ?? node.parent?.name)
            ?? (node.modifiers?.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : node.pos)}`;
    }
    function enclosingFunction(node)
    {
        for (let current = node.parent; current; current = current.parent)
        {
            if (ts.isFunctionLike(current))
            {
                return current;
            }
        }
        return null;
    }
    function callableKey(node)
    {
        const binding = callTarget(node);
        return binding && ts.isFunctionLike(binding) ? functionKey(binding) : importedKey(binding);
    }
    function callTarget(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return null;
        }
        seen = new Set([...seen, node]);
        if (ts.isIdentifier(node))
        {
            const binding = lookup(node, node.text);
            return binding && ts.isIdentifier(binding) ? callTarget(binding, seen) : binding;
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
        {
            const binding = lookup(node, node.expression.text);
            if (binding?.imported === '*')
            {
                return { ...binding, imported: node.name.text };
            }
            if (binding && ts.isObjectLiteralExpression(binding))
            {
                const property = binding.properties.find((item) => name(item.name) === node.name.text);
                return property && callTarget(property.initializer ?? property.name, seen);
            }
        }
        return null;
    }
    function origins(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return [];
        }
        seen = new Set([...seen, node]);
        if (ts.isIdentifier(node))
        {
            const fn = enclosingFunction(node);
            const parameter = fn?.parameters.findIndex((item) => name(item.name) === node.text) ?? -1;
            if (parameter >= 0)
            {
                return [`${functionKey(fn)}#parameter:${parameter}`];
            }
            return origins(lookup(node, node.text), seen);
        }
        if (ts.isCallExpression(node))
        {
            return [callableKey(node.expression), ...node.arguments.flatMap((item) => origins(item, seen))].filter(Boolean);
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
            || ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))
        {
            return origins(node.expression, seen);
        }
        if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))
        {
            return [`${file}#record:${node.pos}`, ...(ts.isObjectLiteralExpression(node) ? node.properties : node.elements)
                .flatMap((item) => origins(item.initializer ?? item.expression ?? item, seen))];
        }
        return [];
    }
    const browserEffects = new WeakMap();
    function hasBrowserAction(node, seen = new Set())
    {
        if (!node || seen.has(node))
        {
            return false;
        }
        if (browserEffects.has(node))
        {
            return browserEffects.get(node);
        }
        const completeSearch = seen.size === 0;
        seen = new Set([...seen, node]);
        const result = nodes(node).some((item) =>
        {
            if (!ts.isCallExpression(item) || !active.has(item))
            {
                return false;
            }
            if (browserActions.has(expression(item.expression)?.split('.').at(-1)))
            {
                return true;
            }
            const callee = callTarget(item.expression);
            return (callee && ts.isFunctionLike(callee) && hasBrowserAction(callee.body, seen))
                || externalEffects.has(importedKey(callee));
        });
        // A positive has a concrete reachable action. A negative is reusable
        // only after an entire root search, never a cycle-truncated subsearch.
        if (result || completeSearch)
        {
            browserEffects.set(node, result);
        }
        return result;
    }
    function inBrowserOperation(node)
    {
        for (let scope = scopeOf(node); scope && scope !== ast; scope = scopeOf(scope))
        {
            if (hasBrowserAction(scope))
            {
                return true;
            }
        }
        return false;
    }
    function singleCandidateSelection(loop)
    {
        // One indexed candidate search, one visible candidate click and an
        // immediate function return cannot repeat an action after a failure.
        if (!ts.isForStatement(loop) || !ts.isVariableDeclarationList(loop.initializer ?? {})
            || loop.initializer.declarations.length !== 1 || !ts.isBlock(loop.statement)
            || loop.statement.statements.length !== 1)
        {
            return false;
        }
        const declaration = loop.initializer.declarations[0];
        const index = name(declaration.name);
        const increment = loop.incrementor;
        const nextCandidate = (ts.isPostfixUnaryExpression(increment ?? {})
            && increment.operator === ts.SyntaxKind.PlusPlusToken && name(increment.operand) === index)
            || (ts.isBinaryExpression(increment ?? {}) && increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
                && name(increment.left) === index && ts.isNumericLiteral(increment.right) && increment.right.text === '1');
        const unwrap = (node) => ts.isAwaitExpression(node ?? {}) ? node.expression : node;
        const count = unwrap(loop.condition?.right);
        const branch = loop.statement.statements[0];
        const visible = ts.isIfStatement(branch) ? unwrap(branch.expression) : null;
        const candidate = visible && ts.isCallExpression(visible) && ts.isPropertyAccessExpression(visible.expression)
            ? visible.expression.expression : null;
        if (!index || declaration.initializer?.getText(ast) !== '0'
            || !ts.isBinaryExpression(loop.condition ?? {}) || loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken
            || name(loop.condition.left) !== index || !nextCandidate
            || !count || !ts.isCallExpression(count) || !ts.isPropertyAccessExpression(count.expression)
            || count.expression.name.text !== 'count' || count.arguments.length !== 0
            || !visible || visible.expression.name.text !== 'isVisible' || visible.arguments.length !== 0
            || !candidate || !ts.isCallExpression(candidate) || !ts.isPropertyAccessExpression(candidate.expression)
            || candidate.expression.name.text !== 'nth' || candidate.arguments.length !== 1
            || name(candidate.arguments[0]) !== index
            || candidate.expression.expression.getText(ast) !== count.expression.expression.getText(ast)
            || branch.elseStatement || !ts.isBlock(branch.thenStatement) || branch.thenStatement.statements.length !== 2)
        {
            return false;
        }
        const [action, terminal] = branch.thenStatement.statements;
        const click = ts.isExpressionStatement(action) ? unwrap(action.expression) : null;
        return click && ts.isCallExpression(click) && ts.isPropertyAccessExpression(click.expression)
            && click.expression.name.text === 'click' && click.arguments.length === 0
            && click.expression.expression.getText(ast) === candidate.getText(ast)
            && ts.isReturnStatement(terminal) && !terminal.expression;
    }
    const schemaIds = new Set([config.matrix.schema, config.subResults.inputSchema, config.subResults.resultSchema, config.output.schema]);
    const schemaClaims = [];
    const schemaGuards = [];
    const returns = [...functions].map((node) => ({ key: functionKey(node), origins: nodes(node.body ?? node)
        .filter(ts.isReturnStatement).flatMap((item) => origins(item.expression)) }));
    const aliases = [];
    for (const statement of ast.statements.filter(ts.isExportDeclaration))
    {
        for (const item of statement.exportClause?.elements ?? [])
        {
            if (!selectedExports.has('*') && !selectedExports.has(item.name.text))
            {
                continue;
            }
            const original = name(item.propertyName ?? item.name);
            const target = statement.moduleSpecifier
                ? importedKey({ module: name(statement.moduleSpecifier), imported: original })
                : callableKey(item.propertyName ?? item.name);
            if (target)
            {
                aliases.push({ key: `${file}:${item.name.text}`, target });
            }
        }
    }
    const callBindings = calls.map((node) => ({ consumer: callableKey(node.expression), args: node.arguments.map((item) => origins(item)) }))
        .filter((item) => item.consumer);
    const assignments = all.filter((node) => ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left))
        .flatMap((node) => origins(node.left).map((key) => ({ key, origins: origins(node.right) })));
    function rejects(node)
    {
        return nodes(node.thenStatement).some((item) =>
        {
            if (ts.isThrowStatement(item))
            {
                return true;
            }
            if (!ts.isCallExpression(item) || !ts.isPropertyAccessExpression(item.expression)
                || item.expression.name.text !== 'push')
            {
                return false;
            }
            const accumulator = expression(item.expression.expression);
            const scope = enclosingFunction(item);
            return scope && nodes(scope.body).some((result) => ts.isReturnStatement(result)
                && expression(result.expression) === accumulator);
        });
    }
    function disjunctionArm(comparison, condition)
    {
        let arm = comparison;
        while (arm !== condition && (ts.isParenthesizedExpression(arm.parent)
            || (ts.isBinaryExpression(arm.parent) && arm.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)))
        {
            arm = arm.parent;
        }
        return arm === condition;
    }
    function rejectingPredicates(condition)
    {
        if (ts.isParenthesizedExpression(condition))
        {
            return rejectingPredicates(condition.expression);
        }
        if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        {
            return [...rejectingPredicates(condition.left), ...rejectingPredicates(condition.right)];
        }
        return ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? [] : [condition];
    }
    function literal(node)
    {
        if (node && ts.isStringLiteralLike(node))
        {
            return JSON.stringify(node.text);
        }
        return node && (ts.isNumericLiteral(node)
            || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind))
            ? node.getText(ast) : null;
    }
    for (const node of all.filter(ts.isIfStatement))
    {
        const condition = nodes(node.expression);
        if (!rejects(node))
        {
            continue;
        }
        for (const comparison of condition.filter(ts.isBinaryExpression))
        {
            if (comparison.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
                && ts.isPropertyAccessExpression(comparison.left) && comparison.left.name.text === 'schema'
                && ts.isStringLiteralLike(comparison.right))
            {
                if (!disjunctionArm(comparison, node.expression))
                {
                    continue;
                }
                const subject = comparison.left.expression.getText(ast);
                const owner = enclosingFunction(node);
                const rejectingBranches = nodes(owner?.body ?? node).filter(ts.isIfStatement).filter(rejects);
                const predicates = rejectingBranches.flatMap((branch) => rejectingPredicates(branch.expression).flatMap(nodes));
                const keys = predicates.filter(ts.isPropertyAccessExpression)
                    .filter((item) => item.expression.getText(ast) === subject).map((item) => item.name.text)
                    .filter((key) => !['schema', 'qualificationEligible'].includes(key));
                for (const loop of nodes(owner?.body ?? node.expression).filter(ts.isForOfStatement))
                {
                    if (ts.isArrayLiteralExpression(loop.expression)
                        && nodes(loop.statement).filter(ts.isIfStatement).some((branch) => rejects(branch)
                            && rejectingPredicates(branch.expression).flatMap(nodes).some((item) => ts.isElementAccessExpression(item)
                                && item.expression.getText(ast) === subject)))
                    {
                        keys.push(...loop.expression.elements.filter(ts.isStringLiteralLike).map((item) => item.text));
                    }
                }
                const values = rejectingBranches.flatMap((branch) => nodes(branch.expression).filter((item) =>
                    ts.isBinaryExpression(item) && ts.isPropertyAccessExpression(item.left)
                    && item.left.expression.getText(ast) === subject && literal(item.right) !== null
                    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(item.operatorToken.kind)
                    && disjunctionArm(item, branch.expression)).map((item) => ({ key: item.left.name.text,
                    value: literal(item.right), rejectsEqual: item.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken })));
                schemaGuards.push({ schema: comparison.right.text, keys, values, subject: origins(comparison.left.expression) });
            }
        }
    }
    for (const node of all)
    {
        if (ts.isCallExpression(node))
        {
            const callable = expression(node.expression);
            const leaf = callable?.split('.').at(-1);
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
            {
                const specifier = expression(node.arguments[0]);
                const payloads = dataPayloads(node.arguments[0]);
                const sourceFiles = sourceDataFiles(node.arguments[0]);
                if (sourceFiles)
                {
                    imports.push(...sourceFiles.map((specifier) => ({ specifier: `/${specifier}`, names: ['*'] })));
                    continue;
                }
                if (!specifier || (specifier.startsWith('data:') && !payloads)
                    || (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('data:')
                    && !ts.isStringLiteralLike(node.arguments[0])))
                {
                    errors.push(`${file}: unresolved active import`);
                }
                else if (!specifier.startsWith('data:'))
                {
                    let declaration = node.parent;
                    if (ts.isAwaitExpression(declaration))
                    {
                        declaration = declaration.parent;
                    }
                    const names = ts.isVariableDeclaration(declaration) && ts.isObjectBindingPattern(declaration.name)
                        ? declaration.name.elements.filter((item) => references.has(name(item.name)))
                            .map((item) => name(item.propertyName ?? item.name)) : ['*'];
                    imports.push({ specifier, names });
                }
                else
                {
                    for (const payload of payloads)
                    {
                        const separator = payload.indexOf(',');
                        assert.ok(separator >= 0, `${file}: unresolved active import data URL`);
                        const body = payload.slice(separator + 1);
                        const decoded = payload.slice(0, separator).endsWith(';base64')
                            ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
                        const nested = inspectModule(decoded, `${file}#data`, config, localeCodes, new Set(['*']), depth + 1, false, externalEffects, sourceRoot);
                        imports.push(...nested.imports);
                        errors.push(...nested.errors);
                        schemaClaims.push(...nested.schemaClaims);
                        schemaGuards.push(...nested.schemaGuards);
                    }
                }
            }
            if (['requestLocale', 'resetLocaleRuntimeForTests', '__advancePublicShellPhase'].includes(leaf))
            {
                errors.push(`${file}: internal locale call ${callable}`);
            }
            if (['launch', 'launchPersistentContext'].includes(leaf) && file !== config.runner.path)
            {
                errors.push(`${file}: second browser launch`);
            }
            if (leaf === 'waitForTimeout' || (leaf === 'setTimeout' && ts.isIdentifier(node.arguments[0])
                && node.arguments[0].text === 'resolve' && inBrowserOperation(node)))
            {
                errors.push(`${file}: fixed browser sleep`);
            }
            if (leaf && /retry/iu.test(leaf) && node.arguments.some((argument) => hasBrowserAction(argument)))
            {
                errors.push(`${file}: browser retry callback`);
            }
            const implementation = ts.isIdentifier(node.expression) ? lookup(node, node.expression.text) : null;
            if (implementation && ts.isFunctionLike(implementation) && implementation.body)
            {
                for (const loop of nodes(implementation.body).filter((item) => ts.isForStatement(item)
                    || ts.isWhileStatement(item) || ts.isDoStatement(item)))
                {
                    const parameters = implementation.parameters.map((item) => name(item.name));
                    const invoked = nodes(loop.statement).filter(ts.isCallExpression)
                        .map((item) => parameters.indexOf(name(item.expression))).filter((index) => index >= 0);
                    if (invoked.some((index) => node.arguments[index] && hasBrowserAction(node.arguments[index])))
                    {
                        errors.push(`${file}: renamed browser retry callback`);
                    }
                }
            }
            if (['query', 'execute'].includes(leaf) && /^(?:INSERT|UPDATE|DELETE)\b/iu.test(expression(node.arguments[0]) ?? ''))
            {
                errors.push(`${file}: direct database fixture`);
            }
            if (['locator', 'querySelector', 'querySelectorAll'].includes(leaf)
                && /(?:data-locale-toggle|LocaleToggle)/u.test(expression(node.arguments[0]) ?? ''))
            {
                errors.push(`${file}: legacy selector`);
            }
        }
        if ((ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) && hasBrowserAction(node.statement)
            && !singleCandidateSelection(node))
        {
            errors.push(`${file}: browser retry loop`);
        }
        const declaredName = ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
            || ts.isPropertyAssignment(node) ? name(node.name) : null;
        if (['flakyAllowlist', 'warningFilter'].includes(declaredName))
        {
            errors.push(`${file}: failure filter`);
        }
        if (declaredName === 'expectedCopy' && node.initializer && ts.isObjectLiteralExpression(node.initializer))
        {
            errors.push(`${file}: handwritten copy authority`);
        }
        const values = ts.isArrayLiteralExpression(node) ? node.elements.map((item) => expression(item))
            : ts.isUnionTypeNode(node) ? node.types.map((item) => ts.isLiteralTypeNode(item) ? expression(item.literal) : null) : [];
        if (values.length > 1 && values.every((value) => localeCodes.has(value)))
        {
            errors.push(`${file}: second locale authority`);
        }
        if (ts.isPropertyAssignment(node) && name(node.name) === 'schema')
        {
            const value = expression(node.initializer);
            if (value && /^fsusblog\.public-shell-locale-(?:matrix|sub-result|qualification)/u.test(value) && !schemaIds.has(value))
            {
                errors.push(`${file}: compat schema`);
            }
        }
        if (ts.isObjectLiteralExpression(node))
        {
            const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map((item) => [name(item.name), item.initializer]));
            if (properties.get('qualificationEligible')?.kind === ts.SyntaxKind.TrueKeyword
                && ['url', 'htmlLang', 'screenshot'].some((key) => properties.has(key)))
            {
                errors.push(`${file}: smoke authority`);
            }
            const declaredSchema = properties.get('schema');
            if (properties.get('qualificationEligible')?.kind === ts.SyntaxKind.TrueKeyword
                && declaredSchema && ts.isStringLiteralLike(declaredSchema) && !schemaIds.has(declaredSchema.text))
            {
                const fn = enclosingFunction(node);
                schemaClaims.push({ file, schema: declaredSchema.text, keys: [...properties.keys()],
                    values: Object.fromEntries([...properties].map(([key, value]) => [key, literal(value)])),
                    origins: [`${file}#record:${node.pos}`, ...(fn ? [functionKey(fn)] : [])] });
            }
            if (declaredName === null && name(node.parent?.name) === 'publicArticle'
                && ['1', 1].includes(ts.isNumericLiteral(properties.get('id') ?? {}) ? Number(properties.get('id').text)
                    : expression(properties.get('id'))))
            {
                errors.push(`${file}: default entity fixture fallback`);
            }
        }
    }
    if (file === config.runner.path && calls.filter((node) =>
        ['launch', 'launchPersistentContext'].includes(expression(node.expression)?.split('.').at(-1))).length > 1)
    {
        errors.push(`${file}: second browser launch`);
    }
    const effects = [];
    for (const node of functions)
    {
        if (hasBrowserAction(node.body))
        {
            const key = name(node.name ?? node.parent.name)
                ?? (node.modifiers?.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
            if (key)
            {
                effects.push(`${file}:${key}`);
            }
        }
    }
    return { imports, errors, schemaClaims, schemaGuards, effects, callBindings, returns, assignments, aliases };
}

async function inspectActiveClosure(root, config)
{
    const json = async (file) => JSON.parse(await readText(root, file));
    const matrix = parseMatrix(await readText(root, 'tests/matrix.yml'));
    const tiers = matrix.tiers.filter((tier) => tier.id === config.runner.kind);
    assert.equal(tiers.length, 1, 'canonical matrix authority binding must be unique');
    const lane = `tools/test/lanes/${config.runner.kind}.sh`;
    assert.equal(tiers[0].command, `bash ${lane}`, 'canonical matrix command mismatch');
    const frontend = await json('src/frontend/package.json');
    assert.equal(frontend.scripts?.[`check:${config.runner.kind}`], `bash ../../${lane}`, 'canonical local command mismatch');
    const coverage = await json('tests/coverage-registry.json');
    const owners = coverage.entries.filter((entry) => entry.tierIds?.includes(config.runner.kind));
    assert.ok(owners.some((entry) => entry.evidencePaths?.includes(config.runner.path)), 'canonical authority binding is missing');
    const paths = owners.flatMap((entry) => entry.evidencePaths ?? []);
    assert.ok(!paths.some((file) => config.legacy.paths.includes(file)), 'retired authority binding');
    const registry = await json('tests/governance/test-lifecycle-registry.json');
    const registrations = registry.nodeTests ?? registry.entries;
    assert.equal(registrations.filter((entry) => entry.file === 'tests/tools/public-shell-locale-legacy-governance.test.mjs').length,
        1, 'canonical lifecycle authority binding must be unique');
    const workflows = [...new Set(paths.filter((file) => file.startsWith('.github/workflows/') && file.endsWith('.yml')))];
    assert.ok(workflows.length > 0, 'canonical CI command binding is missing');
    let ciCount = 0;
    const commandRoots = [];
    const inlineCommands = [];
    for (const file of workflows)
    {
        const workflow = parseYamlDocument(await readText(root, file), { source: file });
        for (const [job, value] of Object.entries(workflow.jobs ?? {}))
        {
            if (job !== config.runner.kind)
            {
                continue;
            }
            const commands = (value.steps ?? []).map((step) => step.run).filter(Boolean);
            const selected = commands.filter((command) => command.includes('ci-tier browser-contract') || command.includes('check:browser-contract')
                || /(?:node|bash).*tests\/browser-contract\//u.test(command));
            assert.equal(selected.length, 1, 'canonical CI command must occur exactly once');
            assert.equal(selected[0], './tools/test.sh ci-tier browser-contract --no-deps', 'canonical CI command mismatch');
            ciCount += 1;
            for (const command of commands)
            {
                const dispatch = executableRoots(command, file, matrix);
                commandRoots.push(...dispatch.roots);
                inlineCommands.push(...dispatch.inline.map((source) => ({ file: `${file}#inline`, source })));
            }
        }
    }
    assert.equal(ciCount, 1, 'canonical CI command binding must be unique');
    const laneSource = await readText(root, lane);
    const executions = laneSource.split('\n').filter((line) => !line.trimStart().startsWith('#')
        && /(?:node|NODE_BIN).*tests\/browser-contract\/[^\s"']+\.mjs/u.test(line) && !line.includes('--test'));
    assert.equal(executions.length, 1, 'canonical lane command must occur exactly once');
    assert.ok(executions[0].includes(config.runner.path), 'canonical lane command mismatch');
    const shellFiles = new Set();
    const shellPending = [lane, ...commandRoots.filter((file) => file.endsWith('.sh'))];
    while (shellPending.length)
    {
        const file = shellPending.pop();
        if (shellFiles.has(file))
        {
            continue;
        }
        shellFiles.add(file);
        const dispatch = executableRoots(await readText(root, file), file, matrix);
        for (const target of dispatch.roots)
        {
            if (target === config.runner.path && file !== lane)
            {
                throw new Error(`${file}: second runner wrapper`);
            }
            if (target.endsWith('.sh'))
            {
                shellPending.push(target);
            }
            else if (target !== config.runner.path)
            {
                commandRoots.push(target);
            }
        }
        inlineCommands.push(...dispatch.inline.map((source) => ({ file: `${file}#inline`, source })));
    }
    const catalog = await json('src/shared/Contracts/Localization/locale-catalog.json');
    const localeCodes = new Set(catalog.locales.filter((item) => item.status === 'enabled').map((item) => item.code));
    const entries = new Set([config.runner.path, ...Object.values(config.commands).map((command) => command.split(' ')[1]),
        ...commandRoots.filter((file) => !file.endsWith('.sh'))]);
    const pending = [...entries, config.matrix.module, ...commandRoots.filter((file) => !file.endsWith('.sh'))]
        .map((file) => ({ file, names: ['*'] }));
    const activeFiles = new Set(shellFiles);
    const requested = new Map();
    const inspections = new Map();
    const errors = [];
    const moduleSources = new Map();
    function enqueueImports(file, inspection)
    {
        for (const { specifier, names: importedNames } of inspection.imports)
        {
            if (!specifier?.startsWith('.') && !specifier?.startsWith('/'))
            {
                continue;
            }
            const target = resolveActiveImport(root, file, specifier);
            if (target === config.runner.path)
            {
                errors.push(`${file}: second runner wrapper`);
            }
            pending.push({ file: target, names: importedNames });
        }
    }
    for (const [index, command] of inlineCommands.entries())
    {
        // Node -e imports resolve from the task root, not the YAML or lane directory.
        const file = `#inline:${index}:${command.file.replaceAll('/', '_')}`;
        const exports = new Set(['*']);
        entries.add(file);
        requested.set(file, exports);
        moduleSources.set(file, command.source);
        const inspection = inspectModule(command.source, file, config, localeCodes, exports, 0, true, new Set(), root);
        inspections.set(file, inspection);
        enqueueImports(file, inspection);
    }
    while (pending.length)
    {
        const { file, names } = pending.pop();
        const selected = requested.get(file);
        if (selected && (selected.has('*') || names.every((item) => selected.has(item))))
        {
            continue;
        }
        const exports = new Set([...(selected ?? []), ...names]);
        requested.set(file, exports);
        const absolute = resolveGatePath(root, file, 'active closure');
        assert.ok(fs.existsSync(absolute) && fs.lstatSync(absolute).isFile() && fs.realpathSync(absolute) === absolute,
            `missing active regular module: ${file}`);
        activeFiles.add(file);
        if (file.endsWith('.json'))
        {
            const document = await json(file);
            const schemas = new Set([config.matrix.schema, config.subResults.inputSchema, config.subResults.resultSchema, config.output.schema]);
            function inspect(value)
            {
                if (!value || typeof value !== 'object')
                {
                    return;
                }
                if (typeof value.schema === 'string' && !schemas.has(value.schema)
                    && (value.qualificationEligible === true || /^fsusblog\.public-shell-locale-(?:matrix|sub-result|qualification)/u.test(value.schema)))
                {
                    errors.push(`${file}: JSON compat schema`);
                }
                for (const nested of Object.values(value))
                {
                    inspect(nested);
                }
            }
            inspect(document);
        }
        if (!/\.(?:mjs|cjs|js|ts)$/u.test(file))
        {
            continue;
        }
        const source = await readText(root, file);
        moduleSources.set(file, source);
        const inspection = inspectModule(source, file, config, localeCodes, exports, 0, entries.has(file), new Set(), root);
        inspections.set(file, inspection);
        enqueueImports(file, inspection);
    }
    const effects = new Set();
    for (let iteration = 0; ; iteration += 1)
    {
        const previous = effects.size;
        for (const inspection of inspections.values())
        {
            inspection.effects.forEach((key) => effects.add(key));
            for (const alias of inspection.aliases)
            {
                if (effects.has(alias.target))
                {
                    effects.add(alias.key);
                }
            }
        }
        if (iteration > 0 && previous === effects.size)
        {
            break;
        }
        assert.ok(iteration <= moduleSources.size, 'active browser effect projection did not converge');
        for (const [file, source] of moduleSources)
        {
            inspections.set(file, inspectModule(source, file, config, localeCodes, requested.get(file), 0, entries.has(file), effects, root));
        }
    }
    const guards = [...inspections.values()].flatMap((item) => item.schemaGuards);
    const aliases = new Map([...inspections.values()].flatMap((item) => item.aliases.map((alias) => [alias.key, alias.target])));
    function resolveAlias(key)
    {
        const seen = new Set();
        while (aliases.has(key))
        {
            assert.ok(!seen.has(key), 'unresolved cyclic active export');
            seen.add(key);
            key = aliases.get(key);
        }
        return key;
    }
    const provenance = new Map();
    const relations = [...inspections.values()].flatMap((item) => [
        ...item.returns,
        ...item.assignments,
        ...item.aliases.map((alias) => ({ key: alias.key, origins: [alias.target] })),
        ...item.callBindings.flatMap((call) => call.args.map((origins, index) => ({ key: `${resolveAlias(call.consumer)}#parameter:${index}`, origins })))
    ]);
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const relation of relations)
        {
            const known = provenance.get(relation.key) ?? new Set();
            const before = known.size;
            for (const origin of relation.origins)
            {
                known.add(origin);
                for (const parent of provenance.get(origin) ?? [])
                {
                    known.add(parent);
                }
            }
            provenance.set(relation.key, known);
            changed ||= known.size !== before;
        }
    }
    for (const inspection of inspections.values())
    {
        errors.push(...inspection.errors);
        for (const claim of inspection.schemaClaims)
        {
            const localeClaim = claim.keys.some((key) => ['locale', 'scene', 'sceneId', 'scenes', 'subResults', 'htmlLang'].includes(key));
            if (localeClaim || !guards.some((guard) => guard.schema === claim.schema
                && claim.keys.filter((key) => !['schema', 'qualificationEligible'].includes(key)).every((key) => guard.keys.includes(key))
                && guard.values.every((check) => claim.values[check.key] === null || claim.values[check.key] === undefined
                    || (claim.values[check.key] === check.value) !== check.rejectsEqual)
                && guard.subject.some((subject) => claim.origins.some((origin) => (provenance.get(subject) ?? new Set()).has(origin)))))
            {
                errors.push(`${claim.file}: renamed compat schema`);
            }
        }
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    return [...activeFiles].sort();
}

export async function checkPublicShellLocaleLegacyGovernance({ root = defaultRoot, configFile = null } = {})
{
    root = await fs.promises.realpath(root);
    const config = await loadPublicShellLocaleGateConfig(root, configFile ?? 'config/testing/public-shell-locale-gate.json');
    const errors = [];
    if (JSON.stringify(config.legacy.paths) !== JSON.stringify(canonicalLegacyPaths))
    {
        errors.push('legacy path inventory has been tampered');
    }
    if (JSON.stringify(config.legacy.forbiddenTokens) !== JSON.stringify(canonicalForbiddenTokens))
    {
        errors.push('legacy forbidden-token inventory has been tampered');
    }
    for (const relative of config.legacy.paths)
    {
        const absolute = resolveGatePath(root, relative, 'legacy inventory');
        if (fs.existsSync(absolute))
        {
            errors.push(`legacy runner or fixture remains: ${relative}`);
            let stat;
            try
            {
                stat = fs.lstatSync(absolute);
            }
            catch
            {
                continue;
            }
            if (stat.isFile())
            {
                const source = await readText(root, relative);
                for (const token of config.legacy.forbiddenTokens)
                {
                    if (source.includes(token))
                    {
                        errors.push(`${relative} contains forbidden legacy token: ${token}`);
                    }
                }
            }
        }
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    const activeFiles = await inspectActiveClosure(root, config);
    return {
        schema: 'fsusblog.public-shell-locale-legacy-governance.v1',
        status: 'pass',
        legacyPaths: config.legacy.paths,
        forbiddenTokens: config.legacy.forbiddenTokens,
        activeFiles,
        browserSpawnCount: 0
    };
}
