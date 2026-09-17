export function isConditionalExecution(ts, node)
{
    return writeExecution(ts, node) === 'conditional';
}

export function writeExecution(ts, node)
{
    const owner = functionOwner(ts, node);
    let conditional = false;
    for (let current = node.parent; current && current !== owner; current = current.parent)
    {
        const shortCircuit = shortCircuitExecution(ts, current, node);
        if (shortCircuit === 'unreachable')
        {
            return 'unreachable';
        }
        if (shortCircuit === 'conditional')
        {
            conditional = true;
        }
        if (
            ts.isIfStatement(current)
        || ts.isConditionalExpression(current)
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
            conditional = true;
        }
    }
    return conditional ? 'conditional' : 'definite';
}

function shortCircuitExecution(ts, expression, node)
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
        return null;
    }
    if (!(expression.right.pos <= node.pos && node.end <= expression.right.end))
    {
        return null;
    }
    const left = unwrapTransparentExpression(ts, expression.left);
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    {
        return left.kind === ts.SyntaxKind.TrueKeyword
            ? 'definite'
            : left.kind === ts.SyntaxKind.FalseKeyword ? 'unreachable' : 'conditional';
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    {
        return left.kind === ts.SyntaxKind.FalseKeyword
            ? 'definite'
            : left.kind === ts.SyntaxKind.TrueKeyword ? 'unreachable' : 'conditional';
    }
    if (left.kind === ts.SyntaxKind.NullKeyword || isUndefinedIdentifier(ts, left))
    {
        return 'definite';
    }
    return isKnownNonNullish(ts, left) ? 'unreachable' : 'conditional';
}

function isUndefinedIdentifier(ts, node)
{
    return ts.isIdentifier(node) && node.text === 'undefined';
}

function isKnownNonNullish(ts, node)
{
    return ts.isStringLiteralLike(node)
        || ts.isNumericLiteral(node)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind);
}

function unwrapTransparentExpression(ts, node)
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
