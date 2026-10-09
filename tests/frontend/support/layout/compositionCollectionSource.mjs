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
        const record = resolver.parse(file);
        const script = record.scripts.find(({ ast }) => ast === node?.getSourceFile());
        if (!script)
        {
            fail(`foreign AST node ${file}`);
        }
        return { file, offset: script.offset + node.getStart(), kind: 'script-source', digest: controlDigest(node.getText()) };
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
    function functionBody(file, expression, seen = new Set())
    {
        expression = unwrap(expression);
        step(file, expression);
        if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
        {
            return { file, fn: expression };
        }
        if (!ts.isIdentifier(expression))
        {
            fail(`opaque callback ${file}:${expression.getStart()}`);
        }
        const identity = `${file}#${expression.text}`;
        if (seen.has(identity))
        {
            fail(`cyclic callback ${identity}`);
        }
        const imported = resolver.parse(file).imports.get(expression.text);
        if (imported)
        {
            const bindings = [];
            resolver.parse(file).scripts.forEach(({ ast }) => walk(ast, (node) =>
            {
                if ((ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isVariableDeclaration(node)
                    || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name?.text === expression.text)
                {
                    bindings.push(node);
                }
            }));
            if (bindings.length !== 1 || !(ts.isImportSpecifier(bindings[0]) || ts.isImportClause(bindings[0])))
            {
                fail(`shadowed callback import ${identity}`);
            }
            readonlyReferences(file, expression.text, new Set([expression]));
            const target = source.importFile(file, imported.specifier);
            const exported = resolver.exportsOf(target).get(imported.name);
            if (!exported?.file || exported.ambiguous || exported.unresolved)
            {
                fail(`unknown callback export ${identity}`);
            }
            const owner = resolver.parse(exported.file);
            const matches = [];
            owner.scripts.forEach(({ ast }) => walk(ast, (node) =>
            {
                if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.text === exported.name)
                {
                    matches.push(node);
                }
            }));
            if (matches.length !== 1)
            {
                fail(`ambiguous callback export ${identity}`);
            }
            const fn = ts.isFunctionDeclaration(matches[0]) ? matches[0] : unwrap(matches[0].initializer);
            if (!fn || !ts.isFunctionLike(fn))
            {
                fail(`unknown callback body ${identity}`);
            }
            return { file: exported.file, fn, importSteps: [step(file, expression), step(exported.file, matches[0])] };
        }
        const found = declaration(file, expression.text, expression);
        if (ts.isFunctionDeclaration(found))
        {
            return { file, fn: found };
        }
        if (!ts.isVariableDeclaration(found) || !(found.parent.flags & ts.NodeFlags.Const))
        {
            fail(`mutable callback ${identity}`);
        }
        return functionBody(file, found.initializer, new Set([...seen, identity]));
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
        const constructors = [];
        resolver.parse(target.file).scripts.forEach(({ ast }) => walk(ast, (node) =>
        {
            if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node))
                && node.name?.text === computed.expression.text)
            {
                constructors.push(node);
            }
        }));
        if (constructors.length)
        {
            fail(`shadowed computed constructor ${target.file}`);
        }
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
        readonlyReferences(file, propsName, new Set([props.name, call.arguments[0]]));
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
            providedBranch: branches.providedBranch, effects: branches.effects, callback: step(target.file, callback) }, steps);
    }
    /** Resolve actual supplier definitions for review; effects stay explicit. */
    function supplier(file, expression)
    {
        step(file, expression);
        const target = functionBody(file, expression);
        return { ...target, effects: callbackEffects(target.file, target.fn), steps: [step(file, expression),
            ...(target.importSteps ?? []), step(target.file, target.fn)] };
    }
    return { collect, callbackEffects, computedBranches, emptyComputedCall, supplier };
}
