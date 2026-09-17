let ts;
let collectRuntimeBindings;
let isTrustedPromiseConstructor;
let proactiveCallbackArguments;
let resolveBinding;
let resolveBindingValue;
let resolveLexicalBinding;
let resolveStaticValue;
let staticArrayElements;
let unwrapRuntimeExpression;
let walk;

export function createPoSpaceRuntimeFlowCore(runtimeTypeScript, provenance, callbacks)
{
    ts = runtimeTypeScript;
    ({
        collectRuntimeBindings,
        resolveBinding,
        resolveBindingValue,
        resolveLexicalBinding,
        resolveStaticValue,
        staticArrayElements,
        unwrapRuntimeExpression,
        walk
    } = provenance);
    ({ isTrustedPromiseConstructor, proactiveCallbackArguments } = callbacks);
    return { analyzeRuntimeFlow };
}

function analyzeRuntimeFlow(sourceFile)
{
    const flow = {
        functionBindings: [],
        constValueBindings: [],
        lexicalBindings: [],
        parameterFunctionValues: new Map(),
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
                for (const called of resolveFunctionValues(node.expression, node, flow, { called: true }))
                {
                    changed = markImmediateFunction(called, flow) || changed;
                    changed = propagateParameterFunctionValues(called, runtimeCallArguments(node, flow), node, flow) || changed;
                }
                for (const argument of proactiveCallbackArguments(node, flow))
                {
                    for (const callback of resolveFunctionValues(argument, node, flow))
                    {
                        changed = markImmediateFunction(callback, flow) || changed;
                    }
                }
            }
            if (
                ts.isNewExpression(node)
        && isImmediateExecutionContext(node, flow)
        && isTrustedPromiseConstructor(node.expression, flow)
            )
            {
                for (const argument of node.arguments ?? [])
                {
                    for (const callback of resolveFunctionValues(argument, node, flow))
                    {
                        changed = markImmediateFunction(callback, flow) || changed;
                    }
                }
            }
        });
    }
    while (changed);
    return flow;
}

function resolveFunctionValues(expression, useNode, flow, options = {}, seen = new Set())
{
    let target = unwrapRuntimeExpression(expression);
    if (
        options.called
&& ts.isPropertyAccessExpression(target)
&& ['call', 'apply'].includes(target.name.text)
    )
    {
        target = unwrapRuntimeExpression(target.expression);
    }
    if (
        ts.isBinaryExpression(target)
&& target.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
    {
        return resolveFunctionValues(target.right, useNode, flow, options, seen);
    }
    if (
        ts.isFunctionExpression(target)
|| ts.isArrowFunction(target)
|| ts.isFunctionDeclaration(target)
|| ts.isMethodDeclaration(target)
    )
    {
        return [target];
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
    {
        const value = resolveStaticValue(target, useNode, flow, new Set(seen));
        return value === target ? [] : resolveFunctionValues(value, target, flow, options, seen);
    }
    if (!ts.isIdentifier(target))
    {
        return [];
    }
    const lexical = resolveLexicalBinding(flow.lexicalBindings, target, useNode);
    if (lexical && ts.isParameter(lexical.declaration))
    {
        return [...(flow.parameterFunctionValues.get(lexical.declaration) ?? [])];
    }
    const valueBinding = resolveBinding(flow.constValueBindings, target, useNode);
    if (valueBinding && !seen.has(valueBinding.declaration))
    {
        seen.add(valueBinding.declaration);
        const value = resolveBindingValue(valueBinding, target, flow, seen);
        if (value)
        {
            return resolveFunctionValues(value, valueBinding.declaration, flow, options, seen);
        }
    }
    const binding = resolveBinding(flow.functionBindings, target, useNode);
    if (!binding || seen.has(binding.declaration))
    {
        return [];
    }
    seen.add(binding.declaration);
    return resolveFunctionValues(binding.value, binding.declaration, flow, options, seen);
}

function runtimeCallArguments(node, flow)
{
    const target = unwrapRuntimeExpression(node.expression);
    if (!ts.isPropertyAccessExpression(target))
    {
        return [...node.arguments];
    }
    if (target.name.text === 'call')
    {
        return node.arguments.slice(1);
    }
    if (target.name.text === 'apply' && node.arguments[1])
    {
        return (staticArrayElements(node.arguments[1], node, flow, new Set()) ?? []).filter(Boolean);
    }
    return [...node.arguments];
}

function propagateParameterFunctionValues(called, argumentsList, useNode, flow)
{
    let changed = false;
    for (const [index, parameter] of called.parameters.entries())
    {
        if (!ts.isIdentifier(parameter.name) || !argumentsList[index])
        {
            continue;
        }
        const values = flow.parameterFunctionValues.get(parameter) ?? new Set();
        for (const value of resolveFunctionValues(argumentsList[index], useNode, flow))
        {
            if (!values.has(value))
            {
                values.add(value);
                changed = true;
            }
        }
        flow.parameterFunctionValues.set(parameter, values);
    }
    return changed;
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
