export function collectBindingWrites(ts, sourceFile, flow, helpers)
{
    const {
        provenanceMember,
        resolveLexicalBinding,
        staticMemberAccess,
        unwrapRuntimeExpression,
        walk
    } = helpers;
    const recordIdentifier = (identifier, node, value, options = {}) =>
    {
        const binding = resolveLexicalBinding(flow.lexicalBindings, identifier, node);
        if (binding && flow.constValueBindings.includes(binding))
        {
            recordWrite(binding, null, makeWrite(ts, node, value, options));
        }
    };
    const recordMember = (member, node, value, options = {}) =>
    {
        const container = unwrapRuntimeExpression(member.container);
        if (!ts.isIdentifier(container))
        {
            return;
        }
        const binding = resolveLexicalBinding(flow.lexicalBindings, container, node);
        if (binding && flow.constValueBindings.includes(binding))
        {
            recordWrite(binding, member.property, makeWrite(ts, node, value, options));
        }
    };

    walk(sourceFile, node =>
    {
        if (
            ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
        )
        {
            recordIdentifier(node.name, node, node.initializer, {
                conditional: isConditionalExecution(ts, node),
                kills: true
            });
            return;
        }
        if (ts.isForInStatement(node) || ts.isForOfStatement(node))
        {
            const target = unwrapRuntimeExpression(node.initializer);
            const values = ts.isArrayLiteralExpression(unwrapRuntimeExpression(node.expression))
                ? unwrapRuntimeExpression(node.expression).elements
                : [null];
            for (const value of values)
            {
                recordTarget(ts, target, node, value, { conditional: true }, recordIdentifier, recordMember, staticMemberAccess);
            }
            return;
        }
        if (
            (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.MinusMinusToken, ts.SyntaxKind.PlusPlusToken].includes(node.operator)
        )
        {
            recordTarget(ts, node.operand, node, null, { kills: true }, recordIdentifier, recordMember, staticMemberAccess);
            return;
        }
        if (
            !ts.isBinaryExpression(node)
        || node.operatorToken.kind < ts.SyntaxKind.FirstAssignment
        || node.operatorToken.kind > ts.SyntaxKind.LastAssignment
        )
        {
            return;
        }
        const left = unwrapRuntimeExpression(node.left);
        const logical = [
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken
        ].includes(node.operatorToken.kind);
        const options = {
            conditional: logical || isConditionalExecution(ts, node),
            kills: node.operatorToken.kind === ts.SyntaxKind.EqualsToken || !logical
        };
        if (ts.isArrayLiteralExpression(left) && ts.isArrayLiteralExpression(unwrapRuntimeExpression(node.right)))
        {
            const values = unwrapRuntimeExpression(node.right).elements;
            for (const [index, target] of left.elements.entries())
            {
                recordTarget(ts, target, node, values[index] ?? null, options, recordIdentifier, recordMember, staticMemberAccess);
            }
            return;
        }
        if (ts.isObjectLiteralExpression(left))
        {
            for (const property of left.properties)
            {
                if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
                {
                    continue;
                }
                const name = destructuringPropertyName(ts, property.name);
                const target = ts.isPropertyAssignment(property) ? property.initializer : property.name;
                if (name)
                {
                    recordTarget(ts, target, node, provenanceMember(node.right, name), options, recordIdentifier, recordMember, staticMemberAccess);
                }
            }
            return;
        }
        const value = node.operatorToken.kind === ts.SyntaxKind.EqualsToken || logical ? node.right : null;
        recordTarget(ts, left, node, value, options, recordIdentifier, recordMember, staticMemberAccess);
    });
}

function destructuringPropertyName(ts, name)
{
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    {
        return name.text;
    }
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
    {
        return name.expression.text;
    }
    return null;
}

function recordTarget(ts, targetNode, node, value, options, recordIdentifier, recordMember, staticMemberAccess)
{
    const target = targetNode;
    if (target?.kind === undefined)
    {
        return;
    }
    if (ts.isArrayLiteralExpression(target))
    {
        const values = ts.isArrayLiteralExpression(value) ? value.elements : [];
        for (const [index, nestedTarget] of target.elements.entries())
        {
            recordTarget(
                ts,
                nestedTarget,
                node,
                values[index] ?? null,
                options,
                recordIdentifier,
                recordMember,
                staticMemberAccess
            );
        }
        return;
    }
    if (ts.isIdentifier(target))
    {
        recordIdentifier(target, node, value, options);
        return;
    }
    const member = staticMemberAccess(target, null);
    if (member)
    {
        recordMember(member, node, value, options);
    }
}

function recordWrite(binding, property, write)
{
    if (property === null)
    {
        binding.writes ??= [];
        binding.writes.push(write);
        return;
    }
    binding.memberWrites ??= new Map();
    const writes = binding.memberWrites.get(property) ?? [];
    writes.push(write);
    binding.memberWrites.set(property, writes);
}

function makeWrite(ts, node, value, options)
{
    return {
        conditional: options.conditional || isConditionalExecution(ts, node),
        kills: options.kills ?? false,
        node,
        owner: functionOwner(ts, node),
        value
    };
}

function isConditionalExecution(ts, node)
{
    const owner = functionOwner(ts, node);
    for (let current = node.parent; current && current !== owner; current = current.parent)
    {
        if (
            ts.isIfStatement(current)
        || ts.isConditionalExpression(current)
        || isShortCircuitExpression(ts, current)
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

function isShortCircuitExpression(ts, node)
{
    return ts.isBinaryExpression(node)
    && [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken
    ].includes(node.operatorToken.kind);
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
