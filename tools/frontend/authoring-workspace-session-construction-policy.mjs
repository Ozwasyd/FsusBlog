// Source AST only. This module never imports or evaluates product code.
function isNamed(ts, node, name)
{
    return !!node && ts.isIdentifier(node) && node.text === name;
}

function hasAggregateErrorBindingOrMutation(ts, tree)
{
    let found = false;
    const unwrap = node =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
            || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    // Bounded syntactic aliases only: module declarations and identifier assignments.
    // Over-approximate across scopes/order; these sets never establish runtime identity.
    const aliases = new Map(['globalThis', 'Object', 'Reflect'].map(name => [name, new Set([name])]));
    const aliasEdges = [];
    const collect = node =>
    {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        {
            aliasEdges.push([node.name.text, unwrap(node.initializer)]);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(unwrap(node.left)))
        {
            aliasEdges.push([unwrap(node.left).text, unwrap(node.right)]);
        }
        ts.forEachChild(node, collect);
    };
    collect(tree);
    let changed;
    do
    {
        changed = false;
        for (const names of aliases.values())
        {
            for (const [name, value] of aliasEdges)
            {
                if (value && ts.isIdentifier(value) && names.has(value.text) && !names.has(name))
                {
                    names.add(name);
                    changed = true;
                }
            }
        }
    }
    while (changed);
    const isAlias = (node, root) =>
    {
        node = unwrap(node);
        return !!node && ts.isIdentifier(node) && aliases.get(root).has(node.text);
    };
    const literalKey = node =>
    {
        node = unwrap(node);
        return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    };
    const propertyKey = node => ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
        ? node.text : ts.isComputedPropertyName(node) ? literalKey(node.expression) : null;
    const binding = node =>
    {
        if (isNamed(ts, node, 'AggregateError'))
        {
            found = true;
        }
        else if (node && (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)))
        {
            for (const element of node.elements)
            {
                if (ts.isBindingElement(element))
                {
                    binding(element.name);
                }
            }
        }
    };
    const aggregateTarget = node =>
    {
        node = unwrap(node);
        if (!node)
        {
            return false;
        }
        if (isNamed(ts, node, 'AggregateError'))
        {
            return true;
        }
        if (ts.isPropertyAccessExpression(node) && isAlias(node.expression, 'globalThis'))
        {
            return node.name.text === 'AggregateError';
        }
        if (ts.isElementAccessExpression(node) && isAlias(node.expression, 'globalThis'))
        {
            const key = literalKey(node.argumentExpression);
            return key === null || key === 'AggregateError';
        }
        if (ts.isObjectLiteralExpression(node))
        {
            return node.properties.some(property => ts.isPropertyAssignment(property) ? aggregateTarget(property.initializer)
                : ts.isShorthandPropertyAssignment(property) ? aggregateTarget(property.name)
                    : ts.isSpreadAssignment(property) && aggregateTarget(property.expression));
        }
        if (ts.isArrayLiteralExpression(node))
        {
            return node.elements.some(aggregateTarget);
        }
        if (ts.isSpreadElement(node))
        {
            return aggregateTarget(node.expression);
        }
        // Destructuring defaults write their left target, never the fallback expression.
        return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && aggregateTarget(node.left);
    };
    const maySupplyAggregateKey = node =>
    {
        node = unwrap(node);
        // Unknown source, spread or computed key may write the constructor: fail closed.
        return !node || !ts.isObjectLiteralExpression(node) || node.properties.some(property =>
            ts.isSpreadAssignment(property) || propertyKey(property.name) === null || propertyKey(property.name) === 'AggregateError');
    };
    const walk = node =>
    {
        if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
        {
            binding(node.name);
        }
        if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isEnumDeclaration(node)
            || ts.isModuleDeclaration(node) || ts.isImportClause(node) || ts.isImportSpecifier(node)
            || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node))
        {
            binding(node.name);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && aggregateTarget(node.left))
        {
            found = true;
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))
            && isAlias(node.arguments[0], 'globalThis'))
        {
            const call = unwrap(node.expression);
            const method = call.name.text;
            const object = isAlias(call.expression, 'Object');
            const reflect = isAlias(call.expression, 'Reflect');
            if ((object || reflect) && method === 'defineProperty' || reflect && method === 'set')
            {
                const key = literalKey(node.arguments[1]);
                found ||= key === null || key === 'AggregateError';
            }
            if (object && method === 'assign')
            {
                found ||= node.arguments.slice(1).some(maySupplyAggregateKey);
            }
            if (object && method === 'defineProperties')
            {
                found ||= maySupplyAggregateKey(node.arguments[1]);
            }
        }
        ts.forEachChild(node, walk);
    };
    walk(tree);
    return found;
}

/** Preserve existing Error allowance; permit only the actual original bridge's standard error aggregation. */
export function isAllowedAuthoringSessionSourceConstruction(ts, tree, node)
{
    if (isNamed(ts, node.expression, 'Error'))
    {
        return true;
    }
    if (!isNamed(ts, node.expression, 'AggregateError') || node.typeArguments?.length
        || hasAggregateErrorBindingOrMutation(ts, tree))
    {
        return false;
    }
    const [errors, message, options] = node.arguments ?? [];
    if (node.arguments?.length !== 3 || !ts.isArrayLiteralExpression(errors) || errors.elements.length !== 2
        || !isNamed(ts, errors.elements[0], 'error') || !isNamed(ts, errors.elements[1], 'retirementError')
        || !ts.isStringLiteral(message) || message.text !== 'authoring-workspace-session-source-retirement-incomplete'
        || !ts.isObjectLiteralExpression(options) || options.properties.length !== 1)
    {
        return false;
    }
    const cause = options.properties[0];
    if (!ts.isPropertyAssignment(cause) || !isNamed(ts, cause.name, 'cause') || !isNamed(ts, cause.initializer, 'retirementError'))
    {
        return false;
    }
    const thrown = node.parent;
    const innerCatch = thrown?.parent?.parent;
    const retry = innerCatch?.parent;
    const outerCatch = retry?.parent?.parent;
    const callback = outerCatch?.parent?.parent?.parent;
    const connect = callback?.parent?.parent?.parent?.parent?.parent;
    return ts.isThrowStatement(thrown) && thrown.expression === node
        && innerCatch && ts.isCatchClause(innerCatch) && isNamed(ts, innerCatch.variableDeclaration?.name, 'retirementError')
        && innerCatch.block.statements.length === 1
        && retry && ts.isTryStatement(retry) && retry.tryBlock.statements.length === 1
        && ts.isExpressionStatement(retry.tryBlock.statements[0])
        && ts.isCallExpression(retry.tryBlock.statements[0].expression)
        && isNamed(ts, retry.tryBlock.statements[0].expression.expression, 'retire')
        && retry.tryBlock.statements[0].expression.arguments.length === 0
        && outerCatch && ts.isCatchClause(outerCatch) && isNamed(ts, outerCatch.variableDeclaration?.name, 'error')
        && outerCatch.block.statements.length === 2 && outerCatch.block.statements[0] === retry
        && ts.isThrowStatement(outerCatch.block.statements[1]) && isNamed(ts, outerCatch.block.statements[1].expression, 'error')
        && callback && ts.isArrowFunction(callback) && ts.isVariableDeclaration(callback.parent)
        && callback.parent.initializer === callback && isNamed(ts, callback.parent.name, 'withCurrentSource')
        && connect && ts.isFunctionDeclaration(connect) && isNamed(ts, connect.name, 'connectAuthoringWorkspaceSessionSource');
}
