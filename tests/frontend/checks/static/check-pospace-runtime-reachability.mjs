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
        version: 7,
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
        workerGlobalAliases: new Set(['globalThis', 'self', 'window']),
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
        const flow = analyzeRuntimeFlow(sourceFile);
        visit(sourceFile, facts, relative, flow);
    }
    return facts;
}

function visit(node, facts, relative, flow)
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
        if (isDeferredDynamicImport(node, flow))
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
        const property = staticStringValue(node.argumentExpression, flow);
        if (property)
        {
            facts.valueIdentifiers.add(property);
        }
    }
    if (ts.isBindingElement(node) && node.propertyName)
    {
        const property = bindingPropertyName(node.propertyName, flow);
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
        if (isWorkerConstructorExpression(node.expression, facts, flow))
        {
            facts.newExpressions.add('Worker');
        }
    }
    if (
        ts.isCallExpression(node)
    && isReflectConstructCall(node.expression)
    && node.arguments[0]
    && isWorkerConstructorExpression(node.arguments[0], facts, flow)
    )
    {
        facts.newExpressions.add('Worker');
    }
    if (
        ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && isWorkerConstructorExpression(node.initializer, facts, flow)
    )
    {
        facts.workerConstructorAliases.add(node.name.text);
    }
    if (
        ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && isWorkerGlobalExpression(node.initializer, facts)
    )
    {
        facts.workerGlobalAliases.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer)
    {
        recordWorkerDestructuringAliases(node.name, node.initializer, facts, flow);
    }
    if (
        ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(node.left)
    && isWorkerConstructorExpression(node.right, facts, flow)
    )
    {
        facts.workerConstructorAliases.add(node.left.text);
    }
    if (
        ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(node.left)
    && isWorkerGlobalExpression(node.right, facts)
    )
    {
        facts.workerGlobalAliases.add(node.left.text);
    }
    ts.forEachChild(node, child => visit(child, facts, relative, flow));
}

function isDeferredDynamicImport(node, flow)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (!ts.isFunctionLike(current))
        {
            continue;
        }
        return !flow.immediateFunctions.has(current);
    }
    return false;
}

const proactiveCallbackFunctions = new Set([
    'queueMicrotask',
    'requestAnimationFrame',
    'requestIdleCallback',
    'setImmediate',
    'setInterval',
    'setTimeout'
]);

const proactivePromiseCallbackMethods = new Set([
    'catch',
    'finally',
    'then'
]);

const synchronousArrayCallbackMethods = new Set([
    'every',
    'filter',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'flatMap',
    'forEach',
    'map',
    'reduce',
    'reduceRight',
    'some',
    'sort',
    'toSorted'
]);

function analyzeRuntimeFlow(sourceFile)
{
    const flow = {
        functionBindings: [],
        constValueBindings: [],
        immediateFunctions: new Set()
    };
    collectRuntimeBindings(sourceFile, flow);
    let changed;
    do
    {
        changed = false;
        walk(sourceFile, node =>
        {
            if (ts.isCallExpression(node) && isImmediateExecutionContext(node, flow))
            {
                changed = markImmediateFunction(resolveCalledFunction(node.expression, node, flow), flow) || changed;
                if (isProactiveCallbackCall(node, flow))
                {
                    for (const argument of node.arguments)
                    {
                        changed = markImmediateFunction(resolveFunctionValue(argument, node, flow), flow) || changed;
                    }
                }
            }
            if (
                ts.isNewExpression(node)
            && isImmediateExecutionContext(node, flow)
            && ts.isIdentifier(unwrapRuntimeExpression(node.expression))
            && unwrapRuntimeExpression(node.expression).text === 'Promise'
            )
            {
                for (const argument of node.arguments ?? [])
                {
                    changed = markImmediateFunction(resolveFunctionValue(argument, node, flow), flow) || changed;
                }
            }
        });
    }
    while (changed);
    return flow;
}

function collectRuntimeBindings(sourceFile, flow)
{
    walk(sourceFile, node =>
    {
        if (ts.isFunctionDeclaration(node) && node.name)
        {
            flow.functionBindings.push(makeBinding(node.name.text, node, node, true));
        }
        if (
            ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && isConstVariableDeclaration(node)
        )
        {
            const binding = makeBinding(node.name.text, node, node.initializer, false);
            flow.constValueBindings.push(binding);
            if (
                ts.isFunctionExpression(unwrapRuntimeExpression(node.initializer))
            || ts.isArrowFunction(unwrapRuntimeExpression(node.initializer))
            || ts.isIdentifier(unwrapRuntimeExpression(node.initializer))
            )
            {
                flow.functionBindings.push(binding);
            }
        }
    });
}

function walk(node, callback)
{
    callback(node);
    ts.forEachChild(node, child => walk(child, callback));
}

function makeBinding(name, declaration, value, hoisted)
{
    return {
        name,
        declaration,
        value,
        hoisted,
        scope: lexicalScope(declaration)
    };
}

function lexicalScope(node)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (
            ts.isBlock(current)
        || ts.isModuleBlock(current)
        || ts.isSourceFile(current)
        || ts.isCaseBlock(current)
        )
        {
            return current;
        }
    }
    return node.getSourceFile();
}

function isConstVariableDeclaration(node)
{
    return ts.isVariableDeclarationList(node.parent)
    && (node.parent.flags & ts.NodeFlags.Const) !== 0;
}

function resolveBinding(bindings, identifier, useNode)
{
    return bindings
        .filter(binding => binding.name === identifier.text)
        .filter(binding => binding.scope.pos <= useNode.pos && useNode.end <= binding.scope.end)
        .filter(binding => binding.hoisted || binding.declaration.pos < useNode.pos)
        .sort((left, right) => (left.scope.end - left.scope.pos) - (right.scope.end - right.scope.pos))[0] ?? null;
}

function resolveCalledFunction(expression, useNode, flow)
{
    const target = unwrapRuntimeExpression(expression);
    if (
        ts.isPropertyAccessExpression(target)
    && ['call', 'apply'].includes(target.name.text)
    )
    {
        return resolveFunctionValue(target.expression, useNode, flow);
    }
    return resolveFunctionValue(target, useNode, flow);
}

function resolveFunctionValue(expression, useNode, flow, seen = new Set())
{
    const target = unwrapRuntimeExpression(expression);
    if (
        ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
    {
        return resolveFunctionValue(target.right, useNode, flow, seen);
    }
    if (ts.isFunctionExpression(target) || ts.isArrowFunction(target) || ts.isFunctionDeclaration(target))
    {
        return target;
    }
    if (!ts.isIdentifier(target) || seen.has(target.text))
    {
        return null;
    }
    seen.add(target.text);
    const binding = resolveBinding(flow.functionBindings, target, useNode);
    return binding ? resolveFunctionValue(binding.value, binding.declaration, flow, seen) : null;
}

function markImmediateFunction(node, flow)
{
    if (!node || flow.immediateFunctions.has(node))
    {
        return false;
    }
    flow.immediateFunctions.add(node);
    return true;
}

function isImmediateExecutionContext(node, flow)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (ts.isFunctionLike(current))
        {
            return flow.immediateFunctions.has(current);
        }
    }
    return true;
}

function isProactiveCallbackCall(node, flow)
{
    const target = unwrapRuntimeExpression(node.expression);
    if (ts.isIdentifier(target))
    {
        return proactiveCallbackFunctions.has(target.text);
    }
    if (!ts.isPropertyAccessExpression(target))
    {
        return false;
    }
    if (proactivePromiseCallbackMethods.has(target.name.text))
    {
        return true;
    }
    if (isArrayPrototypeCallbackInvocation(target))
    {
        return true;
    }
    return synchronousArrayCallbackMethods.has(target.name.text)
    && isStaticArrayValue(target.expression, node, flow);
}

function isArrayPrototypeCallbackInvocation(target)
{
    if (!['apply', 'call'].includes(target.name.text))
    {
        return false;
    }
    const method = unwrapRuntimeExpression(target.expression);
    if (
        !ts.isPropertyAccessExpression(method)
    || !synchronousArrayCallbackMethods.has(method.name.text)
    )
    {
        return false;
    }
    const prototype = unwrapRuntimeExpression(method.expression);
    return ts.isPropertyAccessExpression(prototype)
    && prototype.name.text === 'prototype'
    && ts.isIdentifier(unwrapRuntimeExpression(prototype.expression))
    && unwrapRuntimeExpression(prototype.expression).text === 'Array';
}

function isStaticArrayValue(node, useNode, flow, seen = new Set())
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isArrayLiteralExpression(expression))
    {
        return true;
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text))
    {
        seen.add(expression.text);
        const binding = resolveBinding(flow.constValueBindings, expression, useNode);
        return binding ? isStaticArrayValue(binding.value, binding.declaration, flow, seen) : false;
    }
    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression))
    {
        return expression.expression.text === 'Array';
    }
    if (ts.isCallExpression(expression))
    {
        const callee = unwrapRuntimeExpression(expression.expression);
        if (
            ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'Array'
        && ['from', 'of'].includes(callee.name.text)
        )
        {
            return true;
        }
        if (
            ts.isPropertyAccessExpression(callee)
        && synchronousArrayCallbackMethods.has(callee.name.text)
        )
        {
            return isStaticArrayValue(callee.expression, useNode, flow, seen);
        }
    }
    return false;
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

function staticStringValue(node, flow, seen = new Set())
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isStringLiteralLike(expression))
    {
        return expression.text;
    }
    if (ts.isNumericLiteral(expression))
    {
        return expression.text;
    }
    if (ts.isIdentifier(expression) && flow && !seen.has(expression.text))
    {
        seen.add(expression.text);
        const binding = resolveBinding(flow.constValueBindings, expression, expression);
        return binding ? staticStringValue(binding.value, flow, seen) : null;
    }
    if (
        ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    )
    {
        const left = staticStringValue(expression.left, flow, seen);
        const right = staticStringValue(expression.right, flow, seen);
        return left === null || right === null ? null : left + right;
    }
    return null;
}

function bindingPropertyName(node, flow)
{
    if (ts.isStringLiteralLike(node) || ts.isIdentifier(node))
    {
        return node.text;
    }
    return ts.isComputedPropertyName(node) ? staticStringValue(node.expression, flow) : null;
}

function isWorkerConstructorExpression(node, facts, flow, seen = new Set())
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isIdentifier(expression))
    {
        if (facts.workerConstructorAliases.has(expression.text))
        {
            return true;
        }
        const binding = resolveBinding(flow.constValueBindings, expression, expression);
        if (!binding || seen.has(binding.declaration))
        {
            return false;
        }
        seen.add(binding.declaration);
        return isWorkerConstructorExpression(binding.value, facts, flow, seen);
    }
    if (ts.isPropertyAccessExpression(expression))
    {
        if (expression.name.text === 'Worker' && isWorkerGlobalExpression(expression.expression, facts))
        {
            return true;
        }
        const value = resolveStaticMemberValue(expression.expression, expression.name.text, expression, flow, seen);
        return value ? isWorkerConstructorExpression(value, facts, flow, seen) : false;
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression)
    {
        const property = staticStringValue(expression.argumentExpression, flow);
        if (property === null)
        {
            return false;
        }
        if (property === 'Worker' && isWorkerGlobalExpression(expression.expression, facts))
        {
            return true;
        }
        const value = resolveStaticMemberValue(expression.expression, property, expression, flow, seen);
        return value ? isWorkerConstructorExpression(value, facts, flow, seen) : false;
    }
    if (ts.isCallExpression(expression))
    {
        const target = unwrapRuntimeExpression(expression.expression);
        if (
            ts.isPropertyAccessExpression(target)
        && target.name.text === 'bind'
        )
        {
            return isWorkerConstructorExpression(target.expression, facts, flow, seen);
        }
        if (
            ts.isElementAccessExpression(target)
        && target.argumentExpression
        && staticStringValue(target.argumentExpression, flow) === 'bind'
        )
        {
            return isWorkerConstructorExpression(target.expression, facts, flow, seen);
        }
    }
    if (
        ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
    {
        return isWorkerConstructorExpression(expression.right, facts, flow, seen);
    }
    return false;
}

function resolveStaticMemberValue(containerNode, property, useNode, flow, seen)
{
    const container = resolveStaticValue(containerNode, useNode, flow, seen);
    if (ts.isObjectLiteralExpression(container))
    {
        for (const element of container.properties)
        {
            if (ts.isPropertyAssignment(element) && propertyNameText(element.name, flow) === property)
            {
                return element.initializer;
            }
            if (ts.isShorthandPropertyAssignment(element) && element.name.text === property)
            {
                return element.name;
            }
        }
    }
    if (ts.isArrayLiteralExpression(container) && /^(?:0|[1-9]\d*)$/u.test(property))
    {
        const element = container.elements[Number(property)];
        return element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element) ? element : null;
    }
    return null;
}

function resolveStaticValue(node, useNode, flow, seen)
{
    const expression = unwrapRuntimeExpression(node);
    if (ts.isIdentifier(expression))
    {
        const binding = resolveBinding(flow.constValueBindings, expression, useNode);
        if (!binding || seen.has(binding.declaration))
        {
            return expression;
        }
        seen.add(binding.declaration);
        return resolveStaticValue(binding.value, binding.declaration, flow, seen);
    }
    if (ts.isPropertyAccessExpression(expression))
    {
        const value = resolveStaticMemberValue(expression.expression, expression.name.text, expression, flow, seen);
        return value ? resolveStaticValue(value, expression, flow, seen) : expression;
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression)
    {
        const property = staticStringValue(expression.argumentExpression, flow);
        if (property !== null)
        {
            const value = resolveStaticMemberValue(expression.expression, property, expression, flow, seen);
            return value ? resolveStaticValue(value, expression, flow, seen) : expression;
        }
    }
    return expression;
}

function propertyNameText(node, flow)
{
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    {
        return node.text;
    }
    return ts.isComputedPropertyName(node) ? staticStringValue(node.expression, flow) : null;
}

function isReflectConstructCall(node)
{
    const expression = unwrapRuntimeExpression(node);
    if (
        ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'construct'
    )
    {
        return ts.isIdentifier(unwrapRuntimeExpression(expression.expression))
        && unwrapRuntimeExpression(expression.expression).text === 'Reflect';
    }
    if (
        ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && staticStringValue(expression.argumentExpression, null) === 'construct'
    )
    {
        return ts.isIdentifier(unwrapRuntimeExpression(expression.expression))
        && unwrapRuntimeExpression(expression.expression).text === 'Reflect';
    }
    return false;
}

function isWorkerGlobalExpression(node, facts)
{
    const expression = unwrapRuntimeExpression(node);
    return ts.isIdentifier(expression) && facts.workerGlobalAliases.has(expression.text);
}

function recordWorkerDestructuringAliases(pattern, initializer, facts, flow)
{
    const source = unwrapRuntimeExpression(initializer);
    if (!isWorkerGlobalExpression(source, facts))
    {
        return;
    }
    for (const element of pattern.elements)
    {
        if (
            !ts.isOmittedExpression(element)
        && ts.isIdentifier(element.name)
        && element.propertyName
        && bindingPropertyName(element.propertyName, flow) === 'Worker'
        )
        {
            facts.workerConstructorAliases.add(element.name.text);
        }
    }
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
    else if (clean.startsWith('/src/'))
    {
        resolved = path.posix.join('src/frontend', clean.slice(1));
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
