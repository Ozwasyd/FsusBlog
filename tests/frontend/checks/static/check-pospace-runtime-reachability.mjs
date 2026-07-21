#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../../../..');
const frontendRoot = path.join(repoRoot, 'src/frontend');
const require = createRequire(import.meta.url);
const resolveFrontendDependency = name => require(require.resolve(name, { paths: [frontendRoot] }));
const ts = (() =>
{
    try
    {
        return resolveFrontendDependency('typescript');
    }
    catch (error)
    {
        if (error?.code !== 'MODULE_NOT_FOUND')
        {
            throw error;
        }
        throw new Error('pospace runtime reachability requires the frontend TypeScript dependency', { cause: error });
    }
})();
const parseVueSfc = (() =>
{
    try
    {
        return resolveFrontendDependency('@vue/compiler-sfc').parse;
    }
    catch (error)
    {
        if (error?.code !== 'MODULE_NOT_FOUND')
        {
            throw error;
        }
        throw new Error('pospace runtime reachability requires the frontend @vue/compiler-sfc dependency', { cause: error });
    }
})();

const nodes = Object.freeze({
    registry: 'src/frontend/src/security/challenge-capability-registry.ts',
    executor: 'src/frontend/src/services/securityPoSpaceChallengeExecutor.ts',
    workerClient: 'src/frontend/src/services/securityPoSpaceClient.ts',
    runtime: 'src/frontend/src/services/securityPoSpaceRuntime.ts',
    worker: 'src/frontend/src/workers/security/pospace.worker.ts',
    challengeHost: 'src/frontend/src/components/security/FsusSecurityChallenge.vue',
    poSpaceHost: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
    notification: 'src/frontend/src/composables/useNotification.ts'
});

const executorModule = '@/services/securityPoSpaceChallengeExecutor';

export function checkPoSpaceRuntimeReachability(root = repoRoot)
{
    const facts = Object.fromEntries(
        Object.entries(nodes).map(([id, relative]) => [
            id,
            inspectModule(readFileSync(path.join(root, relative), 'utf8'), relative)
        ])
    );

    const edges = Object.freeze([
        {
            from: 'registry',
            to: 'executor',
            kind: 'dynamic-import',
            module: executorModule
        },
        {
            from: 'executor',
            to: 'workerClient',
            kind: 'static-import',
            module: './securityPoSpaceClient'
        },
        {
            from: 'executor',
            to: 'runtime',
            kind: 'static-import',
            module: './securityPoSpaceRuntime'
        },
        {
            from: 'workerClient',
            to: 'worker',
            kind: 'worker-url-import',
            module: '@/workers/security/pospace.worker.ts?worker&url'
        },
        {
            from: 'challengeHost',
            to: 'poSpaceHost',
            kind: 'static-import',
            module: './FsusPoSpaceChallenge.vue'
        },
        {
            from: 'poSpaceHost',
            to: 'executor',
            kind: 'dynamic-import',
            module: executorModule
        },
        {
            from: 'notification',
            to: 'executor',
            kind: 'dynamic-import',
            module: executorModule
        }
    ]);

    for (const edge of edges)
    {
        const present = edge.kind === 'dynamic-import'
            ? hasExpectedDynamicModule(facts[edge.from], edge.module)
            : facts[edge.from].valueStaticImports.has(edge.module);
        assert.ok(
            present,
            `${nodes[edge.from]} must keep the ${edge.kind} edge to ${nodes[edge.to]}`
        );
    }

    for (const hostId of ['poSpaceHost', 'notification'])
    {
        assert.ok(
            !facts[hostId].eagerExecutorImport,
            `${nodes[hostId]} must keep the PoSpace executor lazy instead of restoring an eager compatibility edge`
        );
    }

    assert.ok(
        facts.executor.valueImports.get('./securityPoSpaceClient')?.has('createPoSpaceWorkerClient'),
        'the shared executor must own PoSpace Worker client construction'
    );
    assert.ok(
        facts.executor.valueImports.get('./securityPoSpaceRuntime')?.has('createPoSpaceVerifyPayload'),
        'the shared executor must own PoSpace verify payload construction'
    );

    const forbiddenHostImplementations = Object.freeze([
        ['direct Worker construction', facts => facts.newExpressions.has('Worker')],
        ['Argon2 implementation import', facts => hasRuntimeModule(facts, isArgon2ModuleSpecifier) || facts.valueIdentifiers.has('argon2idAsync')],
        ['runtime proof solve', facts => facts.valueIdentifiers.has('solvePoSpaceProof')],
        ['Worker client construction', facts => facts.valueIdentifiers.has('createPoSpaceWorkerClient')],
        ['verify payload construction', facts => facts.valueIdentifiers.has('createPoSpaceVerifyPayload')],
        ['direct Worker URL import', facts => hasRuntimeModule(facts, module => module.includes('pospace.worker.ts?worker'))]
    ]);

    for (const hostId of ['challengeHost', 'poSpaceHost', 'notification'])
    {
        for (const [label, isPresent] of forbiddenHostImplementations)
        {
            assert.ok(
                !isPresent(facts[hostId]),
                `${nodes[hostId]} must not duplicate ${label}; use the shared executor`
            );
        }
    }

    assert.ok(
        facts.runtime.valueStaticImports.has('@noble/hashes/argon2.js'),
        'securityPoSpaceRuntime.ts remains the single Argon2 implementation owner'
    );
    assert.ok(
        facts.worker.valueImports.get('../../services/securityPoSpaceRuntime')?.has('solvePoSpaceProof'),
        'the dedicated Worker must delegate solving to the canonical runtime'
    );

    return {
        check: 'pospace-runtime-reachability',
        version: 5,
        ok: true,
        nodes,
        edges: edges.map(({ from, to, kind }) => ({ from, to, kind })),
        duplicateImplementationHosts: ['challengeHost', 'poSpaceHost', 'notification']
    };
}

function inspectModule(source, relative)
{
    const facts = {
        dynamicImports: new Set(),
        lazyDynamicImports: new Set(),
        moduleTopLevelDynamicImports: new Set(),
        eagerExecutorImport: false,
        lazyExecutorImport: false,
        runtimeImports: new Set(),
        valueStaticImports: new Set(),
        valueImports: new Map(),
        valueIdentifiers: new Set(),
        newExpressions: new Set(),
        workerConstructorAliases: new Set(['Worker'])
    };
    const scripts = relative.endsWith('.vue') ? extractVueScripts(source, relative) : [source];
    assert.ok(scripts.length > 0, `${relative} must contain an executable script block`);

    for (const [index, script] of scripts.entries())
    {
        const sourceFile = ts.createSourceFile(
            `${relative}#script-${index}.ts`,
            script,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );
        assert.equal(
            sourceFile.parseDiagnostics.length,
            0,
            `${relative} script ${index + 1} must remain parseable: ${sourceFile.parseDiagnostics.map(item => item.messageText).join('; ')}`
        );
        visit(sourceFile, facts, relative);
    }
    return facts;
}

function visit(node, facts, relative)
{
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
    {
        const module = node.moduleSpecifier.text;
        if (!isTypeOnlyImport(node))
        {
            facts.runtimeImports.add(module);
            facts.eagerExecutorImport ||= isExecutorModuleSpecifier(module, relative);
            facts.valueStaticImports.add(module);
            const names = facts.valueImports.get(module) ?? new Set();
            for (const name of importedValueNames(node))
            {
                names.add(name.imported);
                facts.valueIdentifiers.add(name.imported);
                facts.valueIdentifiers.add(name.local);
            }
            facts.valueImports.set(module, names);
        }
        return;
    }
    if (ts.isExportDeclaration(node))
    {
        if (!isTypeOnlyExport(node))
        {
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
            {
                facts.runtimeImports.add(node.moduleSpecifier.text);
                facts.eagerExecutorImport ||= isExecutorModuleSpecifier(node.moduleSpecifier.text, relative);
            }
            if (node.exportClause && ts.isNamedExports(node.exportClause))
            {
                for (const element of node.exportClause.elements)
                {
                    if (!element.isTypeOnly)
                    {
                        facts.valueIdentifiers.add(element.propertyName?.text ?? element.name.text);
                        facts.valueIdentifiers.add(element.name.text);
                    }
                }
            }
        }
        return;
    }
    if (
        ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
    )
    {
        const module = node.arguments[0].text;
        facts.dynamicImports.add(module);
        if (isDeferredDynamicImport(node))
        {
            facts.lazyDynamicImports.add(module);
            facts.lazyExecutorImport ||= isExecutorModuleSpecifier(module, relative);
        }
        else
        {
            facts.moduleTopLevelDynamicImports.add(module);
            facts.runtimeImports.add(module);
            facts.eagerExecutorImport ||= isExecutorModuleSpecifier(module, relative);
        }
    }
    if (
        ts.isElementAccessExpression(node)
    && node.argumentExpression
    && isValueIdentifier(node)
    )
    {
        const property = staticStringValue(node.argumentExpression);
        if (property)
        {
            facts.valueIdentifiers.add(property);
        }
    }
    if (ts.isBindingElement(node) && node.propertyName)
    {
        const property = bindingPropertyName(node.propertyName);
        if (property)
        {
            facts.valueIdentifiers.add(property);
        }
    }
    if (ts.isIdentifier(node) && isValueIdentifier(node))
    {
        facts.valueIdentifiers.add(node.text);
    }
    if (ts.isNewExpression(node))
    {
        if (isWorkerConstructorExpression(node.expression, facts))
        {
            facts.newExpressions.add('Worker');
        }
        else
        {
            const constructor = expressionPropertyName(node.expression);
            if (constructor)
            {
                facts.newExpressions.add(constructor);
            }
        }
    }
    if (
        ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && isWorkerConstructorExpression(node.initializer, facts)
    )
    {
        facts.workerConstructorAliases.add(node.name.text);
    }
    if (
        ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(node.left)
    && isWorkerConstructorExpression(node.right, facts)
    )
    {
        facts.workerConstructorAliases.add(node.left.text);
    }
    ts.forEachChild(node, child => visit(child, facts, relative));
}

function isDeferredDynamicImport(node)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (!ts.isFunctionLike(current))
        {
            continue;
        }
        return !isImmediatelyInvokedFunction(current);
    }
    return false;
}

function isImmediatelyInvokedFunction(node)
{
    const expression = outerRuntimeExpression(node);
    if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression)
    {
        return true;
    }
    if (
        ts.isPropertyAccessExpression(expression.parent)
    && expression.parent.expression === expression
    && ['call', 'apply'].includes(expression.parent.name.text)
    && ts.isCallExpression(expression.parent.parent)
    && expression.parent.parent.expression === expression.parent
    )
    {
        return true;
    }
    if (
        ts.isCallExpression(expression.parent)
    && expression.parent.arguments.includes(expression)
    && isImmediateCallbackCall(expression.parent.expression)
    )
    {
        return true;
    }
    return false;
}

function outerRuntimeExpression(node)
{
    let expression = node;
    while (expression.parent)
    {
        const parent = expression.parent;
        if (
            ts.isParenthesizedExpression(parent)
        || ts.isAsExpression(parent)
        || ts.isSatisfiesExpression(parent)
        || ts.isNonNullExpression(parent)
        )
        {
            expression = parent;
            continue;
        }
        if (
            ts.isBinaryExpression(parent)
        && parent.operatorToken.kind === ts.SyntaxKind.CommaToken
        && parent.right === expression
        )
        {
            expression = parent;
            continue;
        }
        break;
    }
    return expression;
}

function isImmediateCallbackCall(expression)
{
    const target = unwrapRuntimeExpression(expression);
    return ts.isPropertyAccessExpression(target)
    && ['then', 'catch', 'finally'].includes(target.name.text);
}

function unwrapRuntimeExpression(node)
{
    let expression = node;
    while (
        ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    )
    {
        expression = expression.expression;
    }
    return expression;
}

function staticStringValue(node)
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isStringLiteralLike(expression))
    {
        return expression.text;
    }
    if (
        ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    )
    {
        const left = staticStringValue(expression.left);
        const right = staticStringValue(expression.right);
        return left === null || right === null ? null : left + right;
    }
    return null;
}

function bindingPropertyName(node)
{
    if (ts.isStringLiteralLike(node) || ts.isIdentifier(node))
    {
        return node.text;
    }
    return ts.isComputedPropertyName(node) ? staticStringValue(node.expression) : null;
}

function isWorkerConstructorExpression(node, facts)
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isIdentifier(expression))
    {
        return facts.workerConstructorAliases.has(expression.text);
    }
    if (ts.isPropertyAccessExpression(expression))
    {
        return expression.name.text === 'Worker';
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression)
    {
        return staticStringValue(expression.argumentExpression) === 'Worker';
    }
    if (
        ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
    {
        return isWorkerConstructorExpression(expression.right, facts);
    }
    return false;
}

function expressionPropertyName(node)
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isIdentifier(expression))
    {
        return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression))
    {
        return expression.name.text;
    }
    if (
        ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    )
    {
        return staticStringValue(expression.argumentExpression);
    }
    return null;
}

function isTypeOnlyImport(node)
{
    const clause = node.importClause;
    if (!clause)
    {
        return false;
    }
    if (clause.isTypeOnly)
    {
        return true;
    }
    if (clause.name)
    {
        return false;
    }
    if (!clause.namedBindings)
    {
        return false;
    }
    if (ts.isNamespaceImport(clause.namedBindings))
    {
        return false;
    }
    return clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every(element => element.isTypeOnly);
}

function importedValueNames(node)
{
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly)
    {
        return [];
    }
    const names = [];
    if (clause.name)
    {
        names.push({ imported: 'default', local: clause.name.text });
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
    {
        names.push({ imported: '*', local: clause.namedBindings.name.text });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
    {
        for (const element of clause.namedBindings.elements)
        {
            if (!element.isTypeOnly)
            {
                names.push({
                    imported: element.propertyName?.text ?? element.name.text,
                    local: element.name.text
                });
            }
        }
    }
    return names;
}

function isTypeOnlyExport(node)
{
    if (node.isTypeOnly)
    {
        return true;
    }
    return Boolean(
        node.exportClause
    && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every(element => element.isTypeOnly)
    );
}

function isValueIdentifier(node)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (ts.isTypeNode(current))
        {
            return false;
        }
        if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current))
        {
            return false;
        }
        if (
            ts.isTypeAliasDeclaration(current)
      || ts.isInterfaceDeclaration(current)
      || ts.isTypeParameterDeclaration(current)
        )
        {
            return false;
        }
        if (ts.isStatement(current) || ts.isExpression(current))
        {
            break;
        }
    }
    if (
        (ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent))
    && node.parent.name === node
    && !ts.isShorthandPropertyAssignment(node.parent)
    )
    {
        return false;
    }
    if (isAmbientDeclarationName(node))
    {
        return false;
    }
    return true;
}

function isAmbientDeclarationName(node)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if ((current.flags & ts.NodeFlags.Ambient) !== 0)
        {
            return true;
        }
        if (ts.canHaveModifiers(current))
        {
            const modifiers = ts.getModifiers(current) ?? [];
            if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))
            {
                return true;
            }
        }
    }
    return false;
}

function extractVueScripts(source, relative)
{
    const { descriptor, errors } = parseVueSfc(source, { filename: relative });
    assert.equal(
        errors.length,
        0,
        `${relative} must remain a valid Vue SFC: ${errors.map(formatVueSfcError).join('; ')}`
    );
    return [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean);
}

function formatVueSfcError(error)
{
    return error instanceof Error ? error.message : String(error);
}

function isExecutorModuleSpecifier(module, relative)
{
    const clean = module.replace(/[?#].*$/u, '');
    let resolved;
    if (clean.startsWith('@/'))
    {
        resolved = path.posix.join('src/frontend/src', clean.slice(2));
    }
    else if (clean.startsWith('.'))
    {
        resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), clean));
    }
    else
    {
        return false;
    }
    const sourceIdentity = resolved.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
    return sourceIdentity === nodes.executor.replace(/\.ts$/u, '');
}

function hasExpectedDynamicModule(facts, expected)
{
    return expected === executorModule
        ? facts.lazyExecutorImport
        : facts.lazyDynamicImports.has(expected);
}

function isArgon2ModuleSpecifier(module)
{
    return module === '@noble/hashes/argon2' || module === '@noble/hashes/argon2.js';
}

function hasRuntimeModule(facts, predicate)
{
    return [...facts.runtimeImports, ...facts.dynamicImports].some(predicate);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === scriptPath)
{
    console.log(JSON.stringify(checkPoSpaceRuntimeReachability()));
}
