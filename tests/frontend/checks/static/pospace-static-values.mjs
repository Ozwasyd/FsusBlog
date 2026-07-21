export function createPoSpaceStaticValues(ts, lexical)
{
    const {
        resolveBinding,
        resolveBindingMemberValue,
        resolveBindingValue,
        staticStringValue,
        unwrapRuntimeExpression
    } = lexical;

    function resolveStaticMemberValue(containerNode, property, useNode, flow, seen)
    {
        const containerExpression = unwrapRuntimeExpression(containerNode);
        if (ts.isIdentifier(containerExpression))
        {
            const binding = resolveBinding(flow.constValueBindings, containerExpression, useNode);
            if (binding)
            {
                const write = resolveBindingMemberValue(binding, property, useNode);
                if (write.found)
                {
                    return write.value;
                }
            }
        }
        const container = resolveStaticValue(containerNode, useNode, flow, seen);
        if (ts.isObjectLiteralExpression(container))
        {
            for (const element of [...container.properties].reverse())
            {
                if (ts.isPropertyAssignment(element) && propertyNameText(element.name, flow) === property)
                {
                    return element.initializer;
                }
                if (ts.isMethodDeclaration(element) && propertyNameText(element.name, flow) === property)
                {
                    return element;
                }
                if (ts.isShorthandPropertyAssignment(element) && element.name.text === property)
                {
                    return element.name;
                }
                if (ts.isSpreadAssignment(element))
                {
                    const value = resolveStaticMemberValue(element.expression, property, element, flow, new Set(seen));
                    if (value)
                    {
                        return value;
                    }
                }
            }
        }
        if (ts.isClassDeclaration(container) || ts.isClassExpression(container))
        {
            for (const member of container.members)
            {
                if (
                    ts.isMethodDeclaration(member)
                && member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
                && propertyNameText(member.name, flow) === property
                )
                {
                    return member;
                }
            }
        }
        if (/^(?:0|[1-9]\d*)$/u.test(property))
        {
            const elements = staticArrayElements(container, useNode, flow, new Set(seen));
            return elements?.[Number(property)] ?? null;
        }
        return null;
    }

    function staticArrayElements(node, useNode, flow, seen)
    {
        const value = resolveStaticValue(node, useNode, flow, seen);
        if (!ts.isArrayLiteralExpression(value))
        {
            return null;
        }
        const elements = [];
        for (const element of value.elements)
        {
            if (ts.isOmittedExpression(element))
            {
                elements.push(null);
                continue;
            }
            if (ts.isSpreadElement(element))
            {
                const spread = staticArrayElements(element.expression, element, flow, new Set(seen));
                if (!spread)
                {
                    return null;
                }
                elements.push(...spread);
                continue;
            }
            elements.push(element);
        }
        return elements;
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
            const value = resolveBindingValue(binding, expression, flow, seen);
            return value ? resolveStaticValue(value, binding.declaration, flow, seen) : expression;
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


    return { propertyNameText, resolveStaticMemberValue, resolveStaticValue, staticArrayElements };
}
