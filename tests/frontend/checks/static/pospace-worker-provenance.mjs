export function createPoSpaceWorkerProvenance(ts, provenance)
{
    const {
        isProvenanceMember,
        isUnshadowedGlobalIdentifier,
        propertyNameText,
        resolveBinding,
        resolveBindingMemberValues,
        resolveBindingValue,
        resolveBindingValues,
        resolveStaticMemberValue,
        resolveStaticValue,
        staticStringValue,
        unwrapRuntimeExpression
    } = provenance;

    function isWorkerConstructorExpression(node, facts, flow, seen = new Set())
    {
        if (isProvenanceMember(node))
        {
            return node.property === 'Worker'
            && isWorkerGlobalExpression(node.container, facts, flow);
        }
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
            seen.add(binding.declaration);
            for (const value of resolveBindingValues(binding, expression, flow, seen))
            {
                if (isWorkerConstructorExpression(value, facts, flow, new Set(seen)))
                {
                    return true;
                }
            }
            if (
                binding.restSource
        && !(binding.writes?.length > 0)
        && !binding.restSource.excludedProperties.has('Worker')
        && hasWorkerMember(binding.restSource.container, facts, flow, seen)
            )
            {
                return true;
            }
            return false;
        }
        if (ts.isPropertyAccessExpression(expression))
        {
            const written = isWrittenWorkerMember(expression.expression, expression.name.text, expression, facts, flow, seen);
            if (written !== null)
            {
                return written;
            }
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
            const written = isWrittenWorkerMember(expression.expression, property, expression, facts, flow, seen);
            if (written !== null)
            {
                return written;
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

    function isWrittenWorkerMember(containerNode, property, useNode, facts, flow, seen)
    {
        const container = unwrapRuntimeExpression(containerNode);
        if (!ts.isIdentifier(container))
        {
            return null;
        }
        const binding = resolveBinding(flow.constValueBindings, container, useNode);
        if (!binding)
        {
            return null;
        }
        const state = resolveBindingMemberValues(binding, property, useNode);
        for (const value of state.values)
        {
            if (isWorkerConstructorExpression(value, facts, flow, new Set(seen)))
            {
                return true;
            }
        }
        return state.initialReaches ? null : false;
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
        isWorkerGlobalExpression
    };
}
