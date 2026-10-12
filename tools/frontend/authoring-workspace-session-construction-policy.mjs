// Source AST only. This module never imports or evaluates product code.
function isNamed(ts, node, name)
{
    return !!node && ts.isIdentifier(node) && node.text === name;
}

function hasAggregateErrorBindingOrMutation(ts, tree)
{
    let found = false;
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
    const aggregateTarget = node => isNamed(ts, node, 'AggregateError')
        || ts.isPropertyAccessExpression(node) && isNamed(ts, node.expression, 'globalThis') && node.name.text === 'AggregateError'
        || ts.isElementAccessExpression(node) && isNamed(ts, node.expression, 'globalThis')
            && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'AggregateError';
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
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && ['Object', 'Reflect'].includes(node.expression.expression.getText(tree))
            && node.expression.name.text === 'defineProperty' && isNamed(ts, node.arguments[0], 'globalThis')
            && node.arguments[1] && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === 'AggregateError')
        {
            found = true;
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
