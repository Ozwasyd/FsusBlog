import { controlBranch, functionOwner, isConditionalExecution, writeExecution } from './pospace-control-flow-writes.mjs';

export function collectBindingWrites(ts, sourceFile, flow, helpers)
{
    const {
        provenanceMember,
        resolveLexicalBinding,
        staticMemberAccess,
        staticStringValue,
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
                recordTarget(ts, target, node, value, { conditional: true }, recordIdentifier, recordMember, staticMemberAccess, flow, staticStringValue);
            }
            return;
        }
        if (
            (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.MinusMinusToken, ts.SyntaxKind.PlusPlusToken].includes(node.operator)
        )
        {
            recordTarget(ts, node.operand, node, null, { kills: true }, recordIdentifier, recordMember, staticMemberAccess, flow, staticStringValue);
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
                recordTarget(ts, target, node, values[index] ?? null, options, recordIdentifier, recordMember, staticMemberAccess, flow, staticStringValue);
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
                const name = destructuringPropertyName(ts, property.name, flow, staticStringValue);
                const target = ts.isPropertyAssignment(property) ? property.initializer : property.name;
                if (name)
                {
                    recordTarget(ts, target, node, provenanceMember(node.right, name), options, recordIdentifier, recordMember, staticMemberAccess, flow, staticStringValue);
                }
            }
            return;
        }
        const value = node.operatorToken.kind === ts.SyntaxKind.EqualsToken || logical ? node.right : null;
        recordTarget(ts, left, node, value, options, recordIdentifier, recordMember, staticMemberAccess, flow, staticStringValue);
    });
}

function destructuringPropertyName(ts, name, flow, staticStringValue)
{
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    {
        return name.text;
    }
    if (ts.isComputedPropertyName(name))
    {
        return staticStringValue(name.expression, flow);
    }
    return null;
}

function recordTarget(
    ts,
    targetNode,
    node,
    value,
    options,
    recordIdentifier,
    recordMember,
    staticMemberAccess,
    flow,
    staticStringValue
)
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
                staticMemberAccess,
                flow,
                staticStringValue
            );
        }
        return;
    }
    if (ts.isObjectLiteralExpression(target))
    {
        for (const property of target.properties)
        {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
            {
                continue;
            }
            const name = property.name
                ? destructuringPropertyName(ts, property.name, flow, staticStringValue)
                : null;
            const nestedTarget = ts.isPropertyAssignment(property) ? property.initializer : property.name;
            if (name)
            {
                const nestedValue = { container: value, property: name, provenanceMember: true };
                recordTarget(
                    ts,
                    nestedTarget,
                    node,
                    nestedValue,
                    options,
                    recordIdentifier,
                    recordMember,
                    staticMemberAccess,
                    flow,
                    staticStringValue
                );
            }
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
    const execution = writeExecution(ts, node);
    return {
        ...controlBranch(ts, node),
        conditional: options.conditional || execution === 'conditional',
        kills: options.kills ?? false,
        node,
        owner: functionOwner(ts, node),
        unreachable: execution === 'unreachable',
        value
    };
}
