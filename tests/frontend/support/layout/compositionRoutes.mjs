import { resolve } from 'node:path';

import { controlDigest } from '@fsusblog/control-legality/source';

const routeDeclarations = new WeakMap();

/** Restricted AST interpreter for the real router imports. Never executes product modules. */
export function resolveCompositionRoutes(source, routerFile)
{
    const { ts, parse } = source.resolver;
    const memo = new Map();
    const resolving = new Set();
    const omitted = new Set(['meta', 'props', 'redirect', 'beforeEnter', 'alias']);
    function fail(node, file)
    {
        throw new Error(`[composition-routes] unknown route expression ${file}:${node?.getStart() ?? 0} ${node?.kind ?? 'missing'}`);
    }
    function name(file, identifier, environment)
    {
        if (environment.has(identifier))
        {
            return environment.get(identifier);
        }
        const identity = `${file}#${identifier}`;
        if (memo.has(identity))
        {
            return memo.get(identity);
        }
        if (resolving.has(identity))
        {
            throw new Error(`[composition-routes] cycle ${identity}`);
        }
        resolving.add(identity);
        const record = parse(file);
        let value;
        const imported = record.imports.get(identifier);
        if (imported)
        {
            value = name(source.importFile(file, imported.specifier), imported.name, new Map());
        }
        else if (record.variables.has(identifier))
        {
            value = evaluate(record.variables.get(identifier), file, environment);
        }
        else
        {
            for (const { ast } of record.scripts)
            {
                const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === identifier);
                if (declaration)
                {
                    value = { callable: declaration, file, environment };
                }
            }
            if (!value)
            {
                fail(null, identity);
            }
        }
        resolving.delete(identity);
        memo.set(identity, value);
        return value;
    }
    function call(fn, args)
    {
        if (!fn?.callable)
        {
            throw new Error('[composition-routes] unknown function');
        }
        const environment = new Map(fn.environment);
        fn.callable.parameters.forEach((parameter, index) =>
        {
            if (!ts.isIdentifier(parameter.name))
            {
                fail(parameter, fn.file);
            }
            environment.set(parameter.name.text, args[index] ?? (parameter.initializer ? evaluate(parameter.initializer, fn.file, environment) : undefined));
        });
        if (!ts.isBlock(fn.callable.body))
        {
            return evaluate(fn.callable.body, fn.file, environment);
        }
        for (const statement of fn.callable.body.statements)
        {
            if (ts.isReturnStatement(statement))
            {
                return evaluate(statement.expression, fn.file, environment);
            }
            if (ts.isVariableStatement(statement))
            {
                for (const declaration of statement.declarationList.declarations)
                {
                    if (!ts.isIdentifier(declaration.name))
                    {
                        fail(declaration, fn.file);
                    }
                    environment.set(declaration.name.text, evaluate(declaration.initializer, fn.file, environment));
                }
                continue;
            }
            if (ts.isIfStatement(statement))
            {
                const branch = evaluate(statement.expression, fn.file, environment) ? statement.thenStatement : statement.elseStatement;
                if (!branch)
                {
                    continue;
                }
                const returned = ts.isReturnStatement(branch) ? branch : ts.isBlock(branch) && branch.statements.length === 1
                    && ts.isReturnStatement(branch.statements[0]) ? branch.statements[0] : null;
                if (returned)
                {
                    return evaluate(returned.expression, fn.file, environment);
                }
            }
            fail(statement, fn.file);
        }
        fail(fn.callable.body, fn.file);
    }
    function evaluate(node, file, environment = new Map())
    {
        if (!node)
        {
            fail(node, file);
        }
        if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
        {
            return evaluate(node.expression, file, environment);
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        {
            return node.text;
        }
        if (ts.isNumericLiteral(node))
        {
            return Number(node.text);
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
        {
            return node.kind === ts.SyntaxKind.TrueKeyword;
        }
        if (node.kind === ts.SyntaxKind.NullKeyword)
        {
            return null;
        }
        if (ts.isIdentifier(node))
        {
            if (node.text === 'undefined')
            {
                return undefined;
            }
            return name(file, node.text, environment);
        }
        if (ts.isArrayLiteralExpression(node))
        {
            return node.elements.flatMap((element) => ts.isSpreadElement(element) ? evaluate(element.expression, file, environment)
                : [evaluate(element, file, environment)]);
        }
        if (ts.isObjectLiteralExpression(node))
        {
            const result = {};
            for (const property of node.properties)
            {
                if (ts.isSpreadAssignment(property))
                {
                    Object.assign(result, evaluate(property.expression, file, environment));
                    continue;
                }
                const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
                if (!propertyName)
                {
                    fail(property, file);
                }
                if (!omitted.has(propertyName))
                {
                    result[propertyName] = evaluate(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, file, environment);
                }
            }
            return result;
        }
        if (ts.isArrowFunction(node))
        {
            return { callable: node, file, environment };
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        {
            const target = evaluate(node.expression, file, environment);
            const field = ts.isPropertyAccessExpression(node) ? node.name.text : evaluate(node.argumentExpression, file, environment);
            if (target === null || target === undefined || !(field in Object(target)))
            {
                fail(node, file);
            }
            return target[field];
        }
        if (ts.isConditionalExpression(node))
        {
            return evaluate(evaluate(node.condition, file, environment) ? node.whenTrue : node.whenFalse, file, environment);
        }
        if (ts.isTemplateExpression(node))
        {
            return node.head.text + node.templateSpans.map((span) => evaluate(span.expression, file, environment) + span.literal.text).join('');
        }
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
        {
            return !evaluate(node.operand, file, environment);
        }
        if (ts.isBinaryExpression(node))
        {
            const left = evaluate(node.left, file, environment);
            const right = () => evaluate(node.right, file, environment);
            switch (node.operatorToken.kind)
            {
                case ts.SyntaxKind.PlusToken: return left + right();
                case ts.SyntaxKind.BarBarToken: return left || right();
                case ts.SyntaxKind.AmpersandAmpersandToken: return left && right();
                case ts.SyntaxKind.QuestionQuestionToken: return left ?? right();
                case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right();
                case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right();
                case ts.SyntaxKind.InKeyword: return left in right();
                default: fail(node, file);
            }
        }
        if (ts.isCallExpression(node))
        {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
            {
                return { componentFile: source.importFile(file, node.arguments[0].text) };
            }
            if (ts.isPropertyAccessExpression(node.expression))
            {
                const member = node.expression.name.text;
                if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' && member === 'freeze')
                {
                    return evaluate(node.arguments[0], file, environment);
                }
                const receiver = evaluate(node.expression.expression, file, environment);
                const args = node.arguments.map((argument) => evaluate(argument, file, environment));
                if (Array.isArray(receiver) && member === 'map')
                {
                    return receiver.map((item, index) => call(args[0], [item, index]));
                }
                if (typeof receiver === 'string' && ['startsWith', 'endsWith', 'slice'].includes(member))
                {
                    return String.prototype[member].apply(receiver, args);
                }
                fail(node, file);
            }
            return call(evaluate(node.expression, file, environment), node.arguments.map((argument) => evaluate(argument, file, environment)));
        }
        fail(node, file);
    }
    const router = parse(routerFile);
    const createRouterNames = new Set([...router.imports].filter(([, entry]) => entry.specifier === 'vue-router' && entry.name === 'createRouter').map(([name]) => name));
    const routeExpressions = [];
    function find(node)
    {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && createRouterNames.has(node.expression.text))
        {
            let options = node.arguments[0];
            if (ts.isIdentifier(options))
            {
                options = router.variables.get(options.text);
            }
            if (!options || !ts.isObjectLiteralExpression(options))
            {
                fail(options, routerFile);
            }
            const routes = options.properties.find((property) => property.name?.getText() === 'routes');
            routeExpressions.push(ts.isShorthandPropertyAssignment(routes) ? routes.name : routes?.initializer);
        }
        ts.forEachChild(node, find);
    }
    router.scripts.forEach(({ ast }) => find(ast));
    if (routeExpressions.length !== 1)
    {
        throw new Error('[composition-routes] expected one actual createRouter routes binding');
    }
    const records = evaluate(routeExpressions[0], routerFile);
    const flattened = [];
    const normalize = (path) => path === '/' ? path : path.replace(/\/$/, '');
    function visit(records, parentPath = '/', parents = [], matchedRecords = [])
    {
        for (const record of records)
        {
            if (typeof record.path !== 'string')
            {
                throw new Error('[composition-routes] unknown route path');
            }
            const path = record.path.startsWith('/') ? record.path : `${parentPath.replace(/\/$/, '')}/${record.path}`;
            const views = [...(record.component ? [['default', record.component]] : []),
                ...Object.entries(record.components ?? {}).filter(([, component]) => component)].map(([name, component]) =>
            {
                const resolved = component.componentFile ? component : call(component, []);
                if (!resolved.componentFile)
                {
                    throw new Error('[composition-routes] unresolved route component');
                }
                return [name, resolved.componentFile];
            });
            const components = views.map(([, file]) => file);
            const declaration = { path: normalize(path), componentViews: Object.fromEntries(views),
                hasComponents: Boolean(record.component || record.components),
                ambiguousViews: Boolean(record.component && record.components) || new Set(views.map(([name]) => name)).size !== views.length };
            const chain = [...matchedRecords, declaration];
            flattened.push({ path: normalize(path), componentFiles: components, ancestorFiles: parents, matchedRecords: chain });
            if (record.children)
            {
                visit(record.children, path, [...parents, ...components], chain);
            }
        }
    }
    visit(records);
    const result = { schema: 'fsusblog.composition-routes.v1', routerFile: resolve(routerFile), routes: flattened };
    routeDeclarations.set(result, { source, digest: controlDigest(result) });
    return result;
}

/**
 * Resolve a real dynamic-component call's RouterView Component slot supplier.
 * This observes finite declarations, including empty views; it does not select
 * a runtime route, authorize navigation or grant rendered/state acceptance.
 * callPath is nearest-first, from the slot's SFC through actual component calls
 * to its route-declared owner. Direct route owners need no callPath.
 */
export function resolveCompositionRouterViewSlot(source, routes, { file, offset, callPath = [] })
{
    const fail = (message) =>
    {
        throw new Error(`[composition-routes] ${message}`);
    };
    const retained = routeDeclarations.get(routes);
    if (!retained || retained.source !== source || retained.digest !== controlDigest(routes))
    {
        fail('route declaration is not the unchanged original source observation');
    }
    const { ts, dom } = source.resolver;
    const record = source.resolver.parse(file);
    let selected;
    const visit = (node, ancestors = []) =>
    {
        if (node.type === dom.NodeTypes.ELEMENT && record.template.offset + node.loc.start.offset === offset)
        {
            selected = { node, ancestors };
        }
        for (const child of node.children ?? [])
        {
            visit(child, [...ancestors, node]);
        }
    };
    if (!record.template)
    {
        fail('RouterView slot requires an actual Vue template');
    }
    visit(record.template.ast);
    const directive = (node, name) => node.props?.filter((prop) => prop.type === dom.NodeTypes.DIRECTIVE && prop.name === name) ?? [];
    const dynamic = selected && directive(selected.node, 'bind').filter((prop) => prop.arg?.isStatic && prop.arg.content === 'is');
    if (selected?.node.tag !== 'component' || dynamic.length !== 1 || !dynamic[0].exp
        || directive(selected.node, 'bind').some((prop) => !prop.arg || !prop.arg.isStatic))
    {
        fail('slot target is not an exact authored dynamic component selector');
    }
    const selector = source.expression(dynamic[0].exp.content, file);
    if (!ts.isIdentifier(selector))
    {
        fail('unknown RouterView slot selector expression');
    }
    const suppliers = selected.ancestors.filter((node) => directive(node, 'slot').length);
    const slotNode = suppliers.at(-1);
    const slots = slotNode && directive(slotNode, 'slot');
    if (slots?.length !== 1 || !slots[0].exp || (slots[0].arg && (!slots[0].arg.isStatic || slots[0].arg.content !== 'default')))
    {
        fail('missing or unknown actual default slot owner');
    }
    const origin = source.resolver.resolveTag(file, slotNode.tag);
    if (origin.kind !== 'external' || origin.package !== 'vue-router' || origin.publicName !== 'RouterView')
    {
        fail('slot owner is not the canonical RouterView');
    }
    const pattern = source.expression(`(${slots[0].exp.content}) => 0`, file);
    const parameter = ts.isArrowFunction(pattern) && pattern.parameters.length === 1 && pattern.parameters[0];
    if (!parameter || !ts.isObjectBindingPattern(parameter.name) || parameter.initializer
        || parameter.name.elements.some((element) => element.dotDotDotToken || element.initializer
            || !ts.isIdentifier(element.name) || (element.propertyName && !ts.isIdentifier(element.propertyName))))
    {
        fail('unknown RouterView slot binding pattern');
    }
    const bindings = parameter.name.elements.filter((element) => (element.propertyName ?? element.name).text === 'Component');
    if (bindings.length !== 1 || bindings[0].name.text !== selector.text)
    {
        fail('selector is not the actual RouterView Component binding');
    }
    const scope = selected.ancestors.slice(selected.ancestors.indexOf(slotNode) + 1).concat(selected.node);
    if (scope.some((node) => directive(node, 'for').length || directive(node, 'slot').length))
    {
        fail('unknown intervening template supplier or shadow scope');
    }
    const routerViews = selected.ancestors.filter((node) =>
    {
        if (node.type !== dom.NodeTypes.ELEMENT)
        {
            return false;
        }
        const identity = source.resolver.resolveTag(file, node.tag);
        return identity.kind === 'external' && identity.package === 'vue-router' && identity.publicName === 'RouterView';
    });
    if (routerViews.length !== 1 || directive(slotNode, 'for').length)
    {
        fail('unknown nested RouterView depth');
    }
    const names = slotNode.props.filter((prop) => prop.type === dom.NodeTypes.ATTRIBUTE && prop.name === 'name');
    if (names.length > 1 || slotNode.props.some((prop) => prop.type === dom.NodeTypes.ATTRIBUTE && prop.name === 'route')
        || directive(slotNode, 'bind').some((prop) => !prop.arg || !prop.arg.isStatic || ['name', 'route'].includes(prop.arg.content)))
    {
        fail('unknown RouterView view-name supplier');
    }
    const viewName = names[0]?.value?.content ?? 'default';
    if (!viewName || !Array.isArray(callPath) || new Set(callPath).size !== callPath.length)
    {
        fail('unknown view name or cyclic component call path');
    }
    let ownerFile = file;
    const calls = callPath.map((id) =>
    {
        const call = source.nodes.get(id);
        if (!call || call.definition !== ownerFile || !source.records.get(call.file)?.nodes.includes(id))
        {
            fail('route owner path does not follow actual component definitions');
        }
        ownerFile = call.file;
        return { id, file: call.file, offset: call.offset, definition: call.definition,
            sourceDigest: call.sourceDigest,
            inputDigest: controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }) };
    });
    const alternatives = [];
    for (const route of routes.routes)
    {
        const depths = route.matchedRecords.flatMap((entry, index) => Object.values(entry.componentViews).includes(ownerFile) ? [index] : []);
        if (!depths.length)
        {
            continue;
        }
        if (depths.length !== 1 || route.matchedRecords.some((entry) => entry.ambiguousViews))
        {
            fail('ambiguous route owner or named-view declaration');
        }
        const depth = depths[0];
        const next = route.matchedRecords.slice(depth + 1).find((entry) => entry.hasComponents);
        const componentFile = next?.componentViews[viewName] ?? null;
        alternatives.push({ path: route.path, ownerDepth: depth, viewName,
            componentFile, kind: componentFile ? 'component' : 'empty-view', matchedRecords: route.matchedRecords });
    }
    if (!alternatives.length)
    {
        fail('slot component owner has no actual route declaration');
    }
    const observed = source.resolver.sourceBindings();
    if (observed.errors.length)
    {
        fail('canonical route or slot source inputs changed');
    }
    const slotOffset = record.template.offset + slotNode.loc.start.offset;
    const slotCall = [...source.nodes.values()].find((node) => node.file === file && node.offset === slotOffset);
    const proof = { schema: 'fsusblog.composition-router-view-slot.v1', kind: 'router-view-slot', supplierKind: 'route-component-vnode',
        routerFile: routes.routerFile,
        declarationDigest: retained.digest, file, offset,
        selector: { expression: dynamic[0].exp.content, offset: record.template.offset + dynamic[0].exp.loc.start.offset,
            digest: controlDigest(dynamic[0].exp.content) },
        slotOwner: { file, offset: slotOffset, callNode: slotCall?.id ?? null, tag: slotNode.tag,
            origin, binding: selector.text, property: 'Component', sourceDigest: controlDigest(slotNode.loc.source) },
        routeOwner: { file: ownerFile, callPath: calls }, alternatives, resolverInputs: observed.files };
    const variantDefinitions = [...new Set(alternatives.map((entry) => entry.componentFile).filter(Boolean))];
    return { ...proof, variants: variantDefinitions.map((file) => ({ kind: 'local', file, name: 'default' })),
        variantDefinitions, proofDigest: controlDigest(proof), qualificationEligible: false };
}

export function bindCompositionArchetypes(matrix, routes)
{
    return matrix.archetypes.map((archetype) =>
    {
        const candidates = routes.routes.filter((route) =>
        {
            const routeParts = route.path.split('/');
            const fixtureParts = new URL(archetype.path, 'http://fixture.invalid').pathname.split('/');
            return routeParts.length === fixtureParts.length && routeParts.every((part, index) => part.startsWith(':')
                ? !part.includes('*') && fixtureParts[index].length > 0 : part === fixtureParts[index]);
        }).filter((route) => route.componentFiles.length);
        const specificity = (route) => route.path.split('/').filter((part) => !part.startsWith(':')).length * 100 + route.ancestorFiles.length;
        const best = Math.max(...candidates.map(specificity));
        const matches = candidates.filter((route) => specificity(route) === best);
        if (matches.length !== 1)
        {
            return { archetype, errors: [{ reason: 'route-fixture-binding-not-exact-one', path: archetype.path, count: matches.length }], entryFiles: [] };
        }
        return { archetype, errors: [], entryFiles: [...matches[0].ancestorFiles, ...matches[0].componentFiles] };
    });
}
