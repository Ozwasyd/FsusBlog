export function isConditionalExecution(ts, node)
{
    const owner = functionOwner(ts, node);
    for (let current = node.parent; current && current !== owner; current = current.parent)
    {
        if (
            ts.isIfStatement(current)
        || ts.isConditionalExpression(current)
        || isConditionalShortCircuit(ts, current, node)
        || ts.isForStatement(current)
        || ts.isForInStatement(current)
        || ts.isForOfStatement(current)
        || ts.isWhileStatement(current)
        || ts.isCaseClause(current)
        || ts.isDefaultClause(current)
        || ts.isCatchClause(current)
        || (ts.isTryStatement(current) && current.tryBlock.pos <= node.pos && node.end <= current.tryBlock.end)
        )
        {
            return true;
        }
    }
    return false;
}

function isConditionalShortCircuit(ts, expression, node)
{
    if (
        !ts.isBinaryExpression(expression)
    || ![
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken
    ].includes(expression.operatorToken.kind)
    )
    {
        return false;
    }
    if (!(expression.right.pos <= node.pos && node.end <= expression.right.end))
    {
        return false;
    }
    const left = expression.left;
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left.kind === ts.SyntaxKind.TrueKeyword)
    {
        return false;
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken && left.kind === ts.SyntaxKind.FalseKeyword)
    {
        return false;
    }
    return !(expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && (left.kind === ts.SyntaxKind.NullKeyword || isUndefinedIdentifier(ts, left)));
}

function isUndefinedIdentifier(ts, node)
{
    return ts.isIdentifier(node) && node.text === 'undefined';
}

export function controlBranch(ts, node)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (ts.isFunctionLike(current))
        {
            return {};
        }
        if (ts.isIfStatement(current))
        {
            const arm = current.thenStatement.pos <= node.pos && node.end <= current.thenStatement.end
                ? 'then'
                : current.elseStatement && current.elseStatement.pos <= node.pos && node.end <= current.elseStatement.end
                    ? 'else'
                    : null;
            return arm ? { controlArm: arm, controlGroup: current } : {};
        }
        if (ts.isTryStatement(current))
        {
            if (current.tryBlock.pos <= node.pos && node.end <= current.tryBlock.end)
            {
                return { controlArm: 'try', controlGroup: current };
            }
            if (current.catchClause && current.catchClause.pos <= node.pos && node.end <= current.catchClause.end)
            {
                return { controlArm: 'catch', controlGroup: current };
            }
        }
    }
    return {};
}

export function functionOwner(ts, node)
{
    for (let current = node.parent; current; current = current.parent)
    {
        if (ts.isFunctionLike(current))
        {
            const invocation = directInvocation(ts, current);
            if (!invocation)
            {
                return current;
            }
            current = invocation;
        }
    }
    return null;
}

function directInvocation(ts, functionNode)
{
    let expression = functionNode;
    while (
        expression.parent
    && (
        ts.isParenthesizedExpression(expression.parent)
        || ts.isAsExpression(expression.parent)
        || ts.isNonNullExpression(expression.parent)
    )
    && expression.parent.expression === expression
    )
    {
        expression = expression.parent;
    }
    return expression.parent
    && ts.isCallExpression(expression.parent)
    && expression.parent.expression === expression
        ? expression.parent
        : null;
}
