import { controlDigest } from '@fsusblog/control-legality/source';

/**
 * Bounded collection plans over the ORIGINAL resolver's AST objects. A plan
 * proves collection construction, never VNode/component identity or product
 * state. The canonical render owner must consume every element with its own
 * output visitor and retain its errors. No parser, registry or receipt lives here.
 */
export function createCompositionCollectionSource(source)
{
    const { resolver } = source;
    const { ts } = resolver;
    const fail = (message) =>
    {
        throw new Error(`[composition-collection-source] ${message}`);
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
    function walk(node, visitor)
    {
        visitor(node);
        ts.forEachChild(node, (child) => walk(child, visitor));
    }
    function step(file, node)
    {
        return resolver.sourceStep(file, node);
    }
    function current()
    {
        const bindings = resolver.sourceBindings();
        if (bindings.errors.length)
        {
            fail(`changed canonical inputs: ${JSON.stringify(bindings.errors)}`);
        }
        return bindings.files;
    }
    function proof(payload, steps)
    {
        const inputs = current();
        const identity = { ...payload, steps, inputs, sourceIdentity: resolver.identity };
        return { ...identity, proofDigest: controlDigest(identity) };
    }
    function path(node)
    {
        node = unwrap(node);
        if (node && ts.isIdentifier(node))
        {
            return [node.text];
        }
        if (node && ts.isPropertyAccessExpression(node))
        {
            const base = path(node.expression);
            return base && [...base, node.name.text];
        }
        if (node && ts.isElementAccessExpression(node))
        {
            const base = path(node.expression);
            const key = unwrap(node.argumentExpression);
            return base && [...base, key && (ts.isStringLiteral(key) || ts.isNumericLiteral(key)) ? key.text : '*'];
        }
        return null;
    }
    function declaration(file, name, use)
    {
        const matches = [];
        for (const { ast } of resolver.parse(file).scripts)
        {
            walk(ast, (node) =>
            {
                if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                    || ts.isFunctionDeclaration(node)) && ts.isIdentifier(node.name) && node.name.text === name)
                {
                    matches.push(node);
                }
            });
        }
        // Deliberately reject shadowed bindings rather than borrow another scope.
        if (matches.length !== 1)
        {
            fail(`ambiguous/unknown binding ${file}#${name}`);
        }
        const found = matches[0];
        const scope = ts.isVariableDeclaration(found) && ts.isVariableStatement(found.parent.parent)
            ? found.parent.parent.parent : ts.isFunctionDeclaration(found) ? found.parent : null;
        if (use && scope)
        {
            let visible = false;
            for (let owner = use.parent; owner; owner = owner.parent)
            {
                visible ||= owner === scope;
            }
            if (!visible)
            {
                fail(`out-of-scope collection binding ${file}#${name}`);
            }
        }
        if (use && ts.isVariableDeclaration(found) && found.getStart() >= use.getStart())
        {
            fail(`collection used before declaration ${file}#${name}`);
        }
        return found;
    }
    function condition(file, expression, name)
    {
        return { name, expression: expression.getText(), ...step(file, expression) };
    }
    function enclosingConditions(file, node, stop)
    {
        const conditions = [];
        for (let child = node, parent = node.parent; parent && parent !== stop; child = parent, parent = parent.parent)
        {
            if (ts.isIfStatement(parent))
            {
                conditions.unshift(condition(file, parent.expression, child === parent.thenStatement ? 'if' : 'else'));
            }
            else if (ts.isFunctionLike(parent))
            {
                fail(`deferred collection write ${file}:${node.getStart()}`);
            }
        }
        return conditions;
    }
    function functionBody(file, expression)
    {
        expression = unwrap(expression);
        step(file, expression);
        if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
        {
            return { file, fn: expression };
        }
        // The canonical helper owns immutable import/export/function resolution.
        // Its success grants no purity, argument escape or collection identity.
        if (ts.isIdentifier(expression) && !resolver.parse(file).imports.has(expression.text))
        {
            declaration(file, expression.text, expression);
        }
        const target = resolver.resolveSourceFunction(file, expression);
        readonlyReferences(file, expression.text, new Set([expression]));
        return { ...target, importSteps: [step(file, expression), step(target.file, target.fn)] };
    }
    /** Full callback effects, including nested callbacks; annotations grant nothing. */
    function callbackEffects(file, fn)
    {
        step(file, fn);
        const reads = [];
        const writes = [];
        const escapes = [];
        const calls = [];
        const bindings = new Set();
        const aliases = new Map();
        const parameters = fn.parameters.map((parameter) =>
        {
            if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)
            {
                fail(`unknown callback parameter ${file}:${parameter.getStart()}`);
            }
            bindings.add(parameter.name.text);
            return parameter.name.text;
        });
        const rooted = (node) =>
        {
            const parts = path(node);
            if (!parts)
            {
                return null;
            }
            return aliases.has(parts[0]) ? [...aliases.get(parts[0]), ...parts.slice(1)] : parts;
        };
        walk(fn.body, (node) =>
        {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
            {
                bindings.add(node.name.text);
                const origin = rooted(node.initializer);
                if (origin)
                {
                    aliases.set(node.name.text, origin);
                }
            }
        });
        const entry = (node, target, extra = {}) => ({ ...step(file, node), path: target, ...extra });
        walk(fn.body, (node) =>
        {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
            {
                writes.push(entry(node, rooted(node.left), { operator: node.operatorToken.getText(), value: step(file, node.right) }));
            }
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
            {
                writes.push(entry(node, rooted(node.operand), { operator: ts.tokenToString(node.operator) }));
            }
            if (ts.isDeleteExpression(node))
            {
                writes.push(entry(node, rooted(node.expression), { operator: 'delete' }));
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node))
            {
                calls.push(entry(node, rooted(node.expression), { expression: node.expression.getText(),
                    arguments: (node.arguments ?? []).map((argument) => ({ ...step(file, argument), path: rooted(argument), expression: argument.getText() })) }));
                for (const argument of node.arguments ?? [])
                {
                    const target = rooted(argument);
                    if (target)
                    {
                        escapes.push(entry(argument, target, { kind: 'call-argument' }));
                    }
                }
                const target = rooted(node.expression);
                if (target)
                {
                    escapes.push(entry(node.expression, target, { kind: 'method-receiver' }));
                }
            }
            if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
                && !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node))
            {
                reads.push(entry(node, rooted(node)));
            }
            if (ts.isIdentifier(node) && bindings.has(node.text) && node.parent.name !== node
                && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
            {
                reads.push(entry(node, rooted(node)));
            }
            if (ts.isReturnStatement(node) && node.expression && rooted(node.expression))
            {
                escapes.push(entry(node.expression, rooted(node.expression), { kind: 'return' }));
            }
            if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
            {
                for (const parameter of parameters)
                {
                    let captured = false;
                    walk(node.body, (child) =>
                    {
                        captured ||= rooted(child)?.[0] === parameter;
                    });
                    if (captured)
                    {
                        escapes.push(entry(node, [parameter], { kind: 'callback-capture' }));
                    }
                }
            }
        });
        return proof({ parameters, reads, writes, escapes, calls }, [step(file, fn)]);
    }
    function readonlyReferences(file, name, allowed = new Set())
    {
        resolver.parse(file).scripts.forEach(({ ast }) => walk(ast, (node) =>
        {
            if (!ts.isIdentifier(node) || node.text !== name || allowed.has(node))
            {
                return;
            }
            const parent = node.parent;
            if (parent.name === node && (ts.isVariableDeclaration(parent) || ts.isParameter(parent)
                || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)))
            {
                return;
            }
            if (ts.isPropertyAccessExpression(parent) && parent.name === node)
            {
                return;
            }
            let top = node;
            while (top.parent && ((ts.isPropertyAccessExpression(top.parent) || ts.isElementAccessExpression(top.parent))
                && top.parent.expression === top || ts.isNonNullExpression(top.parent) || ts.isAsExpression(top.parent)))
            {
                top = top.parent;
            }
            const use = top.parent;
            if (ts.isBinaryExpression(use) && use.left === top && use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && use.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isDeleteExpression(use)
                || (ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use))
                    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(use.operator))
            {
                fail(`mutated collection binding ${file}#${name}`);
            }
            if (ts.isVariableDeclaration(use) && use.initializer === top || ts.isSpreadAssignment(use)
                || ts.isPropertyAssignment(use) && use.initializer === top
                || ts.isArrayLiteralExpression(use) || ts.isReturnStatement(use)
                || ts.isBinaryExpression(use) && use.right === top && use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                    && use.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                || (ts.isCallExpression(use) || ts.isNewExpression(use)) && (use.arguments?.includes(top) || use.expression === top))
            {
                fail(`escaped collection binding ${file}#${name}`);
            }
        }));
    }
    function scalar(node)
    {
        node = unwrap(node);
        return node && (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind));
    }
    /**
     * Finite array/map/filter and fresh local push plans. Leaves retain original
     * AST nodes and callback bindings for the canonical output visitor. Guards
     * are never evaluated as runtime product facts.
     */
    function collect(file, expression)
    {
        const steps = [];
        const effects = [];
        const elements = [];
        const seen = new Set();
        function visit(node, conditions = [], bindings = new Map())
        {
            node = unwrap(node);
            steps.push(step(file, node));
            if (ts.isArrayLiteralExpression(node))
            {
                for (const item of node.elements)
                {
                    if (ts.isOmittedExpression(item))
                    {
                        fail(`sparse collection ${file}:${item.getStart()}`);
                    }
                    if (ts.isSpreadElement(item))
                    {
                        visit(item.expression, conditions, bindings);
                    }
                    else
                    {
                        elements.push({ node: item, conditions, bindings });
                    }
                }
                return;
            }
            if (ts.isConditionalExpression(node))
            {
                visit(node.whenTrue, [...conditions, condition(file, node.condition, 'if')], bindings);
                visit(node.whenFalse, [...conditions, condition(file, node.condition, 'else')], bindings);
                return;
            }
            if (ts.isIdentifier(node))
            {
                if (seen.has(node.text))
                {
                    fail(`cyclic collection ${file}#${node.text}`);
                }
                const found = declaration(file, node.text, node);
                if (!ts.isVariableDeclaration(found) || !(found.parent.flags & ts.NodeFlags.Const) || !found.initializer)
                {
                    fail(`mutable/opaque collection ${file}#${node.text}`);
                }
                resolver.assertImmutableBinding(file, node.text);
                seen.add(node.text);
                steps.push(step(file, found));
                const scope = found.parent.parent.parent;
                const pushes = [];
                const allowed = new Set([node, found.name]);
                walk(scope, (candidate) =>
                {
                    if (ts.isCallExpression(candidate) && ts.isPropertyAccessExpression(candidate.expression)
                        && ts.isIdentifier(candidate.expression.expression) && candidate.expression.expression.text === node.text
                        && candidate.expression.name.text === 'push')
                    {
                        if (candidate.arguments.some(ts.isSpreadElement) || candidate.getStart() > node.getStart()
                            || !ts.isExpressionStatement(candidate.parent))
                        {
                            fail(`unordered collection push ${file}#${node.text}`);
                        }
                        const guards = enclosingConditions(file, candidate, scope);
                        pushes.push({ candidate, guards });
                        allowed.add(candidate.expression.expression);
                    }
                });
                // Other uses may read length or render the same collection, but
                // must not export its identity or borrow mutable array methods.
                readonlyReferences(file, node.text, allowed);
                visit(found.initializer, conditions, bindings);
                for (const { candidate, guards } of pushes.sort((a, b) => a.candidate.getStart() - b.candidate.getStart()))
                {
                    steps.push(step(file, candidate));
                    effects.push({ kind: 'fresh-array-push', ...step(file, candidate), conditions: guards });
                    candidate.arguments.forEach((item) => elements.push({ node: item, conditions: [...conditions, ...guards], bindings }));
                }
                seen.delete(node.text);
                return;
            }
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && ['map', 'filter'].includes(node.expression.name.text) && node.arguments.length === 1 && !node.questionDotToken)
            {
                const target = functionBody(file, node.arguments[0]);
                if (target.file !== file)
                {
                    fail(`cross-file callback requires canonical binding adapter ${file}`);
                }
                const fn = target.fn;
                if (fn.modifiers?.length || fn.asteriskToken || fn.parameters.length < 1 || fn.parameters.length > 2)
                {
                    fail(`unknown collection callback ${file}:${fn.getStart()}`);
                }
                const effect = callbackEffects(file, fn);
                // Calls, item writes and captures are never pure by a function
                // name or a VNode/readonly annotation.
                if (effect.writes.length || effect.calls.length || effect.escapes.some((entry) => entry.kind !== 'return'))
                {
                    fail(`effectful collection callback ${file}:${fn.getStart()}`);
                }
                if (effect.reads.some((entry) => !entry.path || entry.path.length !== 1 || !effect.parameters.includes(entry.path[0])))
                {
                    fail(`unbound collection callback read ${file}:${fn.getStart()}`);
                }
                effects.push({ kind: node.expression.name.text, ...effect });
                let returned = unwrap(fn.body);
                if (ts.isBlock(returned))
                {
                    if (returned.statements.length !== 1 || !ts.isReturnStatement(returned.statements[0]) || !returned.statements[0].expression)
                    {
                        fail(`unknown collection callback flow ${file}:${fn.getStart()}`);
                    }
                    returned = unwrap(returned.statements[0].expression);
                }
                const start = elements.length;
                visit(node.expression.expression, conditions, bindings);
                const suppliers = elements.splice(start);
                if (effect.parameters.length === 2 && suppliers.some((item) => item.conditions.length !== conditions.length))
                {
                    fail(`condition-dependent collection index ${file}:${node.getStart()}`);
                }
                suppliers.forEach((item, index) =>
                {
                    // Runtime object identity cannot be lent to a callback.
                    if (!scalar(item.node))
                    {
                        fail(`opaque collection item ${file}:${item.node.getStart()}`);
                    }
                    const next = new Map(item.bindings);
                    next.set(effect.parameters[0], { node: item.node, file });
                    if (effect.parameters[1])
                    {
                        next.set(effect.parameters[1], { index, file });
                    }
                    if (node.expression.name.text === 'filter')
                    {
                        elements.push({ ...item, conditions: [...item.conditions, condition(file, returned, 'if')], bindings: next });
                    }
                    else
                    {
                        elements.push({ node: returned, conditions: item.conditions, bindings: next });
                    }
                });
                return;
            }
            fail(`opaque collection supplier ${file}:${node.getStart()}: ${node.getText()}`);
        }
        visit(expression);
        const identityElements = elements.map(({ node, conditions, bindings }) => ({ source: step(file, node), conditions,
            bindings: [...bindings].map(([name, value]) => ({ name, ...('index' in value ? { index: value.index }
                : { source: step(value.file, value.node) }) })) }));
        const result = proof({ kind: 'collection-plan', elements: identityElements, effects }, steps);
        return { ...result, outputs: elements };
    }
    /**
     * Proves only an authored early empty branch of a computed helper call,
     * against an ORIGINAL canonical component call with a truly absent prop.
     * The complete provided branch is retained; it receives no render authority.
     */
    function computedBranches(file, call)
    {
        step(file, call);
        if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isIdentifier(unwrap(call.arguments[0])))
        {
            fail(`unbound computed collection call ${file}`);
        }
        const target = functionBody(file, call.expression);
        const fn = target.fn;
        if (fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name) || fn.parameters[0].initializer
            || fn.parameters[0].dotDotDotToken || !ts.isBlock(fn.body) || fn.body.statements.length !== 1
            || !ts.isReturnStatement(fn.body.statements[0]))
        {
            fail(`unknown collection helper ${target.file}`);
        }
        const computed = unwrap(fn.body.statements[0].expression);
        const imported = computed && ts.isCallExpression(computed) && ts.isIdentifier(computed.expression)
            ? resolver.parse(target.file).imports.get(computed.expression.text) : null;
        if (imported?.specifier !== 'vue' || imported.name !== 'computed' || computed.arguments.length !== 1)
        {
            fail(`unknown computed constructor ${target.file}`);
        }
        resolver.assertImmutableBinding(target.file, computed.expression.text);
        readonlyReferences(target.file, computed.expression.text, new Set([computed.expression]));
        const callback = unwrap(computed.arguments[0]);
        if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length || callback.modifiers?.length
            || !ts.isBlock(callback.body))
        {
            fail(`unknown computed callback ${target.file}`);
        }
        const statements = callback.body.statements;
        const first = statements[0];
        const test = first && ts.isIfStatement(first) && unwrap(first.expression);
        const member = test && ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken
            && path(test.operand);
        const returned = first && ts.isIfStatement(first) && ts.isBlock(first.thenStatement)
            && first.thenStatement.statements.length === 1 ? first.thenStatement.statements[0] : null;
        if (!member || member.length !== 2 || member[0] !== fn.parameters[0].name.text || first.elseStatement
            || !returned || !ts.isReturnStatement(returned) || !ts.isArrayLiteralExpression(unwrap(returned.expression))
            || unwrap(returned.expression).elements.length || statements.length < 2)
        {
            fail(`no authored first empty branch ${target.file}`);
        }
        const property = member[1];
        const steps = [step(file, call), ...(target.importSteps ?? []), step(target.file, fn), step(target.file, first),
            ...statements.slice(1).map((statement) => step(target.file, statement))];
        return { ...proof({ kind: 'computed-collection-branches', property, condition: condition(target.file, first.expression, 'if'),
            emptyBranch: step(target.file, returned), providedBranch: { condition: condition(target.file, first.expression, 'else'),
                steps: statements.slice(1).map((statement) => step(target.file, statement)), renderProven: false },
            effects: callbackEffects(target.file, fn) }, steps), target, callback };
    }
    function emptyComputedCall(file, call, componentCall)
    {
        if (source.nodes.get(componentCall?.id) !== componentCall || componentCall.definition !== file)
        {
            fail(`unbound canonical component call ${file}`);
        }
        const branches = computedBranches(file, call);
        const { target, callback, property } = branches;
        const fn = target.fn;
        const propsName = unwrap(call.arguments[0]).text;
        const props = declaration(file, propsName, call);
        const macro = ts.isVariableDeclaration(props) && unwrap(props.initializer);
        if (!macro || !ts.isCallExpression(macro) || !ts.isIdentifier(macro.expression)
            || macro.expression.text !== 'defineProps' || resolver.parse(file).imports.has('defineProps'))
        {
            fail(`unbound actual props argument ${file}`);
        }
        const declarationInfo = resolver.componentPropDeclaration(file, property);
        if (!declarationInfo || declarationInfo.defaultNode)
        {
            fail(`unknown/nonempty default ${file}#${property}`);
        }
        const callerClosure = bindingClosure(file, props, property, new Set([call.arguments[0]]));
        if (!callerClosure.readonly)
        {
            fail(`escaped collection binding ${file}#${propsName}; caller source closure ${JSON.stringify({
                unresolved: callerClosure.unresolved, effects: callerClosure.functions.filter((entry) => entry.writes.length || entry.escapes.length)
            })}`);
        }
        // Provided values retain all their effects and never gain authority.
        if (branches.effects.writes.some((entry) => entry.path?.[0] === fn.parameters[0].name.text))
        {
            fail(`mutated helper collection props ${target.file}`);
        }
        const kebab = property.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase());
        if (componentCall.scopedBindings?.includes(property) || Object.keys(componentCall.attributes).some((name) => [property, kebab].includes(name))
            || componentCall.directives.some((entry) => entry.name === 'bind'
                && (!entry.argument || !entry.argumentStatic || [property, kebab].includes(entry.argument))))
        {
            fail(`provided/opaque collection input ${componentCall.id}#${property}`);
        }
        const supplied = source.nodes.get(componentCall.id);
        const steps = [step(file, props), ...branches.steps];
        return proof({ kind: 'empty-call-branch', property, callNode: supplied.id, callPath: [supplied.id],
            inputDigests: [controlDigest({ attributes: supplied.attributes, directives: supplied.directives, slots: supplied.slotInputs })],
            declarationDigest: declarationInfo.declarationDigest, empty: true, condition: branches.condition,
            providedBranch: branches.providedBranch, effects: branches.effects, callerClosure,
            callback: step(target.file, callback) }, [...steps, ...callerClosure.steps]);
    }
    /** Resolve actual supplier definitions for review; effects stay explicit. */
    function supplier(file, expression)
    {
        step(file, expression);
        const target = functionBody(file, expression);
        const queue = [target];
        const functions = [];
        const edges = [];
        const unresolved = [];
        const visited = new Set();
        const steps = [step(file, expression), ...(target.importSteps ?? [])];
        while (queue.length)
        {
            const owner = queue.shift();
            const definition = step(owner.file, owner.fn);
            const identity = controlDigest(definition);
            if (visited.has(identity))
            {
                continue;
            }
            if (visited.size === 64)
            {
                fail(`supplier source closure exceeds 64 actual functions ${file}`);
            }
            visited.add(identity);
            steps.push(definition);
            functions.push({ file: owner.file, name: owner.name ?? null, definition, effects: callbackEffects(owner.file, owner.fn) });
            walk(owner.fn.body, (node) =>
            {
                if (!ts.isCallExpression(node))
                {
                    return;
                }
                const call = step(owner.file, node);
                const argumentsSource = node.arguments.map((argument) => step(owner.file, argument));
                try
                {
                    // Only the original resolver may establish this edge.
                    // Property calls and external/runtime functions stay open.
                    const dependency = resolver.resolveSourceFunction(owner.file, unwrap(node.expression));
                    const callee = step(dependency.file, dependency.fn);
                    edges.push({ from: definition, call, callee, arguments: argumentsSource });
                    queue.push(dependency);
                }
                catch (error)
                {
                    unresolved.push({ from: definition, call, expression: node.expression.getText(),
                        arguments: argumentsSource, reason: error.message });
                }
            });
        }
        const result = proof({ kind: 'supplier-source-closure', functions, edges, unresolved,
            renderProven: false }, steps);
        return { ...target, ...result, effects: functions[0].effects };
    }
    /** Parameter-relative closure: other arguments/effects never imply purity. */
    function boundFunction(file, callee, bindings)
    {
        const bound = bindings?.get(callee);
        if (!bound)
        {
            return resolver.resolveSourceFunction(file, callee);
        }
        step(file, callee);
        step(bound.file, bound.fn);
        // This accepts an explicit original local declaration, not a second
        // import/function resolver. Central binding ownership is unchanged.
        if (bound.file !== file || !ts.isIdentifier(callee) || !ts.isFunctionDeclaration(bound.fn)
            || bound.fn.name?.text !== callee.text || bound.fn.asteriskToken
            || bound.fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        {
            fail(`unbound explicit function AST ${file}`);
        }
        resolver.assertImmutableBinding(file, callee.text);
        let visible = false;
        for (let owner = callee.parent; owner; owner = owner.parent)
        {
            visible ||= owner === bound.fn.parent;
        }
        if (!visible)
        {
            fail(`out-of-scope explicit function AST ${file}`);
        }
        return bound;
    }
    function rootClosure(file, fn, index, property, bindings, seed = null, excluded = new Set())
    {
        const visited = new Set();
        const functions = [];
        const edges = [];
        const unresolved = [];
        const steps = [];
        function inspect(ownerFile, owner, parameterIndex)
        {
            const definition = step(ownerFile, owner);
            const identity = controlDigest({ definition, parameterIndex, property });
            if (visited.has(identity))
            {
                return;
            }
            if (visited.size === 64)
            {
                fail('parameter closure exceeds 64 actual functions');
            }
            visited.add(identity);
            const parameter = owner === fn && seed ? seed : owner.parameters[parameterIndex];
            if (!parameter || !ts.isIdentifier(parameter.name) || !(owner === fn && seed) && parameter.initializer || parameter.dotDotDotToken)
            {
                fail(`unbound source parameter ${ownerFile}`);
            }
            const root = parameter.name.text;
            const reads = [];
            const writes = [];
            const escapes = [];
            const relevant = (parts) => parts?.[0] === root && (!property || parts.length === 1 || parts[1] === property || parts[1] === '*');
            walk(owner.body ?? owner, (node) =>
            {
                if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
                    && ts.isIdentifier(node.name) && node.name.text === root && node !== seed)
                {
                    fail(`shadowed source parameter ${ownerFile}#${root}`);
                }
                if (!ts.isIdentifier(node) || node.text !== root || node === seed?.name || excluded.has(node)
                    || ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                {
                    return;
                }
                let top = node;
                while (top.parent && ((ts.isPropertyAccessExpression(top.parent) || ts.isElementAccessExpression(top.parent))
                    && top.parent.expression === top || ts.isNonNullExpression(top.parent) || ts.isAsExpression(top.parent)
                    || ts.isParenthesizedExpression(top.parent)))
                {
                    top = top.parent;
                }
                const parts = path(top);
                if (!relevant(parts))
                {
                    return;
                }
                const use = top.parent;
                const entry = { ...step(ownerFile, top), path: parts };
                reads.push(entry);
                if (ts.isBinaryExpression(use) && use.left === top && use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                    && use.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isDeleteExpression(use)
                    || (ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use))
                        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(use.operator))
                {
                    writes.push({ ...entry, operation: step(ownerFile, use) });
                    return;
                }
                if (ts.isCallExpression(use) && use.arguments.includes(top) && parts.length === 1)
                {
                    try
                    {
                        const target = boundFunction(ownerFile, unwrap(use.expression), bindings);
                        const argumentIndex = use.arguments.indexOf(top);
                        edges.push({ call: step(ownerFile, use), argument: entry, parameterIndex: argumentIndex,
                            callee: step(target.file, target.fn) });
                        inspect(target.file, target.fn, argumentIndex);
                    }
                    catch (error)
                    {
                        unresolved.push({ ...entry, call: step(ownerFile, use), reason: error.message,
                            required: 'original resolver export/function AST and parameter effect closure' });
                    }
                    return;
                }
                // A member passed to an opaque consumer can carry the selected
                // property's identity. Passing unrelated fields proves nothing
                // about those fields, but cannot manufacture a marks write.
                if ((ts.isCallExpression(use) || ts.isNewExpression(use)) && (use.arguments?.includes(top) || use.expression === top)
                    || ts.isReturnStatement(use) || ts.isVariableDeclaration(use) && use.initializer === top
                    || ts.isPropertyAssignment(use) && use.initializer === top || ts.isShorthandPropertyAssignment(use)
                    || ts.isSpreadAssignment(use) || ts.isArrayLiteralExpression(use)
                    || ts.isBinaryExpression(use) && use.right === top && use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                        && use.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
                {
                    escapes.push({ ...entry, operation: step(ownerFile, use), kind: 'identity-escape' });
                }
            });
            steps.push(definition);
            functions.push({ file: ownerFile, definition, parameterIndex, parameter: root, reads, writes, escapes });
        }
        inspect(file, fn, index);
        return proof({ kind: seed ? 'binding-source-closure' : 'parameter-source-closure', property, functions, edges, unresolved,
            readonly: !unresolved.length && functions.every((entry) => !entry.writes.length && !entry.escapes.length),
            renderProven: false }, steps);
    }
    function parameterClosure(file, fn, index = 0, property = null, bindings = new Map())
    {
        return rootClosure(file, fn, index, property, bindings);
    }
    function bindingClosure(file, binding, property, excluded = new Set(), bindings = new Map())
    {
        step(file, binding);
        if (!ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name) || !(binding.parent.flags & ts.NodeFlags.Const))
        {
            fail(`mutable/opaque caller binding ${file}`);
        }
        resolver.assertImmutableBinding(file, binding.name.text);
        return rootClosure(file, binding.parent.parent.parent, 0, property, bindings, binding, excluded);
    }
    function canonicalCall(call)
    {
        if (source.nodes.get(call?.id) !== call)
        {
            fail('unbound canonical collection input call');
        }
        return { callNode: call.id, callPath: [...call.ancestors, call.id], sourceDigest: call.sourceDigest,
            inputDigest: controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }) };
    }
    /** Closed strings from actual call records; all conditional alternatives survive. */
    function callStrings(call, property)
    {
        const input = canonicalCall(call);
        const kebab = property.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase());
        const names = [property, kebab];
        const provided = Object.keys(call.attributes).filter((name) => names.includes(name));
        const bound = call.directives.filter((entry) => entry.name === 'bind' && names.includes(entry.argument));
        if (call.scopedBindings?.includes(property) || call.directives.some((entry) => entry.name === 'bind'
            && (!entry.argument || !entry.argumentStatic)) || provided.length + bound.length > 1)
        {
            fail(`opaque/ambiguous collection input ${call.id}#${property}`);
        }
        const steps = [];
        const branches = [];
        function strings(node, conditions = [])
        {
            node = unwrap(node);
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            {
                branches.push({ value: node.text, conditions });
                return;
            }
            if (ts.isConditionalExpression(node))
            {
                strings(node.whenTrue, [...conditions, { name: 'if', expression: node.condition.getText(), ...input }]);
                strings(node.whenFalse, [...conditions, { name: 'else', expression: node.condition.getText(), ...input }]);
                return;
            }
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join'
                && ts.isArrayLiteralExpression(unwrap(node.expression.expression)) && node.arguments.length === 1
                && ts.isStringLiteral(node.arguments[0]))
            {
                const items = unwrap(node.expression.expression).elements;
                if (items.every(ts.isStringLiteral))
                {
                    branches.push({ value: items.map((item) => item.text).join(node.arguments[0].text), conditions });
                    return;
                }
            }
            fail(`nonliteral collection input ${call.id}#${property}`);
        }
        if (provided.length)
        {
            if (typeof call.attributes[provided[0]] !== 'string')
            {
                fail(`nonstring collection input ${call.id}#${property}`);
            }
            branches.push({ value: call.attributes[provided[0]], conditions: [] });
        }
        else if (bound.length)
        {
            // The existing parser alone parses the canonical directive text.
            // This expression has no original-script sourceStep; its identity
            // is the actual call/source/input digest, never a synthetic offset.
            strings(source.expression(bound[0].expression, call.file));
        }
        else
        {
            const declarationInfo = resolver.componentPropDeclaration(call.definition, property);
            if (!declarationInfo?.defaultNode)
            {
                fail(`missing string collection default ${call.id}#${property}`);
            }
            steps.push(step(declarationInfo.file, declarationInfo.defaultNode));
            strings(declarationInfo.defaultNode);
        }
        return proof({ kind: 'closed-call-strings', property, ...input, branches, renderProven: false }, steps);
    }
    function tableEntries(file, expression)
    {
        expression = unwrap(expression);
        if (!ts.isIdentifier(expression))
        {
            fail(`unknown keyed collection table ${file}`);
        }
        const found = declaration(file, expression.text, expression);
        resolver.assertImmutableBinding(file, expression.text);
        const object = unwrap(found.initializer);
        if (!object || !ts.isObjectLiteralExpression(object))
        {
            fail(`opaque keyed collection table ${file}`);
        }
        const entries = new Map();
        for (const entry of object.properties)
        {
            if (!ts.isPropertyAssignment(entry) || ts.isComputedPropertyName(entry.name))
            {
                fail(`open keyed collection table ${file}`);
            }
            const key = entry.name.text;
            if (!key || entries.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
            {
                fail(`ambiguous keyed collection property ${file}`);
            }
            entries.set(key, entry.initializer);
        }
        // Root identity must stay local; projecting an entry is not a proof
        // that the entry/VNode itself is immutable.
        walk(found.parent.parent.parent, (node) =>
        {
            if (ts.isIdentifier(node) && node.text === expression.text && node !== found.name)
            {
                const parent = node.parent;
                if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node)
                {
                    let top = parent;
                    while (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top)
                    {
                        top = top.parent;
                    }
                    const use = top.parent;
                    if (ts.isBinaryExpression(use) && use.left === top && use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                        && use.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isDeleteExpression(use))
                    {
                        fail(`mutated keyed collection table ${file}`);
                    }
                    return;
                }
                fail(`escaped keyed collection table ${file}`);
            }
        });
        return { entries, declaration: found, object };
    }
    /** Finite key lookup with an authored fresh-Set membership condition. */
    function slotFallback(file, expression, call)
    {
        const input = canonicalCall(call);
        expression = unwrap(expression);
        step(file, expression);
        if (call.definition !== file || !ts.isBinaryExpression(expression)
            || expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken || expression.right.kind !== ts.SyntaxKind.NullKeyword)
        {
            fail(`unknown slot null fallback ${file}`);
        }
        const invoke = unwrap(expression.left);
        const member = invoke && ts.isCallExpression(invoke) && unwrap(invoke.expression);
        if (!invoke || !ts.isCallExpression(invoke) || invoke.arguments.length || !invoke.questionDotToken
            || !member || !ts.isPropertyAccessExpression(member) || !member.questionDotToken || !ts.isIdentifier(member.expression))
        {
            fail(`unknown optional slot invocation ${file}`);
        }
        const binding = declaration(file, member.expression.text, member.expression);
        const parameter = ts.isBindingElement(binding) && ts.isObjectBindingPattern(binding.parent) && binding.parent.parent;
        const setup = parameter && ts.isParameter(parameter) && parameter.parent;
        if (!setup || setup.parameters?.[1] !== parameter || setup.name?.getText() !== 'setup'
            || (binding.propertyName ?? binding.name).getText() !== 'slots' || binding.initializer || binding.dotDotDotToken)
        {
            fail(`unbound setup slot supplier ${file}`);
        }
        readonlyReferences(file, member.expression.text, new Set([binding.name, member.expression]));
        const name = member.name.text;
        if (call.slotInputs.unknown || Object.hasOwn(call.slotInputs.present, name) && call.slotInputs.present[name] !== false)
        {
            fail(`opaque partition slot supplier ${call.id}#${name}`);
        }
        return { ...proof({ kind: 'absent-call-slot-fallback', ...input, name, absent: true,
            suppliedBranch: step(file, invoke), emptyBranch: step(file, expression.right), renderProven: false },
        [step(file, expression), step(file, binding)]), node: expression.right };
    }
    function keyedMap(file, expression, componentCall = null)
    {
        expression = unwrap(expression);
        step(file, expression);
        if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)
            || expression.expression.name.text !== 'map' || expression.arguments.length !== 1)
        {
            fail(`unknown keyed map ${file}`);
        }
        const fn = functionBody(file, expression.arguments[0]);
        const callback = fn.fn;
        if (fn.file !== file || callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0].name)
            || callback.parameters[0].initializer || callback.parameters[0].dotDotDotToken || callback.modifiers?.length)
        {
            fail(`unknown keyed map callback ${file}`);
        }
        const result = unwrap(callback.body);
        if (!ts.isElementAccessExpression(result) || unwrap(result.argumentExpression).getText() !== callback.parameters[0].name.text)
        {
            fail(`unbound keyed map callback ${file}`);
        }
        const table = tableEntries(file, result.expression);
        const input = unwrap(expression.expression.expression);
        if (!ts.isCallExpression(input) || !ts.isPropertyAccessExpression(input.expression) || input.expression.name.text !== 'filter'
            || input.arguments.length !== 1)
        {
            fail(`unknown keyed map input ${file}`);
        }
        const predicate = functionBody(file, input.arguments[0]);
        const test = unwrap(predicate.fn.body);
        if (predicate.file !== file || predicate.fn.parameters.length !== 1 || !ts.isIdentifier(predicate.fn.parameters[0].name)
            || predicate.fn.parameters[0].initializer || predicate.fn.parameters[0].dotDotDotToken || predicate.fn.modifiers?.length
            || !ts.isCallExpression(test) || !ts.isPropertyAccessExpression(test.expression) || test.expression.name.text !== 'has'
            || !ts.isIdentifier(test.expression.expression) || test.arguments.length !== 1
            || test.arguments[0].getText() !== predicate.fn.parameters[0].name.text)
        {
            fail(`effectful keyed filter callback ${file}`);
        }
        const set = declaration(file, test.expression.expression.text, test);
        resolver.assertImmutableBinding(file, set.name.text);
        const constructor = unwrap(set.initializer);
        if (!constructor || !ts.isNewExpression(constructor) || constructor.expression.getText() !== 'Set'
            || resolver.parse(file).variables.has('Set') || resolver.parse(file).imports.has('Set') || constructor.arguments?.length !== 1)
        {
            fail(`opaque keyed filter receiver ${file}`);
        }
        for (const { ast } of resolver.parse(file).scripts)
        {
            walk(ast, (node) =>
            {
                if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.getText() === 'Set')
                {
                    fail(`shadowed keyed filter constructor ${file}`);
                }
            });
        }
        const allowed = new Set([set.name]);
        walk(set.parent.parent.parent, (node) =>
        {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && node.expression.expression.getText() === set.name.text && node.expression.name.text === 'has'
                && node.arguments.length === 1)
            {
                allowed.add(node.expression.expression);
            }
        });
        readonlyReferences(file, set.name.text, allowed);
        const keys = collect(file, input.expression.expression);
        const outputs = keys.outputs.map((item) =>
        {
            if (!ts.isStringLiteral(unwrap(item.node)) || !table.entries.has(unwrap(item.node).text))
            {
                fail(`unknown keyed collection element ${file}`);
            }
            const bindings = new Map(item.bindings);
            bindings.set(predicate.fn.parameters[0].name.text, { node: item.node, file });
            let node = table.entries.get(unwrap(item.node).text);
            let slot = null;
            if (componentCall && ts.isBinaryExpression(unwrap(node)) && unwrap(node).operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
            {
                const { node: fallback, ...identity } = slotFallback(file, node, componentCall);
                node = fallback;
                slot = identity;
            }
            return { node, slot, key: unwrap(item.node).text, bindings,
                conditions: [...item.conditions, condition(file, test, 'if')] };
        });
        return { ...proof({ kind: 'keyed-map-plan', effects: [callbackEffects(file, callback), callbackEffects(file, predicate.fn)],
            elements: outputs.map((item) => ({ key: item.key, source: step(file, item.node), conditions: item.conditions,
                keySource: step(file, item.bindings.get(predicate.fn.parameters[0].name.text).node), slot: item.slot })),
            membershipInput: step(file, constructor.arguments[0]), renderProven: false },
        [step(file, expression), step(file, table.declaration), step(file, constructor), ...keys.steps]), outputs };
    }
    /** Real pane record and actual caller label/slot supplier, no UID inference. */
    function paneLabel(file, recordExpression, call, callbackFile, callback)
    {
        const input = canonicalCall(call);
        if (call.definition !== file)
        {
            fail(`unbound pane supplier call ${call.id}`);
        }
        recordExpression = unwrap(recordExpression);
        step(file, recordExpression);
        step(callbackFile, callback);
        if (!ts.isCallExpression(recordExpression) || recordExpression.arguments.length !== 1
            || !ts.isObjectLiteralExpression(unwrap(recordExpression.arguments[0])))
        {
            fail(`unknown actual pane supplier ${file}`);
        }
        const object = unwrap(recordExpression.arguments[0]);
        const fields = new Map();
        for (const entry of object.properties)
        {
            if (!(ts.isShorthandPropertyAssignment(entry) || ts.isPropertyAssignment(entry)) || ts.isComputedPropertyName(entry.name)
                || fields.has(entry.name.text))
            {
                fail(`open pane record ${file}`);
            }
            fields.set(entry.name.text, ts.isShorthandPropertyAssignment(entry) ? entry.name : entry.initializer);
        }
        const effects = callbackEffects(callbackFile, callback);
        const label = [];
        walk(callback.body, (node) =>
        {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken
                && ts.isCallExpression(unwrap(node.left)) && path(unwrap(node.left).expression)?.slice(1).join('.') === 'slots.label'
                && path(node.right)?.slice(1).join('.') === 'props.label')
            {
                label.push(node);
            }
        });
        if (label.length !== 1 || path(unwrap(label[0].left).expression)?.[0] !== callback.parameters[0]?.name.text
            || path(label[0].right)?.[0] !== callback.parameters[0]?.name.text || unwrap(label[0].left).arguments.length
            || !fields.has('props') || !fields.has('slots'))
        {
            fail(`unknown pane label fallback ${callbackFile}`);
        }
        const props = fields.get('props');
        const slots = fields.get('slots');
        if (!ts.isIdentifier(props) || !ts.isIdentifier(slots))
        {
            fail(`opaque pane props/slots ${file}`);
        }
        const propsBinding = declaration(file, props.text, props);
        const slotsBinding = declaration(file, slots.text, slots);
        const propsCall = unwrap(propsBinding.initializer);
        const slotsCall = unwrap(slotsBinding.initializer);
        if (!ts.isCallExpression(propsCall) || propsCall.expression.getText() !== 'defineProps'
            || resolver.parse(file).imports.has('defineProps') || !ts.isCallExpression(slotsCall))
        {
            fail(`unbound pane props/slots source ${file}`);
        }
        const slotsImport = resolver.parse(file).imports.get(slotsCall.expression.getText());
        if (slotsImport?.specifier !== 'vue' || slotsImport.name !== 'useSlots' || slotsCall.arguments.length)
        {
            fail(`unknown pane slot supplier ${file}`);
        }
        if (call.slotInputs.unknown || Object.hasOwn(call.slotInputs.present, 'label') && call.slotInputs.present.label !== false)
        {
            fail(`provided/opaque pane label slot ${call.id}`);
        }
        const strings = callStrings(call, 'label');
        return proof({ kind: 'pane-label-supplier', ...input, labels: strings.branches, labelInput: strings.proofDigest,
            slot: { name: 'label', absent: true }, fields: [...fields].map(([name, node]) => ({ name, source: step(file, node) })),
            callbackEffects: effects, labelFallback: step(callbackFile, label[0]),
            requiredBinding: 'canonical provider/registry call-to-runtime-item identity; no uid or pane index inferred',
            renderProven: false }, [step(file, recordExpression), step(file, propsBinding), step(file, slotsBinding),
            step(callbackFile, label[0]), ...strings.steps]);
    }
    /** Link real registry/provider/inject/item and JSX supplier source edges. */
    function paneSourceChain({ ownerFile, registryCall, providerCall, paneFile, recordExpression,
        injectionCall, registerCall, navExpression, navFile, mapCall })
    {
        const steps = [];
        function owned(file, node)
        {
            const value = step(file, node);
            steps.push(value);
            return value;
        }
        function importedBinding(file, expression)
        {
            expression = unwrap(expression);
            if (!ts.isIdentifier(expression))
            {
                fail(`opaque provider key ${file}`);
            }
            const imported = resolver.parse(file).imports.get(expression.text);
            if (!imported)
            {
                fail(`unresolved provider key ${file}`);
            }
            resolver.assertImmutableBinding(file, expression.text);
            const targetFile = source.importFile(file, imported.specifier);
            const record = resolver.parse(targetFile);
            const declarationNode = declaration(targetFile, imported.name);
            resolver.assertImmutableBinding(targetFile, imported.name);
            const initializer = record.variables.get(imported.name);
            if (!initializer || initializer !== declarationNode.initializer)
            {
                fail(`unknown provider key binding ${file}`);
            }
            return { file: targetFile, name: imported.name, definition: owned(targetFile, declarationNode),
                initialization: owned(targetFile, initializer) };
        }
        for (const [file, node] of [[ownerFile, registryCall], [ownerFile, providerCall], [ownerFile, navExpression],
            [paneFile, injectionCall], [paneFile, registerCall], [paneFile, recordExpression], [navFile, mapCall]])
        {
            owned(file, node);
        }
        if (!ts.isCallExpression(registryCall) || !ts.isVariableDeclaration(registryCall.parent)
            || !ts.isObjectBindingPattern(registryCall.parent.name) || !ts.isCallExpression(providerCall)
            || providerCall.arguments.length !== 2 || !ts.isObjectLiteralExpression(unwrap(providerCall.arguments[1]))
            || !ts.isCallExpression(injectionCall) || injectionCall.arguments.length !== 1)
        {
            fail('unknown pane registry/provider source');
        }
        const providedKey = importedBinding(ownerFile, providerCall.arguments[0]);
        const injectedKey = importedBinding(paneFile, injectionCall.arguments[0]);
        if (controlDigest(providedKey.definition) !== controlDigest(injectedKey.definition))
        {
            fail('mismatched actual pane provider key');
        }
        const supplied = new Map();
        for (const entry of unwrap(providerCall.arguments[1]).properties)
        {
            if (!(ts.isShorthandPropertyAssignment(entry) || ts.isPropertyAssignment(entry))
                || ts.isComputedPropertyName(entry.name) || supplied.has(entry.name.text))
            {
                fail('open pane provider payload');
            }
            supplied.set(entry.name.text, ts.isShorthandPropertyAssignment(entry) ? entry.name : entry.initializer);
        }
        const bindings = new Map();
        for (const entry of registryCall.parent.name.elements)
        {
            if (!ts.isIdentifier(entry.name) || entry.dotDotDotToken || entry.initializer
                || entry.propertyName && !ts.isIdentifier(entry.propertyName))
            {
                fail('open registry result binding');
            }
            bindings.set(entry.name.text, entry.propertyName?.text ?? entry.name.text);
        }
        const injected = injectionCall.parent;
        if (!ts.isVariableDeclaration(injected) || !ts.isIdentifier(injected.name)
            || !ts.isCallExpression(registerCall) || registerCall.arguments.length !== 1
            || !ts.isPropertyAccessExpression(registerCall.expression)
            || registerCall.expression.expression.getText() !== injected.name.text)
        {
            fail('unbound pane registration source');
        }
        const registration = supplied.get(registerCall.expression.name.text);
        const pane = registerCall.arguments[0];
        if (!registration || !ts.isIdentifier(registration) || !bindings.has(registration.text)
            || !ts.isIdentifier(pane) || declaration(paneFile, pane.text, pane).initializer !== recordExpression)
        {
            fail('unbound pane item/registry argument');
        }
        navExpression = unwrap(navExpression);
        if (!ts.isPropertyAccessExpression(navExpression) || navExpression.name.text !== 'value'
            || !ts.isIdentifier(navExpression.expression) || !bindings.has(navExpression.expression.text)
            || !ts.isCallExpression(mapCall) || !ts.isPropertyAccessExpression(mapCall.expression)
            || mapCall.expression.name.text !== 'map' || mapCall.arguments.length !== 1
            || path(mapCall.expression.expression)?.length !== 2)
        {
            fail('unbound pane navigation supplier');
        }
        const attribute = navExpression.parent;
        const jsx = ts.isJsxExpression(attribute) && attribute.parent;
        if (!jsx || !ts.isJsxAttribute(jsx) || jsx.name.getText() !== path(mapCall.expression.expression)[1])
        {
            fail('mismatched pane navigation prop edge');
        }
        const target = resolver.resolveSourceFunction(ownerFile, registryCall.expression);
        const returned = ts.isBlock(target.fn.body) && target.fn.body.statements.at(-1);
        const returnedObject = returned && ts.isReturnStatement(returned) && unwrap(returned.expression);
        if (!returnedObject || !ts.isObjectLiteralExpression(returnedObject))
        {
            fail('open registry result source');
        }
        const registryMembers = new Map();
        for (const entry of returnedObject.properties)
        {
            if (!(ts.isShorthandPropertyAssignment(entry) || ts.isPropertyAssignment(entry))
                || ts.isComputedPropertyName(entry.name) || registryMembers.has(entry.name.text))
            {
                fail('open registry result object');
            }
            registryMembers.set(entry.name.text, ts.isShorthandPropertyAssignment(entry) ? entry.name : entry.initializer);
        }
        const registerMember = registryMembers.get(bindings.get(registration.text));
        const childrenMember = registryMembers.get(bindings.get(navExpression.expression.text));
        if (!registerMember || !childrenMember)
        {
            fail('missing actual registry suppliers');
        }
        const register = resolver.resolveSourceFunction(target.file, registerMember);
        const registryEffects = callbackEffects(register.file, register.fn);
        const { fn: closureAST, ...supplierClosure } = supplier(ownerFile, registryCall.expression);
        // Raw ASTs (with parent cycles) remain outside proof identities.
        owned(supplierClosure.file, closureAST);
        return proof({ kind: 'pane-provider-source-chain', key: providedKey,
            registry: owned(target.file, target.fn), register: owned(register.file, register.fn),
            item: owned(paneFile, recordExpression), children: owned(target.file, childrenMember),
            suppliedNavigation: owned(ownerFile, navExpression), map: owned(navFile, mapCall),
            registryEffects, itemEffects: callbackEffects(navFile, unwrap(mapCall.arguments[0])),
            supplierClosure,
            requiredBinding: 'actual mounted registry membership, vm.subTree/component.uid ordering and provider ancestry',
            renderProven: false }, steps);
    }
    /** Derive the actual class helper's conditional writes, never trust VNode types. */
    function classMutation(file, fn)
    {
        const effects = callbackEffects(file, fn);
        if (fn.parameters.length !== 2 || fn.modifiers?.length || !ts.isBlock(fn.body) || fn.body.statements.length !== 1)
        {
            fail(`unknown class mutation flow ${file}`);
        }
        const root = fn.parameters[0].name.text;
        const cls = fn.parameters[1].name.text;
        const guard = fn.body.statements[0];
        const body = ts.isIfStatement(guard) && ts.isBlock(guard.thenStatement) ? guard.thenStatement.statements : [];
        const init = body[0];
        const assign = body[1] && ts.isExpressionStatement(body[1]) ? body[1].expression : null;
        const missing = init && ts.isIfStatement(init) && unwrap(init.expression);
        const initialize = init && ts.isIfStatement(init) && ts.isBlock(init.thenStatement)
            && init.thenStatement.statements.length === 1 && ts.isExpressionStatement(init.thenStatement.statements[0])
            ? init.thenStatement.statements[0].expression : null;
        const value = assign && ts.isBinaryExpression(assign) && unwrap(assign.right);
        const parts = value && ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
            ? unwrap(value.expression.expression) : null;
        if (!ts.isIfStatement(guard) || guard.elseStatement || guard.expression.getText() !== root || body.length !== 2
            || !missing || !ts.isPrefixUnaryExpression(missing) || missing.operator !== ts.SyntaxKind.ExclamationToken
            || path(missing.operand)?.join('.') !== `${root}.props` || init.elseStatement
            || !initialize || !ts.isBinaryExpression(initialize) || initialize.operatorToken.kind !== ts.SyntaxKind.EqualsToken
            || path(initialize.left)?.join('.') !== `${root}.props` || !ts.isObjectLiteralExpression(unwrap(initialize.right))
            || unwrap(initialize.right).properties.length || !assign || !ts.isBinaryExpression(assign)
            || assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken || path(assign.left)?.join('.') !== `${root}.props.class`
            || !parts || !ts.isArrayLiteralExpression(parts) || parts.elements.length !== 2
            || path(parts.elements[0])?.join('.') !== `${root}.props.class` || parts.elements[1].getText() !== cls
            || value.expression.name.text !== 'join' || value.arguments.length !== 1 || !ts.isStringLiteral(value.arguments[0])
            || value.arguments[0].text !== ' ' || effects.writes.length !== 2 || effects.calls.length !== 1)
        {
            fail(`unclosed class mutation effects ${file}`);
        }
        return proof({ kind: 'class-mutation-contract', effects, writes: effects.writes,
            conditions: [condition(file, guard.expression, 'if'), condition(file, missing, 'if')],
            sourceWritePaths: effects.writes.map((entry) => entry.path),
            requiredBinding: 'actual element/own plain props identity, primitive prior class value and closed class argument; implicit join conversions grant no purity',
            renderProven: false }, [step(file, fn), step(file, initialize), step(file, assign)]);
    }
    /** Evaluate a bounded primitive closure, using only its original AST. */
    function primitiveFunction(file, fn, values)
    {
        step(file, fn);
        if (!ts.isBlock(fn.body) || fn.modifiers?.length || fn.asteriskToken)
        {
            fail(`opaque primitive closure ${file}`);
        }
        const bindings = new Map();
        const used = [];
        fn.parameters.forEach((parameter, index) =>
        {
            if (!ts.isIdentifier(parameter.name))
            {
                fail(`opaque primitive parameter ${file}`);
            }
            bindings.set(parameter.name.text, parameter.dotDotDotToken ? values.slice(index) : values[index]);
        });
        const active = new Set();
        function evaluate(node)
        {
            node = unwrap(node);
            used.push(step(file, node));
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            {
                return node.text;
            }
            if (ts.isNumericLiteral(node))
            {
                return Number(node.text);
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
                if (bindings.has(node.text))
                {
                    return bindings.get(node.text);
                }
                if (active.has(node.text))
                {
                    fail(`cyclic primitive closure ${file}`);
                }
                const binding = declaration(file, node.text, node);
                if (!ts.isVariableDeclaration(binding) || !(binding.parent.flags & ts.NodeFlags.Const) || !binding.initializer)
                {
                    fail(`opaque captured primitive ${file}#${node.text}`);
                }
                resolver.assertImmutableBinding(file, node.text);
                active.add(node.text);
                const value = evaluate(binding.initializer);
                active.delete(node.text);
                return value;
            }
            if (ts.isConditionalExpression(node))
            {
                return evaluate(node.condition) ? evaluate(node.whenTrue) : evaluate(node.whenFalse);
            }
            if (ts.isPropertyAccessExpression(node) && node.name.text === 'length')
            {
                const value = evaluate(node.expression);
                if (Array.isArray(value) || typeof value === 'string')
                {
                    return value.length;
                }
            }
            if (ts.isElementAccessExpression(node))
            {
                const value = evaluate(node.expression);
                const index = evaluate(node.argumentExpression);
                if (Array.isArray(value) && Number.isInteger(index) && index >= 0 && index < value.length)
                {
                    return value[index];
                }
            }
            if (ts.isBinaryExpression(node))
            {
                const left = evaluate(node.left);
                if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
                {
                    return left && evaluate(node.right);
                }
                if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
                {
                    return left || evaluate(node.right);
                }
                const right = evaluate(node.right);
                if (node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
                    && typeof left === 'number' && typeof right === 'number')
                {
                    return left >= right;
                }
            }
            if (ts.isTemplateExpression(node))
            {
                let value = node.head.text;
                for (const span of node.templateSpans)
                {
                    const item = evaluate(span.expression);
                    if (!['string', 'number', 'boolean'].includes(typeof item))
                    {
                        fail(`opaque primitive interpolation ${file}`);
                    }
                    value += String(item) + span.literal.text;
                }
                return value;
            }
            fail(`opaque primitive expression ${file}:${node.getStart()}`);
        }
        const statements = fn.body.statements;
        if (!statements.length || !ts.isReturnStatement(statements.at(-1)) || !statements.at(-1).expression)
        {
            fail(`unknown primitive closure return ${file}`);
        }
        for (const statement of statements.slice(0, -1))
        {
            if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const))
            {
                fail(`effectful primitive closure ${file}`);
            }
            for (const binding of statement.declarationList.declarations)
            {
                if (!ts.isIdentifier(binding.name) || !binding.initializer || bindings.has(binding.name.text))
                {
                    fail(`opaque primitive local ${file}`);
                }
                bindings.set(binding.name.text, evaluate(binding.initializer));
            }
        }
        const value = evaluate(statements.at(-1).expression);
        if (!['string', 'number', 'boolean'].includes(typeof value))
        {
            fail(`nonprimitive closure result ${file}`);
        }
        return { value, steps: [step(file, fn), ...used] };
    }
    function classArgument(file, expression, bindings)
    {
        expression = unwrap(expression);
        if (ts.isStringLiteral(expression))
        {
            return { value: expression.text, steps: [step(file, expression)] };
        }
        if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)
            || !ts.isIdentifier(expression.expression.expression) || expression.arguments.some((argument) => !scalar(argument)))
        {
            fail(`opaque class argument ${file}`);
        }
        const receiver = declaration(file, expression.expression.expression.text, expression);
        resolver.assertImmutableBinding(file, receiver.name.text);
        for (const { ast } of resolver.parse(file).scripts)
        {
            walk(ast, (node) =>
            {
                if (!ts.isIdentifier(node) || node.text !== receiver.name.text || node === receiver.name
                    || ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                {
                    return;
                }
                if ((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
                    && node.parent.expression === node)
                {
                    return;
                }
                fail(`escaped class supplier identity ${file}`);
            });
        }
        const initialization = unwrap(receiver.initializer);
        if (!initialization || !ts.isCallExpression(initialization))
        {
            fail(`opaque class supplier ${file}`);
        }
        const target = boundFunction(file, initialization.expression, bindings);
        const returned = ts.isBlock(target.fn.body) && target.fn.body.statements.at(-1);
        const object = returned && ts.isReturnStatement(returned) && unwrap(returned.expression);
        if (!object || !ts.isObjectLiteralExpression(object))
        {
            fail(`open class supplier ${file}`);
        }
        const properties = object.properties.filter((entry) => entry.name?.text === expression.expression.name.text);
        if (properties.length !== 1 || !(ts.isShorthandPropertyAssignment(properties[0]) || ts.isPropertyAssignment(properties[0])))
        {
            fail(`unknown class supplier member ${file}`);
        }
        const member = ts.isShorthandPropertyAssignment(properties[0]) ? properties[0].name : properties[0].initializer;
        const closure = resolver.resolveSourceFunction(target.file, member);
        const values = expression.arguments.map((argument) =>
        {
            argument = unwrap(argument);
            return ts.isStringLiteral(argument) ? argument.text : ts.isNumericLiteral(argument) ? Number(argument.text)
                : argument.kind === ts.SyntaxKind.TrueKeyword ? true : argument.kind === ts.SyntaxKind.FalseKeyword ? false : null;
        });
        const result = primitiveFunction(closure.file, closure.fn, values);
        if (typeof result.value !== 'string')
        {
            fail(`nonstring class argument ${file}`);
        }
        return { ...result, steps: [step(file, expression), step(file, receiver), step(target.file, target.fn), ...result.steps] };
    }
    function constructorOrigin(file, call)
    {
        step(file, call);
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression))
        {
            fail(`opaque collection constructor ${file}`);
        }
        const record = resolver.parse(file);
        const imported = record.imports.get(call.expression.text);
        if (!imported)
        {
            fail(`unbound canonical collection constructor ${file}`);
        }
        resolver.assertImmutableBinding(file, call.expression.text);
        // Reuse a constructor classified by the ORIGINAL graph, matched back
        // to its actual script call and immutable import binding. No package,
        // function name, VNode annotation or independent classifier admits it.
        for (const reference of source.nodes.values())
        {
            if (reference.file !== file || reference.sourceSyntax?.kind !== 'vue-vnode')
            {
                continue;
            }
            const originals = [];
            for (const { ast } of record.scripts)
            {
                walk(ast, (node) =>
                {
                    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments[1]
                        && node.arguments[1].getStart() + 1 === reference.sourceSyntax.markerOffset
                        && node.getStart() === reference.offset && controlDigest(node.getText()) === reference.sourceDigest
                        && record.imports.get(node.expression.text) === imported)
                    {
                        originals.push(node);
                    }
                });
            }
            if (originals.length === 1)
            {
                return proof({ kind: 'canonical-constructor-source', callNode: reference.id,
                    sourceDigest: reference.sourceDigest, imported, renderProven: false }, [step(file, call), step(file, originals[0])]);
            }
        }
        fail(`unbound canonical collection constructor ${file}#${call.expression.text}`);
    }
    /** Source binding for a known constructor's actual props argument. */
    function bindClass(file, mutationCall, element, bindings = new Map())
    {
        step(file, mutationCall);
        element = unwrap(element);
        step(file, element);
        if (!ts.isCallExpression(mutationCall) || mutationCall.arguments.length !== 2
            || !ts.isCallExpression(element) || element.arguments.length < 2 || element.arguments.length > 3)
        {
            fail(`opaque class element binding ${file}`);
        }
        const props = unwrap(element.arguments[1]);
        if (!ts.isObjectLiteralExpression(props) || props.properties.some((entry) => !ts.isPropertyAssignment(entry)
            || ts.isComputedPropertyName(entry.name) || ['__proto__', 'constructor', 'prototype'].includes(entry.name.text))
            || new Set(props.properties.map((entry) => entry.name.text)).size !== props.properties.length)
        {
            fail(`opaque/mutated class props supplier ${file}`);
        }
        const priorClass = props.properties.find((entry) => entry.name.text === 'class');
        if (priorClass && !scalar(priorClass.initializer))
        {
            fail(`opaque prior class conversion ${file}`);
        }
        const constructor = constructorOrigin(file, element);
        // This is an argument-source binding, not an assertion that an opaque
        // constructor returns this object or that a runtime VNode is writable.
        const target = boundFunction(file, mutationCall.expression, bindings);
        const contract = classMutation(target.file, target.fn);
        const argument = classArgument(file, mutationCall.arguments[1], bindings);
        return proof({ kind: 'class-argument-binding', helper: contract.proofDigest, classValue: argument.value,
            target: step(file, mutationCall.arguments[0]), constructor: step(file, element), constructorSource: constructor,
            props: step(file, props),
            fields: props.properties.map((entry) => ({ name: entry.name.text, source: step(file, entry.initializer) })),
            priorClass: priorClass ? { source: step(file, priorClass.initializer), expression: priorClass.initializer.getText() }
                : { absentOwnArgumentField: true },
            requiredBinding: 'canonical VNode constructor result-to-own-props identity and original class conversion; AST argument source alone grants no runtime identity',
            renderProven: false }, [step(file, mutationCall), step(file, element), ...constructor.steps, ...contract.steps, ...argument.steps]);
    }
    /** Ordered two-container assembly over every closed actual input branch. */
    function partitionCollection(file, loop, call, bindings = new Map())
    {
        canonicalCall(call);
        step(file, loop);
        if (call.definition !== file || !ts.isCallExpression(loop) || !ts.isPropertyAccessExpression(loop.expression)
            || loop.expression.name.text !== 'forEach' || !ts.isIdentifier(loop.expression.expression) || loop.arguments.length !== 1)
        {
            fail(`unknown ordered partition ${file}`);
        }
        const components = declaration(file, loop.expression.expression.text, loop);
        const map = unwrap(components.initializer);
        const trim = map && ts.isCallExpression(map) && map.arguments.length === 1 && unwrap(map.arguments[0]);
        const split = map && ts.isCallExpression(map) && ts.isPropertyAccessExpression(map.expression) && unwrap(map.expression.expression);
        if (!map || !ts.isCallExpression(map) || !ts.isPropertyAccessExpression(map.expression) || map.expression.name.text !== 'map'
            || !trim || !ts.isArrowFunction(trim) || trim.parameters.length !== 1 || !ts.isIdentifier(trim.parameters[0].name)
            || trim.parameters[0].initializer || trim.parameters[0].dotDotDotToken || trim.modifiers?.length
            || !ts.isCallExpression(unwrap(trim.body)) || unwrap(trim.body).arguments.length
            || path(unwrap(trim.body).expression)?.join('.') !== `${trim.parameters[0].name.text}.trim`
            || !split || !ts.isCallExpression(split) || !ts.isPropertyAccessExpression(split.expression)
            || split.expression.name.text !== 'split' || split.arguments.length !== 1 || !ts.isStringLiteral(split.arguments[0])
            || !path(split.expression.expression) || path(split.expression.expression).length !== 2)
        {
            fail(`opaque ordered partition keys ${file}`);
        }
        const property = path(split.expression.expression)[1];
        const strings = callStrings(call, property);
        if (!ts.isVariableDeclaration(components) || !(components.parent.flags & ts.NodeFlags.Const))
        {
            fail(`mutable partition keys ${file}`);
        }
        resolver.assertImmutableBinding(file, components.name.text);
        const keyUses = new Set([components.name, loop.expression.expression]);
        walk(components.parent.parent.parent, (node) =>
        {
            if (ts.isNewExpression(node) && node.expression.getText() === 'Set' && node.arguments?.length === 1
                && node.arguments[0].getText() === components.name.text)
            {
                keyUses.add(node.arguments[0]);
            }
        });
        if (keyUses.size > 2)
        {
            for (const { ast } of resolver.parse(file).scripts)
            {
                walk(ast, (node) =>
                {
                    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                        || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.getText() === 'Set')
                    {
                        fail(`shadowed partition key constructor ${file}`);
                    }
                });
            }
            if (resolver.parse(file).imports.has('Set'))
            {
                fail(`shadowed partition key constructor ${file}`);
            }
        }
        readonlyReferences(file, components.name.text, keyUses);
        const propsName = path(split.expression.expression)[0];
        const propsBinding = declaration(file, propsName, split);
        if (!ts.isParameter(propsBinding) || propsBinding.parent.name?.getText() !== 'setup'
            || propsBinding.parent.parameters[0] !== propsBinding)
        {
            fail(`unbound partition props parameter ${file}`);
        }
        let inSetup = false;
        for (let owner = loop.parent; owner; owner = owner.parent)
        {
            inSetup ||= owner === propsBinding.parent.body;
        }
        if (!inSetup)
        {
            fail(`out-of-scope partition props parameter ${file}`);
        }
        const primitiveReads = new Set();
        walk(propsBinding.parent.body, (node) =>
        {
            const parts = ts.isCallExpression(node) && path(node.expression);
            if (parts?.length === 3 && parts[0] === propsName && parts[1] === property && ['split', 'includes'].includes(parts[2])
                && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && !node.questionDotToken)
            {
                const member = unwrap(node.expression);
                primitiveReads.add(unwrap(unwrap(member.expression).expression));
            }
        });
        const inputClosure = rootClosure(file, propsBinding.parent, 0, property, bindings, null, primitiveReads);
        if (!inputClosure.readonly)
        {
            fail(`mutated/escaped partition input ${file}#${property}`);
        }
        const fn = unwrap(loop.arguments[0]);
        if (!ts.isArrowFunction(fn) || fn.modifiers?.length || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)
            || fn.parameters[0].initializer || fn.parameters[0].dotDotDotToken || !ts.isBlock(fn.body) || fn.body.statements.length !== 2)
        {
            fail(`effectful ordered partition callback ${file}`);
        }
        const item = fn.parameters[0].name.text;
        const delimiterGuard = fn.body.statements[0];
        const route = fn.body.statements[1];
        const delimiter = ts.isIfStatement(delimiterGuard) && unwrap(delimiterGuard.expression);
        const delimiterBody = ts.isIfStatement(delimiterGuard) && ts.isBlock(delimiterGuard.thenStatement) ? delimiterGuard.thenStatement.statements : [];
        const stateWrite = delimiterBody[0] && ts.isExpressionStatement(delimiterBody[0]) && unwrap(delimiterBody[0].expression);
        if (!delimiter || !ts.isBinaryExpression(delimiter) || delimiter.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
            || delimiter.left.getText() !== item || !ts.isStringLiteral(delimiter.right) || delimiterGuard.elseStatement
            || delimiterBody.length !== 2 || !stateWrite || !ts.isBinaryExpression(stateWrite)
            || stateWrite.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(stateWrite.left)
            || stateWrite.right.kind !== ts.SyntaxKind.TrueKeyword || !ts.isReturnStatement(delimiterBody[1]) || delimiterBody[1].expression
            || !ts.isIfStatement(route) || !route.elseStatement || !ts.isPrefixUnaryExpression(unwrap(route.expression))
            || unwrap(route.expression).operator !== ts.SyntaxKind.ExclamationToken
            || unwrap(route.expression).operand.getText() !== stateWrite.left.text)
        {
            fail(`order-sensitive partition flow ${file}`);
        }
        const state = declaration(file, stateWrite.left.text, stateWrite.left);
        if (!ts.isVariableDeclaration(state) || state.parent.flags & ts.NodeFlags.Const || state.initializer?.kind !== ts.SyntaxKind.FalseKeyword)
        {
            fail(`opaque partition state ${file}`);
        }
        function push(statement)
        {
            if (ts.isBlock(statement) && statement.statements.length === 1)
            {
                statement = statement.statements[0];
            }
            const operation = ts.isExpressionStatement(statement) && unwrap(statement.expression);
            if (!operation || !ts.isCallExpression(operation) || operation.arguments.length !== 1
                || !ts.isPropertyAccessExpression(operation.expression) || operation.expression.name.text !== 'push'
                || !ts.isIdentifier(operation.expression.expression) || !ts.isElementAccessExpression(unwrap(operation.arguments[0]))
                || unwrap(operation.arguments[0]).argumentExpression.getText() !== item)
            {
                fail(`unknown partition element write ${file}`);
            }
            return operation;
        }
        const leftPush = push(route.thenStatement);
        const rightPush = push(route.elseStatement);
        const leftName = leftPush.expression.expression.text;
        const rightName = rightPush.expression.expression.text;
        if (leftName === rightName || unwrap(leftPush.arguments[0]).expression.getText() !== unwrap(rightPush.arguments[0]).expression.getText())
        {
            fail(`ambiguous partition destinations ${file}`);
        }
        const table = tableEntries(file, unwrap(leftPush.arguments[0]).expression);
        const scope = state.parent.parent.parent;
        const classCalls = [];
        const wrappers = [];
        const constructorEdges = [];
        const guardSteps = [];
        for (const statement of scope.statements)
        {
            if (statement.getStart() < loop.getStart() && ts.isIfStatement(statement))
            {
                const returns = [];
                walk(statement.thenStatement, (node) =>
                {
                    if (ts.isReturnStatement(node))
                    {
                        returns.push(node);
                    }
                });
                if (returns.length)
                {
                    guardSteps.push(condition(file, statement.expression, 'else'));
                }
            }
        }
        for (const name of [leftName, rightName])
        {
            const array = declaration(file, name, loop);
            if (!ts.isVariableDeclaration(array) || !(array.parent.flags & ts.NodeFlags.Const)
                || !ts.isArrayLiteralExpression(unwrap(array.initializer)) || unwrap(array.initializer).elements.length)
            {
                fail(`nonfresh partition collection ${file}#${name}`);
            }
            resolver.assertImmutableBinding(file, name);
            walk(scope, (node) =>
            {
                if (!ts.isIdentifier(node) || node.text !== name || node === array.name)
                {
                    return;
                }
                const parent = node.parent;
                if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'length')
                {
                    return;
                }
                if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'push'
                    && ts.isCallExpression(parent.parent))
                {
                    const operation = parent.parent;
                    if (operation === leftPush || operation === rightPush)
                    {
                        return;
                    }
                    if (name !== leftName || operation.getStart() < loop.getStart() || operation.arguments.length !== 1
                        || !ts.isIdentifier(operation.arguments[0]) || !ts.isExpressionStatement(operation.parent))
                    {
                        fail(`mutated partition collection ${file}#${name}`);
                    }
                    const wrapper = declaration(file, operation.arguments[0].text, operation);
                    const constructor = unwrap(wrapper.initializer);
                    if (!constructor || !ts.isCallExpression(constructor) || constructor.arguments.length !== 3
                        || constructor.arguments[2].getText() !== rightName || constructor.getStart() > loop.getStart())
                    {
                        fail(`opaque partition wrapper ${file}`);
                    }
                    wrappers.push({ node: constructor, operation, conditions: enclosingConditions(file, operation, scope) });
                    return;
                }
                if (ts.isElementAccessExpression(parent) && parent.expression === node)
                {
                    // The only borrowed array members are actual class helper
                    // arguments and the array's own length used in last-index.
                    if (parent.parent && ts.isCallExpression(parent.parent) && parent.parent.arguments[0] === parent
                        && parent.parent.getStart() > loop.getStart())
                    {
                        const index = unwrap(parent.argumentExpression);
                        const first = ts.isNumericLiteral(index) && index.text === '0';
                        const last = ts.isBinaryExpression(index) && index.operatorToken.kind === ts.SyntaxKind.MinusToken
                            && path(index.left)?.join('.') === `${name}.length` && ts.isNumericLiteral(index.right) && index.right.text === '1';
                        if (!first && !last)
                        {
                            fail(`opaque partition class index ${file}`);
                        }
                        classCalls.push({ node: parent.parent, name, position: first ? 'first' : 'last',
                            conditions: enclosingConditions(file, parent.parent, scope) });
                        return;
                    }
                }
                if (ts.isCallExpression(parent) && parent.arguments[2] === node)
                {
                    constructorEdges.push({ array: name, source: constructorOrigin(file, parent), children: step(file, node) });
                    return;
                }
                fail(`escaped/mutated partition collection ${file}#${name}`);
            });
        }
        walk(scope, (node) =>
        {
            if (ts.isBinaryExpression(node) && path(node.left)?.[0] === state.name.text
                && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                && node !== stateWrite)
            {
                fail(`mutated partition state ${file}`);
            }
            if (ts.isIdentifier(node) && node.text === state.name.text && (ts.isCallExpression(node.parent)
                || ts.isVariableDeclaration(node.parent) && node.parent.initializer === node))
            {
                fail(`escaped partition state ${file}`);
            }
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
                && path(node.operand)?.[0] === state.name.text || ts.isDeleteExpression(node) && path(node.expression)?.[0] === state.name.text)
            {
                fail(`mutated partition state ${file}`);
            }
        });
        const branches = strings.branches.map((branch) =>
        {
            const left = [];
            const right = [];
            let switched = false;
            const transitions = [];
            for (const [index, key] of branch.value.split(split.arguments[0].text).map((key) => key.trim()).entries())
            {
                if (key === delimiter.right.text)
                {
                    switched = true;
                    transitions.push({ index, key, write: step(file, stateWrite), condition: condition(file, delimiter, 'if') });
                    continue;
                }
                if (!table.entries.has(key))
                {
                    fail(`unknown supplied partition key ${call.id}#${key}`);
                }
                let node = table.entries.get(key);
                let slot = null;
                const supplierNode = node;
                if (ts.isBinaryExpression(unwrap(node)) && unwrap(node).operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
                {
                    const { node: fallback, ...identity } = slotFallback(file, node, call);
                    node = fallback;
                    slot = identity;
                }
                (switched ? right : left).push({ key, node, supplier: step(file, supplierNode), slot, index });
            }
            const mutations = [];
            for (const operation of classCalls)
            {
                const items = operation.name === leftName ? left : right;
                const item = operation.position === 'first' ? items[0] : items.at(-1);
                // Undefined receives no writes under the authored first guard.
                if (!item || item.node.kind === ts.SyntaxKind.NullKeyword)
                {
                    continue;
                }
                mutations.push({ key: item.key, index: item.index, position: operation.position,
                    conditions: operation.conditions, binding: bindClass(file, operation.node, item.node, bindings) });
            }
            return { conditions: [...guardSteps, ...branch.conditions], transitions, left, right, mutations,
                wrappers: switched && right.length ? wrappers : [] };
        });
        const payload = branches.map((branch) => ({ ...branch, left: branch.left.map((item) => ({ ...item, node: step(file, item.node) })),
            right: branch.right.map((item) => ({ ...item, node: step(file, item.node) })),
            wrappers: branch.wrappers.map((item) => ({ source: step(file, item.node), push: step(file, item.operation), conditions: item.conditions })) }));
        return { ...proof({ kind: 'ordered-partition-plan', callNode: call.id, input: strings.proofDigest, inputClosure,
            branches: payload, constructorEdges, callbackEffects: callbackEffects(file, fn), renderProven: false },
        [step(file, loop), step(file, components), step(file, table.declaration), step(file, state), ...strings.steps, ...inputClosure.steps]), outputs: branches };
    }
    return { collect, callbackEffects, computedBranches, emptyComputedCall, supplier, parameterClosure, bindingClosure,
        callStrings, keyedMap, paneLabel, paneSourceChain, classMutation, bindClass, partitionCollection, slotFallback };
}
