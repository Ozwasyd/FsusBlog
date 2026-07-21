export function collectBindingWrites(ts, sourceFile, flow, helpers)
{
    const {
        resolveLexicalBinding,
        staticMemberAccess,
        unwrapRuntimeExpression,
        walk
    } = helpers;
    const recordBindingWrite = (identifier, node, value) =>
    {
        const binding = resolveLexicalBinding(flow.lexicalBindings, identifier, node);
        if (binding && flow.constValueBindings.includes(binding))
        {
            binding.writes ??= [];
            binding.writes.push({ node, value });
        }
    };
    const assignmentValue = node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : null;

    walk(sourceFile, node =>
    {
        if (
            (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.MinusMinusToken, ts.SyntaxKind.PlusPlusToken].includes(node.operator)
        && ts.isIdentifier(node.operand)
        )
        {
            recordBindingWrite(node.operand, node, null);
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
        if (ts.isIdentifier(left))
        {
            recordBindingWrite(left, node, assignmentValue(node));
            return;
        }
        if (
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isArrayLiteralExpression(left)
        && ts.isArrayLiteralExpression(unwrapRuntimeExpression(node.right))
        )
        {
            const values = unwrapRuntimeExpression(node.right).elements;
            for (const [index, target] of left.elements.entries())
            {
                if (ts.isIdentifier(target))
                {
                    recordBindingWrite(target, node, values[index] ?? null);
                }
            }
            return;
        }
        const member = staticMemberAccess(left, flow);
        const container = member && unwrapRuntimeExpression(member.container);
        if (!member || !ts.isIdentifier(container))
        {
            return;
        }
        const binding = resolveLexicalBinding(flow.lexicalBindings, container, node);
        if (binding && flow.constValueBindings.includes(binding))
        {
            binding.memberWrites ??= new Map();
            const writes = binding.memberWrites.get(member.property) ?? [];
            writes.push({ node, value: assignmentValue(node) });
            binding.memberWrites.set(member.property, writes);
        }
    });
}
