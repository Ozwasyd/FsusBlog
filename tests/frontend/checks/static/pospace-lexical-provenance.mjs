import { collectBindingWrites } from './pospace-binding-writes.mjs';
import { createPoSpaceReachingDefinitions } from './pospace-reaching-definitions.mjs';

export function createPoSpaceLexicalProvenance(ts, resolveStaticMemberValue)
{
    const { reachingValues } = createPoSpaceReachingDefinitions(ts);
    function collectRuntimeBindings(sourceFile, flow)
    {
        walk(sourceFile, node =>
        {
            if (ts.isFunctionDeclaration(node) && node.name)
            {
                const binding = makeBinding(node.name.text, node, node, true);
                flow.functionBindings.push(binding);
                flow.lexicalBindings.push(binding);
            }
            if (ts.isClassDeclaration(node) && node.name)
            {
                const binding = makeBinding(node.name.text, node, node, true);
                flow.lexicalBindings.push(binding);
                flow.constValueBindings.push(binding);
            }
            if (
                ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
            )
            {
                const varScoped = isVarDeclaration(node);
                const scope = varScoped ? variableScope(node) : lexicalScope(node);
                let binding = varScoped
                    ? flow.lexicalBindings.find(candidate => candidate.varScoped
                        && candidate.name === node.name.text
                        && candidate.scope === scope)
                    : null;
                if (!binding)
                {
                    binding = makeBinding(
                        node.name.text,
                        node,
                        varScoped ? null : (node.initializer ?? null),
                        varScoped,
                        scope
                    );
                    binding.varScoped = varScoped;
                    flow.lexicalBindings.push(binding);
                }
                if (node.initializer)
                {
                    if (!flow.constValueBindings.includes(binding))
                    {
                        flow.constValueBindings.push(binding);
                    }
                    if (
                        ts.isFunctionExpression(unwrapRuntimeExpression(node.initializer))
                || ts.isArrowFunction(unwrapRuntimeExpression(node.initializer))
                || ts.isIdentifier(unwrapRuntimeExpression(node.initializer))
                    )
                    {
                        flow.functionBindings.push(binding);
                    }
                }
            }
            if (ts.isParameter(node) && ts.isIdentifier(node.name))
            {
                flow.lexicalBindings.push({
                    name: node.name.text,
                    declaration: node,
                    value: null,
                    hoisted: true,
                    scope: node.parent
                });
            }
            if (ts.isBindingElement(node) && ts.isIdentifier(node.name))
            {
                const binding = makeBinding(node.name.text, node, null, false);
                flow.lexicalBindings.push(binding);
                const memberSource = constDestructuredMemberSource(node);
                if (memberSource)
                {
                    Object.assign(binding, memberSource);
                    flow.constValueBindings.push(binding);
                }
            }
            if (ts.isImportClause(node))
            {
                if (node.name)
                {
                    flow.lexicalBindings.push(makeBinding(node.name.text, node.name, null, true));
                }
                if (node.namedBindings && ts.isNamespaceImport(node.namedBindings))
                {
                    flow.lexicalBindings.push(makeBinding(node.namedBindings.name.text, node.namedBindings.name, null, true));
                }
                if (node.namedBindings && ts.isNamedImports(node.namedBindings))
                {
                    for (const element of node.namedBindings.elements)
                    {
                        flow.lexicalBindings.push(makeBinding(element.name.text, element.name, null, true));
                    }
                }
            }
        });
        collectBindingWrites(ts, sourceFile, flow, {
            provenanceMember,
            resolveLexicalBinding,
            staticMemberAccess,
            staticStringValue,
            unwrapRuntimeExpression,
            walk
        });
    }

    function constDestructuredMemberSource(node)
    {
        const pattern = node.parent;
        if (!ts.isObjectBindingPattern(pattern) && !ts.isArrayBindingPattern(pattern))
        {
            return null;
        }
        const declaration = pattern.parent;
        if (
            !ts.isVariableDeclaration(declaration)
    || !declaration.initializer
        )
        {
            return null;
        }
        if (ts.isObjectBindingPattern(pattern))
        {
            if (node.dotDotDotToken)
            {
                const excludedProperties = pattern.elements
                    .filter(element => element !== node && !element.dotDotDotToken)
                    .map(element => staticPropertySyntaxValue(element.propertyName ?? element.name))
                    .filter(property => property !== null);
                return {
                    restSource: {
                        container: declaration.initializer,
                        excludedProperties: new Set(excludedProperties)
                    }
                };
            }
            const property = node.propertyName ?? node.name;
            const key = staticPropertySyntaxValue(property);
            return key === null ? null : { memberSource: { container: declaration.initializer, property: key } };
        }
        return { memberSource: { container: declaration.initializer, property: String(pattern.elements.indexOf(node)) } };
    }

    function staticPropertySyntaxValue(node)
    {
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
        {
            return node.text;
        }
        if (ts.isComputedPropertyName(node))
        {
            return staticPropertySyntaxValue(node.expression);
        }
        if (
            ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.PlusToken
        )
        {
            const left = staticPropertySyntaxValue(node.left);
            const right = staticPropertySyntaxValue(node.right);
            return left === null || right === null ? null : left + right;
        }
        return null;
    }

    function walk(node, callback)
    {
        callback(node);
        ts.forEachChild(node, child => walk(child, callback));
    }

    function makeBinding(name, declaration, value, hoisted, scope = lexicalScope(declaration))
    {
        return {
            name,
            declaration,
            value,
            hoisted,
            scope
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

    function isVarDeclaration(node)
    {
        return ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0;
    }

    function variableScope(node)
    {
        for (let current = node.parent; current; current = current.parent)
        {
            if (ts.isFunctionLike(current) || ts.isSourceFile(current))
            {
                return current;
            }
        }
        return node.getSourceFile();
    }

    function resolveBinding(bindings, identifier, useNode)
    {
        return bindings
            .filter(binding => binding.name === identifier.text)
            .filter(binding => binding.scope.pos <= useNode.pos && useNode.end <= binding.scope.end)
            .filter(binding => binding.hoisted || binding.declaration.pos < useNode.pos)
            .sort((left, right) => (left.scope.end - left.scope.pos) - (right.scope.end - right.scope.pos))[0] ?? null;
    }

    function resolveLexicalBinding(bindings, identifier, useNode)
    {
        return bindings
            .filter(binding => binding.name === identifier.text)
            .filter(binding => binding.scope.pos <= useNode.pos && useNode.end <= binding.scope.end)
            .sort((left, right) => (left.scope.end - left.scope.pos) - (right.scope.end - right.scope.pos))[0] ?? null;
    }

    function resolveBindingValue(binding, useNode, flow, seen)
    {
        const value = resolveBindingValues(binding, useNode, flow, seen).at(-1) ?? null;
        return resolveProvenanceMemberValue(value, useNode, flow, seen);
    }

    function resolveBindingMemberValue(binding, property, useNode)
    {
        const state = resolveBindingMemberValues(binding, property, useNode);
        return state.initialReaches
            ? { found: false, value: null }
            : { found: true, value: state.values.at(-1) ?? null };
    }

    function resolveBindingValues(binding, useNode)
    {
        const initial = binding.memberSource
            ? [provenanceMember(binding.memberSource.container, binding.memberSource.property)]
            : binding.value ? [binding.value] : [];
        return reachingValues(initial, binding.writes, useNode).values;
    }

    function resolveBindingMemberValues(binding, property, useNode)
    {
        return reachingValues([], binding.memberWrites?.get(property), useNode);
    }

    function provenanceMember(container, property)
    {
        return { container, property, provenanceMember: true };
    }

    function isProvenanceMember(value)
    {
        return value?.provenanceMember === true;
    }

    function resolveProvenanceMemberValue(value, useNode, flow, seen)
    {
        if (!isProvenanceMember(value))
        {
            return value;
        }
        const lookupNode = useNode?.kind === undefined ? provenanceMemberUseNode(value) : useNode;
        const container = resolveProvenanceMemberValue(value.container, lookupNode, flow, seen);
        return resolveStaticMemberValue(container, value.property, lookupNode, flow, seen) ?? value;
    }

    function provenanceMemberUseNode(value)
    {
        let current = value;
        while (isProvenanceMember(current))
        {
            current = current.container;
        }
        return current;
    }

    function isUnshadowedGlobalIdentifier(identifier, flow)
    {
        return !resolveLexicalBinding(flow.lexicalBindings, identifier, identifier);
    }

    function staticMemberAccess(node, flow)
    {
        const expression = unwrapRuntimeExpression(node);
        if (ts.isPropertyAccessExpression(expression))
        {
            return { container: expression.expression, property: expression.name.text };
        }
        if (ts.isElementAccessExpression(expression) && expression.argumentExpression)
        {
            const property = staticStringValue(expression.argumentExpression, flow);
            return property === null ? null : { container: expression.expression, property };
        }
        return null;
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
            const value = binding ? resolveBindingValue(binding, expression, flow, seen) : null;
            return value ? staticStringValue(value, flow, seen) : null;
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


    return {
        bindingPropertyName,
        collectRuntimeBindings,
        isProvenanceMember,
        isUnshadowedGlobalIdentifier,
        resolveBinding,
        resolveBindingMemberValue,
        resolveBindingMemberValues,
        resolveBindingValue,
        resolveBindingValues,
        resolveLexicalBinding,
        resolveProvenanceMemberValue,
        staticMemberAccess,
        staticStringValue,
        unwrapRuntimeExpression,
        walk
    };
}
