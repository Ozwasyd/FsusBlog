#!/usr/bin/env node
/**
 * Repository-owned TypeScript AST adapter for JS/TS test-case discovery.
 *
 * Consumes canonical inventory file membership (vitest / node-test /
 * playwright adapters) and produces real test-case records, suite records
 * (describe hierarchy + hooks), static expansion of literal test.each tables,
 * dynamic obligations for non-literal tables/computed titles, and per-case
 * method facts (invocations, assertion candidates, returns, production/test
 * symbol classification). No regex is used as a test-discovery authority and
 * syntax errors fail closed with precise file/call locations.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const FRAMEWORK_MODULES = new Map([
    ['vitest', 'vitest'],
    ['node:test', 'node-test'],
    ['@playwright/test', 'playwright']
]);

const TEST_API_NAMES = new Set(['test', 'it']);
const DESCRIBE_API_NAMES = new Set(['describe']);
const MODIFIER_NAMES = new Set(['skip', 'only', 'todo', 'fails']);
const HOOK_NAMES = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const PLAYWRIGHT_HOOK_NAMES = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const PLAYWRIGHT_MODIFIER_NAMES = new Set(['skip', 'only', 'fail', 'fixme', 'todo', 'slow']);

const BEHAVIOR_TEST_MODULE = 'tools/contracts/behavior-test.mjs';

const MAX_INVOCATIONS = 100;
const MAX_ASSERTIONS = 100;

function shortHash(value)
{
    return createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function slug(value)
{
    return String(value)
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 56) || 'unnamed';
}

function scriptKindFor(file)
{
    if (/\.tsx$/u.test(file))
    {
        return ts.ScriptKind.TSX;
    }
    if (/\.ts$/u.test(file))
    {
        return ts.ScriptKind.TS;
    }
    if (/\.jsx$/u.test(file))
    {
        return ts.ScriptKind.JSX;
    }
    return ts.ScriptKind.JS;
}

function positionOf(sourceFile, pos)
{
    const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, pos);
    return { line: line + 1, column: character + 1 };
}

function spanOf(sourceFile, node)
{
    return {
        start: positionOf(sourceFile, node.getStart(sourceFile)),
        end: positionOf(sourceFile, node.getEnd())
    };
}

function literalText(node, source)
{
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    {
        return node.text;
    }
    if (ts.isTemplateExpression(node))
    {
        return source.slice(node.getStart() + 1, node.getEnd() - 1);
    }
    return null;
}

function titleInfo(node, source)
{
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    {
        return { title: node.text, dynamic: false };
    }
    if (ts.isTemplateExpression(node))
    {
        return { title: source.slice(node.getStart() + 1, node.getEnd() - 1), dynamic: true };
    }
    return { title: null, dynamic: false };
}

function isLiteralStringLike(node)
{
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

function normalizeSpecifier(specifier)
{
    return String(specifier ?? '').replaceAll('\\', '/');
}

function resolveRelativeModule(root, file, specifier)
{
    const normalized = normalizeSpecifier(specifier);
    if (normalized.startsWith('node:') || normalized.startsWith('npm:') || !normalized.startsWith('.'))
    {
        return null;
    }
    const base = path.posix.dirname(file);
    const candidates = [
        path.posix.normalize(path.posix.join(base, normalized)),
        path.posix.normalize(path.posix.join(base, `${normalized}.mjs`)),
        path.posix.normalize(path.posix.join(base, `${normalized}.js`)),
        path.posix.normalize(path.posix.join(base, `${normalized}.ts`)),
        path.posix.normalize(path.posix.join(base, `${normalized}.tsx`))
    ];
    for (const candidate of candidates)
    {
        if (existsSync(path.join(root, candidate)))
        {
            return candidate;
        }
    }
    return candidates[0];
}

function resolveModule(root, file, specifier)
{
    const normalized = normalizeSpecifier(specifier);
    if (normalized.startsWith('@/'))
    {
        const frontendPath = normalized.slice(2);
        const candidates = [
            path.posix.normalize(path.posix.join('src/frontend/src', frontendPath)),
            path.posix.normalize(path.posix.join('src/frontend/src', `${frontendPath}.mjs`)),
            path.posix.normalize(path.posix.join('src/frontend/src', `${frontendPath}.js`)),
            path.posix.normalize(path.posix.join('src/frontend/src', `${frontendPath}.ts`)),
            path.posix.normalize(path.posix.join('src/frontend/src', `${frontendPath}.tsx`))
        ];
        return candidates.find((candidate) => existsSync(path.join(root, candidate))) ?? null;
    }
    return resolveRelativeModule(root, file, normalized);
}

function classifyModule(root, file, specifier)
{
    const normalized = normalizeSpecifier(specifier);
    if (FRAMEWORK_MODULES.has(normalized))
    {
        return { assembly: normalized, assemblyKind: 'test-framework' };
    }
    if (normalized === BEHAVIOR_TEST_MODULE || normalized.endsWith(`/${BEHAVIOR_TEST_MODULE}`))
    {
        return { assembly: BEHAVIOR_TEST_MODULE, assemblyKind: 'test' };
    }
    if (normalized.startsWith('node:') || normalized.startsWith('npm:'))
    {
        return { assembly: normalized, assemblyKind: 'third-party' };
    }
    const resolved = resolveModule(root, file, normalized);
    if (resolved)
    {
        if (resolved.startsWith('src/'))
        {
            return { assembly: resolved, assemblyKind: 'production' };
        }
        return { assembly: resolved, assemblyKind: 'test' };
    }
    return { assembly: normalized, assemblyKind: 'third-party' };
}

function staticObjectRowValues(node)
{
    if (!node || !ts.isObjectLiteralExpression(node))
    {
        return null;
    }
    const values = new Map();
    for (const property of node.properties)
    {
        if (!ts.isPropertyAssignment(property))
        {
            return null;
        }
        const key = ts.isIdentifier(property.name) ? property.name.text : literalText(property.name, '');
        if (key === null)
        {
            return null;
        }
        const initializer = property.initializer;
        if (isLiteralStringLike(initializer))
        {
            values.set(key, literalText(initializer, ''));
        }
        else if (ts.isNumericLiteral(initializer))
        {
            values.set(key, Number(initializer.text));
        }
        else if (initializer.kind === ts.SyntaxKind.TrueKeyword)
        {
            values.set(key, true);
        }
        else if (initializer.kind === ts.SyntaxKind.FalseKeyword)
        {
            values.set(key, false);
        }
    }
    return values;
}

function formatRowTitle(title, row, rowIndex, rowKey)
{
    const namedSpecifiers = [...String(title).matchAll(/\$([A-Za-z_$][\w$]*)/gu)];
    if (namedSpecifiers.length > 0)
    {
        if (!(row instanceof Map))
        {
            return { displayName: `${title} [${rowIndex}]`, name: title };
        }
        let unresolved = false;
        const formatted = String(title).replace(/\$([A-Za-z_$][\w$]*)/gu, (token, key) =>
        {
            if (!row.has(key))
            {
                unresolved = true;
                return token;
            }
            const value = row.get(key);
            return typeof value === 'string' ? value : JSON.stringify(value);
        });
        if (!unresolved)
        {
            return {
                displayName: formatted,
                name: formatted,
                identitySeed: row.get('caseName') ?? row.get('name') ?? formatted
            };
        }
        return { displayName: `${title} [${rowIndex}]`, name: title };
    }
    const hasSpecifier = /%(?:[sdifjoO]|#)/u.test(title);
    if (!hasSpecifier)
    {
        return { displayName: rowKey === null ? `${title} [${rowIndex}]` : `${title} [${rowKey}]`, name: title };
    }
    let formatted = String(title);
    let index = 0;
    formatted = formatted.replace(/%[sdifjoO]|%/gu, (token) =>
    {
        if (token === '%')
        {
            return '%';
        }
        const value = row[index];
        index += 1;
        if (value === undefined)
        {
            return '';
        }
        if (typeof value === 'string')
        {
            return value;
        }
        return JSON.stringify(value);
    });
    return { displayName: formatted, name: formatted };
}

function staticTableRows(node)
{
    if (!node)
    {
        return null;
    }
    const rows = [];
    if (ts.isArrayLiteralExpression(node))
    {
        for (const [index, element] of node.elements.entries())
        {
            if (ts.isSpreadElement(element))
            {
                return null;
            }
            rows.push({ index, key: null, value: element });
        }
        return rows;
    }
    if (ts.isObjectLiteralExpression(node))
    {
        for (const [index, property] of node.properties.entries())
        {
            if (!ts.isPropertyAssignment(property))
            {
                return null;
            }
            const key = ts.isIdentifier(property.name) ? property.name.text : literalText(property.name, '');
            if (key === null)
            {
                return null;
            }
            rows.push({ index, key, value: property.initializer });
        }
        return rows;
    }
    return null;
}

function collectDeclaredNames(sourceFile)
{
    const names = new Set();
    const visit = (node) =>
    {
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        {
            if (node.name)
            {
                names.add(node.name.text);
            }
        }
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        {
            names.add(node.name.text);
        }
        else if (ts.isBindingElement(node) && ts.isIdentifier(node.name))
        {
            names.add(node.name.text);
        }
        else if (ts.isParameter(node) && ts.isIdentifier(node.name))
        {
            names.add(node.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return names;
}

function collectLocalFunctionBodies(sourceFile)
{
    const functions = new Map();
    const addFunction = (name, body) =>
    {
        if (!name || !body)
        {
            return;
        }
        if (functions.has(name))
        {
            functions.set(name, null);
            return;
        }
        functions.set(name, body);
    };
    for (const statement of sourceFile.statements)
    {
        if (ts.isFunctionDeclaration(statement) && statement.name)
        {
            addFunction(statement.name.text, statement.body);
            continue;
        }
        if (!ts.isVariableStatement(statement))
        {
            continue;
        }
        for (const declaration of statement.declarationList.declarations)
        {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
            {
                continue;
            }
            if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            {
                addFunction(declaration.name.text, declaration.initializer.body);
            }
        }
    }
    for (const [name, body] of functions)
    {
        if (body === null)
        {
            functions.delete(name);
        }
    }
    return functions;
}

function collectImports(sourceFile, source)
{
    const imports = new Map();
    const addBinding = (localName, moduleSpecifier, exportedName) =>
    {
        if (!localName)
        {
            return;
        }
        imports.set(localName, { module: moduleSpecifier, exported: exportedName });
    };
    const visit = (node) =>
    {
        if (ts.isImportDeclaration(node))
        {
            const specifier = literalText(node.moduleSpecifier, source) ?? '';
            const clause = node.importClause;
            if (!clause)
            {
                return;
            }
            if (clause.name)
            {
                addBinding(clause.name.text, specifier, 'default');
            }
            const bindings = clause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings))
            {
                addBinding(bindings.name.text, specifier, '*');
            }
            else if (bindings && ts.isNamedImports(bindings))
            {
                for (const element of bindings.elements)
                {
                    addBinding(element.name.text, specifier, element.propertyName?.text ?? element.name.text);
                }
            }
        }
        else if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]))
        {
            const specifier = node.arguments[0].text;
            const parent = node.parent;
            if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
            {
                addBinding(parent.name.text, specifier, 'default');
            }
            else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name))
            {
                for (const element of parent.name.elements)
                {
                    addBinding(element.name.text, specifier, element.propertyName?.text ?? element.name.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return imports;
}

function isBehaviorTestModule(specifier, root, file)
{
    const normalized = normalizeSpecifier(specifier);
    if (normalized === BEHAVIOR_TEST_MODULE || normalized.endsWith(`/${BEHAVIOR_TEST_MODULE}`))
    {
        return true;
    }
    const resolved = resolveRelativeModule(root, file, normalized);
    return resolved !== null && (resolved === BEHAVIOR_TEST_MODULE || resolved.endsWith(`/${BEHAVIOR_TEST_MODULE}`));
}

function baseIdentifier(node)
{
    let current = node;
    while (ts.isPropertyAccessExpression(current))
    {
        current = current.expression;
    }
    if (ts.isCallExpression(current))
    {
        return null;
    }
    return ts.isIdentifier(current) ? current.text : null;
}

function createExtractionContext({ root, file, adapter, source, sourceFile })
{
    const declaredNames = collectDeclaredNames(sourceFile);
    const imports = collectImports(sourceFile, source);
    const localFunctions = collectLocalFunctionBodies(sourceFile);
    return {
        root,
        file,
        adapter,
        source,
        sourceFile,
        declaredNames,
        imports,
        localFunctions,
        occurrenceByName: new Map(),
        testCases: [],
        suiteRecords: [],
        diagnostics: [],
        rootSuite: null,
        namedCallbacks: new Map()
    };
}

function resolveApi(ctx, node)
{
    if (ts.isIdentifier(node))
    {
        const name = node.text;
        const binding = ctx.imports.get(name);
        if (binding)
        {
            const framework = FRAMEWORK_MODULES.get(binding.module);
            const apiName = framework && binding.exported === 'default' && binding.module === 'node:test' ? 'test' : binding.exported;
            if (framework && (TEST_API_NAMES.has(apiName) || DESCRIBE_API_NAMES.has(apiName) || HOOK_NAMES.has(apiName)))
            {
                return { api: apiName, framework };
            }
            if (framework && binding.exported === '*')
            {
                return { api: 'namespace', framework };
            }
            if (isBehaviorTestModule(binding.module, ctx.root, ctx.file) && binding.exported === 'behaviorTest')
            {
                return { api: 'behaviorTest', framework: ctx.adapter };
            }
            return null;
        }
        if (ctx.declaredNames.has(name))
        {
            return null;
        }
        if (TEST_API_NAMES.has(name))
        {
            return { api: name, framework: ctx.adapter };
        }
        if (DESCRIBE_API_NAMES.has(name))
        {
            return { api: 'describe', framework: ctx.adapter };
        }
        if (HOOK_NAMES.has(name))
        {
            return { api: name, framework: ctx.adapter };
        }
        return null;
    }
    if (ts.isPropertyAccessExpression(node))
    {
        const property = node.name.text;
        let base = resolveApi(ctx, node.expression);
        if (base && base.api === 'namespace')
        {
            if (TEST_API_NAMES.has(property))
            {
                return { api: property, framework: base.framework };
            }
            if (DESCRIBE_API_NAMES.has(property))
            {
                return { api: 'describe', framework: base.framework };
            }
            if (MODIFIER_NAMES.has(property))
            {
                return { api: property, framework: base.framework, baseApi: 'test' };
            }
            return null;
        }
        if (!base)
        {
            return null;
        }
        if (property === 'each')
        {
            return base.api === 'test' || base.api === 'it'
                ? { api: 'each', framework: base.framework }
                : null;
        }
        if (MODIFIER_NAMES.has(property))
        {
            if (base.api === 'test' || base.api === 'it' || base.api === 'describe')
            {
                return { api: property, framework: base.framework, baseApi: base.api };
            }
            return null;
        }
        if (property === 'describe')
        {
            if (base.api === 'test' || base.api === 'it')
            {
                return { api: 'describe', framework: base.framework };
            }
            return null;
        }
        if (PLAYWRIGHT_HOOK_NAMES.has(property) || PLAYWRIGHT_MODIFIER_NAMES.has(property) || property === 'use')
        {
            if (base.api === 'test')
            {
                return { api: property, framework: base.framework };
            }
            return null;
        }
        if (base.api === 'test' || base.api === 'it' || base.api === 'describe')
        {
            return { api: property, framework: base.framework, baseApi: base.api };
        }
        return null;
    }
    return null;
}

function parseOptionsObject(node)
{
    if (!node || !ts.isObjectLiteralExpression(node))
    {
        return {};
    }
    const options = {};
    for (const property of node.properties)
    {
        if (!ts.isPropertyAssignment(property))
        {
            continue;
        }
        const key = ts.isIdentifier(property.name) ? property.name.text : null;
        if (!key)
        {
            continue;
        }
        const initializer = property.initializer;
        if (key === 'skip')
        {
            if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
            {
                options.skipReason = initializer.text;
            }
            else if (initializer.kind === ts.SyntaxKind.TrueKeyword)
            {
                options.skipReason = 'skip';
            }
        }
        else if (key === 'todo')
        {
            options.todo = initializer.kind === ts.SyntaxKind.TrueKeyword;
        }
        else if (key === 'only')
        {
            options.only = initializer.kind === ts.SyntaxKind.TrueKeyword;
        }
        else if (key === 'timeout' && ts.isNumericLiteral(initializer))
        {
            options.timeoutMs = Number(initializer.text);
        }
        else if (key === 'tag' && (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)))
        {
            options.tag = initializer.text;
        }
    }
    return options;
}

function callbackInfo(node)
{
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    {
        const asyncFlag = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
        return {
            node,
            body: node.body,
            async: asyncFlag,
            name: ts.isFunctionExpression(node) && node.name ? node.name.text : null
        };
    }
    return null;
}

function fixtureFromCallback(callback)
{
    if (!callback || callback.parameters.length === 0)
    {
        return null;
    }
    const first = callback.parameters[0];
    if (ts.isObjectBindingPattern(first.name))
    {
        const names = first.name.elements
            .map((element) => (ts.isIdentifier(element.name) ? element.name.text : element.propertyName?.text ?? null))
            .filter((value) => value !== null);
        return names.length > 0 ? names.join(', ') : null;
    }
    return null;
}

function assertionRootIdentifier(node)
{
    let current = node;
    while (ts.isPropertyAccessExpression(current))
    {
        current = current.expression;
    }
    while (ts.isCallExpression(current))
    {
        current = current.expression;
        while (ts.isPropertyAccessExpression(current))
        {
            current = current.expression;
        }
    }
    return ts.isIdentifier(current) ? current.text : null;
}

function assertionBinding(ctx, rootName)
{
    if (!rootName)
    {
        return null;
    }
    const binding = ctx.imports.get(rootName);
    if (binding)
    {
        if ((binding.module === 'vitest' || binding.module === '@playwright/test')
            && binding.exported === 'expect')
        {
            return binding;
        }
        if ((binding.module === 'node:assert' || binding.module === 'node:assert/strict')
            && (binding.exported === 'default' || binding.exported === '*' || binding.exported === 'strict'))
        {
            return binding;
        }
        return null;
    }
    if (rootName === 'expect'
        && !ctx.declaredNames.has(rootName)
        && (ctx.adapter === 'vitest' || ctx.adapter === 'playwright'))
    {
        return { module: ctx.adapter === 'vitest' ? 'vitest' : '@playwright/test', exported: 'expect' };
    }
    return null;
}

function isAssertionCallee(ctx, callee)
{
    return assertionBinding(ctx, assertionRootIdentifier(callee)) !== null;
}

function resolveCallIdentity(ctx, call)
{
    const callee = call.expression;
    const assertionRoot = assertionRootIdentifier(callee);
    const resolvedAssertionBinding = assertionBinding(ctx, assertionRoot);
    if (ts.isPropertyAccessExpression(callee))
    {
        const root = baseIdentifier(callee.expression) ?? assertionRoot;
        const binding = root ? ctx.imports.get(root) : null;
        return {
            methodName: callee.name.text,
            containingType: ctx.source.slice(callee.expression.getStart(ctx.sourceFile), callee.expression.getEnd()).replace(/\s+/gu, ' ').trim().slice(0, 160),
            rootName: root,
            moduleSpecifier: resolvedAssertionBinding?.module ?? binding?.module ?? null,
            isAssertion: isAssertionCallee(ctx, callee)
        };
    }
    if (ts.isIdentifier(callee))
    {
        const binding = ctx.imports.get(callee.text);
        return {
            methodName: callee.text,
            containingType: undefined,
            rootName: callee.text,
            moduleSpecifier: resolvedAssertionBinding?.module ?? binding?.module ?? null,
            isAssertion: resolvedAssertionBinding !== null
        };
    }
    return { methodName: '<expression>', containingType: undefined, rootName: null, moduleSpecifier: null, isAssertion: false };
}

function callFacts(ctx, body, testIdByCallbackName)
{
    if (!body)
    {
        return null;
    }
    const invocations = [];
    const assertionCandidates = [];
    const returnStatements = [];
    const productionSymbolReferences = [];
    const visitedLocalFunctions = new Set();
    let asyncSeen = false;

    const visit = (node, ownsCallbackReturns = true) =>
    {
        if (ts.isAwaitExpression(node))
        {
            asyncSeen = true;
        }
        if (ownsCallbackReturns && ts.isReturnStatement(node))
        {
            const text = ctx.source.slice(node.getStart(ctx.sourceFile), node.getEnd()).replace(/\s+/gu, ' ').trim().slice(0, 240);
            if (!returnStatements.includes(text))
            {
                returnStatements.push(text);
            }
        }
        if (ts.isCallExpression(node))
        {
            const location = spanOf(ctx.sourceFile, node);
            const identity = resolveCallIdentity(ctx, node);
            if (identity.isAssertion)
            {
                const chainedExpectationRoot = identity.methodName === 'expect'
                    && ts.isPropertyAccessExpression(node.parent)
                    && node.parent.expression === node;
                if (!chainedExpectationRoot && assertionCandidates.length < MAX_ASSERTIONS)
                {
                    assertionCandidates.push({
                        methodName: identity.methodName,
                        containingType: identity.containingType,
                        assembly: identity.moduleSpecifier ?? ctx.adapter,
                        assemblyKind: 'test-framework',
                        callsTestMethod: false,
                        location
                    });
                }
            }
            else if (invocations.length < MAX_INVOCATIONS)
            {
                const classification = identity.moduleSpecifier
                    ? classifyModule(ctx.root, ctx.file, identity.moduleSpecifier)
                    : { assembly: 'local', assemblyKind: 'test' };
                const callsTestMethod = Boolean(identity.rootName && testIdByCallbackName.has(identity.rootName));
                const entry = {
                    methodName: identity.methodName,
                    containingType: identity.containingType,
                    assembly: classification.assembly,
                    assemblyKind: classification.assemblyKind,
                    callsTestMethod,
                    location
                };
                if (callsTestMethod)
                {
                    entry.calledTestMethodId = testIdByCallbackName.get(identity.rootName);
                }
                invocations.push(entry);
                if (classification.assemblyKind === 'production')
                {
                    productionSymbolReferences.push({ ...entry });
                }
                const localFunctionBody = identity.moduleSpecifier === null
                    && identity.rootName
                    ? ctx.localFunctions.get(identity.rootName)
                    : null;
                if (localFunctionBody && !visitedLocalFunctions.has(identity.rootName))
                {
                    visitedLocalFunctions.add(identity.rootName);
                    visit(localFunctionBody, false);
                }
            }
        }
        // Helper and nested callback returns exit their own function, not this test.
        const childOwnsCallbackReturns = ownsCallbackReturns && !ts.isFunctionLike(node);
        ts.forEachChild(node, child => visit(child, childOwnsCallbackReturns));
    };
    visit(body);
    return {
        asyncSeen,
        facts: {
            invocations,
            assertionCandidates,
            returnStatements,
            productionSymbolReferences,
            testAttributeReferences: []
        }
    };
}

function ensureRootSuite(ctx)
{
    if (ctx.rootSuite)
    {
        return ctx.rootSuite;
    }
    ctx.rootSuite = {
        id: `suite:${ctx.adapter}:${ctx.file}#<root>`,
        title: '<root>',
        file: ctx.file,
        adapter: ctx.adapter,
        suitePath: '<root>',
        parentSuiteId: null,
        sourceSpan: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
        hooks: [],
        traits: []
    };
    ctx.suiteRecords.push(ctx.rootSuite);
    return ctx.rootSuite;
}

function currentSuitePath(stack)
{
    return stack.map((suite) => suite.title).join(' › ');
}

function caseIdFor(ctx, framework, name, ordinal, seedExtra = '')
{
    const suffix = shortHash(`${name}\n${ordinal}${seedExtra ? `\n${seedExtra}` : ''}`);
    // Playwright e2e specs keep the legacy `vitest:` id namespace so the frozen
    // retention/replacement ledger and vitest history entries stay resolvable;
    // the record's `adapter` field still labels the framework as playwright.
    const idFramework = framework === 'playwright' ? 'vitest' : framework;
    return `${idFramework}:${ctx.file}#${slug(name)}-${suffix}`;
}

function nextOrdinal(ctx, name)
{
    const ordinal = (ctx.occurrenceByName.get(name) ?? 0) + 1;
    ctx.occurrenceByName.set(name, ordinal);
    return ordinal;
}

function addTestCase(ctx, entry)
{
    ctx.testCases.push(entry);
    const callback = entry._callback;
    if (callback?.name)
    {
        ctx.namedCallbacks.set(callback.name, entry.id);
    }
    delete entry._callback;
    return entry.id;
}

function attachBodyAndFacts(ctx, entry, callback)
{
    if (callback?.body)
    {
        const bodySpan = spanOf(ctx.sourceFile, callback.body);
        const bodySource = ctx.source.slice(callback.body.getStart(ctx.sourceFile), callback.body.getEnd()).trim();
        entry.bodySpan = bodySpan;
        if (bodySource)
        {
            entry.bodySource = bodySource;
        }
    }
    const facts = callback?.body ? callFacts(ctx, callback.body, ctx.namedCallbacks) : null;
    if (facts?.facts && (facts.facts.invocations.length > 0 || facts.facts.assertionCandidates.length > 0 || facts.facts.returnStatements.length > 0))
    {
        entry.methodFacts = facts.facts;
    }
    return facts;
}

function handleTestCall(ctx, stack, call, api)
{
    const args = call.arguments;
    const titleNode = args[0];
    const titleInfoValue = titleInfo(titleNode, ctx.source);
    const title = titleInfoValue.title;
    if (titleInfoValue.dynamic || title === null || api.dynamicNativeTable)
    {
        const start = positionOf(ctx.sourceFile, call.getStart(ctx.sourceFile));
        const displayName = title === null ? '<dynamic title>' : title;
        const nameForId = title === null ? '<dynamic-title>' : title;
        const id = caseIdFor(ctx, api.framework, nameForId, nextOrdinal(ctx, nameForId));
        addTestCase(ctx, {
            id,
            displayName,
            kind: 'test',
            identity: 'dynamic',
            ownerFile: ctx.file,
            ownerSuite: currentSuitePath(stack) || undefined,
            ownerClass: stack.length > 0 ? stack[stack.length - 1].title : undefined,
            adapter: api.framework,
            sourceSpan: spanOf(ctx.sourceFile, call),
            dynamicCaseInfo: {
                generationLocation: `${ctx.file}:${start.line}:${start.column}`,
                inventoryObligation: `runtime inventory must record every executed case id after ${ctx.file}:${start.line} execution`
            },
            traits: [{ name: 'DynamicTitle', value: 'true' }]
        });
        return;
    }

    let callback = null;
    let skipReason = api.api === 'skip' ? 'skip' : null;
    let todo = api.api === 'todo';
    let only = api.api === 'only';
    let fails = api.api === 'fails';
    let timeoutMs = null;
    let tag = null;
    for (const arg of args)
    {
        if (isLiteralStringLike(arg))
        {
            continue;
        }
        if (ts.isObjectLiteralExpression(arg))
        {
            const options = parseOptionsObject(arg);
            skipReason = skipReason ?? options.skipReason ?? null;
            todo = todo || options.todo;
            only = only || options.only;
            timeoutMs = options.timeoutMs ?? null;
            tag = options.tag ?? null;
            continue;
        }
        const info = callbackInfo(arg);
        if (info)
        {
            callback = info;
        }
    }

    const ordinal = nextOrdinal(ctx, title);
    const id = caseIdFor(ctx, api.framework, title, ordinal);
    const traits = [];
    if (only)
    {
        traits.push({ name: 'Only', value: 'true' });
    }
    if (todo)
    {
        traits.push({ name: 'Todo', value: 'true' });
    }
    if (fails)
    {
        traits.push({ name: 'Fails', value: 'true' });
    }
    if (tag)
    {
        traits.push({ name: 'Tag', value: tag });
    }

    const entry = {
        id,
        displayName: title,
        kind: 'test',
        identity: 'static',
        ownerFile: ctx.file,
        ownerSuite: currentSuitePath(stack) || undefined,
        ownerClass: stack.length > 0 ? stack[stack.length - 1].title : undefined,
        adapter: api.framework,
        sourceSpan: spanOf(ctx.sourceFile, call),
        traits,
        _callback: callback
    };
    if (skipReason)
    {
        entry.skipReason = skipReason;
    }
    if (timeoutMs !== null)
    {
        entry.timeoutMs = timeoutMs;
    }
    const fixture = callback ? fixtureFromCallback(callback.node) : null;
    if (fixture && api.framework === 'playwright')
    {
        entry.fixture = fixture;
    }
    const facts = attachBodyAndFacts(ctx, entry, callback);
    if (facts?.asyncSeen || callback?.async)
    {
        entry.traits.push({ name: 'Async', value: 'true' });
    }
    addTestCase(ctx, entry);
}

function handleEachCall(ctx, stack, call, api)
{
    const inner = call.expression;
    const tableNode = inner.arguments[0];
    const args = call.arguments;
    const titleNode = args[0];
    const titleInfoValue = titleInfo(titleNode, ctx.source);
    const title = titleInfoValue.title;
    if (titleInfoValue.dynamic || title === null)
    {
        handleTestCall(ctx, stack, call, { ...api, api: 'test' });
        return;
    }
    const rows = staticTableRows(tableNode);
    if (rows === null)
    {
        const start = positionOf(ctx.sourceFile, call.getStart(ctx.sourceFile));
        const ordinal = nextOrdinal(ctx, title);
        const id = caseIdFor(ctx, api.framework, title, ordinal);
        addTestCase(ctx, {
            id,
            displayName: title,
            kind: 'theory',
            identity: 'dynamic',
            ownerFile: ctx.file,
            ownerSuite: currentSuitePath(stack) || undefined,
            ownerClass: stack.length > 0 ? stack[stack.length - 1].title : undefined,
            adapter: api.framework,
            sourceSpan: spanOf(ctx.sourceFile, call),
            dynamicCaseInfo: {
                generationLocation: `${ctx.file}:${start.line}:${start.column}`,
                inventoryObligation: `runtime inventory must record every executed case id after ${ctx.file}:${start.line} test.each execution`
            },
            traits: [{ name: 'DynamicTable', value: 'true' }]
        });
        return;
    }

    const baseOrdinal = nextOrdinal(ctx, title);
    let callback = null;
    let timeoutMs = null;
    for (const arg of args)
    {
        if (isLiteralStringLike(arg))
        {
            continue;
        }
        if (ts.isObjectLiteralExpression(arg))
        {
            timeoutMs = parseOptionsObject(arg).timeoutMs ?? null;
            continue;
        }
        const info = callbackInfo(arg);
        if (info)
        {
            callback = info;
        }
    }
    for (const row of rows)
    {
        const rawValue = (element) =>
        {
            if (!element)
            {
                return undefined;
            }
            if (ts.isArrayLiteralExpression(element))
            {
                return element.elements.map((item) => literalText(item, ctx.source) ?? ctx.source.slice(item.getStart(ctx.sourceFile), item.getEnd()).replace(/\s+/gu, ' ').trim().slice(0, 120));
            }
            return literalText(element, ctx.source) ?? ctx.source.slice(element.getStart(ctx.sourceFile), element.getEnd()).replace(/\s+/gu, ' ').trim().slice(0, 120);
        };
        const values = rawValue(row.value);
        const objectValues = staticObjectRowValues(row.value);
        const rowKey = row.key;
        const { displayName, name, identitySeed } = formatRowTitle(
            title,
            objectValues ?? (Array.isArray(values) ? values : [values]),
            row.index,
            rowKey
        );
        const seedExtra = identitySeed === undefined
            ? String(rowKey === null ? row.index : rowKey)
            : String(identitySeed);
        const id = caseIdFor(ctx, api.framework, name, baseOrdinal, seedExtra);
        const entry = {
            id,
            displayName,
            kind: 'theory',
            identity: 'static',
            ownerFile: ctx.file,
            ownerSuite: currentSuitePath(stack) || undefined,
            ownerClass: stack.length > 0 ? stack[stack.length - 1].title : undefined,
            adapter: api.framework,
            sourceSpan: spanOf(ctx.sourceFile, call),
            traits: [{ name: 'DataRow', value: seedExtra }],
            _callback: callback
        };
        if (timeoutMs !== null)
        {
            entry.timeoutMs = timeoutMs;
        }
        attachBodyAndFacts(ctx, entry, callback);
        addTestCase(ctx, entry);
    }
}

function handleDescribeCall(ctx, stack, call, api)
{
    const titleNode = call.arguments[0];
    const title = isLiteralStringLike(titleNode) ? literalText(titleNode, ctx.source) : '<dynamic suite>';
    const suitePath = [...stack.map((suite) => suite.title), title].join(' › ');
    const id = `suite:${api.framework}:${ctx.file}#${suitePath}`;
    const parentSuiteId = stack.length > 0 ? stack[stack.length - 1].id : ensureRootSuite(ctx).id;
    const suite = {
        id,
        title,
        file: ctx.file,
        adapter: api.framework,
        suitePath,
        parentSuiteId,
        sourceSpan: spanOf(ctx.sourceFile, call),
        hooks: [],
        traits: []
    };
    if (api.api === 'skip')
    {
        suite.traits.push({ name: 'Skip', value: 'true' });
    }
    if (api.api === 'only')
    {
        suite.traits.push({ name: 'Only', value: 'true' });
    }
    ctx.suiteRecords.push(suite);
    return suite;
}

function handleHookCall(ctx, stack, call, hookName)
{
    const target = stack.length > 0 ? stack[stack.length - 1] : ensureRootSuite(ctx);
    target.hooks.push({ name: hookName, sourceSpan: spanOf(ctx.sourceFile, call) });
}

function handleUseCall(ctx, stack, call)
{
    const target = stack.length > 0 ? stack[stack.length - 1] : ensureRootSuite(ctx);
    const value = ctx.source.slice(call.getStart(ctx.sourceFile), call.getEnd()).replace(/\s+/gu, ' ').trim().slice(0, 240);
    if (!target.traits.some((trait) => trait.name === 'ProjectAnnotation' && trait.value === value))
    {
        target.traits.push({ name: 'ProjectAnnotation', value });
    }
}

function handleBehaviorTestCall(ctx, stack, call, api)
{
    const args = call.arguments;
    const behaviorBindingId = isLiteralStringLike(args[0]) ? literalText(args[0], ctx.source) : null;
    const kind = isLiteralStringLike(args[1]) ? literalText(args[1], ctx.source) : null;
    let title = null;
    if (isLiteralStringLike(args[2]))
    {
        title = literalText(args[2], ctx.source);
    }
    else if (ts.isObjectLiteralExpression(args[2]))
    {
        for (const property of args[2].properties)
        {
            if (ts.isPropertyAssignment(property)
        && property.name.getText(ctx.sourceFile) === 'title'
        && isLiteralStringLike(property.initializer))
            {
                title = literalText(property.initializer, ctx.source);
            }
        }
    }
    if (behaviorBindingId === null || kind === null || title === null)
    {
        const start = positionOf(ctx.sourceFile, call.getStart(ctx.sourceFile));
        const id = caseIdFor(ctx, api.framework, '<behavior-test>', nextOrdinal(ctx, '<behavior-test>'), `line:${start.line}`);
        addTestCase(ctx, {
            id,
            displayName: '<behaviorTest>',
            kind: 'behavior-test',
            identity: 'dynamic',
            ownerFile: ctx.file,
            ownerSuite: currentSuitePath(stack) || undefined,
            adapter: api.framework,
            sourceSpan: spanOf(ctx.sourceFile, call),
            dynamicCaseInfo: {
                generationLocation: `${ctx.file}:${start.line}:${start.column}`,
                inventoryObligation: `runtime inventory must record every executed behavior test case id after ${ctx.file}:${start.line} execution`
            },
            traits: [
                { name: 'BehaviorId', value: String(behaviorBindingId ?? 'unknown') },
                { name: 'BehaviorKind', value: String(kind ?? 'unknown') }
            ]
        });
        return;
    }
    const ordinal = nextOrdinal(ctx, title);
    const id = caseIdFor(ctx, api.framework, title, ordinal);
    let callback = null;
    for (const arg of args.slice(3))
    {
        const info = callbackInfo(arg);
        if (info)
        {
            callback = info;
        }
    }
    const entry = {
        id,
        displayName: title,
        kind: 'behavior-test',
        identity: 'static',
        ownerFile: ctx.file,
        ownerSuite: currentSuitePath(stack) || undefined,
        ownerClass: stack.length > 0 ? stack[stack.length - 1].title : undefined,
        adapter: api.framework,
        sourceSpan: spanOf(ctx.sourceFile, call),
        traits: [
            { name: 'BehaviorId', value: behaviorBindingId },
            { name: 'BehaviorKind', value: kind }
        ],
        _callback: callback
    };
    const facts = attachBodyAndFacts(ctx, entry, callback);
    if (facts?.asyncSeen || callback?.async)
    {
        entry.traits.push({ name: 'Async', value: 'true' });
    }
    addTestCase(ctx, entry);
}

// Native node:test has no test.each. Only this closed, inline frozen-table
// form is expanded; no binding evaluation or user code executes here.
function nativeFrozenLiteral(node, kind)
{
    if (!node || !ts.isCallExpression(node) || node.arguments.length !== 1
        || node.questionDotToken || !ts.isPropertyAccessExpression(node.expression)
        || node.expression.questionDotToken || !ts.isIdentifier(node.expression.expression)
        || node.expression.expression.text !== 'Object' || node.expression.name.text !== 'freeze')
    {
        return null;
    }
    return kind(node.arguments[0]) ? node.arguments[0] : null;
}

function nativeTableExpansion(ctx, loop)
{
    if (!ts.isForOfStatement(loop) || loop.awaitModifier || loop.parent !== ctx.sourceFile
        || !ts.isVariableDeclarationList(loop.initializer)
        || !(loop.initializer.flags & ts.NodeFlags.Const) || loop.initializer.declarations.length !== 1
        || !ts.isBlock(loop.statement) || loop.statement.statements.length !== 1)
    {
        return null;
    }
    const declaration = loop.initializer.declarations[0];
    const statement = loop.statement.statements[0];
    const table = nativeFrozenLiteral(loop.expression, ts.isArrayLiteralExpression);
    if (!ts.isIdentifier(declaration.name) || declaration.initializer || !table || !table.elements.length || table.elements.length > 256
        || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
    {
        return null;
    }
    const call = statement.expression;
    const api = resolveApi(ctx, call.expression);
    const imported = ts.isIdentifier(call.expression) && ctx.imports.get(call.expression.text);
    const callback = call.arguments.length === 2 ? callbackInfo(call.arguments[1]) : null;
    const title = call.arguments[0];
    if (!imported || imported.module !== 'node:test' || api?.framework !== 'node-test'
        || !TEST_API_NAMES.has(api.api) || !callback || !ts.isTemplateExpression(title)
        || call.questionDotToken)
    {
        return null;
    }
    const rowName = declaration.name.text;
    const rows = [];
    const freezeReceivers = new Set([loop.expression.expression.expression]);
    for (const element of table.elements)
    {
        const object = nativeFrozenLiteral(element, ts.isObjectLiteralExpression);
        if (!object)
        {
            return null;
        }
        freezeReceivers.add(element.expression.expression);
        const values = new Map();
        for (const property of object.properties)
        {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
                || values.has(property.name.text))
            {
                return null;
            }
            const array = nativeFrozenLiteral(property.initializer, ts.isArrayLiteralExpression);
            if (ts.isStringLiteral(property.initializer))
            {
                values.set(property.name.text, property.initializer.text);
            }
            else if (array && array.elements.every(ts.isStringLiteral))
            {
                freezeReceivers.add(property.initializer.expression.expression);
                values.set(property.name.text, array.elements.map((item) => item.text));
            }
            else
            {
                return null;
            }
        }
        if (typeof values.get('caseName') !== 'string' || !values.get('caseName')
            || typeof values.get('authorityId') !== 'string' || !values.get('authorityId'))
        {
            return null;
        }
        rows.push({ values, element });
    }
    const titleKeys = title.templateSpans.map(({ expression }) =>
        ts.isPropertyAccessExpression(expression) && !expression.questionDotToken
        && ts.isIdentifier(expression.expression) && expression.expression.text === rowName
            ? expression.name.text : null);
    if (titleKeys.some((key) => key === null) || !titleKeys.includes('caseName') || !titleKeys.includes('authorityId'))
    {
        return null;
    }
    const assertionBindings = new Set([...ctx.imports].filter(([, binding]) =>
        ['node:assert/strict', 'node:assert'].includes(binding.module) && binding.exported === 'default').map(([name]) => name));
    let valid = true;
    const inspect = (node) =>
    {
        // Frozen arrays still inherit their iterator. Observable access to its
        // authority (including prototype escape routes) is outside this form.
        if (ts.isIdentifier(node) && ['globalThis', 'global', 'eval', 'Function', 'Reflect', 'Array', 'Symbol'].includes(node.text))
        {
            valid = false;
        }
        if (ts.isPropertyAccessExpression(node) && ['prototype', '__proto__', 'constructor'].includes(node.name.text))
        {
            valid = false;
        }
        if (ts.isElementAccessExpression(node) && (!ts.isStringLiteral(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)
            || ['prototype', '__proto__', 'constructor'].includes(node.argumentExpression.text)))
        {
            valid = false;
        }
        if (ts.isIdentifier(node) && node.text === 'Object' && !freezeReceivers.has(node))
        {
            const property = node.parent;
            const invocation = property.parent;
            const safeRead = ts.isPropertyAccessExpression(property) && property.expression === node
                && !property.questionDotToken && property.name.text === 'hasOwn'
                && ts.isCallExpression(invocation) && invocation.expression === property
                && !invocation.questionDotToken && invocation.arguments.length === 2
                && ts.isStringLiteral(invocation.arguments[1]);
            if (!safeRead)
            {
                valid = false;
            }
        }
        if (ts.isIdentifier(node) && assertionBindings.has(node.text))
        {
            const parent = node.parent;
            if (!(ts.isImportClause(parent) && parent.name === node)
                && !(ts.isPropertyAccessExpression(parent) && parent.expression === node
                    && !parent.questionDotToken && ts.isCallExpression(parent.parent)
                    && parent.parent.expression === parent && !parent.parent.questionDotToken))
            {
                valid = false;
            }
        }
        if (ts.isIdentifier(node) && node.text === call.expression.text)
        {
            const parent = node.parent;
            if (!(ts.isImportClause(parent) && parent.name === node)
                && !(ts.isImportSpecifier(parent) && parent.name === node)
                && !(ts.isCallExpression(parent) && parent.expression === node))
            {
                valid = false;
            }
        }
        if (ts.isIdentifier(node) && node.text === rowName && node !== declaration.name)
        {
            const access = node.parent;
            if (!ts.isPropertyAccessExpression(access) || access.expression !== node || access.questionDotToken
                || !rows.every((row) => row.values.has(access.name.text)))
            {
                valid = false;
            }
            else
            {
                let target = access;
                while (ts.isParenthesizedExpression(target.parent))
                {
                    target = target.parent;
                }
                const parent = target.parent;
                if ((ts.isBinaryExpression(parent) && parent.left === target
                        && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                        && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
                    || ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)
                    || ts.isDeleteExpression(parent))
                {
                    valid = false;
                }
                const assertionRead = ts.isCallExpression(parent) && parent.arguments.includes(target)
                    && ts.isPropertyAccessExpression(parent.expression) && !parent.expression.questionDotToken
                    && ts.isIdentifier(parent.expression.expression) && assertionBindings.has(parent.expression.expression.text)
                    && ['deepEqual', 'deepStrictEqual'].includes(parent.expression.name.text) && !parent.questionDotToken;
                if (rows.some((row) => Array.isArray(row.values.get(access.name.text)))
                    && !(ts.isForOfStatement(parent) && parent.expression === target) && !assertionRead)
                {
                    valid = false;
                }
            }
        }
        // A nested registration cannot share the outer row's callback identity.
        if (ts.isCallExpression(node) && node !== call && node.pos >= callback.node.pos
            && node.end <= callback.node.end && resolveApi(ctx, node.expression)?.framework === 'node-test')
        {
            valid = false;
        }
        ts.forEachChild(node, inspect);
    };
    inspect(ctx.sourceFile);
    if (!valid)
    {
        return null;
    }
    const identities = new Set();
    for (const row of rows)
    {
        row.title = title.head.text;
        for (let index = 0; index < title.templateSpans.length; index++)
        {
            const value = row.values.get(titleKeys[index]);
            if (typeof value !== 'string')
            {
                return null;
            }
            row.title += value + title.templateSpans[index].literal.text;
        }
        const identity = JSON.stringify([row.values.get('caseName'), row.values.get('authorityId')]);
        if (identities.has(identity) || rows.some((other) => other !== row && other.title === row.title))
        {
            return null;
        }
        identities.add(identity);
    }
    return { rows, call, callback, api };
}

function visitNode(ctx, node, stack)
{
    if (ts.isForOfStatement(node))
    {
        const expansion = nativeTableExpansion(ctx, node);
        if (expansion)
        {
            for (const [index, row] of expansion.rows.entries())
            {
                const entry = {
                    id: caseIdFor(ctx, 'node-test', row.title, nextOrdinal(ctx, row.title)),
                    displayName: row.title,
                    kind: 'theory',
                    identity: 'static',
                    ownerFile: ctx.file,
                    adapter: 'node-test',
                    sourceSpan: spanOf(ctx.sourceFile, expansion.call),
                    traits: [
                        { name: 'DataRow', value: String(index) },
                        { name: 'NativeRowDigest', value: createHash('sha256').update(JSON.stringify([...row.values])).digest('hex') },
                        { name: 'NativeRowSource', value: JSON.stringify(spanOf(ctx.sourceFile, row.element)) }
                    ]
                };
                attachBodyAndFacts(ctx, entry, expansion.callback);
                addTestCase(ctx, entry);
            }
            return;
        }
    }
    if (ts.isCallExpression(node))
    {
        const callee = node.expression;
        let api = null;
        let eachCall = null;
        if (ts.isCallExpression(callee))
        {
            const innerApi = resolveApi(ctx, callee.expression);
            if (innerApi?.api === 'each')
            {
                api = { ...innerApi, api: 'test' };
                eachCall = callee;
            }
        }
        else
        {
            api = resolveApi(ctx, callee);
        }
        if (api)
        {
            const simpleTestApi = api.api === 'test' || api.api === 'it' || api.api === 'skip' || api.api === 'only' || api.api === 'todo' || api.api === 'fails';
            if (simpleTestApi)
            {
                if (eachCall)
                {
                    handleEachCall(ctx, stack, node, { ...api, eachCall });
                }
                else
                {
                    let ancestor = node.parent;
                    while (ancestor && !ts.isSourceFile(ancestor)
                        && !ts.isForOfStatement(ancestor) && !ts.isForStatement(ancestor)
                        && !ts.isForInStatement(ancestor) && !ts.isWhileStatement(ancestor)
                        && !ts.isDoStatement(ancestor))
                    {
                        ancestor = ancestor.parent;
                    }
                    const dynamicNativeTable = api.framework === 'node-test' && ancestor && !ts.isSourceFile(ancestor);
                    if (dynamicNativeTable)
                    {
                        ctx.diagnostics.push({ severity: 'error', code: 'native-table-not-closed', file: ctx.file,
                            message: `native registration is not an immutable closed table at ${ctx.file}:${positionOf(ctx.sourceFile, node.getStart()).line}` });
                    }
                    handleTestCall(ctx, stack, node, { ...api, dynamicNativeTable });
                }
            }
            else if (api.api === 'each')
            {
                // test.each(...) without an outer registration call is not a case.
            }
            else if (api.api === 'describe' || api.baseApi === 'describe')
            {
                const suite = handleDescribeCall(ctx, stack, node, api);
                const childStack = [...stack, suite];
                for (const arg of node.arguments)
                {
                    visitChildren(ctx, arg, childStack);
                }
                return;
            }
            else if (HOOK_NAMES.has(api.api))
            {
                handleHookCall(ctx, stack, node, api.api);
            }
            else if (api.api === 'use')
            {
                handleUseCall(ctx, stack, node);
            }
            else if (api.api === 'behaviorTest')
            {
                handleBehaviorTestCall(ctx, stack, node, api);
            }
        }
    }
    visitChildren(ctx, node, stack);
}

function visitChildren(ctx, node, stack)
{
    ts.forEachChild(node, (child) => visitNode(ctx, child, stack));
}

function extractFile(entry, root)
{
    const file = entry.path;
    const adapter = entry.adapter;
    const absolute = path.join(root, file);
    if (!existsSync(absolute))
    {
        return {
            testCases: [],
            suiteRecords: [],
            diagnostics: [{
                severity: 'error',
                code: 'ts-adapter-file-missing',
                file,
                message: `requested adapter input file does not exist: ${file}`
            }]
        };
    }
    const source = readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const ctx = createExtractionContext({ root, file, adapter, source, sourceFile });
    if (sourceFile.parseDiagnostics.length > 0)
    {
        for (const diagnostic of sourceFile.parseDiagnostics.slice(0, 20))
        {
            const at = diagnostic.start === undefined ? null : positionOf(sourceFile, diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            ctx.diagnostics.push({
                severity: 'error',
                code: 'ts-parse-error',
                file,
                message: at === null ? message : `${message} at ${file}:${at.line}`
            });
        }
        return { testCases: [], suiteRecords: [], diagnostics: ctx.diagnostics };
    }
    visitChildren(ctx, sourceFile, []);
    if (ctx.rootSuite && ctx.rootSuite.hooks.length === 0 && ctx.rootSuite.traits.length === 0)
    {
        ctx.suiteRecords = ctx.suiteRecords.filter((suite) => suite.id !== ctx.rootSuite.id);
        ctx.rootSuite = null;
    }
    return { testCases: ctx.testCases, suiteRecords: ctx.suiteRecords, diagnostics: ctx.diagnostics };
}

function readRequest()
{
    const requestPath = process.argv[2];
    if (requestPath)
    {
        return JSON.parse(readFileSync(requestPath, 'utf8'));
    }
    const chunks = [];
    for (const chunk of process.stdin)
    {
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function main()
{
    const request = readRequest();
    const root = request.root;
    const files = Array.isArray(request.files) ? request.files : [];
    const testCases = [];
    const suiteRecords = [];
    const diagnostics = [];
    for (const entry of files)
    {
        const result = extractFile(entry, root);
        testCases.push(...result.testCases);
        suiteRecords.push(...result.suiteRecords);
        diagnostics.push(...result.diagnostics);
    }
    testCases.sort((left, right) => left.id.localeCompare(right.id));
    suiteRecords.sort((left, right) => left.id.localeCompare(right.id));
    diagnostics.sort((left, right) => (
        left.severity.localeCompare(right.severity)
    || left.code.localeCompare(right.code)
    || String(left.file ?? '').localeCompare(String(right.file ?? ''))
    ));
    process.stdout.write(`${JSON.stringify({ testCases, suiteRecords, diagnostics })}\n`);
}

main();
