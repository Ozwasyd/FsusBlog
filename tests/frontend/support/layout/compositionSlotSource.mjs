import { controlDigest } from '@fsusblog/control-legality/source';

/**
 * Bounded slot values from the existing composition graph and resolver ASTs.
 * Results describe source only. They neither modify the graph nor authorize DOM
 * identity, geometry, receipts, runtime values, or product acceptance.
 */
export function createCompositionSlotSource({ source })
{
    const { resolver } = source;
    const { ts, dom } = resolver;
    const values = new WeakMap();
    const closures = new WeakSet();
    const vnodes = new WeakSet();
    const reserved = new Set(['__proto__', 'prototype', 'constructor',
        'data-fsus-composition-node', 'data-fsus-composition-call']);
    const fail = (message) =>
    {
        throw new Error(`[composition-slot-source] ${message}`);
    };
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
            || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    function step(file, node, context)
    {
        const record = resolver.parse(file);
        const script = record.scripts.find(({ ast }) => ast === node.getSourceFile());
        if (!script)
        {
            fail(`AST does not belong to canonical record ${file}`);
        }
        const entry = { file, offset: script.offset + node.getStart(), kind: 'script-source', digest: controlDigest(node.getText()) };
        context.steps.push(entry);
        return entry;
    }
    function templateStep(record, node, context)
    {
        context.steps.push({ file: record.file, offset: record.template.offset + node.loc.start.offset,
            kind: 'template-source', digest: controlDigest(node.loc.source) });
    }
    function root(node)
    {
        node = unwrap(node);
        while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
        {
            node = unwrap(node.expression);
        }
        return node && ts.isIdentifier(node) ? node.text : null;
    }
    function readonly(record, name, declaration, context)
    {
        const identity = `${record.file}:${declaration.getStart()}:${name}`;
        if (context.guards.has(identity))
        {
            return;
        }
        context.guards.add(identity);
        const contains = (node) =>
        {
            if (ts.isIdentifier(node) && node.text === name)
            {
                return true;
            }
            let found = false;
            ts.forEachChild(node, (child) =>
            {
                found = contains(child) || found;
            });
            return found;
        };
        const visit = (node) =>
        {
            if (ts.isIdentifier(node) && node.text === name && node !== declaration
                && node.parent.name === node && (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent)
                    || ts.isBindingElement(node.parent) || ts.isFunctionDeclaration(node.parent)
                    || ts.isClassDeclaration(node.parent) || ts.isImportSpecifier(node.parent)))
            {
                fail(`shadowed source binding ${record.file}#${name}`);
            }
            if ((ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && root(node.left) === name)
                || (ts.isDeleteExpression(node) && root(node.expression) === name)
                || ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
                    && root(node.operand) === name))
            {
                fail(`mutated source binding ${record.file}#${name}`);
            }
            if (ts.isCallExpression(node) && ((!ts.isIdentifier(node.expression) && root(node.expression) === name)
                || node.arguments.some((argument) => root(argument) === name)))
            {
                context.escapes.push({ file: record.file, node, name });
            }
            if (ts.isVariableDeclaration(node) && node.initializer && contains(node.initializer)
                && node.name !== declaration)
            {
                if (!ts.isIdentifier(node.name))
                {
                    fail(`unbound source alias pattern ${record.file}#${name}`);
                }
                // Follow aggregate aliases too: [vnode] and {child:vnode} can
                // otherwise hide writes behind another identifier.
                readonly(record, node.name.text, node.name, context);
            }
            ts.forEachChild(node, visit);
        };
        record.scripts.forEach(({ ast }) => visit(ast));
        step(record.file, declaration.parent, context);
    }
    function propertyName(node)
    {
        if (!node || ts.isComputedPropertyName(node) || (!ts.isIdentifier(node) && !ts.isStringLiteral(node)))
        {
            fail('unknown property name');
        }
        if (reserved.has(node.text))
        {
            fail(`reserved property ${node.text}`);
        }
        return node.text;
    }
    function closure(file, node, env)
    {
        if (node.asteriskToken || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        {
            fail('async/generator callback');
        }
        const value = { file, node, env: new Map(env) };
        closures.add(value);
        return value;
    }
    function lexical(file, identifier, env, context)
    {
        const name = identifier.text;
        if (env.has(name))
        {
            return env.get(name);
        }
        const record = resolver.parse(file);
        let scope = identifier.parent;
        while (scope)
        {
            if (ts.isBlock(scope) || ts.isSourceFile(scope))
            {
                const declarations = scope.statements.flatMap((statement) => ts.isVariableStatement(statement)
                    ? statement.declarationList.declarations.filter((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)
                    : ts.isFunctionDeclaration(statement) && statement.name?.text === name ? [statement] : []);
                if (declarations.length)
                {
                    if (declarations.length !== 1)
                    {
                        fail(`ambiguous source binding ${file}#${name}`);
                    }
                    const declaration = declarations[0];
                    readonly(record, name, declaration.name, context);
                    if (ts.isFunctionDeclaration(declaration))
                    {
                        return closure(file, declaration, env);
                    }
                    if (!(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer
                        || declaration.getStart() > identifier.getStart())
                    {
                        fail(`unbound source constant ${file}#${name}`);
                    }
                    const key = `${file}:${declaration.getStart()}`;
                    if (context.active.has(key))
                    {
                        fail(`cyclic source constant ${key}`);
                    }
                    context.active.add(key);
                    const result = evaluate(file, declaration.initializer, env, context);
                    context.active.delete(key);
                    return result;
                }
            }
            scope = scope.parent;
        }
        const imported = record.imports.get(name);
        if (imported)
        {
            // Component identity remains the canonical resolver's decision.
            // Callable imports must resolve to actual source, never a name table.
            const target = source.importFile(file, imported.specifier);
            if (typeof target !== 'string')
            {
                fail(`opaque imported callback ${file}#${name}`);
            }
            const exported = resolver.exportsOf(target).get(imported.name);
            if (!exported || exported.ambiguous)
            {
                fail(`unknown imported callback ${file}#${name}`);
            }
            const owner = resolver.parse(exported.file);
            const declarations = owner.scripts.flatMap(({ ast }) => ast.statements.flatMap((statement) =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === exported.name ? [statement]
                    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter((entry) =>
                        ts.isIdentifier(entry.name) && entry.name.text === exported.name) : []));
            if (declarations.length !== 1)
            {
                fail(`unbound imported function body ${exported.file}#${exported.name}`);
            }
            readonly(owner, exported.name, declarations[0].name, context);
            const declaration = declarations[0];
            if (ts.isFunctionDeclaration(declaration))
            {
                return closure(exported.file, declaration, new Map());
            }
            const initializer = unwrap(declaration.initializer);
            if (!(declaration.parent.flags & ts.NodeFlags.Const) || !initializer
                || !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
            {
                fail('unbound imported callback initializer');
            }
            return closure(exported.file, initializer, new Map());
        }
        fail(`unknown runtime value ${file}#${name}`);
    }
    function vueApi(file, identifier, name, context)
    {
        if (!ts.isIdentifier(identifier))
        {
            return false;
        }
        const record = resolver.parse(file);
        const imported = record.imports.get(identifier.text);
        if (imported?.specifier !== 'vue' || imported.name !== name)
        {
            return false;
        }
        const bindings = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isImportDeclaration)
            .flatMap((statement) => statement.importClause && !statement.importClause.isTypeOnly
                && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                ? statement.importClause.namedBindings.elements.filter((entry) => !entry.isTypeOnly && entry.name.text === identifier.text) : []));
        if (bindings.length !== 1)
        {
            fail('ambiguous Vue import');
        }
        readonly(record, identifier.text, bindings[0].name, context);
        return true;
    }
    function fields(file, properties, env, context, jsx = false)
    {
        const result = Object.create(null);
        for (const property of properties)
        {
            if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
                || ts.isMethodDeclaration(property) || jsx && ts.isJsxAttribute(property)))
            {
                fail('unknown attrs or spread');
            }
            const name = propertyName(property.name);
            if (Object.hasOwn(result, name))
            {
                fail(`duplicate property ${name}`);
            }
            const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
            result[name] = ts.isMethodDeclaration(property) ? closure(file, property, env)
                : initializer ? evaluate(file, initializer, env, context) : '';
        }
        return result;
    }
    function vnode(file, node, target, props, children, context)
    {
        if (!['native', 'local', 'fsusui-public'].includes(target.kind))
        {
            fail(`unproved original component identity ${file}:${node.getStart()}`);
        }
        const definition = source.componentFile(target);
        const result = { target, definition, props, children, source: context.steps.at(-1), clones: [] };
        vnodes.add(result);
        return result;
    }
    function component(file, node, jsx, context)
    {
        if ((ts.isStringLiteral(node) || jsx && ts.isIdentifier(node)) && dom.parserOptions.isNativeTag(node.text))
        {
            return { kind: 'native', name: node.text };
        }
        if (ts.isIdentifier(node) && resolver.parse(file).imports.has(node.text))
        {
            const record = resolver.parse(file);
            const bindings = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isImportDeclaration)
                .flatMap((statement) => [statement.importClause?.name,
                    ...(statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                        ? statement.importClause.namedBindings.elements.filter((entry) => !entry.isTypeOnly).map((entry) => entry.name) : [])]))
                .filter((name) => name?.text === node.text);
            if (bindings.length !== 1)
            {
                fail('ambiguous original component import');
            }
            readonly(record, node.text, bindings[0], context);
        }
        const targets = resolver.resolveExpression(file, node);
        if (targets.length !== 1)
        {
            fail('ambiguous original component identity');
        }
        return targets[0];
    }
    function invoke(value, args, context, allowVoid = false)
    {
        if (!value || !closures.has(value))
        {
            fail('opaque callback');
        }
        if (value.template)
        {
            if (args.length)
            {
                fail('unbound template slot argument payload');
            }
            return value.output;
        }
        const { file, node } = value;
        const key = `${file}:${node.getStart()}`;
        if (context.active.has(key) || args.length !== node.parameters.length)
        {
            fail(`recursive callback or mismatched parameters ${key}`);
        }
        context.active.add(key);
        const env = new Map(value.env);
        for (let index = 0; index < node.parameters.length; index++)
        {
            const parameter = node.parameters[index];
            if (parameter.initializer || parameter.dotDotDotToken)
            {
                fail('unknown callback parameter default/rest');
            }
            bindPattern(file, parameter.name, args[index], env, context);
        }
        const callbackStep = step(file, node, context);
        const result = ts.isBlock(node.body) ? flow(file, node.body, env, context) : { returned: true, value: evaluate(file, node.body, env, context) };
        context.active.delete(key);
        if (!result.returned && !allowVoid)
        {
            fail(`callback may fall through ${key}`);
        }
        context.effects.push({ ...callbackStep,
            kind: 'readonly-callback', parameters: node.parameters.map((parameter) => parameter.name.getText()),
            argumentsDigest: controlDigest(project(args)), returnDigest: controlDigest(project(result.value)) });
        return result.value;
    }
    function bindPattern(file, pattern, value, env, context)
    {
        if (ts.isIdentifier(pattern))
        {
            readonly(resolver.parse(file), pattern.text, pattern, context);
            env.set(pattern.text, value);
            return;
        }
        if (ts.isObjectBindingPattern(pattern) && value && typeof value === 'object'
            && !Array.isArray(value) && !vnodes.has(value) && !closures.has(value))
        {
            for (const element of pattern.elements)
            {
                if (element.initializer || element.dotDotDotToken)
                {
                    fail('unknown callback binding default/rest');
                }
                const name = propertyName(element.propertyName ?? element.name);
                if (!Object.hasOwn(value, name))
                {
                    fail(`unknown callback argument field ${name}`);
                }
                bindPattern(file, element.name, value[name], env, context);
            }
            return;
        }
        fail('unbound callback parameter');
    }
    function flow(file, node, env, context)
    {
        step(file, node, context);
        if (ts.isReturnStatement(node))
        {
            return { returned: true, value: node.expression ? evaluate(file, node.expression, env, context) : undefined };
        }
        if (ts.isBlock(node))
        {
            const local = new Map(env);
            for (const statement of node.statements)
            {
                const result = flow(file, statement, local, context);
                if (result.returned)
                {
                    return result;
                }
            }
            return { returned: false };
        }
        if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const)
        {
            for (const declaration of node.declarationList.declarations)
            {
                if (!declaration.initializer)
                {
                    fail('unknown callback local');
                }
                bindPattern(file, declaration.name, evaluate(file, declaration.initializer, env, context), env, context);
            }
            return { returned: false };
        }
        if (ts.isFunctionDeclaration(node) && node.name)
        {
            env.set(node.name.text, closure(file, node, env));
            return { returned: false };
        }
        if (ts.isIfStatement(node))
        {
            const condition = evaluate(file, node.expression, env, context);
            return condition ? flow(file, node.thenStatement, env, context)
                : node.elseStatement ? flow(file, node.elseStatement, env, context) : { returned: false };
        }
        if (ts.isExpressionStatement(node))
        {
            evaluate(file, node.expression, env, context);
            return { returned: false };
        }
        if (ts.isEmptyStatement(node))
        {
            return { returned: false };
        }
        fail(`unproved callback effects ${file}:${node.getStart()}`);
    }
    function evaluate(file, original, env, context)
    {
        const node = unwrap(original);
        if (!node || ++context.operations > 2048)
        {
            fail('missing source or bounded evaluation limit');
        }
        step(file, node, context);
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        {
            return node.text;
        }
        if (ts.isNumericLiteral(node))
        {
            return Number(node.text);
        }
        if (node.kind === ts.SyntaxKind.NullKeyword)
        {
            return null;
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword)
        {
            return true;
        }
        if (node.kind === ts.SyntaxKind.FalseKeyword)
        {
            return false;
        }
        if (ts.isIdentifier(node))
        {
            return lexical(file, node, env, context);
        }
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        {
            return closure(file, node, env);
        }
        if (ts.isObjectLiteralExpression(node))
        {
            return fields(file, node.properties, env, context);
        }
        if (ts.isArrayLiteralExpression(node))
        {
            if (node.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)))
            {
                fail('unknown source array spread/hole');
            }
            return node.elements.map((element) => evaluate(file, element, env, context));
        }
        if (ts.isJsxExpression(node))
        {
            return node.expression ? evaluate(file, node.expression, env, context) : null;
        }
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))
        {
            const opening = ts.isJsxElement(node) ? node.openingElement : node;
            const props = fields(file, opening.attributes.properties, env, context, true);
            const children = ts.isJsxElement(node) ? node.children.map((child) => ts.isJsxText(child)
                ? child.text : evaluate(file, child, env, context)) : [];
            step(file, node, context);
            return vnode(file, node, component(file, opening.tagName, true, context), props, children, context);
        }
        if (ts.isConditionalExpression(node))
        {
            return evaluate(file, evaluate(file, node.condition, env, context) ? node.whenTrue : node.whenFalse, env, context);
        }
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
        {
            return !evaluate(file, node.operand, env, context);
        }
        if (ts.isBinaryExpression(node))
        {
            const left = evaluate(file, node.left, env, context);
            if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
            {
                return left && evaluate(file, node.right, env, context);
            }
            if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
            {
                return left || evaluate(file, node.right, env, context);
            }
            if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
            {
                return left ?? evaluate(file, node.right, env, context);
            }
            const right = evaluate(file, node.right, env, context);
            if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
            {
                return left === right;
            }
            if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
            {
                return left !== right;
            }
            fail('unproved callback operator/effects');
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        {
            const value = evaluate(file, node.expression, env, context);
            if (node.questionDotToken && value == null)
            {
                return undefined;
            }
            const name = ts.isPropertyAccessExpression(node) ? node.name.text : evaluate(file, node.argumentExpression, env, context);
            if (reserved.has(name) || typeof name !== 'string' && !Number.isInteger(name))
            {
                fail('unknown property access');
            }
            if (value && vnodes.has(value))
            {
                if (name === 'type' && value.target.kind === 'native')
                {
                    return value.target.name;
                }
                if (!['children', 'props'].includes(name))
                {
                    fail(`unproved VNode runtime field ${name}`);
                }
            }
            if (Array.isArray(value) && name === 'length')
            {
                return value.length;
            }
            if (!value || typeof value !== 'object' || !Object.hasOwn(value, name))
            {
                fail(`unknown runtime field ${name}`);
            }
            return value[name];
        }
        if (ts.isCallExpression(node))
        {
            context.calls.add(node);
            if (node.arguments.some(ts.isSpreadElement))
            {
                fail('unknown callback argument spread');
            }
            if (vueApi(file, node.expression, 'h', context) || vueApi(file, node.expression, 'createVNode', context))
            {
                if (node.arguments.length < 2 || node.arguments.length > 3)
                {
                    fail('unbound vnode arguments');
                }
                const props = evaluate(file, node.arguments[1], env, context);
                if (!props || Array.isArray(props) || typeof props !== 'object' || vnodes.has(props) || closures.has(props))
                {
                    fail('unknown vnode props');
                }
                const children = node.arguments[2] ? evaluate(file, node.arguments[2], env, context) : [];
                step(file, node, context);
                return vnode(file, node, component(file, node.arguments[0], false, context), props, children, context);
            }
            if (vueApi(file, node.expression, 'cloneVNode', context))
            {
                if (node.arguments.length !== 2)
                {
                    fail('unbound clone arguments/ref merge');
                }
                const originalVNode = evaluate(file, node.arguments[0], env, context);
                const props = evaluate(file, node.arguments[1], env, context);
                if (!originalVNode || !vnodes.has(originalVNode) || !props || typeof props !== 'object'
                    || Array.isArray(props) || closures.has(props) || vnodes.has(props))
                {
                    fail('unknown clone input/attrs');
                }
                // Ref/event/class/style merging needs separate actual effect proofs.
                // Ordinary own literal props may not replace the original type,
                // key/ref or authored provenance markers.
                for (const [name, value] of Object.entries(props))
                {
                    if (reserved.has(name) || ['type', 'key', 'ref', 'class', 'style', 'is', 'innerHTML', 'textContent'].includes(name)
                        || /^on[A-Z]/.test(name) || value !== null && !['string', 'number', 'boolean'].includes(typeof value))
                    {
                        fail(`unproved clone prop/effect ${name}`);
                    }
                    if (originalVNode.definition)
                    {
                        const declaration = resolver.componentPropDeclaration(originalVNode.definition, name);
                        if (!declaration)
                        {
                            fail(`undeclared clone prop ${name}`);
                        }
                        step(declaration.file, declaration.node, context);
                    }
                }
                step(file, node, context);
                const result = { ...originalVNode, props: { ...originalVNode.props, ...props },
                    clones: [...originalVNode.clones, context.steps.at(-1)] };
                vnodes.add(result);
                return result;
            }
            if (vueApi(file, node.expression, 'withDirectives', context))
            {
                if (node.arguments.length !== 2)
                {
                    fail('unbound directive arguments');
                }
                const originalVNode = evaluate(file, node.arguments[0], env, context);
                const directives = evaluate(file, node.arguments[1], env, context);
                if (!originalVNode || !vnodes.has(originalVNode) || !Array.isArray(directives))
                {
                    fail('unknown directive input');
                }
                for (const tuple of directives)
                {
                    if (!Array.isArray(tuple) || tuple.length !== 1 || !tuple[0] || typeof tuple[0] !== 'object'
                        || closures.has(tuple[0]) || vnodes.has(tuple[0]))
                    {
                        fail('unbound directive tuple/payload');
                    }
                    for (const [hook, callback] of Object.entries(tuple[0]))
                    {
                        if (!['created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated', 'beforeUnmount', 'unmounted'].includes(hook)
                            || !closures.has(callback) || callback.node.parameters.length)
                        {
                            fail(`unproved directive effect ${hook}`);
                        }
                        invoke(callback, [], context, true);
                    }
                }
                return originalVNode;
            }
            const callback = evaluate(file, node.expression, env, context);
            if (node.questionDotToken && callback == null)
            {
                return undefined;
            }
            return invoke(callback, node.arguments.map((argument) => evaluate(file, argument, env, context)), context);
        }
        fail(`unknown source value/effects ${file}:${node.getStart()}: ${node.getText()}`);
    }
    function project(value)
    {
        if (value === undefined)
        {
            return { absent: true };
        }
        if (Array.isArray(value))
        {
            return value.map(project);
        }
        if (value && closures.has(value))
        {
            return value.template ? { kind: 'template-slot', supplier: value.supplier }
                : { kind: 'source-callback', file: value.file, offset: value.node.getStart(), digest: controlDigest(value.node.getText()) };
        }
        if (value && typeof value === 'object')
        {
            return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, project(entry)]));
        }
        return value;
    }
    function result(value, context, inputs = {})
    {
        const unresolved = (entry) =>
        {
            if (entry && closures.has(entry))
            {
                return !entry.template;
            }
            if (entry && typeof entry === 'object')
            {
                return Object.values(entry).some(unresolved);
            }
            return false;
        };
        if (unresolved(value))
        {
            fail('callback return/effects require an actual invocation');
        }
        for (const escape of context.escapes)
        {
            if (!context.calls.has(escape.node))
            {
                fail(`unproved source escape ${escape.file}#${escape.name}`);
            }
        }
        const bindings = resolver.sourceBindings();
        if (bindings.errors.length)
        {
            fail(`source dependency changed: ${JSON.stringify(bindings.errors)}`);
        }
        const proof = { ...inputs, steps: [...new Map(context.steps.map((entry) => [controlDigest(entry), entry])).values()],
            effects: context.effects, value: project(value), sourceIdentity: resolver.identity, resolverInputs: bindings.files };
        proof.proofDigest = controlDigest(proof);
        values.set(proof, { value, context });
        return proof;
    }
    const context = () => ({ steps: [], effects: [], active: new Set(), calls: new Set(), escapes: [], guards: new Set(), operations: 0 });
    function canonicalNode(graph, id)
    {
        const node = graph.nodes.find((entry) => entry.id === id);
        if (!node || source.nodes.get(id) !== node)
        {
            fail(`foreign or missing graph node ${id}`);
        }
        return node;
    }
    function bindSlot({ graph, callNode, name = 'default' })
    {
        const call = canonicalNode(graph, callNode);
        if (!call.definition || call.slotInputs.unknown || call.slotInputs.present[name] !== true)
        {
            fail(`unbound actual slot supplier ${callNode}#${name}`);
        }
        const record = resolver.parse(call.file);
        if (!record.template)
        {
            fail('script slot supplier requires actual callback invocation binding');
        }
        const ctx = context();
        let supplier;
        const find = (node) =>
        {
            if (node.type === dom.NodeTypes.ELEMENT && record.template.offset + node.loc.start.offset === call.offset)
            {
                supplier = node;
            }
            node.children?.forEach(find);
        };
        find(record.template.ast);
        if (!supplier)
        {
            fail('missing canonical template supplier');
        }
        templateStep(record, supplier, ctx);
        const slotDirective = (node) => node.props?.find((entry) => entry.type === dom.NodeTypes.DIRECTIVE && entry.name === 'slot');
        const named = supplier.children.filter((child) => slotDirective(child)?.arg?.content === name);
        const direct = slotDirective(supplier);
        const selected = named.length ? named : name === 'default' && !direct ? supplier.children.filter((child) => !slotDirective(child)) : [supplier];
        if (named.length > 1 || direct?.arg && direct.arg.content !== name)
        {
            fail('ambiguous actual slot supplier');
        }
        const contents = selected.flatMap((child) => slotDirective(child) ? child.children : [child]);
        for (const child of [...selected, supplier])
        {
            if (slotDirective(child)?.exp?.content || child.props?.some((entry) => entry.type === dom.NodeTypes.DIRECTIVE
                && ['if', 'else-if', 'else', 'for'].includes(entry.name)))
            {
                fail('unbound scoped/conditional slot supplier');
            }
        }
        function output(node)
        {
            templateStep(record, node, ctx);
            if (node.type === dom.NodeTypes.TEXT)
            {
                return node.content;
            }
            if (node.type === dom.NodeTypes.COMMENT)
            {
                return null;
            }
            if (node.type !== dom.NodeTypes.ELEMENT)
            {
                fail('opaque template slot output');
            }
            const entry = graph.nodes.find((candidate) => candidate.file === record.file
                && candidate.offset === record.template.offset + node.loc.start.offset);
            if (!entry || entry.origin.kind === 'framework-structure' || entry.directives.length || entry.conditional.length)
            {
                fail('unproved template slot output');
            }
            canonicalNode(graph, entry.id);
            if (entry.parentId !== call.id && !entry.ancestors.includes(call.id))
            {
                fail('slot output outside actual supplier');
            }
            const value = { target: entry.origin, definition: entry.definition, props: entry.attributes,
                children: node.children.map(output), source: { file: entry.file, offset: entry.offset, digest: entry.sourceDigest, kind: 'template-source' },
                sourceNode: entry.id, clones: [] };
            vnodes.add(value);
            return value;
        }
        const value = { template: true, supplier: call.id, output: contents.map(output) };
        closures.add(value);
        return result(value, ctx, { callNode: call.id, property: name, callPath: [call.id],
            inputDigest: controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }) });
    }
    function proveValue({ file, node })
    {
        const ctx = context();
        return result(evaluate(file, node, new Map(), ctx), ctx);
    }
    function invokeSlot({ graph, binding, file, invocation })
    {
        const bound = values.get(binding);
        if (!bound || !bound.value.template)
        {
            fail('foreign slot proof');
        }
        const call = canonicalNode(graph, binding.callNode);
        if (call.definition !== file)
        {
            fail('slot invocation does not belong to actual component');
        }
        const ctx = context();
        ctx.steps.push(...bound.context.steps);
        const node = unwrap(invocation);
        if (!ts.isCallExpression(node))
        {
            fail('missing actual slot invocation');
        }
        const callee = unwrap(node.expression);
        const property = ts.isPropertyAccessExpression(callee) ? callee.name.text
            : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : null;
        if (property !== binding.property || !ts.isIdentifier(callee.expression))
        {
            fail('unknown actual slot callee');
        }
        let setup = node.parent;
        while (setup && !(ts.isMethodDeclaration(setup) && setup.name?.getText() === 'setup'))
        {
            setup = setup.parent;
        }
        const renderSource = source.records.get(file)?.renderSource;
        if (!setup || !renderSource || setup.getStart() !== renderSource.setupOffset
            || controlDigest(setup.getText()) !== renderSource.setupDigest
            || node.getStart() < renderSource.renderOffset)
        {
            fail('slot invocation is outside canonical component render binding');
        }
        const pattern = setup?.parameters[1]?.name;
        const parameter = pattern && ts.isObjectBindingPattern(pattern) ? pattern.elements.find((element) =>
            (element.propertyName ?? element.name).getText() === 'slots') : null;
        if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== callee.expression.text
            || parameter.initializer || parameter.dotDotDotToken)
        {
            fail('unbound actual setup slots parameter');
        }
        readonly(resolver.parse(file), parameter.name.text, parameter.name, ctx);
        const env = new Map([[parameter.name.text, { [binding.property]: bound.value }]]);
        return result(evaluate(file, node, env, ctx), ctx, { callNode: call.id, property: binding.property,
            callPath: binding.callPath, inputDigest: binding.inputDigest, supplierProofDigest: binding.proofDigest });
    }
    return { bindSlot, proveValue, invokeSlot };
}
