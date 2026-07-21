export function createPoSpaceProactiveCallbacks(ts, provenance)
{
    const {
        isUnshadowedGlobalIdentifier,
        isProvenanceMember,
        isWorkerGlobalExpression,
        resolveBinding,
        resolveBindingValue,
        resolveBindingValues,
        resolveStaticValue,
        staticArrayElements,
        staticMemberAccess,
        unwrapRuntimeExpression
    } = provenance;

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

    function proactiveCallbackArguments(node, flow)
    {
        const target = unwrapRuntimeExpression(node.expression);
        if (isTrustedSchedulerFunctionValue(target, node, flow))
        {
            return [...node.arguments];
        }
        if (!ts.isPropertyAccessExpression(target))
        {
            return [];
        }
        if (
            proactivePromiseCallbackMethods.has(target.name.text)
    && isTrustedPromiseValue(target.expression, node, flow)
        )
        {
            return [...node.arguments];
        }
        const prototypeInvocation = arrayPrototypeCallbackInvocation(target, node, flow);
        if (prototypeInvocation === 'call')
        {
            return node.arguments.slice(1);
        }
        if (prototypeInvocation === 'apply' && node.arguments[1])
        {
            return (staticArrayElements(node.arguments[1], node, flow, new Set()) ?? []).filter(Boolean);
        }
        return synchronousArrayCallbackMethods.has(target.name.text)
    && isStaticArrayValue(target.expression, node, flow)
            ? [...node.arguments]
            : [];
    }

    function isTrustedSchedulerFunctionValue(node, useNode, flow, seen = new Set())
    {
        const expression = unwrapRuntimeExpression(node);
        if (ts.isIdentifier(expression))
        {
            if (
                proactiveCallbackFunctions.has(expression.text)
        && isUnshadowedGlobalIdentifier(expression, flow)
            )
            {
                return true;
            }
            const binding = resolveBinding(flow.constValueBindings, expression, useNode);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            seen.add(binding.declaration);
            const value = resolveBindingValue(binding, expression, flow, seen);
            return value ? isTrustedSchedulerFunctionValue(value, binding.declaration, flow, seen) : false;
        }
        const member = staticMemberAccess(expression, flow);
        return Boolean(
            member
    && proactiveCallbackFunctions.has(member.property)
    && isWorkerGlobalExpression(member.container, null, flow)
        );
    }

    function isTrustedPromiseConstructor(node, flow, seen = new Set())
    {
        if (isProvenanceMember(node))
        {
            return node.property === 'Promise'
            && isWorkerGlobalExpression(node.container, null, flow);
        }
        const expression = unwrapRuntimeExpression(node);
        if (
            ts.isBinaryExpression(expression)
        && [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken
        ].includes(expression.operatorToken.kind)
        )
        {
            return isTrustedPromiseConstructor(expression.left, flow, new Set(seen))
            || isTrustedPromiseConstructor(expression.right, flow, new Set(seen));
        }
        if (ts.isIdentifier(expression))
        {
            if (expression.text === 'Promise' && isUnshadowedGlobalIdentifier(expression, flow))
            {
                return true;
            }
            const binding = resolveBinding(flow.constValueBindings, expression, expression);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            seen.add(binding.declaration);
            return resolveBindingValues(binding, expression, flow, seen)
                .some(value => isTrustedPromiseConstructor(value, flow, new Set(seen)));
        }
        const member = staticMemberAccess(expression, flow);
        return Boolean(
            member
        && member.property === 'Promise'
        && isWorkerGlobalExpression(member.container, null, flow)
        );
    }

    function isTrustedPromiseValue(node, useNode, flow, seen = new Set())
    {
        const expression = unwrapRuntimeExpression(node);
        if (ts.isIdentifier(expression))
        {
            const binding = resolveBinding(flow.constValueBindings, expression, useNode);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            seen.add(binding.declaration);
            return resolveBindingValues(binding, expression, flow, seen)
                .some(value => isTrustedPromiseValue(value, binding.declaration, flow, new Set(seen)));
        }
        if (ts.isNewExpression(expression))
        {
            return isTrustedPromiseConstructor(expression.expression, flow);
        }
        if (!ts.isCallExpression(expression))
        {
            return false;
        }
        const target = unwrapRuntimeExpression(expression.expression);
        if (isTrustedPromiseFactoryValue(target, expression, flow, seen))
        {
            return true;
        }
        const member = staticMemberAccess(target, flow);
        if (!member)
        {
            return false;
        }
        if (proactivePromiseCallbackMethods.has(member.property))
        {
            return isTrustedPromiseValue(member.container, expression, flow, seen);
        }
        if (
            ['all', 'allSettled', 'any', 'race', 'reject', 'resolve', 'withResolvers'].includes(member.property)
        )
        {
            return isTrustedPromiseConstructor(member.container, flow);
        }
        return member.property === 'fetch'
    && isWorkerGlobalExpression(member.container, null, flow);
    }

    function isTrustedPromiseFactoryValue(node, useNode, flow, seen = new Set())
    {
        if (isProvenanceMember(node))
        {
            return ['all', 'allSettled', 'any', 'race', 'reject', 'resolve', 'withResolvers'].includes(node.property)
            && isTrustedPromiseConstructor(node.container, flow);
        }
        const expression = unwrapRuntimeExpression(node);
        if (ts.isIdentifier(expression))
        {
            const binding = resolveBinding(flow.constValueBindings, expression, useNode);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            seen.add(binding.declaration);
            return resolveBindingValues(binding, expression, flow, seen)
                .some(value => isTrustedPromiseFactoryValue(value, binding.declaration, flow, new Set(seen)));
        }
        if (ts.isCallExpression(expression))
        {
            const invocation = staticMemberAccess(expression.expression, flow);
            return Boolean(
                invocation
            && invocation.property === 'bind'
            && isTrustedPromiseFactoryValue(invocation.container, expression, flow, seen)
            );
        }
        if (
            ts.isBinaryExpression(expression)
        && expression.operatorToken.kind === ts.SyntaxKind.CommaToken
        )
        {
            return isTrustedPromiseFactoryValue(expression.right, useNode, flow, seen);
        }
        const member = staticMemberAccess(expression, flow);
        return Boolean(
            member
        && ['all', 'allSettled', 'any', 'race', 'reject', 'resolve', 'withResolvers'].includes(member.property)
        && isTrustedPromiseConstructor(member.container, flow)
        );
    }

    function arrayPrototypeCallbackInvocation(target, useNode, flow)
    {
        if (!['apply', 'call'].includes(target.name.text))
        {
            return null;
        }
        const method = resolveStaticValue(target.expression, useNode, flow, new Set());
        if (
            !ts.isPropertyAccessExpression(method)
    || !synchronousArrayCallbackMethods.has(method.name.text)
        )
        {
            return null;
        }
        const prototype = unwrapRuntimeExpression(method.expression);
        return ts.isPropertyAccessExpression(prototype)
    && prototype.name.text === 'prototype'
    && ts.isIdentifier(unwrapRuntimeExpression(prototype.expression))
    && unwrapRuntimeExpression(prototype.expression).text === 'Array'
    && isUnshadowedGlobalIdentifier(unwrapRuntimeExpression(prototype.expression), flow)
            ? target.name.text
            : null;
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
            const value = binding ? resolveBindingValue(binding, expression, flow, seen) : null;
            return value ? isStaticArrayValue(value, binding.declaration, flow, seen) : false;
        }
        if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression))
        {
            return expression.expression.text === 'Array'
            && isUnshadowedGlobalIdentifier(expression.expression, flow);
        }
        if (ts.isCallExpression(expression))
        {
            const callee = unwrapRuntimeExpression(expression.expression);
            if (
                ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'Array'
        && isUnshadowedGlobalIdentifier(callee.expression, flow)
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

    return { isTrustedPromiseConstructor, proactiveCallbackArguments };
}
