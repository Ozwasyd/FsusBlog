// This adapter retains the original rule's visitors, options, metadata and failures.
// Native globals are trusted; structural parameter annotations do not prove provenance.
export function withRejectionForwarding(originalRule)
{
    return {
        ...originalRule,
        create(context)
        {
            const source = context.sourceCode;
            const services = source.parserServices;
            const checker = services.program.getTypeChecker();
            const tsNode = node => services.esTreeNodeToTSNodeMap.get(node);
            function nativeSymbol(symbol, name, library)
            {
                const libraries = name === 'Promise'
                    ? ['es5', 'es2015.iterable', 'es2015.promise', 'es2015.symbol.wellknown', 'es2018.promise']
                    : library === 'dom' ? ['dom', 'webworker'] : [library];
                return symbol?.getName() === name && symbol.declarations?.length > 0
                    && symbol.declarations.every(declaration =>
                        services.program.isSourceFileDefaultLibrary(declaration.getSourceFile())
                        && libraries.some(candidate => declaration.getSourceFile().fileName.endsWith(`/lib.${candidate}.d.ts`)));
            }

            function variableAt(identifier)
            {
                if (identifier?.type !== 'Identifier')
                {
                    return null;
                }
                for (let scope = source.getScope(identifier); scope; scope = scope.upper)
                {
                    if (scope.set.has(identifier.name))
                    {
                        return scope.set.get(identifier.name);
                    }
                }
                return null;
            }

            function unchanged(variable)
            {
                return variable?.defs.length === 1 && variable.identifiers.length === 1
                    && variable.references.every(reference => !reference.isWrite());
            }

            function nativeIdentifier(node, name, library)
            {
                return node?.type === 'Identifier'
                    && !(variableAt(node)?.defs.length > 0)
                    && nativeSymbol(checker.getSymbolAtLocation(tsNode(node)), name, library);
            }

            function nativeParameter(node, name, library)
            {
                const identifier = node?.type === 'TSNonNullExpression' ? node.expression : node;
                const variable = variableAt(identifier);
                if (!unchanged(variable) || variable.defs[0].type !== 'Parameter'
                    || variable.references.some(reference =>
                    {
                        let access = reference.identifier;
                        while ((access.parent.type === 'MemberExpression' && access.parent.object === access)
                            || (access.parent.type === 'TSNonNullExpression' && access.parent.expression === access))
                        {
                            access = access.parent;
                        }
                        return (access.parent.type === 'AssignmentExpression' && access.parent.left === access)
                            || access.parent.type === 'UpdateExpression'
                            || (access.parent.type === 'UnaryExpression' && access.parent.operator === 'delete');
                    }))
                {
                    return false;
                }
                const type = checker.getNonNullableType(services.getTypeAtLocation(identifier));
                return nativeSymbol(type.getSymbol(), name, library);
            }

            function member(node, name)
            {
                return node?.type === 'MemberExpression' && !node.computed && !node.optional
                    && node.property.type === 'Identifier' && node.property.name === name;
            }

            function nativeOrigin(node, name)
            {
                if (name === 'Promise')
                {
                    if (node?.type === 'NewExpression')
                    {
                        return nativeIdentifier(node.callee, 'Promise', 'es2015.promise');
                    }
                    if (node?.type !== 'CallExpression' || node.optional)
                    {
                        return false;
                    }
                    // resolve(value) can return a caller-owned Promise with replaced methods.
                    return (member(node.callee, 'resolve') && node.arguments.length === 0
                        || member(node.callee, 'reject'))
                        && nativeIdentifier(node.callee.object, 'Promise', 'es2015.promise');
                }
                if (name === 'AbortSignal')
                {
                    return (node?.type === 'CallExpression' && !node.optional
                        && member(node.callee, 'abort')
                        && nativeIdentifier(node.callee.object, 'AbortSignal', 'dom'))
                        || (member(node, 'signal') && node.object.type === 'NewExpression'
                            && nativeIdentifier(node.object.callee, 'AbortController', 'dom'));
                }
                return false;
            }

            function nativeSink(call)
            {
                if (call?.type !== 'CallExpression' || call.optional || call.arguments.length !== 1)
                {
                    return false;
                }
                if (member(call.callee, 'reject'))
                {
                    return nativeIdentifier(call.callee.object, 'Promise', 'es2015.promise');
                }
                const variable = variableAt(call.callee);
                const executor = variable?.defs[0]?.node;
                const construction = executor?.parent;
                return unchanged(variable) && variable.defs[0].type === 'Parameter'
                    && executor.params.length === 2 && executor.params[1] === variable.identifiers[0]
                    && construction?.type === 'NewExpression' && construction.arguments[0] === executor
                    && nativeIdentifier(construction.callee, 'Promise', 'es2015.promise');
            }

            function callbackReason(node)
            {
                const variable = variableAt(node);
                const callback = variable?.defs[0]?.node;
                const call = callback?.parent;
                if (!unchanged(variable) || variable.defs[0].type !== 'Parameter'
                    || !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)
                    || callback.async || callback.generator || callback.id
                    || callback.params.length !== 1 || callback.params[0] !== variable.identifiers[0]
                    || call?.type !== 'CallExpression' || call.optional)
                {
                    return false;
                }
                const method = call.callee;
                const rejectionIndex = member(method, 'then') ? 1 : member(method, 'catch') ? 0 : -1;
                if (rejectionIndex < 0 || call.arguments.length !== rejectionIndex + 1
                    || call.arguments[rejectionIndex] !== callback
                    || !nativeOrigin(method.object, 'Promise'))
                {
                    return false;
                }
                return nativeSymbol(checker.getSymbolAtLocation(tsNode(method.property)), method.property.name, 'es5');
            }

            function abortReason(node)
            {
                if (member(node, 'reason'))
                {
                    return nativeOrigin(node.object, 'AbortSignal')
                        && nativeSymbol(checker.getSymbolAtLocation(tsNode(node.property)), 'reason', 'dom');
                }
                if (node?.type !== 'CallExpression' || node.optional || node.arguments.length !== 1)
                {
                    return false;
                }
                const variable = variableAt(node.callee);
                const helper = variable?.defs[0]?.node;
                if (!unchanged(variable) || helper?.type !== 'FunctionDeclaration'
                    || helper.async || helper.generator || helper.params.length !== 1
                    || helper.params[0].type !== 'Identifier' || helper.body.body.length !== 1
                    || helper.body.body[0].type !== 'ReturnStatement'
                    || !nativeOrigin(node.arguments[0], 'AbortSignal'))
                {
                    return false;
                }
                const returned = helper.body.body[0].argument;
                if (returned?.type !== 'LogicalExpression' || returned.operator !== '??'
                    || !member(returned.left, 'reason')
                    || variableAt(returned.left.object) !== variableAt(helper.params[0])
                    || !nativeParameter(returned.left.object, 'AbortSignal', 'dom')
                    || !nativeSymbol(checker.getSymbolAtLocation(tsNode(returned.left.property)), 'reason', 'dom'))
                {
                    return false;
                }
                const fallback = returned.right;
                return fallback.type === 'NewExpression'
                    && nativeIdentifier(fallback.callee, 'DOMException', 'dom')
                    && fallback.arguments.length === 2
                    && fallback.arguments[0].type === 'Literal' && typeof fallback.arguments[0].value === 'string'
                    && fallback.arguments[1].type === 'Literal' && fallback.arguments[1].value === 'AbortError';
            }

            const originalContext = Object.create(context, {
                report: {
                    value(descriptor)
                    {
                        const call = descriptor.node;
                        if (descriptor.messageId === 'rejectAnError' && nativeSink(call)
                            && (callbackReason(call.arguments[0]) || abortReason(call.arguments[0])))
                        {
                            return;
                        }
                        context.report(descriptor);
                    }
                }
            });
            return originalRule.create(originalContext);
        }
    };
}
