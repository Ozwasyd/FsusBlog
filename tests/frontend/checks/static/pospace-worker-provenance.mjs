export function createPoSpaceWorkerProvenance(ts, provenance)
{
    const {
        isUnshadowedGlobalIdentifier,
        propertyNameText,
        resolveBinding,
        resolveBindingValue,
        resolveStaticMemberValue,
        resolveStaticValue,
        staticArrayElements,
        staticMemberAccess,
        staticStringValue,
        unwrapRuntimeExpression
    } = provenance;

    function isWorkerConstructorExpression(node, facts, flow, seen = new Set())
    {
        const expression = unwrapRuntimeExpression(node);
        if (ts.isIdentifier(expression))
        {
            if (expression.text === 'Worker' && isUnshadowedGlobalIdentifier(expression, flow))
            {
                return true;
            }
            const binding = resolveBinding(flow.constValueBindings, expression, expression);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            if (
                binding.memberSource?.property === 'Worker'
        && hasWorkerMember(binding.memberSource.container, facts, flow, seen)
            )
            {
                return true;
            }
            if (
                binding.restSource
        && !binding.restSource.excludedProperties.has('Worker')
        && hasWorkerMember(binding.restSource.container, facts, flow, seen)
            )
            {
                return true;
            }
            seen.add(binding.declaration);
            const value = resolveBindingValue(binding, expression, flow, seen);
            return value ? isWorkerConstructorExpression(value, facts, flow, seen) : false;
        }
        if (ts.isPropertyAccessExpression(expression))
        {
            if (expression.name.text === 'Worker' && hasWorkerMember(expression.expression, facts, flow, seen))
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
            if (property === 'Worker' && hasWorkerMember(expression.expression, facts, flow, seen))
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

    function hasWorkerMember(node, facts, flow, seen = new Set())
    {
        const expression = unwrapRuntimeExpression(node);
        if (isWorkerGlobalExpression(expression, facts, flow))
        {
            return true;
        }
        if (ts.isIdentifier(expression))
        {
            const binding = resolveBinding(flow.constValueBindings, expression, expression);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            seen.add(binding.declaration);
            if (binding.restSource)
            {
                return !binding.restSource.excludedProperties.has('Worker')
            && hasWorkerMember(binding.restSource.container, facts, flow, seen);
            }
            const value = resolveBindingValue(binding, expression, flow, seen);
            return value ? hasWorkerMember(value, facts, flow, seen) : false;
        }
        const container = resolveStaticValue(expression, expression, flow, new Set(seen));
        if (!ts.isObjectLiteralExpression(container))
        {
            return false;
        }
        for (const element of [...container.properties].reverse())
        {
            if (
                (ts.isPropertyAssignment(element) || ts.isMethodDeclaration(element))
        && propertyNameText(element.name, flow) === 'Worker'
            )
            {
                return ts.isPropertyAssignment(element)
            && isWorkerConstructorExpression(element.initializer, facts, flow, new Set(seen));
            }
            if (ts.isShorthandPropertyAssignment(element) && element.name.text === 'Worker')
            {
                return isWorkerConstructorExpression(element.name, facts, flow, new Set(seen));
            }
            if (ts.isSpreadAssignment(element) && hasWorkerMember(element.expression, facts, flow, new Set(seen)))
            {
                return true;
            }
        }
        return false;
    }

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
        const expression = unwrapRuntimeExpression(node);
        if (ts.isIdentifier(expression))
        {
            const binding = resolveBinding(flow.constValueBindings, expression, expression);
            if (!binding || seen.has(binding.declaration))
            {
                return false;
            }
            if (
                binding.memberSource?.property === 'construct'
        && isReflectObjectExpression(binding.memberSource.container, facts, flow)
            )
            {
                return true;
            }
            seen.add(binding.declaration);
            const value = resolveBindingValue(binding, expression, flow, seen);
            return value ? isReflectConstructFunctionValue(value, facts, flow, seen) : false;
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
        const member = staticMemberAccess(expression, flow);
        return Boolean(
            member
    && member.property === 'construct'
    && isReflectObjectExpression(member.container, facts, flow)
        );
    }

    function isReflectObjectExpression(node, facts, flow, seen = new Set())
    {
        const expression = unwrapRuntimeExpression(node);
        if (!ts.isIdentifier(expression))
        {
            return false;
        }
        if (expression.text === 'Reflect' && isUnshadowedGlobalIdentifier(expression, flow))
        {
            return true;
        }
        const binding = resolveBinding(flow.constValueBindings, expression, expression);
        if (!binding || seen.has(binding.declaration))
        {
            return false;
        }
        seen.add(binding.declaration);
        const value = resolveBindingValue(binding, expression, flow, seen);
        return value ? isReflectObjectExpression(value, facts, flow, seen) : false;
    }

    function isWorkerGlobalExpression(node, facts, flow, seen = new Set())
    {
        const expression = unwrapRuntimeExpression(node);
        if (!ts.isIdentifier(expression))
        {
            return false;
        }
        if (
            ['globalThis', 'self', 'window'].includes(expression.text)
    && isUnshadowedGlobalIdentifier(expression, flow)
        )
        {
            return true;
        }
        const binding = resolveBinding(flow.constValueBindings, expression, expression);
        if (!binding || binding.restSource || seen.has(binding.declaration))
        {
            return false;
        }
        seen.add(binding.declaration);
        const value = resolveBindingValue(binding, expression, flow, seen);
        return value ? isWorkerGlobalExpression(value, facts, flow, seen) : false;
    }

    return {
        isWorkerConstructorExpression,
        isWorkerGlobalExpression,
        reflectConstructRuntimeArguments
    };
}
