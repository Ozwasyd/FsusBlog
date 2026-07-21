export function createPoSpaceReflectProvenance(ts, provenance)
{
    const {
        isProvenanceMember,
        isUnshadowedGlobalIdentifier,
        isWorkerGlobalExpression,
        resolveBinding,
        resolveBindingValues,
        resolveStaticValue,
        staticArrayElements,
        staticMemberAccess,
        unwrapRuntimeExpression
    } = provenance;

    function reflectConstructRuntimeArguments(node, facts, flow)
    {
        const target = unwrapRuntimeExpression(node.expression);
        if (isReflectConstructFunctionValue(target, facts, flow))
        {
            return [...node.arguments];
        }
        const invocation = staticMemberAccess(target, flow);
        if (!invocation || !['apply', 'call'].includes(invocation.property))
        {
            return null;
        }
        if (!isReflectConstructFunctionValue(invocation.container, facts, flow))
        {
            return null;
        }
        if (invocation.property === 'call')
        {
            return node.arguments.slice(1);
        }
        return node.arguments[1]
            ? staticArrayElements(node.arguments[1], node, flow, new Set())
            : null;
    }

    function isReflectConstructFunctionValue(node, facts, flow, seen = new Set())
    {
        if (isProvenanceMember(node))
        {
            return node.property === 'construct'
            && isReflectObjectExpression(node.container, facts, flow);
        }
        const expression = unwrapRuntimeExpression(node);
        if (ts.isIdentifier(expression))
        {
            const binding = resolveBinding(flow.constValueBindings, expression, expression);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            seen.add(binding.declaration);
            for (const value of resolveBindingValues(binding, expression, flow, seen))
            {
                if (isReflectConstructFunctionValue(value, facts, flow, new Set(seen)))
                {
                    return true;
                }
            }
            return false;
        }
        if (ts.isCallExpression(expression))
        {
            const invocation = staticMemberAccess(expression.expression, flow);
            return Boolean(
                invocation
        && invocation.property === 'bind'
        && isReflectConstructFunctionValue(invocation.container, facts, flow, seen)
            );
        }
        if (
            ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.CommaToken
        )
        {
            return isReflectConstructFunctionValue(expression.right, facts, flow, seen);
        }
        const resolved = resolveStaticValue(expression, expression, flow, new Set(seen));
        if (resolved !== expression)
        {
            return isReflectConstructFunctionValue(resolved, facts, flow, seen);
        }
        const member = staticMemberAccess(expression, flow);
        return Boolean(
            member
    && member.property === 'construct'
    && isReflectObjectExpression(member.container, facts, flow)
        );
    }

    function isReflectObjectExpression(node, facts, flow, seen = new Set())
    {
        if (isProvenanceMember(node))
        {
            return node.property === 'Reflect'
            && isWorkerGlobalExpression(node.container, facts, flow);
        }
        const expression = unwrapRuntimeExpression(node);
        if (
            ts.isIdentifier(expression)
        && expression.text === 'Reflect'
        && isUnshadowedGlobalIdentifier(expression, flow)
        )
        {
            return true;
        }
        const member = staticMemberAccess(expression, flow);
        if (
            member?.property === 'Reflect'
        && isWorkerGlobalExpression(member.container, facts, flow)
        )
        {
            return true;
        }
        if (!ts.isIdentifier(expression))
        {
            return false;
        }
        const binding = resolveBinding(flow.constValueBindings, expression, expression);
        if (!binding || seen.has(binding.declaration))
        {
            return false;
        }
        seen.add(binding.declaration);
        return resolveBindingValues(binding, expression, flow, seen)
            .some(value => isReflectObjectExpression(value, facts, flow, new Set(seen)));
    }


    return { reflectConstructRuntimeArguments };
}
