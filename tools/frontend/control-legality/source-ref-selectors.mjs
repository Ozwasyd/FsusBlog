import { controlDigest } from './source.mjs';

/** Walk canonical Vue nodes; parse expressions only through the owner's parser. */
export function collectSelectorTemplateExpressions(record, expression)
{
    const expressions = [];
    function visit(node)
    {
        if (node.type === 5)
        {
            expressions.push(expression(node.content.content, record.file));
        }
        for (const prop of node.props ?? [])
        {
            if (prop.type !== 7)
            {
                continue;
            }
            if (prop.exp)
            {
                expressions.push(expression(prop.exp.content, record.file));
            }
            if (prop.arg && !prop.arg.isStatic)
            {
                expressions.push(expression(prop.arg.content, record.file));
            }
        }
        (node.children ?? []).forEach(visit);
    }
    if (record.template)
    {
        visit(record.template.ast);
    }
    return expressions;
}

/**
 * A bounded extension of the caller's canonical resolver. Inputs are its actual
 * AST nodes; expression parses, template scopes and graph reachability belong to
 * compositionSource. No type annotation constrains a runtime value here.
 *
 * expression is source.expression from the existing composition owner. Every
 * template expression is visited, including event, ref and argument callbacks.
 * Script facts use resolver.sourceStep; synthetic template ASTs are recorded as
 * caller expression inputs and never masquerade as original source steps.
 */
export function createFiniteRefSelectorSource({ resolver, expression: parseExpression })
{
    const { ts } = resolver;
    const fail = (message) =>
    {
        throw new Error(`[control-legality] finite selector: ${message}`);
    };
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    if (!resolver.sourceStep || !resolver.resolveSourceFunction || !resolver.assertImmutableBinding)
    {
        fail('canonical module context is required');
    }
    const walk = (node, visit) =>
    {
        visit(node);
        ts.forEachChild(node, (child) => walk(child, visit));
    };
    const declarationName = (node) => (ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) ? node.name : null;
    function binding(file, identifier)
    {
        const name = identifier.text;
        for (let scope = identifier.parent; scope; scope = scope.parent)
        {
            const matches = [];
            if (ts.isFunctionLike(scope))
            {
                matches.push(...scope.parameters.filter((parameter) => parameter.name.getText() === name));
            }
            if (ts.isBlock(scope) || ts.isSourceFile(scope))
            {
                for (const statement of scope.statements)
                {
                    if (ts.isVariableStatement(statement))
                    {
                        matches.push(...statement.declarationList.declarations.filter((entry) => entry.name.getText() === name));
                    }
                    else if (declarationName(statement)?.getText() === name)
                    {
                        matches.push(statement);
                    }
                }
            }
            if (matches.length)
            {
                if (matches.length !== 1)
                {
                    fail(`ambiguous binding ${file}#${name}`);
                }
                return matches[0];
            }
        }
        // Template expression ASTs have their own SourceFile, so use only the
        // actual top-level declaration, never a same-named nested declaration.
        const matches = resolver.parse(file).scripts.flatMap(({ ast }) => ast.statements.filter(ts.isVariableStatement)
            .flatMap((statement) => statement.declarationList.declarations.filter((entry) => entry.name.getText() === name)));
        if (matches.length > 1)
        {
            fail(`ambiguous template binding ${file}#${name}`);
        }
        return matches[0] ?? null;
    }
    const assignment = (node) => ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    function root(node)
    {
        node = unwrap(node);
        while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
        {
            node = unwrap(node.expression);
        }
        return node;
    }
    const scalar = (value) => value.kind === 'literal';
    const literal = (value) => ({ kind: 'literal', value });
    const forbiddenKey = (key) => ['__proto__', 'prototype', 'constructor'].includes(key);

    function run(file, expression, { templateRefs = false, itemBindings = new Map(), shadowedNames = new Set(), selectorOffset = null } = {})
    {
        const inputRecord = resolver.parse(file);
        let templateContext = null;
        if (inputRecord.template)
        {
            const matches = [];
            function context(node, scopes = [])
            {
                const next = [...scopes, ...(node.props ?? []).filter((prop) => prop.type === 7 && ['for', 'slot'].includes(prop.name))];
                if (node.type === 1 && node.tag === 'component')
                {
                    for (const prop of node.props)
                    {
                        if (prop.type === 7 && prop.name === 'bind' && prop.arg?.isStatic && prop.arg.content === 'is'
                            && prop.exp?.content.trim() === expression.getText()
                            && (selectorOffset === null || selectorOffset === inputRecord.template.offset + node.loc.start.offset))
                        {
                            matches.push({ node, prop, scopes: next });
                        }
                    }
                }
                (node.children ?? []).forEach((child) => context(child, next));
            }
            context(inputRecord.template.ast);
            if (matches.length !== 1)
            {
                fail('selector requires an exact canonical template occurrence');
            }
            const match = matches[0];
            const scopes = new Map();
            for (const scope of match.scopes)
            {
                if (scope.name === 'slot')
                {
                    fail('slot scope requires its separate canonical supplier proof');
                }
                const parsed = scope.forParseResult;
                if (!parsed?.source)
                {
                    fail('unknown canonical iterable scope');
                }
                for (const kind of ['value', 'key', 'index'])
                {
                    const name = parsed[kind]?.content;
                    if (!name)
                    {
                        continue;
                    }
                    // Bounded identifier bindings only; destructuring belongs to
                    // the owner's existing pattern/context analysis.
                    if (!/^[$A-Z_a-z][$\w]*$/.test(name))
                    {
                        fail('unknown iterable binding pattern');
                    }
                    shadowedNames = new Set([...shadowedNames, name]);
                    scopes.set(name, { kind, scope, parsed });
                }
            }
            for (const [name, supplier] of itemBindings)
            {
                const actual = scopes.get(name);
                if (!actual || actual.kind !== 'value' || supplier.file !== file
                    || supplier.expression.getText() !== actual.parsed.source.content)
                {
                    fail(`unbound canonical iterable supplier ${name}`);
                }
            }
            templateContext = { file, offset: inputRecord.template.offset + match.node.loc.start.offset,
                digest: controlDigest(match.node.loc.source), expression: match.prop.exp.content,
                iterableScopes: [...scopes].map(([name, scope]) => ({ name, kind: scope.kind,
                    offset: inputRecord.template.offset + scope.scope.loc.start.offset, expression: scope.parsed.source.content })) };
        }
        else if (itemBindings.size)
        {
            fail('template item binding has no canonical template scope');
        }
        const steps = [];
        const expressionInputs = [];
        const audited = new Map();
        const active = new Set();
        const cache = new Map();
        const safeCalls = new Set();
        const writes = new Set();
        const records = new Map();
        const evaluatedNodes = new Set();
        const recordRoots = new Map();
        const valueIdentity = (value) => value.kind === 'object' ? { kind: value.kind,
            fields: [...value.fields].map(([key, values]) => [key, values.map(valueIdentity)]) }
            : value.kind === 'array' ? { kind: value.kind, items: value.items.map((values) => values.map(valueIdentity)) }
                : value;
        const union = (values) => [...new Map(values.map((value) => [controlDigest(valueIdentity(value)), value])).values()];
        let operations = 0;
        function note(owner, node)
        {
            if (++operations > 12000)
            {
                fail('source domain exceeds bounded evaluation');
            }
            const record = resolver.parse(owner);
            if (record.scripts.some(({ ast }) => ast === node.getSourceFile()))
            {
                steps.push(resolver.sourceStep(owner, node));
            }
            else
            {
                expressionInputs.push({ file: owner, expression: node.getText(), digest: controlDigest(node.getText()) });
            }
            if (!records.has(owner))
            {
                records.set(owner, record);
                record.scripts.forEach(({ ast }) => steps.push(resolver.sourceStep(owner, ast)));
            }
        }
        function roots(owner)
        {
            if (recordRoots.has(owner))
            {
                return recordRoots.get(owner);
            }
            const record = resolver.parse(owner);
            if (record.template && typeof parseExpression !== 'function')
            {
                fail(`template expression interface required for ${owner}`);
            }
            const expressions = record.template ? collectSelectorTemplateExpressions(record, parseExpression) : [];
            if (!Array.isArray(expressions) || expressions.some((node) => !node || typeof node.getSourceFile !== 'function'))
            {
                fail(`invalid canonical template expression interface ${owner}`);
            }
            const result = [...record.scripts.map(({ ast }) => ast), ...expressions];
            recordRoots.set(owner, result);
            expressions.forEach((node) => note(owner, node));
            return result;
        }
        function imported(owner, node)
        {
            const record = resolver.parse(owner);
            const entry = record.imports.get(node.text);
            if (!entry || binding(owner, node))
            {
                return null;
            }
            const declarations = [];
            record.scripts.forEach(({ ast }) => walk(ast, (candidate) =>
            {
                if (ts.isImportSpecifier(candidate) && candidate.name.text === node.text && !candidate.isTypeOnly
                    && !candidate.parent.parent.isTypeOnly)
                {
                    declarations.push(candidate);
                }
            }));
            if (declarations.length !== 1)
            {
                fail(`ambiguous runtime import ${owner}#${node.text}`);
            }
            note(owner, declarations[0]);
            for (const ast of roots(owner))
            {
                walk(ast, (candidate) =>
                {
                    const written = assignment(candidate) ? candidate.left : ts.isDeleteExpression(candidate) ? candidate.expression
                    : (ts.isPrefixUnaryExpression(candidate) || ts.isPostfixUnaryExpression(candidate))
                        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(candidate.operator) ? candidate.operand : null;
                    const selected = written && root(written);
                    if (selected && ts.isIdentifier(selected) && selected.text === node.text && !binding(owner, selected))
                    {
                        fail(`mutated runtime import ${owner}#${node.text}`);
                    }
                });
            }
            return entry;
        }
        function vue(owner, node, name)
        {
            node = unwrap(node);
            const entry = node && ts.isIdentifier(node) ? imported(owner, node) : null;
            return entry?.specifier === 'vue' && entry.name === name;
        }
        function origin(owner, entry)
        {
            const target = resolver.modulePath(entry.specifier, owner,
                resolver.identity.mode === 'local' && owner.startsWith(resolver.identity.publicRoot.replace(/\/element-plus$/, '/')));
            const exported = typeof target === 'string' ? resolver.exportsOf(target).get(entry.name) : null;
            if (!exported?.file || exported.ambiguous || exported.unresolved)
            {
                fail(`unknown supplier import ${owner}#${entry.name}`);
            }
            return exported;
        }
        function objectGlobal(owner, node)
        {
            if (!ts.isIdentifier(node) || node.text !== 'Object' || binding(owner, node)
                || resolver.parse(owner).imports.has('Object'))
            {
                fail(`shadowed Object operation ${owner}`);
            }
            for (const ast of roots(owner))
            {
                walk(ast, (candidate) =>
                {
                    if (!ts.isIdentifier(candidate) || candidate.text !== 'Object' || binding(owner, candidate)
                    || declarationName(candidate.parent) === candidate || ts.isTypeNode(candidate.parent)
                    || (ts.isPropertyAccessExpression(candidate.parent) && candidate.parent.name === candidate)
                    || (ts.isPropertyAssignment(candidate.parent) && candidate.parent.name === candidate))
                    {
                        return;
                    }
                    let access = candidate;
                    while (access.parent && (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent))
                    && access.parent.expression === access)
                    {
                        access = access.parent;
                    }
                    if (!ts.isCallExpression(access.parent) || access.parent.expression !== access || access === candidate)
                    {
                        fail(`mutated or escaped Object intrinsic ${owner}`);
                    }
                });
            }
        }
        function member(values, keys)
        {
            const result = [];
            for (const value of values)
            {
                for (const key of keys)
                {
                    if (key.kind !== 'literal' || forbiddenKey(String(key.value)))
                    {
                        fail('unknown or prototype selector key');
                    }
                    if (value.kind === 'object' && value.fields.has(String(key.value)))
                    {
                        result.push(...value.fields.get(String(key.value)));
                    }
                    else if (value.kind === 'array' && key.value === 'length')
                    {
                        result.push(literal(value.items.length));
                    }
                    else if (value.kind === 'array' && Number.isInteger(key.value) && key.value >= 0 && key.value < value.items.length)
                    {
                        result.push(...value.items[key.value]);
                    }
                    else
                    {
                        fail(`unknown item or missing own property ${String(key.value)}`);
                    }
                }
            }
            return result;
        }
        function declare(owner, declaration, env)
        {
            if (env.has(declaration))
            {
                return env.get(declaration);
            }
            if (cache.has(declaration))
            {
                return cache.get(declaration);
            }
            if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer
                || !(declaration.parent.flags & ts.NodeFlags.Const))
            {
                fail(`nonconstant supplier binding ${owner}`);
            }
            if (active.has(declaration))
            {
                fail(`cyclic supplier binding ${owner}#${declaration.name.text}`);
            }
            note(owner, declaration);
            active.add(declaration);
            const init = unwrap(declaration.initializer);
            let values;
            if (ts.isCallExpression(init) && (vue(owner, init.expression, 'shallowRef') || vue(owner, init.expression, 'ref')))
            {
                if (init.arguments.length !== 1)
                {
                    fail('ref requires one actual initializer');
                }
                safeCalls.add(init);
                values = evaluate(owner, init.arguments[0], env);
                const refWrites = [];
                for (const ast of roots(owner))
                {
                    walk(ast, (node) =>
                    {
                        if (!assignment(node) || !ts.isIdentifier(root(node.left))
                        || binding(owner, root(node.left)) !== declaration)
                        {
                            return;
                        }
                        const left = unwrap(node.left);
                        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left)
                        || !ts.isIdentifier(left.expression) || left.name.text !== 'value')
                        {
                            fail('unknown ref write');
                        }
                        writes.add(node);
                        refWrites.push(node);
                        note(owner, node);
                    });
                }
                // Re-evaluate all writes until their entire finite domain closes.
                // An initializer-only cache cannot prove later write/read cycles.
                let stable = false;
                for (let round = 0; round < 64 && !stable; round++)
                {
                    for (const [key, cached] of cache)
                    {
                        if (!cached.every((value) => value.kind === 'ref'))
                        {
                            cache.delete(key);
                        }
                    }
                    cache.set(declaration, [{ kind: 'ref', values }]);
                    const next = union([...values, ...refWrites.flatMap((node) => evaluate(owner, node.right, env))]);
                    if (next.length > 256)
                    {
                        fail('ref write domain exceeds finite bound');
                    }
                    stable = controlDigest(next.map(valueIdentity)) === controlDigest(values.map(valueIdentity));
                    values = next;
                }
                if (!stable)
                {
                    fail('ref writes have no bounded finite closure');
                }
                values = [{ kind: 'ref', values }];
            }
            else
            {
                values = evaluate(owner, init, env);
            }
            if (!(ts.isCallExpression(init) && (vue(owner, init.expression, 'shallowRef') || vue(owner, init.expression, 'ref')))
                && ts.isSourceFile(declaration.parent.parent.parent))
            {
                try
                {
                    resolver.assertImmutableBinding(owner, declaration.name.text);
                }
                catch (error)
                {
                    fail(`reassigned or mutated supplier ${owner}#${declaration.name.text}: ${error.message}`);
                }
            }
            active.delete(declaration);
            cache.set(declaration, values);
            audited.set(declaration, { owner, values });
            return values;
        }
        function callback(owner, fn, items, env)
        {
            fn = unwrap(fn);
            if (!ts.isArrowFunction(fn) || fn.modifiers?.length || fn.parameters.length !== 1
                || !ts.isIdentifier(fn.parameters[0].name) || fn.parameters[0].initializer || fn.parameters[0].dotDotDotToken
                || ts.isBlock(fn.body))
            {
                fail('unknown collection callback');
            }
            const parameter = fn.parameters[0];
            note(owner, fn);
            const next = new Map(env);
            next.set(parameter, items.flat());
            cache.set(parameter, items.flat());
            audited.set(parameter, { owner, values: items.flat() });
            return items.map((item) => evaluate(owner, fn.body, new Map(next).set(parameter, item)));
        }
        function call(owner, node, env)
        {
            const callee = unwrap(node.expression);
            if (vue(owner, callee, 'markRaw') && node.arguments.length === 1)
            {
                const values = evaluate(owner, node.arguments[0], env);
                if (!values.every((value) => value.kind === 'component'))
                {
                    fail('markRaw input is not an actual component import');
                }
                safeCalls.add(node);
                return values;
            }
            if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object'
                && ['keys', 'values'].includes(callee.name.text) && node.arguments.length === 1)
            {
                objectGlobal(owner, callee.expression);
                const values = evaluate(owner, node.arguments[0], env);
                if (!values.every((value) => value.kind === 'object'))
                {
                    fail('unknown Object supplier');
                }
                safeCalls.add(node);
                return values.map((value) => ({ kind: 'array', items: [...value.fields].map(([key, field]) =>
                    callee.name.text === 'keys' ? [literal(key)] : field) }));
            }
            if (ts.isPropertyAccessExpression(callee) && ['map', 'findIndex'].includes(callee.name.text) && node.arguments.length === 1)
            {
                const values = evaluate(owner, callee.expression, env);
                if (!values.every((value) => value.kind === 'array'))
                {
                    fail('unknown iterable supplier');
                }
                const results = values.map((value) => callback(owner, node.arguments[0], value.items, env));
                safeCalls.add(node);
                if (callee.name.text === 'map')
                {
                    return results.map((items) => ({ kind: 'array', items }));
                }
                if (!results.flat(2).every((value) => value.kind === 'literal' && typeof value.value === 'boolean'))
                {
                    fail('unknown findIndex predicate');
                }
                return values.flatMap((value) => Array.from({ length: value.items.length + 1 }, (_, index) => literal(index - 1)));
            }
            // keysOf is proved by its actual exported function body. Its name
            // and package confer no behavior; other matching helpers work too.
            if (ts.isIdentifier(callee) && node.arguments.length === 1)
            {
                const entry = imported(owner, callee);
                if (entry)
                {
                    let target;
                    try
                    {
                        target = resolver.resolveSourceFunction(owner, callee);
                    }
                    catch (error)
                    {
                        fail(`unknown supplier call ${owner}: ${error.message}`);
                    }
                    const fn = unwrap(target.fn);
                    if (fn && ts.isArrowFunction(fn) && !fn.modifiers?.length && fn.parameters.length === 1
                        && ts.isIdentifier(fn.parameters[0].name) && !fn.parameters[0].initializer && !fn.parameters[0].dotDotDotToken)
                    {
                        const body = unwrap(fn.body);
                        if (ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression)
                            && body.expression.name.text === 'keys' && ts.isIdentifier(body.expression.expression)
                            && body.expression.expression.text === 'Object' && body.arguments.length === 1
                            && ts.isIdentifier(body.arguments[0]) && body.arguments[0].text === fn.parameters[0].name.text)
                        {
                            objectGlobal(target.file, body.expression.expression);
                            note(target.file, fn);
                            const declaration = binding(target.file, fn.parent.name);
                            if (declaration)
                            {
                                audited.set(declaration, { owner: target.file, values: [] });
                            }
                            safeCalls.add(node);
                            const values = evaluate(owner, node.arguments[0], env);
                            if (!values.every((value) => value.kind === 'object'))
                            {
                                fail('unknown key supplier');
                            }
                            return values.map((value) => ({ kind: 'array', items: [...value.fields.keys()].map((key) => [literal(key)]) }));
                        }
                    }
                }
            }
            fail(`unknown supplier call ${owner}:${node.getText()}`);
        }
        function evaluate(owner, input, env = new Map())
        {
            const node = unwrap(input);
            if (!node)
            {
                fail('missing supplier expression');
            }
            note(owner, node);
            evaluatedNodes.add(node);
            if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
            {
                return [literal(ts.isNumericLiteral(node) ? Number(node.text) : node.text)];
            }
            if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
            {
                return [literal(node.kind === ts.SyntaxKind.TrueKeyword)];
            }
            if (ts.isIdentifier(node))
            {
                const declaration = binding(owner, node);
                if (declaration && declaration.getSourceFile() === node.getSourceFile())
                {
                    return declare(owner, declaration, env);
                }
                if (itemBindings.has(node.text))
                {
                    const supplied = itemBindings.get(node.text);
                    const values = evaluate(supplied.file, supplied.expression);
                    if (!values.every((value) => value.kind === 'array'))
                    {
                        fail('unknown template item supplier');
                    }
                    const items = values.flatMap((value) => value.items.flat());
                    audited.set(node, { owner, values: items, templateName: node.text });
                    return items;
                }
                if (shadowedNames.has(node.text))
                {
                    fail(`unbound template item ${node.text}`);
                }
                if (declaration)
                {
                    return declare(owner, declaration, env);
                }
                const entry = imported(owner, node);
                if (!entry)
                {
                    fail(`unknown runtime item ${owner}#${node.text}`);
                }
                const component = resolver.resolveImport(owner, entry);
                if (component.kind === 'fsusui-public' || component.kind === 'upstream-internal'
                    || (component.kind === 'local' && component.file.endsWith('.vue')))
                {
                    const values = [{ kind: 'component', source: component }];
                    audited.set(node, { owner, values, importedName: node.text });
                    return values;
                }
                const target = origin(owner, entry);
                const record = resolver.parse(target.file);
                const declarations = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isVariableStatement)
                    .flatMap((statement) => statement.declarationList.declarations.filter((entry) => ts.isIdentifier(entry.name)
                        && entry.name.text === target.name)));
                const declarationNode = declarations.length === 1 ? declarations[0] : null;
                if (!declarationNode)
                {
                    fail(`unknown imported runtime supplier ${owner}#${node.text}: ${JSON.stringify(component)}`);
                }
                try
                {
                    resolver.assertImmutableBinding(target.file, target.name);
                }
                catch (error)
                {
                    fail(`reassigned or mutated supplier ${target.file}#${target.name}: ${error.message}`);
                }
                const values = declare(target.file, declarationNode, env);
                // The actual importer binding participates in escape checks too.
                audited.set(node, { owner, values, importedName: node.text });
                return values;
            }
            if (ts.isObjectLiteralExpression(node))
            {
                if (node.properties.length > 256)
                {
                    fail('object domain exceeds finite bound');
                }
                const fields = new Map();
                for (const field of node.properties)
                {
                    if (ts.isSpreadAssignment(field))
                    {
                        const values = evaluate(owner, field.expression, env);
                        if (values.length !== 1 || values[0].kind !== 'object')
                        {
                            fail('unknown object spread');
                        }
                        for (const [key, value] of values[0].fields)
                        {
                            fields.set(key, value);
                        }
                        continue;
                    }
                    if (!(ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)) || ts.isComputedPropertyName(field.name))
                    {
                        fail('unknown object field');
                    }
                    const key = field.name.text;
                    if (forbiddenKey(key) || fields.has(key))
                    {
                        fail('prototype or duplicate object field');
                    }
                    fields.set(key, evaluate(owner, ts.isShorthandPropertyAssignment(field) ? field.name : field.initializer, env));
                }
                return [{ kind: 'object', fields }];
            }
            if (ts.isArrayLiteralExpression(node))
            {
                if (node.elements.length > 256)
                {
                    fail('array domain exceeds finite bound');
                }
                if (node.elements.some((entry) => ts.isSpreadElement(entry) || ts.isOmittedExpression(entry)))
                {
                    fail('unknown array item');
                }
                return [{ kind: 'array', items: node.elements.map((entry) => evaluate(owner, entry, env)) }];
            }
            if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
            {
                let values = evaluate(owner, node.expression, env);
                const keys = ts.isPropertyAccessExpression(node) ? [literal(node.name.text)] : evaluate(owner, node.argumentExpression, env);
                if (keys.length === 1 && keys[0].value === 'value' && values.every((value) => value.kind === 'ref'))
                {
                    return values.flatMap((value) => value.values);
                }
                if (templateRefs)
                {
                    values = values.flatMap((value) => value.kind === 'ref' ? value.values : [value]);
                }
                return member(values, keys);
            }
            if (ts.isConditionalExpression(node))
            {
                return [...evaluate(owner, node.whenTrue, env), ...evaluate(owner, node.whenFalse, env)];
            }
            if (ts.isCallExpression(node))
            {
                return call(owner, node, env);
            }
            if (ts.isBinaryExpression(node))
            {
                const left = evaluate(owner, node.left, env);
                const right = evaluate(owner, node.right, env);
                if (left.length * right.length > 256)
                {
                    fail('key domain exceeds finite bound');
                }
                if (!left.every((value) => value.kind === 'literal') || !right.every((value) => value.kind === 'literal'))
                {
                    fail('unknown arithmetic domain');
                }
                const result = [];
                for (const a of left)
                {
                    for (const b of right)
                    {
                        let value;
                        if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
                        {
                            value = a.value === b.value;
                        }
                        else if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
                        {
                            value = a.value !== b.value;
                        }
                        else if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && typeof a.value === 'number' && typeof b.value === 'number')
                        {
                            value = a.value + b.value;
                        }
                        else if (node.operatorToken.kind === ts.SyntaxKind.PercentToken && Number.isInteger(a.value) && Number.isInteger(b.value) && b.value > 0)
                        {
                            value = a.value % b.value;
                        }
                        else
                        {
                            fail('unknown key arithmetic');
                        }
                        if (typeof value === 'number' && !Number.isFinite(value))
                        {
                            fail('nonfinite key domain');
                        }
                        result.push(literal(value));
                    }
                }
                return result;
            }
            fail(`unknown supplier expression ${owner}:${node.getText()}`);
        }
        function audit(declaration, { owner, values, importedName, templateName })
        {
            const name = templateName ?? importedName ?? declaration.name?.text;
            if (!name)
            {
                fail('unknown effect binding');
            }
            for (const ast of roots(owner))
            {
                walk(ast, (node) =>
                {
                    if (!ts.isIdentifier(node) || node.text !== name || declarationName(node.parent) === node
                    || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                    || (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
                    || ts.isTypeNode(node.parent))
                    {
                        return;
                    }
                    const selectedBinding = binding(owner, node);
                    if (templateName ? resolver.parse(owner).scripts.some(({ ast }) => ast === node.getSourceFile())
                    || selectedBinding?.getSourceFile() === node.getSourceFile()
                        : importedName ? selectedBinding !== null : selectedBinding !== declaration)
                    {
                        return;
                    }
                    let access = node;
                    while (access.parent && (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)
                    || ts.isAsExpression(access.parent) || ts.isSatisfiesExpression(access.parent) || ts.isParenthesizedExpression(access.parent))
                    && access.parent.expression === access)
                    {
                        access = access.parent;
                    }
                    const parent = access.parent;
                    if (templateName && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword
                    && parent.left === access && itemBindings.get(name)?.expression.getText() === parent.right.getText())
                    {
                        return;
                    }
                    if (assignment(parent) && parent.left === access)
                    {
                        if (!writes.has(parent))
                        {
                            fail(`reassigned or mutated supplier ${owner}#${name}`);
                        }
                        return;
                    }
                    if (parent && (ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent)
                    || (ts.isPrefixUnaryExpression(parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator))))
                    {
                        fail(`mutated supplier ${owner}#${name}`);
                    }
                    if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)))
                    {
                        if (!safeCalls.has(parent))
                        {
                        // Scalar projections cannot carry an object/ref alias.
                            if (access === node || parent.expression === access || !evaluate(owner, access).every(scalar))
                            {
                                fail(`escaped supplier ${owner}#${name}`);
                            }
                        }
                        return;
                    }
                    if (values.every(scalar))
                    {
                        return;
                    }
                    if (ts.isExportSpecifier(parent))
                    {
                        fail(`escaped export alias ${owner}#${name}`);
                    }
                    if (ts.isSpreadAssignment(parent))
                    {
                    // Only copies already evaluated in a closed map callback.
                        if (!evaluatedNodes.has(parent.parent))
                        {
                            fail('unproved spread escape');
                        }
                        return;
                    }
                    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent))
                    {
                        if (evaluatedNodes.has(parent.parent))
                        {
                            return;
                        }
                    }
                    if ((ts.isVariableDeclaration(parent) && parent.initializer === access)
                    || ts.isReturnStatement(parent) || ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)
                    || ts.isArrayLiteralExpression(parent) || (assignment(parent) && parent.right === access))
                    {
                        if (access === node || !evaluate(owner, access).every(scalar))
                        {
                            if (!(assignment(parent) && writes.has(parent)))
                            {
                                fail(`escaped alias ${owner}#${name}`);
                            }
                        }
                        return;
                    }
                    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword
                    && parent.right === access && [...itemBindings.values()].some((supplier) => supplier.file === owner
                        && supplier.expression.getText() === access.getText()))
                    {
                        return;
                    }
                    if (access !== node && evaluate(owner, access).every(scalar))
                    {
                        return;
                    }
                    if (unwrap(access).getText() === expression.getText() && owner === file)
                    {
                        return;
                    }
                    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken,
                        ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind))
                    {
                        return;
                    }
                    fail(`unknown supplier use ${owner}#${name}: ${access.getText()} in ${ts.SyntaxKind[parent.kind]}`);
                });
            }
        }
        const values = evaluate(file, expression);
        if (!values.length || !values.every((value) => value.kind === 'component'))
        {
            fail('selector is not a fully enumerated component set');
        }
        for (const [declaration, effect] of audited)
        {
            audit(declaration, effect);
        }
        const bindings = resolver.sourceBindings();
        if (bindings.errors.length)
        {
            fail('canonical source changed during selector proof');
        }
        const uniqueSteps = [...new Map(steps.map((entry) => [controlDigest(entry), entry])).values()];
        const uniqueExpressions = [...new Map(expressionInputs.map((entry) => [controlDigest(entry), entry])).values()];
        const inputs = bindings.files;
        const targets = [...new Map(values.map((value) => [controlDigest(value.source), value.source])).values()];
        const selectorSource = { bindingFile: file, expression: expression.getText(), steps: uniqueSteps, inputs,
            expressionInputs: uniqueExpressions, templateRefs, templateContext, targets,
            itemBindings: [...itemBindings].map(([name, supplier]) => ({ name, file: supplier.file, expression: supplier.expression.getText() })),
            shadowedNames: [...shadowedNames].sort() };
        selectorSource.proofDigest = controlDigest(selectorSource);
        return targets
            .map((target) => ({ ...target, selectorSource }));
    }
    return { resolve: run };
}
